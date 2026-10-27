import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import {
  auditLogTable,
  cigAdminSecurityEventsTable,
  db,
  organisationsTable,
  teachersTable,
  classesTable,
  studentDataRequestControlsTable,
  studentSessionsTable,
} from "@workspace/db";
import { logger } from "./logger";
import { recordDeletionTombstones } from "./deletion-ledger";
import { getRestorationAdmissionState } from "./restoration-quarantine";
import { acquireRetentionPolicyMutationLock } from "./organisation-retention";
import { enqueueAiCredentialSecretCleanup } from "./ai-credential-secret-cleanup-queue";
import { invalidateAiCredentialSecret } from "./ai-credential-secret-store";

export const ORGANISATION_DELETION_RETENTION_DAYS = 30;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

type DeletedOrganisation = {
  id: number;
  name: string;
  slug: string;
  aiKeySecretRef: string | null;
  deletedAt: Date;
  deletedByCigAdminId: number | null;
};

type PermanentDeletionGuard = (tx: Pick<typeof db, "execute" | "select">) => Promise<boolean>;

/**
 * Removes an already-soft-deleted organisation and all data owned by it.
 * It is intentionally idempotent: a concurrent/manual purge simply returns
 * null and the caller can safely retry later.
 */
export async function permanentlyDeleteSoftDeletedOrganisation(
  organisationId: number,
  action: "cig_admin.organisation_hard_deleted" | "cig_admin.organisation_purged_after_retention",
  actorId: number | null,
  guard?: PermanentDeletionGuard,
): Promise<DeletedOrganisation | null> {
  const deleted = await db.transaction(async (tx) => {
    // A manual hard delete supplies a guard that acquires the CIG mutation lock
    // and rechecks the actor in this transaction. Retention purges deliberately
    // have no actor and therefore no administrator authorization guard.
    if (guard && !await guard(tx)) return null;
    await acquireRetentionPolicyMutationLock(tx, organisationId);

    const [organisation] = await tx
      .select({
        id: organisationsTable.id,
        name: organisationsTable.name,
        slug: organisationsTable.slug,
        aiKeySecretRef: organisationsTable.aiKeySecretRef,
        deletedAt: organisationsTable.deletedAt,
        deletedByCigAdminId: organisationsTable.deletedByCigAdminId,
      })
      .from(organisationsTable)
      .where(and(eq(organisationsTable.id, organisationId), isNotNull(organisationsTable.deletedAt)))
      .for("update");

    if (!organisation?.deletedAt) return null;
    const [hold] = await tx.select({ deletionLegalHold: organisationsTable.deletionLegalHold })
      .from(organisationsTable).where(eq(organisationsTable.id, organisation.id));
    if (hold?.deletionLegalHold) return null;
    const activeRequestControls = await tx
      .select({
        kind: studentDataRequestControlsTable.kind,
        processingLimits: studentDataRequestControlsTable.processingLimits,
      })
      .from(studentDataRequestControlsTable)
      .where(and(
        eq(studentDataRequestControlsTable.organisationId, organisation.id),
        eq(studentDataRequestControlsTable.lifecycleState, "active"),
      ));
    if (activeRequestControls.some(
      (control) => control.kind !== "restriction" || control.processingLimits.includes("deletion"),
    )) return null;
    if (organisation.aiKeySecretRef) {
      await enqueueAiCredentialSecretCleanup(tx, organisation.id, organisation.aiKeySecretRef);
    }

    const teacherIds = await tx.select({ id: teachersTable.id })
      .from(teachersTable).where(eq(teachersTable.organisationId, organisation.id));
    const classIds = teacherIds.length
      ? await tx.select({ id: classesTable.id }).from(classesTable)
        .where(inArray(classesTable.teacherId, teacherIds.map((teacher) => teacher.id)))
      : [];
    const studentIds = classIds.length
      ? await tx.select({ id: studentSessionsTable.id }).from(studentSessionsTable)
        .where(inArray(studentSessionsTable.classId, classIds.map((cls) => cls.id)))
      : [];
    const auditIds = await tx.select({ id: auditLogTable.id }).from(auditLogTable)
      .where(eq(auditLogTable.organisationId, organisation.id));
    await recordDeletionTombstones(tx, [
      { entityType: "organisation", entityId: organisation.id },
      ...teacherIds.map((teacher) => ({ entityType: "teacher" as const, entityId: teacher.id })),
      ...classIds.map((cls) => ({ entityType: "class" as const, entityId: cls.id })),
      ...studentIds.map((student) => ({ entityType: "student_record" as const, entityId: student.id })),
      ...auditIds.map((audit) => ({ entityType: "security_audit" as const, entityId: audit.id })),
    ]);

    // audit_log uses SET NULL foreign keys, so remove it explicitly. Deleting
    // teachers then cascades through classes, sessions, student work, feedback,
    // recovery codes, password history, and activity records.
    await tx.delete(auditLogTable).where(eq(auditLogTable.organisationId, organisation.id));
    await tx.execute(sql`SET LOCAL app.organisation_purge = 'on'`);
    await tx.delete(teachersTable).where(eq(teachersTable.organisationId, organisation.id));
    // This must be inside the same transaction as irreversible destruction.
    // A failed security event write rolls deletion back, leaving the school
    // available for a retry instead of silently losing the required evidence.
    await tx.insert(cigAdminSecurityEventsTable).values({
      adminId: actorId,
      action,
      metadata: JSON.stringify({
        organisationId: organisation.id,
        organisationName: organisation.name,
        organisationSlug: organisation.slug,
        deletedAt: organisation.deletedAt.toISOString(),
        deletedByCigAdminId: organisation.deletedByCigAdminId,
      }),
    });
    const [removed] = await tx
      .delete(organisationsTable)
      .where(and(eq(organisationsTable.id, organisation.id), isNotNull(organisationsTable.deletedAt)))
      .returning({ id: organisationsTable.id });
    if (!removed) return null;
    return { ...organisation, deletedAt: organisation.deletedAt };
  });

  if (deleted?.aiKeySecretRef) {
    invalidateAiCredentialSecret(deleted.id, deleted.aiKeySecretRef);
  }
  return deleted;
}

export async function purgeExpiredDeletedOrganisations(): Promise<number> {
  const cutoff = new Date(Date.now() - ORGANISATION_DELETION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let purged = 0;
  while (true) {
    const expired = await db
      .select({ id: organisationsTable.id })
      .from(organisationsTable)
      .where(and(
        isNotNull(organisationsTable.deletedAt),
        lte(organisationsTable.deletedAt, cutoff),
        eq(organisationsTable.deletionLegalHold, false),
      ))
      .orderBy(organisationsTable.deletedAt)
      .limit(100);

    if (expired.length === 0) break;

    let batchPurged = 0;
    for (const organisation of expired) {
      try {
        const removed = await permanentlyDeleteSoftDeletedOrganisation(
          organisation.id,
          "cig_admin.organisation_purged_after_retention",
          null,
        );
        if (removed) {
          purged++;
          batchPurged++;
        }
      } catch (error) {
        logger.error({ err: error, organisationId: organisation.id }, "Unable to purge soft-deleted organisation");
      }
    }

    // An audit or database failure leaves a school intact for the next run.
    // Stop only when this batch made no progress; otherwise keep draining the
    // backlog immediately instead of extending retention by another day.
    if (batchPurged === 0) break;
  }
  return purged;
}

let purgeRunning = false;

async function runPurgeSafely(): Promise<void> {
  if (purgeRunning) return;
  if (await getRestorationAdmissionState() !== "ready") return;
  purgeRunning = true;
  try {
    const purged = await purgeExpiredDeletedOrganisations();
    if (purged > 0) logger.info({ purged }, "Purged expired soft-deleted organisations");
  } catch (error) {
    logger.error({ err: error }, "Organisation deletion retention purge failed");
  } finally {
    purgeRunning = false;
  }
}

export function startOrganisationDeletionPurge(): void {
  void runPurgeSafely();
  const interval = setInterval(() => void runPurgeSafely(), PURGE_INTERVAL_MS);
  interval.unref();
}
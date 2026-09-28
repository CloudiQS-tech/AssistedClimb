import { and, eq, gt, isNotNull, isNull, lte } from "drizzle-orm";
import {
  auditLogTable,
  classesTable,
  db,
  organisationRetentionDefaultsTable,
  recoverableDeletionEvidenceTable,
  studentSessionsTable,
  teachersTable,
} from "@workspace/db";
import { logger } from "./logger";
import { recordDeletionTombstones } from "./deletion-ledger";
import { getRestorationAdmissionState } from "./restoration-quarantine";
import { acquireRetentionPolicyMutationLock } from "./organisation-retention";
import { findBlockingStudentDataControl } from "./student-data-request-controls";
import {
  sendRecoverableDeletionWarningEmail,
  type RecoverableDeletionWarningEmailStatus,
} from "./platform-email";

export const RECOVERABLE_DELETION_DAYS = 30;
export const RECOVERABLE_DELETION_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const RECOVERABLE_DELETION_WARNING_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

type RecoverableDeletionWarningClaim = {
  targetType: "class" | "student_record";
  targetId: number;
  classId: number;
  organisationId: number;
  targetLabel: string;
  deletionScheduledFor: Date;
  warningAttemptedAt: Date;
};

const deletionReasons = ["teacher_requested", "departure_requested", "archive_retention_expired"] as const;
type DeletionReason = typeof deletionReasons[number];

function isDeletionReason(value: string | null): value is DeletionReason {
  return Boolean(value && deletionReasons.includes(value as DeletionReason));
}

export function recoverableDeletionDeadline(now = new Date()): Date {
  return new Date(now.getTime() + RECOVERABLE_DELETION_DAYS * 24 * 60 * 60 * 1000);
}

function warningFailureReason(status: RecoverableDeletionWarningEmailStatus | "no-recipient" | "ambiguous") {
  if (status === "not-configured") return "email_not_configured";
  if (status === "no-recipient") return "no_active_school_master";
  if (status === "ambiguous") return "ambiguous_transport_outcome";
  return "delivery_failed";
}

async function claimRecoverableDeletionWarnings(now: Date): Promise<RecoverableDeletionWarningClaim[]> {
  const warningWindowEndsAt = new Date(now.getTime() + RECOVERABLE_DELETION_WARNING_DAYS * DAY_MS);
  return db.transaction(async (tx) => {
    const policies = await tx.select({
      organisationId: organisationRetentionDefaultsTable.organisationId,
      legalHold: organisationRetentionDefaultsTable.legalHold,
    }).from(organisationRetentionDefaultsTable);
    const legalHoldByOrganisation = new Map(policies.map((policy) => [policy.organisationId, policy.legalHold]));
    const claims: RecoverableDeletionWarningClaim[] = [];

    const classes = await tx.select({
      id: classesTable.id,
      name: classesTable.name,
      organisationId: teachersTable.organisationId,
      archiveLegalHold: classesTable.archiveLegalHold,
      deletionScheduledFor: classesTable.deletionScheduledFor,
      deletionReason: classesTable.deletionReason,
    }).from(classesTable)
      .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
      .where(and(
        isNotNull(classesTable.deletionScheduledFor),
        gt(classesTable.deletionScheduledFor, now),
        lte(classesTable.deletionScheduledFor, warningWindowEndsAt),
        isNull(classesTable.deletionWarningAttemptedAt),
        isNull(classesTable.deletionWarningSentAt),
      )).for("update");

    for (const cls of classes) {
      if (
        !cls.organisationId
        || !cls.deletionScheduledFor
        || !isDeletionReason(cls.deletionReason)
        || cls.archiveLegalHold
        || legalHoldByOrganisation.get(cls.organisationId)
      ) continue;
      if (await findBlockingStudentDataControl(tx, cls.organisationId, "deletion", { classIds: [cls.id] })) continue;
      const [claimed] = await tx.update(classesTable).set({
        deletionWarningAttemptedAt: now,
      }).where(and(
        eq(classesTable.id, cls.id),
        eq(classesTable.deletionScheduledFor, cls.deletionScheduledFor),
        isNull(classesTable.deletionWarningAttemptedAt),
        isNull(classesTable.deletionWarningSentAt),
      )).returning({ id: classesTable.id });
      if (!claimed) continue;
      await tx.insert(auditLogTable).values({
        organisationId: cls.organisationId,
        action: "deletion.recovery_warning_dispatch_started",
        metadata: {
          targetType: "class",
          targetId: cls.id,
          deletionScheduledFor: cls.deletionScheduledFor.toISOString(),
          warningWindowDays: RECOVERABLE_DELETION_WARNING_DAYS,
          warningAttemptedAt: now.toISOString(),
        },
      });
      claims.push({
        targetType: "class",
        targetId: cls.id,
        classId: cls.id,
        organisationId: cls.organisationId,
        targetLabel: cls.name,
        deletionScheduledFor: cls.deletionScheduledFor,
        warningAttemptedAt: now,
      });
    }

    const studentRecords = await tx.select({
      id: studentSessionsTable.id,
      classId: studentSessionsTable.classId,
      className: classesTable.name,
      organisationId: teachersTable.organisationId,
      archiveLegalHold: classesTable.archiveLegalHold,
      deletionScheduledFor: studentSessionsTable.deletionScheduledFor,
      deletionReason: studentSessionsTable.deletionReason,
    }).from(studentSessionsTable)
      .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
      .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
      .where(and(
        isNull(classesTable.deletionScheduledFor),
        isNotNull(studentSessionsTable.deletionScheduledFor),
        gt(studentSessionsTable.deletionScheduledFor, now),
        lte(studentSessionsTable.deletionScheduledFor, warningWindowEndsAt),
        isNull(studentSessionsTable.deletionWarningAttemptedAt),
        isNull(studentSessionsTable.deletionWarningSentAt),
      )).for("update");

    for (const record of studentRecords) {
      if (
        !record.organisationId
        || !record.deletionScheduledFor
        || !isDeletionReason(record.deletionReason)
        || record.archiveLegalHold
        || legalHoldByOrganisation.get(record.organisationId)
      ) continue;
      if (await findBlockingStudentDataControl(tx, record.organisationId, "deletion", {
        studentSessionIds: [record.id],
        classIds: [record.classId],
      })) continue;
      const [claimed] = await tx.update(studentSessionsTable).set({
        deletionWarningAttemptedAt: now,
      }).where(and(
        eq(studentSessionsTable.id, record.id),
        eq(studentSessionsTable.deletionScheduledFor, record.deletionScheduledFor),
        isNull(studentSessionsTable.deletionWarningAttemptedAt),
        isNull(studentSessionsTable.deletionWarningSentAt),
      )).returning({ id: studentSessionsTable.id });
      if (!claimed) continue;
      await tx.insert(auditLogTable).values({
        organisationId: record.organisationId,
        action: "deletion.recovery_warning_dispatch_started",
        metadata: {
          targetType: "student_record",
          targetId: record.id,
          classId: record.classId,
          deletionScheduledFor: record.deletionScheduledFor.toISOString(),
          warningWindowDays: RECOVERABLE_DELETION_WARNING_DAYS,
          warningAttemptedAt: now.toISOString(),
        },
      });
      claims.push({
        targetType: "student_record",
        targetId: record.id,
        classId: record.classId,
        organisationId: record.organisationId,
        targetLabel: record.className,
        deletionScheduledFor: record.deletionScheduledFor,
        warningAttemptedAt: now,
      });
    }
    return claims;
  });
}

async function deliverRecoverableDeletionWarning(claim: RecoverableDeletionWarningClaim): Promise<"sent" | "failed" | "unavailable" | "ambiguous" | "superseded"> {
  return db.transaction(async (tx) => {
    const [policy] = await tx.select({
      legalHold: organisationRetentionDefaultsTable.legalHold,
    }).from(organisationRetentionDefaultsTable)
      .where(eq(organisationRetentionDefaultsTable.organisationId, claim.organisationId))
      .for("update");
    const [recipient] = await tx.select({
      id: teachersTable.id,
      name: teachersTable.name,
      email: teachersTable.email,
    }).from(teachersTable).where(and(
      eq(teachersTable.organisationId, claim.organisationId),
      eq(teachersTable.schoolAdminRole, "master"),
      eq(teachersTable.accountStatus, "active"),
    )).for("update");

    const [current] = claim.targetType === "class"
      ? await tx.select({
        deletionScheduledFor: classesTable.deletionScheduledFor,
        deletionWarningAttemptedAt: classesTable.deletionWarningAttemptedAt,
        deletionWarningSentAt: classesTable.deletionWarningSentAt,
        archiveLegalHold: classesTable.archiveLegalHold,
      }).from(classesTable).where(eq(classesTable.id, claim.targetId)).for("update")
      : await tx.select({
        deletionScheduledFor: studentSessionsTable.deletionScheduledFor,
        deletionWarningAttemptedAt: studentSessionsTable.deletionWarningAttemptedAt,
        deletionWarningSentAt: studentSessionsTable.deletionWarningSentAt,
        archiveLegalHold: classesTable.archiveLegalHold,
      }).from(studentSessionsTable)
        .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
        .where(eq(studentSessionsTable.id, claim.targetId)).for("update");
    const blockingControl = claim.targetType === "class"
      ? await findBlockingStudentDataControl(tx, claim.organisationId, "deletion", { classIds: [claim.classId] })
      : await findBlockingStudentDataControl(tx, claim.organisationId, "deletion", {
        studentSessionIds: [claim.targetId],
        classIds: [claim.classId],
      });
    const stillEligible = current
      && current.deletionScheduledFor?.getTime() === claim.deletionScheduledFor.getTime()
      && current.deletionWarningAttemptedAt?.getTime() === claim.warningAttemptedAt.getTime()
      && !current.deletionWarningSentAt
      && !current.archiveLegalHold
      && !policy?.legalHold
      && !blockingControl
      && claim.deletionScheduledFor.getTime() > Date.now();
    if (!stillEligible) {
      const table = claim.targetType === "class" ? classesTable : studentSessionsTable;
      await tx.update(table).set({ deletionWarningAttemptedAt: null }).where(and(
        eq(table.id, claim.targetId),
        eq(table.deletionWarningAttemptedAt, claim.warningAttemptedAt),
        isNull(table.deletionWarningSentAt),
      ));
      await tx.insert(auditLogTable).values({
        organisationId: claim.organisationId,
        action: "deletion.recovery_warning_superseded",
        metadata: {
          targetType: claim.targetType,
          targetId: claim.targetId,
          deletionScheduledFor: claim.deletionScheduledFor.toISOString(),
          warningAttemptedAt: claim.warningAttemptedAt.toISOString(),
          reason: blockingControl ? "active_data_control" : "deadline_or_hold_state_changed",
        },
      });
      return "superseded";
    }

    let status: RecoverableDeletionWarningEmailStatus | "no-recipient" | "ambiguous";
    try {
      status = recipient
        ? await sendRecoverableDeletionWarningEmail({
          targetType: claim.targetType,
          targetId: claim.targetId,
          targetLabel: claim.targetLabel,
          recipientName: recipient.name,
          recipientEmail: recipient.email,
          deletionScheduledFor: claim.deletionScheduledFor,
          warningWindowDays: RECOVERABLE_DELETION_WARNING_DAYS,
        })
        : "no-recipient";
    } catch {
      status = "ambiguous";
    }
    const occurredAt = new Date();
    if (status === "sent") {
      const table = claim.targetType === "class" ? classesTable : studentSessionsTable;
      await tx.update(table).set({ deletionWarningSentAt: occurredAt }).where(and(
        eq(table.id, claim.targetId),
        eq(table.deletionWarningAttemptedAt, claim.warningAttemptedAt),
        isNull(table.deletionWarningSentAt),
      ));
      await tx.insert(auditLogTable).values({
        organisationId: claim.organisationId,
        teacherId: recipient!.id,
        action: "deletion.recovery_warning_sent",
        metadata: {
          targetType: claim.targetType,
          targetId: claim.targetId,
          deletionScheduledFor: claim.deletionScheduledFor.toISOString(),
          warningWindowDays: RECOVERABLE_DELETION_WARNING_DAYS,
          warningSentAt: occurredAt.toISOString(),
          recipientRole: "school_master",
        },
      });
      return "sent";
    }

    if (status !== "ambiguous") {
      const table = claim.targetType === "class" ? classesTable : studentSessionsTable;
      await tx.update(table).set({ deletionWarningAttemptedAt: null }).where(and(
        eq(table.id, claim.targetId),
        eq(table.deletionWarningAttemptedAt, claim.warningAttemptedAt),
        isNull(table.deletionWarningSentAt),
      ));
    }
    await tx.insert(auditLogTable).values({
      organisationId: claim.organisationId,
      teacherId: recipient?.id ?? null,
      action: status === "not-configured" || status === "no-recipient"
        ? "deletion.recovery_warning_unavailable"
        : "deletion.recovery_warning_failed",
      metadata: {
        targetType: claim.targetType,
        targetId: claim.targetId,
        deletionScheduledFor: claim.deletionScheduledFor.toISOString(),
        warningWindowDays: RECOVERABLE_DELETION_WARNING_DAYS,
        warningAttemptedAt: occurredAt.toISOString(),
        recipientRole: "school_master",
        reason: warningFailureReason(status),
      },
    });
    return status === "not-configured" || status === "no-recipient" ? "unavailable" : status;
  });
}

export async function dispatchRecoverableDeletionWarnings(now = new Date()): Promise<{
  warningsSent: number;
  warningsFailed: number;
}> {
  const claims = await claimRecoverableDeletionWarnings(now);
  let warningsSent = 0;
  let warningsFailed = 0;
  for (const claim of claims) {
    const result = await deliverRecoverableDeletionWarning(claim);
    if (result === "sent") warningsSent++;
    if (result === "failed" || result === "unavailable" || result === "ambiguous") warningsFailed++;
  }
  return { warningsSent, warningsFailed };
}

export async function purgeRecoverableDeletions(now = new Date(), organisationId?: number): Promise<{
  classesPurged: number;
  studentRecordsPurged: number;
}> {
  return db.transaction(async (tx) => {
    let classesPurged = 0;
    let studentRecordsPurged = 0;

    const dueClasses = await tx
      .select({
        id: classesTable.id,
        teacherId: classesTable.teacherId,
        organisationId: teachersTable.organisationId,
        legalHold: classesTable.archiveLegalHold,
        deletionRequestedAt: classesTable.deletionRequestedAt,
        deletionScheduledFor: classesTable.deletionScheduledFor,
        deletionRequestedBy: classesTable.deletionRequestedBy,
        deletionReason: classesTable.deletionReason,
      })
      .from(classesTable)
      .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
      .where(and(
        isNotNull(classesTable.deletionScheduledFor),
        lte(classesTable.deletionScheduledFor, now),
        isNotNull(teachersTable.organisationId),
        organisationId ? eq(teachersTable.organisationId, organisationId) : undefined,
      ))
      .for("update");

    for (const cls of dueClasses) {
      if (
        !cls.organisationId
        || !cls.deletionRequestedAt
        || !cls.deletionScheduledFor
        || !["teacher_requested", "departure_requested", "archive_retention_expired"].includes(cls.deletionReason ?? "")
      ) {
        continue;
      }
      await acquireRetentionPolicyMutationLock(tx, cls.organisationId);
      if (cls.deletionReason === "archive_retention_expired") {
        await acquireRetentionPolicyMutationLock(tx, cls.organisationId);
        const [policy] = await tx.select({ legalHold: organisationRetentionDefaultsTable.legalHold })
          .from(organisationRetentionDefaultsTable)
          .where(eq(organisationRetentionDefaultsTable.organisationId, cls.organisationId))
          .for("update");
        if (cls.legalHold || policy?.legalHold) {
          logger.info({ classId: cls.id }, "Skipped recoverable class deletion because a legal hold remains");
          continue;
        }
      }
      const archivedRecords = await tx
        .select({ id: studentSessionsTable.id })
        .from(studentSessionsTable)
        .where(and(
          eq(studentSessionsTable.classId, cls.id),
          isNotNull(studentSessionsTable.archivedAt),
        ))
        .for("update");
      if (archivedRecords.length) {
        logger.warn(
          { classId: cls.id, archivedRecordCount: archivedRecords.length },
          "Skipped recoverable class deletion because protected archives remain",
        );
        continue;
      }
      const childRecords = await tx.select({ id: studentSessionsTable.id })
        .from(studentSessionsTable)
        .where(eq(studentSessionsTable.classId, cls.id))
        .for("update");
      const blockingControl = await findBlockingStudentDataControl(
        tx,
        cls.organisationId,
        "deletion",
        { classIds: [cls.id], studentSessionIds: childRecords.map((record) => record.id) },
      );
      if (blockingControl) {
        logger.info({ classId: cls.id, controlId: blockingControl.id }, "Skipped recoverable class deletion because a request control remains active");
        continue;
      }
      await recordDeletionTombstones(tx, [
        { entityType: "class", entityId: cls.id },
        ...childRecords.map((record) => ({ entityType: "student_record" as const, entityId: record.id })),
      ]);
      const removed = await tx
        .delete(classesTable)
        .where(and(
          eq(classesTable.id, cls.id),
          eq(classesTable.deletionScheduledFor, cls.deletionScheduledFor),
          lte(classesTable.deletionScheduledFor, now),
        ))
        .returning({ id: classesTable.id });
      if (!removed.length) continue;
      await tx.insert(recoverableDeletionEvidenceTable).values({
        organisationId: cls.organisationId,
        targetType: "class",
        targetId: cls.id,
        classId: cls.id,
        deletionRequestedAt: cls.deletionRequestedAt,
        deletionScheduledFor: cls.deletionScheduledFor,
        deletionReason: cls.deletionReason as "teacher_requested" | "departure_requested" | "archive_retention_expired",
        deletedByTeacherId: cls.deletionRequestedBy,
      });
      classesPurged++;
    }

    const dueStudentRecords = await tx
      .select({
        id: studentSessionsTable.id,
        classId: studentSessionsTable.classId,
        organisationId: teachersTable.organisationId,
        classLegalHold: classesTable.archiveLegalHold,
        archivedAt: studentSessionsTable.archivedAt,
        deletionRequestedAt: studentSessionsTable.deletionRequestedAt,
        deletionScheduledFor: studentSessionsTable.deletionScheduledFor,
        deletionRequestedBy: studentSessionsTable.deletionRequestedBy,
        deletionReason: studentSessionsTable.deletionReason,
      })
      .from(studentSessionsTable)
      .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
      .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
      .where(and(
        isNotNull(studentSessionsTable.deletionScheduledFor),
        lte(studentSessionsTable.deletionScheduledFor, now),
        isNull(classesTable.deletionScheduledFor),
        isNotNull(teachersTable.organisationId),
        organisationId ? eq(teachersTable.organisationId, organisationId) : undefined,
      ))
      .for("update");

    for (const record of dueStudentRecords) {
      if (
        !record.organisationId
        || !record.deletionRequestedAt
        || !record.deletionScheduledFor
         || !["teacher_requested", "archive_retention_expired"].includes(record.deletionReason ?? "")
      ) {
        continue;
      }
      await acquireRetentionPolicyMutationLock(tx, record.organisationId);
      if (record.deletionReason === "archive_retention_expired") {
        if (!record.archivedAt) {
          logger.info(
            { studentRecordId: record.id },
            "Skipped inherited student deletion because the parent class left recovery",
          );
          continue;
        }
        await acquireRetentionPolicyMutationLock(tx, record.organisationId);
        const [policy] = await tx.select({ legalHold: organisationRetentionDefaultsTable.legalHold })
          .from(organisationRetentionDefaultsTable)
          .where(eq(organisationRetentionDefaultsTable.organisationId, record.organisationId))
          .for("update");
        if (record.classLegalHold || policy?.legalHold) {
          logger.info({ studentRecordId: record.id }, "Skipped recoverable student deletion because a legal hold remains");
          continue;
        }
      }
      const blockingControl = await findBlockingStudentDataControl(
        tx,
        record.organisationId,
        "deletion",
        { classIds: [record.classId], studentSessionIds: [record.id] },
      );
      if (blockingControl) {
        logger.info({ studentRecordId: record.id, controlId: blockingControl.id }, "Skipped recoverable student deletion because a request control remains active");
        continue;
      }
      const removed = await tx
        .delete(studentSessionsTable)
        .where(and(
          eq(studentSessionsTable.id, record.id),
          eq(studentSessionsTable.deletionScheduledFor, record.deletionScheduledFor),
          lte(studentSessionsTable.deletionScheduledFor, now),
        ))
        .returning({ id: studentSessionsTable.id });
      if (!removed.length) continue;
      await recordDeletionTombstones(tx, [{ entityType: "student_record", entityId: record.id }]);
      await tx.insert(recoverableDeletionEvidenceTable).values({
        organisationId: record.organisationId,
        targetType: "student_record",
        targetId: record.id,
        classId: record.classId,
        deletionRequestedAt: record.deletionRequestedAt,
        deletionScheduledFor: record.deletionScheduledFor,
        deletionReason: record.deletionReason as "teacher_requested" | "archive_retention_expired",
        deletedByTeacherId: record.deletionRequestedBy,
      });
      studentRecordsPurged++;
    }

    return { classesPurged, studentRecordsPurged };
  });
}

let purgeRunning = false;

async function purgeSafely(): Promise<void> {
  if (purgeRunning) return;
  if (await getRestorationAdmissionState() !== "ready") return;
  purgeRunning = true;
  try {
    const warningResult = await dispatchRecoverableDeletionWarnings();
    const result = await purgeRecoverableDeletions();
    if (result.classesPurged || result.studentRecordsPurged || warningResult.warningsSent || warningResult.warningsFailed) {
      logger.info({ ...result, ...warningResult }, "Recoverable teacher deletion lifecycle processed");
    }
  } catch (error) {
    logger.error({ err: error }, "Recoverable teacher deletion purge failed");
  } finally {
    purgeRunning = false;
  }
}

export function startRecoverableDeletionPurge(): void {
  void purgeSafely();
  const interval = setInterval(() => void purgeSafely(), RECOVERABLE_DELETION_INTERVAL_MS);
  interval.unref();
}
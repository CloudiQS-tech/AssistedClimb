import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import {
  auditLogTable,
  classesTable,
  chatMessagesTable,
  db,
  organisationRetentionDefaultsTable,
  organisationRetentionPoliciesTable,
  organisationsTable,
  stageEntriesTable,
  studentActivitySessionsTable,
  studentRecordDeletionEvidenceTable,
  studentSessionsTable,
  teacherFeedbackTable,
  teacherPasswordHistoryTable,
  teacherRecoveryCodesTable,
  teachersTable,
} from "@workspace/db";
import { logger } from "./logger";
import { recordDeletionTombstones, type DeletionTombstone } from "./deletion-ledger";
import { getRestorationAdmissionState } from "./restoration-quarantine";
import { filterStudentSessionsAllowedForDeletion } from "./student-data-request-controls";

export const RETENTION_CATEGORIES = [
  "student_learning_records",
  "ai_conversations",
  "student_activity",
  "completed_climbs",
  "teacher_account_records",
  "security_audit_logs",
] as const;
export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number];
export const RETENTION_ENFORCEMENT_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const RETENTION_POLICY_MUTATION_LOCK_NAMESPACE = 8452102;
export const DEFAULT_STUDENT_RECORD_RETENTION_DAYS = 30;
export const DEFAULT_TEACHER_RECORD_RETENTION_DAYS = 365;
type RetentionDb = Pick<typeof db, "delete" | "execute" | "insert" | "select" | "update">;

export const retentionCategoryLabels: Record<RetentionCategory, string> = {
  student_learning_records: "Student learning records",
  ai_conversations: "AI conversations",
  student_activity: "Student activity",
  completed_climbs: "Completed climbs",
  teacher_account_records: "Teacher account records",
  security_audit_logs: "Security audit logs",
};

type RetentionPolicy = {
  retentionDays: number;
  deletionStatus: string;
  legalHold: boolean;
  operatorVerifiedAt: Date | null;
};

export type RetentionBlockReason =
  | "policy_not_scheduled"
  | "legal_hold"
  | "missing_operator_verification";

export function getRetentionBlockReason(policy: RetentionPolicy): RetentionBlockReason | null {
  if (policy.deletionStatus !== "scheduled") return "policy_not_scheduled";
  if (policy.legalHold) return "legal_hold";
  if (!policy.operatorVerifiedAt) return "missing_operator_verification";
  return null;
}

export async function acquireRetentionPolicyMutationLock(
  tx: Pick<typeof db, "execute">,
  organisationId: number,
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${RETENTION_POLICY_MUTATION_LOCK_NAMESPACE}, ${organisationId})`);
}

function cutoffFor(policy: RetentionPolicy, now: Date): Date {
  return new Date(now.getTime() - policy.retentionDays * 24 * 60 * 60 * 1000);
}

async function deleteRowsByIds(
  tx: RetentionDb,
  table: any,
  ids: number[],
  entityType: DeletionTombstone["entityType"],
): Promise<number> {
  if (ids.length === 0) return 0;
  await recordDeletionTombstones(tx, ids.map((entityId) => ({ entityType, entityId })));
  const result = await tx.delete(table).where(inArray(table.id, ids)).returning({ id: table.id });
  return result.length;
}

async function deleteStudentLearningRecords(tx: RetentionDb, organisationId: number, cutoff: Date): Promise<number> {
  const stageRows = await tx
    .select({ id: stageEntriesTable.id, sessionId: studentSessionsTable.id, classId: studentSessionsTable.classId })
    .from(stageEntriesTable)
    .innerJoin(studentSessionsTable, eq(stageEntriesTable.sessionId, studentSessionsTable.id))
    .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
    .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
    .where(and(
      eq(teachersTable.organisationId, organisationId),
      isNull(studentSessionsTable.archivedAt),
      lte(stageEntriesTable.updatedAt, cutoff),
    ));
  const feedbackRows = await tx
    .select({ id: teacherFeedbackTable.id, sessionId: studentSessionsTable.id, classId: studentSessionsTable.classId })
    .from(teacherFeedbackTable)
    .innerJoin(studentSessionsTable, eq(teacherFeedbackTable.sessionId, studentSessionsTable.id))
    .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
    .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
    .where(and(
      eq(teachersTable.organisationId, organisationId),
      isNull(studentSessionsTable.archivedAt),
      lte(teacherFeedbackTable.updatedAt, cutoff),
    ));
  const allowed = await filterStudentSessionsAllowedForDeletion(
    tx,
    organisationId,
    [...stageRows, ...feedbackRows].map((row) => ({ id: row.sessionId, classId: row.classId })),
    ["learning", "feedback"],
  );
  const allowedIds = new Set(allowed.map((row) => row.id));
  return await deleteRowsByIds(tx, stageEntriesTable, stageRows.filter((row) => allowedIds.has(row.sessionId)).map((row) => row.id), "stage_entry")
    + await deleteRowsByIds(tx, teacherFeedbackTable, feedbackRows.filter((row) => allowedIds.has(row.sessionId)).map((row) => row.id), "teacher_feedback");
}

async function deleteAiConversations(tx: RetentionDb, organisationId: number, cutoff: Date): Promise<number> {
  const rows = await tx
    .select({ id: chatMessagesTable.id, sessionId: studentSessionsTable.id, classId: studentSessionsTable.classId })
    .from(chatMessagesTable)
    .innerJoin(studentSessionsTable, eq(chatMessagesTable.sessionId, studentSessionsTable.id))
    .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
    .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
    .where(and(
      eq(teachersTable.organisationId, organisationId),
      isNull(studentSessionsTable.archivedAt),
      lte(chatMessagesTable.createdAt, cutoff),
    ));
  const allowed = await filterStudentSessionsAllowedForDeletion(
    tx,
    organisationId,
    rows.map((row) => ({ id: row.sessionId, classId: row.classId })),
    ["ai_conversations"],
  );
  const allowedIds = new Set(allowed.map((row) => row.id));
  return deleteRowsByIds(tx, chatMessagesTable, rows.filter((row) => allowedIds.has(row.sessionId)).map((row) => row.id), "chat_message");
}

async function deleteStudentActivity(tx: RetentionDb, organisationId: number, cutoff: Date): Promise<number> {
  const rows = await tx
    .select({ id: studentActivitySessionsTable.id, sessionId: studentSessionsTable.id, classId: studentSessionsTable.classId })
    .from(studentActivitySessionsTable)
    .innerJoin(studentSessionsTable, eq(studentActivitySessionsTable.studentSessionId, studentSessionsTable.id))
    .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
    .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
    .where(and(
      eq(teachersTable.organisationId, organisationId),
      isNull(studentSessionsTable.archivedAt),
      lte(studentActivitySessionsTable.lastSeenAt, cutoff),
    ));
  const allowed = await filterStudentSessionsAllowedForDeletion(
    tx,
    organisationId,
    rows.map((row) => ({ id: row.sessionId, classId: row.classId })),
    ["activity"],
  );
  const allowedIds = new Set(allowed.map((row) => row.id));
  return deleteRowsByIds(tx, studentActivitySessionsTable, rows.filter((row) => allowedIds.has(row.sessionId)).map((row) => row.id), "student_activity");
}

async function anonymiseCompletedClimbs(tx: RetentionDb, organisationId: number, cutoff: Date): Promise<number> {
  const rows = await tx
    .select({ id: studentSessionsTable.id, classId: studentSessionsTable.classId })
    .from(studentSessionsTable)
    .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
    .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
    .where(and(
      eq(teachersTable.organisationId, organisationId),
      isNotNull(studentSessionsTable.lockedAt),
      isNull(studentSessionsTable.archivedAt),
      lte(studentSessionsTable.createdAt, cutoff),
    ));
  const allowedRows = await filterStudentSessionsAllowedForDeletion(tx, organisationId, rows, ["identity", "learning"]);
  if (allowedRows.length === 0) return 0;
  await recordDeletionTombstones(tx, allowedRows.map((row) => ({ entityType: "student_identity", entityId: row.id })));
  const result = await tx
    .update(studentSessionsTable)
    .set({
      studentName: "Archived student",
      pinHash: null,
      sessionNonce: null,
    })
    .where(inArray(studentSessionsTable.id, allowedRows.map((row) => row.id)))
    .returning({ id: studentSessionsTable.id });
  return result.length;
}

async function anonymiseTeacherAccounts(tx: RetentionDb, organisationId: number, cutoff: Date): Promise<number> {
  const rows = await tx
    .select({ id: teachersTable.id })
    .from(teachersTable)
    .where(and(
      eq(teachersTable.organisationId, organisationId),
      eq(teachersTable.accountStatus, "deleted"),
      lte(teachersTable.createdAt, cutoff),
    ));
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return 0;
  await recordDeletionTombstones(tx, ids.map((entityId) => ({ entityType: "teacher_identity", entityId })));
  await tx.delete(teacherPasswordHistoryTable).where(inArray(teacherPasswordHistoryTable.teacherId, ids));
  await tx.delete(teacherRecoveryCodesTable).where(inArray(teacherRecoveryCodesTable.teacherId, ids));
  const result = await tx
    .update(teachersTable)
    .set({
      email: sql`'deleted-teacher-' || ${teachersTable.id} || '@retained.invalid'`,
      name: "Deleted teacher",
      passwordHash: "retention-anonymised",
      isItAdmin: false,
      schoolAdminRole: null,
      loginToken: null,
      mustChangePassword: false,
      failedLoginAttempts: 0,
      lockedUntil: null,
      totpSecret: null,
      totpEnabled: false,
      totpSetupTokenHash: null,
      totpSetupTokenExpiresAt: null,
      pendingTotpLoginTokenHash: null,
      pendingTotpLoginTokenExpiresAt: null,
      postMfaSessionTicketHash: null,
      postMfaSessionTicketExpiresAt: null,
      passwordResetToken: null,
      passwordResetExpiresAt: null,
      emailVerificationTokenHash: null,
      emailVerificationExpiresAt: null,
      recoveryFailedAttempts: 0,
      recoveryLockedUntil: null,
    })
    .where(inArray(teachersTable.id, ids))
    .returning({ id: teachersTable.id });
  return result.length;
}

async function deleteSecurityAuditLogs(tx: RetentionDb, organisationId: number, cutoff: Date): Promise<number> {
  const rows = await tx.select({ id: auditLogTable.id }).from(auditLogTable)
    .where(and(eq(auditLogTable.organisationId, organisationId), lte(auditLogTable.createdAt, cutoff)));
  await recordDeletionTombstones(tx, rows.map((row) => ({ entityType: "security_audit", entityId: row.id })));
  const result = await tx
    .delete(auditLogTable)
    .where(and(eq(auditLogTable.organisationId, organisationId), lte(auditLogTable.createdAt, cutoff)))
    .returning({ id: auditLogTable.id });
  return result.length;
}

async function processCategory(
  tx: RetentionDb,
  organisationId: number,
  category: RetentionCategory,
  policy: RetentionPolicy,
  now: Date,
): Promise<{ recordsAffected: number; outcome: "deleted" | "anonymised" | "blocked"; reason?: RetentionBlockReason }> {
  const reason = getRetentionBlockReason(policy);
  if (reason) return { recordsAffected: 0, outcome: "blocked", reason };
  const cutoff = cutoffFor(policy, now);
  let recordsAffected = 0;
  let outcome: "deleted" | "anonymised" = "deleted";
  switch (category) {
    case "student_learning_records":
      recordsAffected = await deleteStudentLearningRecords(tx, organisationId, cutoff);
      break;
    case "ai_conversations":
      recordsAffected = await deleteAiConversations(tx, organisationId, cutoff);
      break;
    case "student_activity":
      recordsAffected = await deleteStudentActivity(tx, organisationId, cutoff);
      break;
    case "completed_climbs":
      recordsAffected = await anonymiseCompletedClimbs(tx, organisationId, cutoff);
      outcome = "anonymised";
      break;
    case "teacher_account_records":
      recordsAffected = await anonymiseTeacherAccounts(tx, organisationId, cutoff);
      outcome = "anonymised";
      break;
    case "security_audit_logs":
      recordsAffected = await deleteSecurityAuditLogs(tx, organisationId, cutoff);
      break;
  }
  return { recordsAffected, outcome };
}

async function purgeArchivedStudentRecords(
  tx: RetentionDb,
  organisationId: number,
  policy: RetentionPolicy,
  now: Date,
): Promise<{ recordsAffected: number; outcome: "deleted" | "blocked"; reason?: RetentionBlockReason }> {
  const reason = getRetentionBlockReason(policy);
  if (reason) return { recordsAffected: 0, outcome: "blocked", reason };

  const archived = await tx
    .select({
      id: studentSessionsTable.id,
      classId: studentSessionsTable.classId,
      archivedAt: studentSessionsTable.archivedAt,
      retentionUntil: studentSessionsTable.retentionUntil,
    })
    .from(studentSessionsTable)
    .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
    .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
    .where(and(
      eq(teachersTable.organisationId, organisationId),
      isNotNull(studentSessionsTable.archivedAt),
      isNotNull(studentSessionsTable.retentionUntil),
      lte(studentSessionsTable.retentionUntil, now),
    ))
    .for("update");

  let recordsAffected = 0;
  const allowedArchived = await filterStudentSessionsAllowedForDeletion(
    tx,
    organisationId,
    archived.map((row) => ({ id: row.id, classId: row.classId })),
  );
  const allowedArchivedIds = new Set(allowedArchived.map((row) => row.id));
  for (const record of archived) {
    if (!allowedArchivedIds.has(record.id)) continue;
    if (!record.archivedAt || !record.retentionUntil) continue;
    // Evidence and cascading application deletion are committed together.
    // The evidence intentionally says nothing about backups or providers.
    await tx.insert(studentRecordDeletionEvidenceTable).values({
      organisationId,
      deletedStudentSessionId: record.id,
      classId: record.classId,
      archivedAt: record.archivedAt,
      retentionUntil: record.retentionUntil,
      deletionReason: "retention_expired",
    });
    await tx.insert(auditLogTable).values({
      organisationId,
      action: "student_record_purged_after_retention",
      metadata: {
        studentSessionId: record.id,
        classId: record.classId,
        retentionUntil: record.retentionUntil.toISOString(),
      },
    });
    await recordDeletionTombstones(tx, [{ entityType: "student_record", entityId: record.id }]);
    const removed = await tx.delete(studentSessionsTable)
      .where(and(
        eq(studentSessionsTable.id, record.id),
        isNotNull(studentSessionsTable.archivedAt),
        lte(studentSessionsTable.retentionUntil, now),
      ))
      .returning({ id: studentSessionsTable.id });
    if (removed.length) recordsAffected++;
  }
  return { recordsAffected, outcome: "deleted" };
}

async function writeRetentionEvidence(
  tx: RetentionDb,
  organisationId: number,
  category: RetentionCategory,
  policy: RetentionPolicy,
  now: Date,
  result: Awaited<ReturnType<typeof processCategory>>,
): Promise<void> {
  await tx.insert(auditLogTable).values({
    organisationId,
    action: result.outcome === "blocked"
      ? "organisation.retention_enforcement_blocked"
      : "organisation.retention_records_processed",
    metadata: {
      dataCategory: category,
      categoryLabel: retentionCategoryLabels[category],
      policyScope: "effective_policy",
      retentionDays: policy.retentionDays,
      recordsAffected: result.recordsAffected,
      outcome: result.outcome,
      blockedReason: result.reason ?? null,
      processedAt: now.toISOString(),
    },
  });
}

export async function enforceRetentionForOrganisation(organisationId: number, now = new Date()): Promise<{
  organisationId: number;
  processed: Array<{ dataCategory: RetentionCategory; recordsAffected: number; outcome: string; reason?: string }>;
} | null> {
  return db.transaction(async (tx) => {
    await acquireRetentionPolicyMutationLock(tx, organisationId);
    const [organisation] = await tx
      .select({ id: organisationsTable.id })
      .from(organisationsTable)
      .where(and(eq(organisationsTable.id, organisationId), isNull(organisationsTable.deletedAt)))
      .for("update");
    if (!organisation) return null;

    const [defaultPolicy] = await tx
      .select()
      .from(organisationRetentionDefaultsTable)
      .where(eq(organisationRetentionDefaultsTable.organisationId, organisationId));
    if (!defaultPolicy) return { organisationId, processed: [] };
    const exceptions = await tx
      .select()
      .from(organisationRetentionPoliciesTable)
      .where(eq(organisationRetentionPoliciesTable.organisationId, organisationId))
      .orderBy(asc(organisationRetentionPoliciesTable.dataCategory));
    const exceptionByCategory = new Map(exceptions.map((policy) => [policy.dataCategory, policy]));
    const processed: Array<{ dataCategory: RetentionCategory; recordsAffected: number; outcome: string; reason?: string }> = [];
    for (const category of RETENTION_CATEGORIES) {
      const policy = exceptionByCategory.get(category) ?? defaultPolicy;
      const result = await processCategory(tx, organisationId, category, policy, now);
      await writeRetentionEvidence(tx, organisationId, category, policy, now, result);
      processed.push({
        dataCategory: category,
        recordsAffected: result.recordsAffected,
        outcome: result.outcome,
        ...(result.reason ? { reason: result.reason } : {}),
      });
    }
    const studentPolicy = exceptionByCategory.get("student_learning_records") ?? defaultPolicy ?? {
      retentionDays: DEFAULT_STUDENT_RECORD_RETENTION_DAYS,
      deletionStatus: "retained",
      legalHold: false,
      operatorVerifiedAt: null,
    };
    const archivedStudentResult = await purgeArchivedStudentRecords(tx, organisationId, studentPolicy, now);
    await writeRetentionEvidence(tx, organisationId, "student_learning_records", studentPolicy, now, {
      ...archivedStudentResult,
      // Keep the scheduled archive lifecycle distinguishable from the
      // category's ordinary age-based processing in the audit metadata.
    });
    processed.push({
      dataCategory: "student_learning_records",
      recordsAffected: archivedStudentResult.recordsAffected,
      outcome: archivedStudentResult.outcome,
      ...(archivedStudentResult.reason ? { reason: archivedStudentResult.reason } : {}),
    });
    return { organisationId, processed };
  });
}

export async function enforceRetentionForAllOrganisations(): Promise<number> {
  const organisations = await db.execute(sql`
    SELECT id FROM organisations
    WHERE deleted_at IS NULL
    ORDER BY id
  `);
  let processed = 0;
  for (const row of organisations.rows as Array<{ id: number }>) {
    try {
      if (await enforceRetentionForOrganisation(Number(row.id))) processed++;
    } catch (error) {
      logger.error({ err: error, organisationId: row.id }, "Unable to enforce school retention policy");
    }
  }
  return processed;
}

let enforcementRunning = false;

async function runRetentionSafely(): Promise<void> {
  if (enforcementRunning) return;
  if (await getRestorationAdmissionState() !== "ready") return;
  enforcementRunning = true;
  try {
    const processed = await enforceRetentionForAllOrganisations();
    if (processed > 0) logger.info({ processed }, "School retention enforcement completed");
  } catch (error) {
    logger.error({ err: error }, "School retention enforcement failed");
  } finally {
    enforcementRunning = false;
  }
}

export function startOrganisationRetentionEnforcement(): void {
  void runRetentionSafely();
  const interval = setInterval(() => void runRetentionSafely(), RETENTION_ENFORCEMENT_INTERVAL_MS);
  interval.unref();
}
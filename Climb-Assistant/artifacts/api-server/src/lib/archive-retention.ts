import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  auditLogTable,
  classesTable,
  db,
  organisationRetentionDefaultsTable,
  platformSettingsTable,
  studentSessionsTable,
  teachersTable,
} from "@workspace/db";
import { logger } from "./logger";
import { getArchiveExpiryWarningMessageId, sendArchiveExpiryWarningEmail } from "./platform-email";
import { getRestorationAdmissionState } from "./restoration-quarantine";

export const RETENTION_DAY_OPTIONS = [30, 60, 90, 180, 365] as const;
export const MAX_PLATFORM_RETENTION_DAYS = 36_500;
export const ARCHIVE_EXPIRY_WARNING_DAYS = 7;
export const ARCHIVE_WARNING_REVIEW_THRESHOLD_HOURS = 24;
export const ARCHIVE_WARNING_REVIEW_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const INTERVAL_MS = 24 * 60 * 60 * 1000;

interface ArchiveExpiryWarningClaim {
  classId: number;
  organisationId: number;
  archiveExpiresAt: Date;
  warningAttemptedAt: Date;
}

export interface ArchiveRetentionDependencies {
  sendWarningEmail?: typeof sendArchiveExpiryWarningEmail;
  beforeWarningDispatch?: (claim: Readonly<ArchiveExpiryWarningClaim>) => Promise<void>;
  organisationIdScope?: number[];
}

function redactedSchoolText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120)
    : "";
}

export async function getArchiveWarningDeliveryReview(now = new Date()) {
  const thresholdAt = new Date(now.getTime() - ARCHIVE_WARNING_REVIEW_THRESHOLD_HOURS * HOUR_MS);
  const result = await db.execute(sql`
    SELECT
      c.id AS "classId",
      c.archive_expiry_warning_attempted_at AS "attemptedAt",
      c.archive_expires_at AS "archiveExpiresAt",
      organisation.name AS "organisationName",
      organisation.slug AS "organisationSlug"
    FROM classes c
    INNER JOIN teachers owner ON owner.id = c.teacher_id
    INNER JOIN organisations organisation ON organisation.id = owner.organisation_id
    WHERE c.archive_expires_at IS NOT NULL
      AND c.archive_expiry_warning_attempted_at IS NOT NULL
      AND c.archive_expiry_warning_attempted_at <= ${thresholdAt}
      AND c.archive_expiry_warning_sent_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM audit_log final_outcome
        WHERE final_outcome.organisation_id = organisation.id
          AND final_outcome.action IN (
            'archive.expiry_warning_sent',
            'archive.expiry_warning_failed',
            'archive.expiry_warning_superseded'
          )
          AND final_outcome.metadata->>'targetType' = 'class'
          AND final_outcome.metadata->>'targetId' = c.id::text
          AND final_outcome.created_at >= c.archive_expiry_warning_attempted_at
      )
    ORDER BY c.archive_expiry_warning_attempted_at ASC
    LIMIT ${ARCHIVE_WARNING_REVIEW_LIMIT + 1}
  `);

  const rows = (result.rows as Array<Record<string, unknown>>).slice(0, ARCHIVE_WARNING_REVIEW_LIMIT);
  const items = rows.map((row) => {
    const classId = Number(row.classId);
    const attemptedAt = new Date(row.attemptedAt as string | Date);
    const archiveExpiresAt = new Date(row.archiveExpiresAt as string | Date);
    return {
      id: `archive-warning-${classId}-${attemptedAt.getTime()}`,
      school: {
        name: redactedSchoolText(row.organisationName),
        slug: redactedSchoolText(row.organisationSlug) || null,
      },
      attemptedAt: attemptedAt.toISOString(),
      archiveExpiresAt: archiveExpiresAt.toISOString(),
      ageHours: Math.floor(Math.max(0, now.getTime() - attemptedAt.getTime()) / HOUR_MS),
      providerMessageId: getArchiveExpiryWarningMessageId(classId, archiveExpiresAt),
    };
  });

  return {
    generatedAt: now.toISOString(),
    thresholdHours: ARCHIVE_WARNING_REVIEW_THRESHOLD_HOURS,
    thresholdAt: thresholdAt.toISOString(),
    items,
    truncated: result.rows.length > ARCHIVE_WARNING_REVIEW_LIMIT,
    privacy: "Only school identity, delivery timestamps, and the deterministic provider Message-ID are returned. Student names, class names, learning content, recipient details, credentials, and raw audit metadata are excluded.",
    guidance: [
      "Check the SMTP provider delivery or event log for the deterministic Message-ID shown for each attempt.",
      "Only manually retry after the provider confirms that it did not accept the message.",
      "If the provider accepted the message, do not retry: the claim remains retained to prevent a duplicate compliance notice.",
    ],
  };
}

function warningFailureReason(status: "not-configured" | "failed" | "no-recipient") {
  if (status === "not-configured") return "email_not_configured";
  if (status === "no-recipient") return "no_active_school_master";
  return "delivery_failed";
}

async function deliverArchiveExpiryWarning(
  claim: ArchiveExpiryWarningClaim,
  sendWarningEmail: typeof sendArchiveExpiryWarningEmail,
) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select({
      id: classesTable.id,
      name: classesTable.name,
      organisationId: teachersTable.organisationId,
      archivedAt: classesTable.archivedAt,
      archiveExpiresAt: classesTable.archiveExpiresAt,
      archiveLifecycleStatus: classesTable.archiveLifecycleStatus,
      archiveLegalHold: classesTable.archiveLegalHold,
      archiveExpiryWarningAttemptedAt: classesTable.archiveExpiryWarningAttemptedAt,
      archiveExpiryWarningSentAt: classesTable.archiveExpiryWarningSentAt,
      deletionScheduledFor: classesTable.deletionScheduledFor,
    }).from(classesTable)
      .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
      .where(eq(classesTable.id, claim.classId))
      .for("update");
    const [policy] = await tx.select({
      legalHold: organisationRetentionDefaultsTable.legalHold,
    }).from(organisationRetentionDefaultsTable)
      .where(eq(organisationRetentionDefaultsTable.organisationId, claim.organisationId))
      .for("update");

    const stillEligible = current
      && current.organisationId === claim.organisationId
      && current.archivedAt
      && current.archiveExpiresAt?.getTime() === claim.archiveExpiresAt.getTime()
      && current.archiveLifecycleStatus === "archived"
      && !current.archiveLegalHold
      && !policy?.legalHold
      && !current.deletionScheduledFor
      && !current.archiveExpiryWarningSentAt
      && current.archiveExpiryWarningAttemptedAt?.getTime() === claim.warningAttemptedAt.getTime();
    if (!stillEligible) {
      await tx.update(classesTable).set({
        archiveExpiryWarningAttemptedAt: null,
      }).where(and(
        eq(classesTable.id, claim.classId),
        eq(classesTable.archiveExpiryWarningAttemptedAt, claim.warningAttemptedAt),
        isNull(classesTable.archiveExpiryWarningSentAt),
      ));
      await tx.insert(auditLogTable).values({
        organisationId: claim.organisationId,
        action: "archive.expiry_warning_superseded",
        metadata: {
          targetType: "class",
          targetId: claim.classId,
          archiveExpiresAt: claim.archiveExpiresAt.toISOString(),
          warningAttemptedAt: claim.warningAttemptedAt.toISOString(),
          reason: "archive_or_hold_state_changed",
        },
      });
      return "superseded" as const;
    }

    const [recipient] = await tx.select({
      id: teachersTable.id,
      name: teachersTable.name,
      email: teachersTable.email,
    }).from(teachersTable).where(and(
      eq(teachersTable.organisationId, claim.organisationId),
      eq(teachersTable.schoolAdminRole, "master"),
      eq(teachersTable.accountStatus, "active"),
    )).for("update");
    const status = recipient
      ? await sendWarningEmail({
          classId: claim.classId,
          className: current.name,
          recipientName: recipient.name,
          recipientEmail: recipient.email,
          archiveExpiresAt: claim.archiveExpiresAt,
          warningWindowDays: ARCHIVE_EXPIRY_WARNING_DAYS,
        })
      : "no-recipient";
    const occurredAt = new Date();

    if (status === "sent") {
      await tx.update(classesTable).set({
        archiveExpiryWarningSentAt: occurredAt,
      }).where(and(
        eq(classesTable.id, claim.classId),
        eq(classesTable.archiveExpiryWarningAttemptedAt, claim.warningAttemptedAt),
        isNull(classesTable.archiveExpiryWarningSentAt),
      ));
      await tx.insert(auditLogTable).values({
        organisationId: claim.organisationId,
        teacherId: recipient!.id,
        action: "archive.expiry_warning_sent",
        metadata: {
          targetType: "class",
          targetId: claim.classId,
          archiveExpiresAt: claim.archiveExpiresAt.toISOString(),
          warningWindowDays: ARCHIVE_EXPIRY_WARNING_DAYS,
          warningSentAt: occurredAt.toISOString(),
          recipientRole: "school_master",
        },
      });
      return "sent" as const;
    }

    await tx.update(classesTable).set({
      archiveExpiryWarningAttemptedAt: null,
    }).where(and(
      eq(classesTable.id, claim.classId),
      eq(classesTable.archiveExpiryWarningAttemptedAt, claim.warningAttemptedAt),
      isNull(classesTable.archiveExpiryWarningSentAt),
    ));
    await tx.insert(auditLogTable).values({
      organisationId: claim.organisationId,
      teacherId: recipient?.id ?? null,
      action: "archive.expiry_warning_failed",
      metadata: {
        targetType: "class",
        targetId: claim.classId,
        archiveExpiresAt: claim.archiveExpiresAt.toISOString(),
        warningWindowDays: ARCHIVE_EXPIRY_WARNING_DAYS,
        warningAttemptedAt: occurredAt.toISOString(),
        recipientRole: "school_master",
        reason: warningFailureReason(status),
      },
    });
    return "failed" as const;
  });
}

async function deliverArchiveExpiryWarnings(
  claims: ArchiveExpiryWarningClaim[],
  dependencies: ArchiveRetentionDependencies,
) {
  let warningsSent = 0;
  let warningsFailed = 0;
  for (const claim of claims) {
    await dependencies.beforeWarningDispatch?.(claim);
    const result = await deliverArchiveExpiryWarning(
      claim,
      dependencies.sendWarningEmail ?? sendArchiveExpiryWarningEmail,
    );
    if (result === "sent") warningsSent++;
    else if (result === "failed") warningsFailed++;
  }
  return { warningsSent, warningsFailed };
}

async function platformDays(
  key: "archive_retention_days" | "deletion_recovery_days",
  fallback: number,
  presetOnly = false,
): Promise<number> {
  const [setting] = await db.select({ value: platformSettingsTable.value })
    .from(platformSettingsTable).where(eq(platformSettingsTable.key, key));
  const value = Number(setting?.value);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PLATFORM_RETENTION_DAYS) return fallback;
  if (presetOnly && !RETENTION_DAY_OPTIONS.includes(value as typeof RETENTION_DAY_OPTIONS[number])) return fallback;
  return value;
}

export async function getPlatformRetentionDefaults() {
  const [archiveSetting, deletionRecoveryDays, minSetting, maxSetting, choicesSetting] = await Promise.all([
    db.select({ value: platformSettingsTable.value }).from(platformSettingsTable)
      .where(eq(platformSettingsTable.key, "archive_retention_days")),
    platformDays("deletion_recovery_days", 30, true),
    db.select({ value: platformSettingsTable.value }).from(platformSettingsTable).where(eq(platformSettingsTable.key, "archive_retention_min_days")),
    db.select({ value: platformSettingsTable.value }).from(platformSettingsTable).where(eq(platformSettingsTable.key, "archive_retention_max_days")),
    db.select({ value: platformSettingsTable.value }).from(platformSettingsTable).where(eq(platformSettingsTable.key, "archive_retention_choices")),
  ]);
  const minimumDays = Math.min(
    MAX_PLATFORM_RETENTION_DAYS,
    Math.max(1, Number(minSetting[0]?.value) || 1),
  );
  const maximumDays = Math.min(
    MAX_PLATFORM_RETENTION_DAYS,
    Math.max(minimumDays, Number(maxSetting[0]?.value) || 3650),
  );
  const configuredArchiveDays = Number(archiveSetting[0]?.value);
  const archiveRetentionDays = Math.min(
    maximumDays,
    Math.max(minimumDays, Number.isInteger(configuredArchiveDays) ? configuredArchiveDays : 30),
  );
  let standardChoices: number[] = [...RETENTION_DAY_OPTIONS];
  try {
    const parsed = JSON.parse(choicesSetting[0]?.value ?? "[]");
    if (Array.isArray(parsed)) standardChoices = [...new Set(parsed.map(Number))]
      .filter((value) => Number.isInteger(value) && value >= minimumDays && value <= maximumDays)
      .sort((a, b) => a - b);
  } catch {}
  return { archiveRetentionDays, deletionRecoveryDays, minimumDays, maximumDays, standardChoices };
}

export async function getOrganisationLifecycleDays(organisationId: number) {
  const [policy] = await db.select({
    archiveRetentionDays: organisationRetentionDefaultsTable.archiveRetentionDays,
    deletionRecoveryDays: organisationRetentionDefaultsTable.deletionRecoveryDays,
  }).from(organisationRetentionDefaultsTable)
    .where(eq(organisationRetentionDefaultsTable.organisationId, organisationId));
  const defaults = await getPlatformRetentionDefaults();
  return {
    archiveRetentionDays: policy?.archiveRetentionDays ?? defaults.archiveRetentionDays,
    deletionRecoveryDays: policy?.deletionRecoveryDays ?? defaults.deletionRecoveryDays,
  };
}

type ArchiveRetentionResult = {
  classesScheduled: number;
  studentRecordsScheduled: number;
};

type ArchiveRetentionWorkerResult = ArchiveRetentionResult & {
  warningsSent: number;
  warningsFailed: number;
};

export function processArchiveRetention(now: Date, organisationId: number): Promise<ArchiveRetentionResult>;
export function processArchiveRetention(
  now?: Date,
  dependencies?: ArchiveRetentionDependencies,
): Promise<ArchiveRetentionWorkerResult>;
export async function processArchiveRetention(
  now = new Date(),
  dependenciesOrOrganisationId: ArchiveRetentionDependencies | number = {},
): Promise<ArchiveRetentionResult | ArchiveRetentionWorkerResult> {
  const organisationScopedCall = typeof dependenciesOrOrganisationId === "number";
  const dependencies: ArchiveRetentionDependencies = organisationScopedCall
    ? { organisationIdScope: [dependenciesOrOrganisationId] }
    : dependenciesOrOrganisationId;
  const defaults = await getPlatformRetentionDefaults();
  const lifecycleResult = await db.transaction(async (tx) => {
    const policies = await tx.select().from(organisationRetentionDefaultsTable);
    const policyByOrg = new Map(policies.map((policy) => [policy.organisationId, policy]));
    const warningClaims: ArchiveExpiryWarningClaim[] = [];
    let classesScheduled = 0;
    let studentRecordsScheduled = 0;

    const archivedClasses = await tx.select({
      id: classesTable.id,
      organisationId: teachersTable.organisationId,
      archivedAt: classesTable.archivedAt,
      archiveExpiresAt: classesTable.archiveExpiresAt,
      legalHold: classesTable.archiveLegalHold,
      archiveExpiryWarningAttemptedAt: classesTable.archiveExpiryWarningAttemptedAt,
      archiveExpiryWarningSentAt: classesTable.archiveExpiryWarningSentAt,
    }).from(classesTable).innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
      .where(and(
        isNotNull(classesTable.archivedAt),
        isNull(classesTable.deletionScheduledFor),
        dependencies.organisationIdScope?.length
          ? inArray(teachersTable.organisationId, dependencies.organisationIdScope)
          : undefined,
      ))
      .for("update");

    for (const cls of archivedClasses) {
      if (!cls.organisationId || !cls.archivedAt) continue;
      const policy = policyByOrg.get(cls.organisationId);
      const expiry = cls.archiveExpiresAt
        ?? new Date(cls.archivedAt.getTime() + (policy?.archiveRetentionDays ?? defaults.archiveRetentionDays) * DAY_MS);
      if (!cls.archiveExpiresAt) {
        await tx.update(classesTable).set({ archiveExpiresAt: expiry, archiveLifecycleStatus: "archived" })
          .where(eq(classesTable.id, cls.id));
      }
      if (expiry > now) {
        const warningWindowStarted = expiry.getTime() - now.getTime() <= ARCHIVE_EXPIRY_WARNING_DAYS * DAY_MS;
        if (
          warningWindowStarted
          && !cls.legalHold
          && !policy?.legalHold
          && !cls.archiveExpiryWarningSentAt
          && !cls.archiveExpiryWarningAttemptedAt
        ) {
          await tx.update(classesTable).set({
            archiveExpiryWarningAttemptedAt: now,
          }).where(and(
            eq(classesTable.id, cls.id),
            isNull(classesTable.archiveExpiryWarningSentAt),
            isNull(classesTable.deletionScheduledFor),
          ));
          await tx.insert(auditLogTable).values({
            organisationId: cls.organisationId,
            action: "archive.expiry_warning_dispatch_started",
            metadata: {
              targetType: "class",
              targetId: cls.id,
              archiveExpiresAt: expiry.toISOString(),
              warningWindowDays: ARCHIVE_EXPIRY_WARNING_DAYS,
              warningAttemptedAt: now.toISOString(),
            },
          });
          warningClaims.push({
            classId: cls.id,
            organisationId: cls.organisationId,
            archiveExpiresAt: expiry,
            warningAttemptedAt: now,
          });
        }
        continue;
      }
      if (cls.legalHold || policy?.legalHold) continue;
      const recoveryDays = policy?.deletionRecoveryDays ?? defaults.deletionRecoveryDays;
      const scheduledFor = new Date(now.getTime() + recoveryDays * DAY_MS);
      const [updated] = await tx.update(classesTable).set({
        archiveLifecycleStatus: "pending_deletion",
        deletionRequestedAt: now,
        deletionScheduledFor: scheduledFor,
        deletionReason: "archive_retention_expired",
        archiveExpiryNotifiedAt: now,
      }).where(and(eq(classesTable.id, cls.id), isNull(classesTable.deletionScheduledFor))).returning({ id: classesTable.id });
      if (!updated) continue;
      await tx.update(studentSessionsTable).set({
        archiveLifecycleStatus: "pending_deletion",
        deletionRequestedAt: now,
        deletionScheduledFor: scheduledFor,
        deletionReason: "archive_retention_expired",
        archiveExpiryNotifiedAt: now,
      }).where(eq(studentSessionsTable.classId, cls.id));
      await tx.insert(auditLogTable).values({
        organisationId: cls.organisationId,
        action: "archive.retention_expired",
        metadata: { targetType: "class", targetId: cls.id, recoveryDays, deletionScheduledFor: scheduledFor.toISOString() },
      });
      classesScheduled++;
    }

    const archivedStudents = await tx.select({
      id: studentSessionsTable.id,
      classId: studentSessionsTable.classId,
      organisationId: teachersTable.organisationId,
      archivedAt: studentSessionsTable.archivedAt,
      archiveExpiresAt: studentSessionsTable.archiveExpiresAt,
    }).from(studentSessionsTable)
      .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
      .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
      .where(and(
        isNotNull(studentSessionsTable.archivedAt),
        isNull(studentSessionsTable.deletionScheduledFor),
        isNull(classesTable.deletionScheduledFor),
        dependencies.organisationIdScope?.length
          ? inArray(teachersTable.organisationId, dependencies.organisationIdScope)
          : undefined,
      )).for("update");

    for (const record of archivedStudents) {
      if (!record.organisationId || !record.archivedAt) continue;
      const policy = policyByOrg.get(record.organisationId);
      const expiry = record.archiveExpiresAt
        ?? new Date(record.archivedAt.getTime() + (policy?.archiveRetentionDays ?? defaults.archiveRetentionDays) * DAY_MS);
      if (!record.archiveExpiresAt) {
        await tx.update(studentSessionsTable).set({ archiveExpiresAt: expiry, archiveLifecycleStatus: "archived" })
          .where(eq(studentSessionsTable.id, record.id));
      }
      if (expiry > now || policy?.legalHold) continue;
      const recoveryDays = policy?.deletionRecoveryDays ?? defaults.deletionRecoveryDays;
      const scheduledFor = new Date(now.getTime() + recoveryDays * DAY_MS);
      const [updated] = await tx.update(studentSessionsTable).set({
        archiveLifecycleStatus: "pending_deletion",
        deletionRequestedAt: now,
        deletionScheduledFor: scheduledFor,
        deletionReason: "archive_retention_expired",
        archiveExpiryNotifiedAt: now,
      }).where(and(eq(studentSessionsTable.id, record.id), isNull(studentSessionsTable.deletionScheduledFor)))
        .returning({ id: studentSessionsTable.id });
      if (!updated) continue;
      await tx.insert(auditLogTable).values({
        organisationId: record.organisationId,
        action: "archive.retention_expired",
        metadata: { targetType: "student_record", targetId: record.id, classId: record.classId, recoveryDays, deletionScheduledFor: scheduledFor.toISOString() },
      });
      studentRecordsScheduled++;
    }
    return { classesScheduled, studentRecordsScheduled, warningClaims };
  });
  const warningResult = await deliverArchiveExpiryWarnings(lifecycleResult.warningClaims, dependencies);
  if (organisationScopedCall) {
    return {
      classesScheduled: lifecycleResult.classesScheduled,
      studentRecordsScheduled: lifecycleResult.studentRecordsScheduled,
    };
  }
  return {
    classesScheduled: lifecycleResult.classesScheduled,
    studentRecordsScheduled: lifecycleResult.studentRecordsScheduled,
    ...warningResult,
  };
}

let running = false;
async function runSafely() {
  if (running) return;
  if (await getRestorationAdmissionState() !== "ready") return;
  running = true;
  try {
    const result = await processArchiveRetention();
    if (result.classesScheduled || result.studentRecordsScheduled || result.warningsSent || result.warningsFailed) {
      logger.info(result, "Archive retention lifecycle processed");
    }
  } catch (error) {
    logger.error({ err: error }, "Archive retention lifecycle failed");
  } finally {
    running = false;
  }
}

export function startArchiveRetentionLifecycle() {
  void runSafely();
  const interval = setInterval(() => void runSafely(), INTERVAL_MS);
  interval.unref();
}
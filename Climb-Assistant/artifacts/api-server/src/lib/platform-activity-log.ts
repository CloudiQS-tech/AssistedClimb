import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";

const ADMIN_ACTIONS = [
  "cig_admin.account_link_claimed", "cig_admin.bootstrap_started", "cig_admin.created",
  "cig_admin.creation_notification_failed", "cig_admin.device_recovery_account_notification_failed",
  "cig_admin.device_recovery_failed", "cig_admin.device_recovery_locked",
  "cig_admin.device_recovery_notification_failed", "cig_admin.device_recovery_started",
  "cig_admin.login", "cig_admin.login_failed", "cig_admin.login_locked", "cig_admin.logout",
  "cig_admin.manual_account_link_created", "cig_admin.master_transfer_notification_failed",
  "cig_admin.master_transferred", "cig_admin.mfa_enabled", "cig_admin.mfa_setup_failed",
  "cig_admin.mfa_setup_locked", "cig_admin.password_changed", "cig_admin.password_recovered",
  "cig_admin.platform_email_test_failed", "cig_admin.platform_email_test_sent",
  "cig_admin.recovery_account_notification_failed", "cig_admin.recovery_codes_rotated",
  "cig_admin.recovery_failed", "cig_admin.recovery_locked", "cig_admin.recovery_notification_failed",
  "cig_admin.step_up_failed", "cig_admin.step_up_succeeded", "cig_admin.subadmin_activated",
  "cig_admin.subadmin_disabled", "cig_admin.subadmin_mfa_reset", "cig_admin.subadmin_password_reset",
  "cig_admin.subadmin_removed", "cig_admin.totp_failed", "cig_admin.totp_locked",
  "cig_admin.organisation_hard_deleted", "cig_admin.organisation_purged_after_retention",
] as const;
const SCHOOL_ACTIONS = [
  "organisation.restored", "organisation.soft_deleted", "teacher.password_reset_delivery_failed",
  "teacher.password_reset_manual_link_created", "teacher.password_reset_requested",
] as const;
const ACTIONS = [...ADMIN_ACTIONS, ...SCHOOL_ACTIONS] as const;

export function isValidActivityDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export const platformActivityLogQuery = z.object({
  category: z.enum(["administrator-security", "school-administration"]).optional(),
  action: z.enum(ACTIONS).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isValidActivityDate, "Use a real calendar date.").optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isValidActivityDate, "Use a real calendar date.").optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).optional().default(25),
});
export const platformActivityLogReportQuery = platformActivityLogQuery.omit({ page: true, pageSize: true });
export const PLATFORM_ACTIVITY_REPORT_LIMIT = 500;

type ActivityLogRow = {
  id: number;
  source: "cig-admin-security" | "audit";
  createdAt: Date | string;
  category: "administrator-security" | "school-administration";
  action: string;
  actorName: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  organisationName: string | null;
  organisationSlug: string | null;
  accountLabel: string | null;
  metadata: unknown;
};

function sqlList(values: readonly string[]) {
  return values.map((value) => sql`${value}`).reduce((list, value, index) => index === 0 ? value : sql`${list}, ${value}`);
}

function activityEventsCte() {
  return sql`
    WITH activity_events AS (
      SELECT e.id::bigint AS id, 'cig-admin-security'::text AS source, e.created_at AS "createdAt",
        'administrator-security'::text AS category, e.action, actor.name AS "actorName",
        actor.email AS "actorEmail", actor.role AS "actorRole", NULL::text AS "organisationName",
        NULL::text AS "organisationSlug", NULL::text AS "accountLabel", e.metadata::text AS metadata
      FROM cig_admin_security_events e
      LEFT JOIN cig_admins actor ON actor.id = e.admin_id
      WHERE e.action IN (${sqlList(ADMIN_ACTIONS)})
      UNION ALL
      SELECT l.id::bigint AS id, 'audit'::text AS source, l.created_at AS "createdAt",
        'school-administration'::text AS category, l.action, actor.name AS "actorName",
        actor.email AS "actorEmail", actor.role AS "actorRole", organisation.name AS "organisationName",
        organisation.slug AS "organisationSlug",
        CASE WHEN teacher.is_it_admin = true AND teacher.school_admin_role = 'master'
          THEN 'School Admin account' ELSE 'Teacher account' END AS "accountLabel",
        l.metadata::text AS metadata
      FROM audit_log l
      LEFT JOIN organisations organisation ON organisation.id = l.organisation_id
      LEFT JOIN teachers teacher ON teacher.id = l.teacher_id
      LEFT JOIN cig_admins actor ON actor.id = CASE
        WHEN COALESCE(l.metadata->>'initiatedByCigAdminId', l.metadata->>'deletedByCigAdminId', l.metadata->>'restoredByCigAdminId') ~ '^[0-9]+$'
        THEN COALESCE(l.metadata->>'initiatedByCigAdminId', l.metadata->>'deletedByCigAdminId', l.metadata->>'restoredByCigAdminId')::int
        ELSE NULL
      END
      WHERE l.action IN (${sqlList(SCHOOL_ACTIONS)})
        AND (
          l.action <> 'teacher.password_reset_requested'
          OR COALESCE(l.metadata->>'initiatedByCigAdminId', '') ~ '^[0-9]+$'
        )
    )
  `;
}

function cleanText(value: unknown, maxLength = 120): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
  return cleaned || null;
}

function safeMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const LABELS: Record<string, string> = {
  "cig_admin.account_link_claimed": "CIG administrator account link claimed",
  "cig_admin.bootstrap_started": "CIG Master bootstrap started",
  "cig_admin.created": "CIG sub-admin account created",
  "cig_admin.creation_notification_failed": "CIG sub-admin notification failed",
  "cig_admin.device_recovery_account_notification_failed": "Device recovery account notification failed",
  "cig_admin.device_recovery_failed": "CIG administrator device recovery failed",
  "cig_admin.device_recovery_locked": "CIG administrator device recovery locked",
  "cig_admin.device_recovery_notification_failed": "Device recovery security notification failed",
  "cig_admin.device_recovery_started": "CIG administrator device recovery started",
  "cig_admin.login": "CIG administrator signed in", "cig_admin.login_failed": "CIG administrator sign-in failed",
  "cig_admin.login_locked": "CIG administrator sign-in locked", "cig_admin.logout": "CIG administrator signed out",
  "cig_admin.manual_account_link_created": "Manual CIG administrator account link created",
  "cig_admin.master_transfer_notification_failed": "Master transfer notification failed",
  "cig_admin.master_transferred": "Master responsibility transferred",
  "cig_admin.mfa_enabled": "CIG administrator MFA enabled", "cig_admin.mfa_setup_failed": "CIG administrator MFA setup failed",
  "cig_admin.mfa_setup_locked": "CIG administrator MFA setup locked", "cig_admin.password_changed": "CIG administrator password changed",
  "cig_admin.password_recovered": "CIG administrator password recovered",
  "cig_admin.platform_email_test_failed": "Platform email test failed", "cig_admin.platform_email_test_sent": "Platform email test sent",
  "cig_admin.recovery_account_notification_failed": "Recovery account notification failed",
  "cig_admin.recovery_codes_rotated": "CIG administrator recovery codes rotated",
  "cig_admin.recovery_failed": "CIG administrator recovery failed", "cig_admin.recovery_locked": "CIG administrator recovery locked",
  "cig_admin.recovery_notification_failed": "Recovery security notification failed",
  "cig_admin.step_up_failed": "Fresh administrator verification failed", "cig_admin.step_up_succeeded": "Fresh administrator verification succeeded",
  "cig_admin.subadmin_activated": "CIG sub-admin access enabled", "cig_admin.subadmin_disabled": "CIG sub-admin access suspended",
  "cig_admin.subadmin_mfa_reset": "CIG sub-admin authenticator reset",
  "cig_admin.subadmin_password_reset": "CIG sub-admin password reset requested", "cig_admin.subadmin_removed": "CIG sub-admin removed",
  "cig_admin.totp_failed": "CIG administrator authenticator check failed", "cig_admin.totp_locked": "CIG administrator authenticator check locked",
  "cig_admin.organisation_hard_deleted": "School permanently deleted",
  "cig_admin.organisation_purged_after_retention": "School permanently deleted after retention",
  "organisation.restored": "School restored", "organisation.soft_deleted": "School removal started",
  "teacher.password_reset_delivery_failed": "School Admin reset delivery failed",
  "teacher.password_reset_manual_link_created": "Manual School Admin reset link created",
  "teacher.password_reset_requested": "School Admin password reset requested",
};

function outcomeAndContext(action: string, metadata: Record<string, unknown>) {
  if (action.endsWith("_failed")) return { outcome: "Failed", context: "The requested security or notification action did not complete." };
  if (action.endsWith("_locked")) return { outcome: "Blocked", context: "Further attempts were temporarily blocked." };
  if (action === "cig_admin.login") return { outcome: "Succeeded", context: "Administrator session started." };
  if (action === "cig_admin.logout") return { outcome: "Succeeded", context: "Administrator session ended." };
  if (action === "cig_admin.step_up_succeeded") return { outcome: "Succeeded", context: "Fresh MFA verification completed." };
  if (action === "cig_admin.subadmin_activated") return { outcome: "Succeeded", context: "Sub-admin access is active." };
  if (action === "cig_admin.subadmin_disabled") return { outcome: "Succeeded", context: "Sub-admin access is suspended." };
  if (action === "organisation.soft_deleted") return { outcome: "Succeeded", context: "The school entered its recoverable removal window." };
  if (action === "organisation.restored") return { outcome: "Succeeded", context: "The school was restored." };
  if (action.includes("hard_deleted") || action.includes("purged")) return { outcome: "Succeeded", context: "The school record was permanently removed." };
  if (action.includes("password_reset")) return {
    outcome: action.includes("delivery_failed") ? "Failed" : "Succeeded",
    context: metadata.method === "cig-admin-manual-link" ? "A manual hand-off was selected; the credential itself is never shown here." : "The credential was invalidated; no password or reset token is shown here.",
  };
  if (action === "cig_admin.platform_email_test_sent") return { outcome: "Succeeded", context: "A delivery test was requested for the signed-in Master." };
  if (action === "cig_admin.platform_email_test_failed") return { outcome: "Failed", context: "The platform email delivery test did not complete." };
  if (action === "cig_admin.recovery_codes_rotated") return { outcome: "Succeeded", context: "Existing recovery codes were invalidated and replaced." };
  if (action.includes("notification_failed")) return { outcome: "Failed", context: "The security notification could not be delivered." };
  return { outcome: "Succeeded", context: "Security activity recorded." };
}

function projectActivityRow(row: ActivityLogRow) {
  const metadata = safeMetadata(row.metadata);
  const permanentDeletion = row.action === "cig_admin.organisation_hard_deleted"
    || row.action === "cig_admin.organisation_purged_after_retention";
  const schoolName = cleanText(row.organisationName) ?? (permanentDeletion ? cleanText(metadata.organisationName) : null);
  const schoolSlug = cleanText(row.organisationSlug) ?? (permanentDeletion ? cleanText(metadata.organisationSlug) : null);
  const { outcome, context } = outcomeAndContext(row.action, metadata);
  return {
    id: `${row.source}-${row.id}`, source: row.source, category: row.category, action: row.action,
    label: row.action === "teacher.password_reset_requested" && row.accountLabel === "Teacher account"
      ? "Teacher password reset requested"
      : LABELS[row.action] ?? "Platform activity",
    occurredAt: row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : new Date(row.createdAt).toISOString(),
    actor: row.actorName && row.actorEmail ? {
      name: cleanText(row.actorName), email: cleanText(row.actorEmail),
      role: row.actorRole === "master" ? "Master CIG Admin" : "CIG Sub-admin",
    } : null,
    school: schoolName ? { name: schoolName, slug: schoolSlug } : null,
    account: row.accountLabel ? { label: row.accountLabel }
      : row.action.includes("subadmin") || row.action.includes("account_link") ? { label: "CIG administrator account" } : null,
    outcome, context,
  };
}

export async function getPlatformActivityLog(query: z.infer<typeof platformActivityLogQuery>) {
  const { category, action, from, to, page, pageSize } = query;
  const filters = [
    category ? sql`category = ${category}` : undefined,
    action ? sql`action = ${action}` : undefined,
    from ? sql`"createdAt" >= ${new Date(`${from}T00:00:00.000Z`)}` : undefined,
    to ? sql`"createdAt" <= ${new Date(`${to}T23:59:59.999Z`)}` : undefined,
  ].filter((filter): filter is NonNullable<typeof filter> => Boolean(filter));
  const where = filters.reduce((combined, filter, index) => index === 0 ? filter : sql`${combined} AND ${filter}`, sql`TRUE`);
  const cte = activityEventsCte();
  const countResult = await db.execute(sql`${cte} SELECT count(*)::int AS count FROM activity_events WHERE ${where}`);
  const total = Number((countResult.rows[0] as { count?: number | string } | undefined)?.count ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const result = await db.execute(sql`
    ${cte}
    SELECT id, source, "createdAt", category, action, "actorName", "actorEmail", "actorRole",
      "organisationName", "organisationSlug", "accountLabel", metadata
    FROM activity_events
    WHERE ${where}
    ORDER BY "createdAt" DESC, source DESC, id DESC
    LIMIT ${pageSize} OFFSET ${(currentPage - 1) * pageSize}
  `);
  const items = (result.rows as unknown as ActivityLogRow[]).map(projectActivityRow);
  return {
    items, total, page: currentPage, pageSize, totalPages,
    privacy: "Only fixed, redacted display fields are returned. Credentials, student data, chat content, raw metadata, and IP addresses are excluded.",
  };
}

export async function getPlatformActivityLogReport(query: z.infer<typeof platformActivityLogReportQuery>) {
  const { category, action, from, to } = query;
  const filters = [
    category ? sql`category = ${category}` : undefined,
    action ? sql`action = ${action}` : undefined,
    from ? sql`"createdAt" >= ${new Date(`${from}T00:00:00.000Z`)}` : undefined,
    to ? sql`"createdAt" <= ${new Date(`${to}T23:59:59.999Z`)}` : undefined,
  ].filter((filter): filter is NonNullable<typeof filter> => Boolean(filter));
  const where = filters.reduce((combined, filter, index) => index === 0 ? filter : sql`${combined} AND ${filter}`, sql`TRUE`);
  const cte = activityEventsCte();
  const countResult = await db.execute(sql`${cte} SELECT count(*)::int AS count FROM activity_events WHERE ${where}`);
  const total = Number((countResult.rows[0] as { count?: number | string } | undefined)?.count ?? 0);
  const result = await db.execute(sql`
    ${cte}
    SELECT id, source, "createdAt", category, action, "actorName", "actorEmail", "actorRole",
      "organisationName", "organisationSlug", "accountLabel", metadata
    FROM activity_events
    WHERE ${where}
    ORDER BY "createdAt" DESC, source DESC, id DESC
    LIMIT ${PLATFORM_ACTIVITY_REPORT_LIMIT}
  `);
  const items = (result.rows as unknown as ActivityLogRow[]).map(projectActivityRow);
  return {
    items,
    total,
    limit: PLATFORM_ACTIVITY_REPORT_LIMIT,
    truncated: total > items.length,
  };
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  const spreadsheetSafe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${spreadsheetSafe.replaceAll('"', '""')}"`;
}

export function buildPlatformActivityLogCsv(items: Awaited<ReturnType<typeof getPlatformActivityLogReport>>["items"]): string {
  const header = [
    "Event", "When", "Actor", "Actor email", "Role",
    "School", "School slug", "Account", "Outcome", "Context",
  ];
  const rows = items.map((item) => [
    item.label,
    item.occurredAt,
    item.actor?.name,
    item.actor?.email,
    item.actor?.role,
    item.school?.name,
    item.school?.slug,
    item.account?.label,
    item.outcome,
    item.context,
  ].map(csvCell).join(","));
  return [header.map(csvCell).join(","), ...rows].join("\n") + "\n";
}
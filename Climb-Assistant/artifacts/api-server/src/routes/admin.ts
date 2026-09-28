import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { randomBytes, timingSafeEqual } from "crypto";
import { resolve } from "path";
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, max, sql } from "drizzle-orm";
import {
  auditLogTable,
  chatMessagesTable,
  cigAdminRecoveryCodesTable,
  cigAdminDeletionShadowsTable,
  cigAdminRoles,
  cigAdminSecurityEventsTable,
  cigAdminsTable,
  classesTable,
  db,
  organisationDeletionShadowsTable,
  organisationsTable,
  platformSettingsTable,
  stageEntriesTable,
  studentSessionsTable,
  tasksTable,
  teacherFeedbackTable,
  teachersTable,
} from "@workspace/db";
import { decrypt, encrypt } from "../lib/crypto";
import { z } from "zod/v4";
import bcrypt from "bcryptjs";
import { generateSecret, generateURI, verifySync } from "otplib";
import QRCode from "qrcode";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { getEmailConfigurationSummary, isEmailConfigured, sendEmail } from "../lib/email";
import {
  checkPasswordPolicy,
  hashPasswordResetToken,
  HIBP_UNAVAILABLE_ACKNOWLEDGED_ACTION,
  HIBP_UNAVAILABLE_CODE,
  recordHibpUnavailableAcknowledgement,
  recordTeacherPassword,
  revokeTeacherSessionsInTransaction,
} from "../lib/teacher-security";
import { logAudit } from "../lib/audit";
import {
  buildPlatformActivityLogCsv,
  getPlatformActivityLog,
  getPlatformActivityLogReport,
  platformActivityLogQuery,
  platformActivityLogReportQuery,
} from "../lib/platform-activity-log";
import { getAppBaseUrl } from "../lib/app-url";
import {
  regenerateAnonymousSessionPreservingSiteAccess,
  regenerateSessionWithCookiePolicy,
} from "../lib/session-cookie";
import {
  ORGANISATION_DELETION_RETENTION_DAYS,
  permanentlyDeleteSoftDeletedOrganisation,
} from "../lib/organisation-deletion";
import {
  getArchiveWarningDeliveryReview,
  getPlatformRetentionDefaults,
} from "../lib/archive-retention";

function generateTempPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

const router: IRouter = Router();
const CIG_ADMIN_MUTATION_LOCK = 8452101;
const CIG_ADMIN_TOTP_CLOCK_SKEW_SECONDS = 30;
const PlatformRetentionSettingsBody = z.object({
  defaultArchiveRetentionDays: z.coerce.number().int().min(1).max(36_500),
  minimumDays: z.coerce.number().int().min(1).max(36_500),
  maximumDays: z.coerce.number().int().min(1).max(36_500),
  standardChoices: z.array(z.coerce.number().int().min(1).max(36_500)).min(1).max(20),
}).superRefine((value, ctx) => {
  if (value.minimumDays > value.maximumDays) ctx.addIssue({ code: "custom", message: "Minimum must not exceed maximum." });
  for (const days of [value.defaultArchiveRetentionDays, ...value.standardChoices]) {
    if (days < value.minimumDays || days > value.maximumDays) ctx.addIssue({ code: "custom", message: "Default and standard choices must be within the allowed limits." });
  }
});

function verifyCigAdminTotp(token: string, encryptedSecret: string): boolean {
  try {
    return verifySync({
      token,
      secret: decrypt(encryptedSecret),
      epochTolerance: CIG_ADMIN_TOTP_CLOCK_SKEW_SECONDS,
    }).valid;
  } catch {
    return false;
  }
}

const MASTER_DOCUMENTS: Record<string, { fileName: string; downloadName: string }> = {
  "cig-admin-data-flow-diagram": {
    fileName: "cig-admin-data-flow-diagram.docx",
    downloadName: "cig-admin-data-flow-diagram.docx",
  },
  "cig-admin-data-flow-document": {
    fileName: "cig-admin-data-flow-document.docx",
    downloadName: "cig-admin-data-flow-document.docx",
  },
};
const adminEmailTestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: "Too many email tests have been requested. Please wait before trying again." },
  standardHeaders: true,
  legacyHeaders: false,
});
const schoolMasterResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => `${req.session.cigAdminId ?? "anonymous"}:${ipKeyGenerator(req.ip ?? "")}`,
  message: { error: "Too many School Admin reset links have been requested. Please wait before trying again." },
  standardHeaders: true,
  legacyHeaders: false,
});
const cigAdminAccountLinkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => `${req.session.cigAdminId ?? "anonymous"}:${ipKeyGenerator(req.ip ?? "")}`,
  message: { error: "Too many CIG administrator account links have been requested. Please wait before trying again." },
  standardHeaders: true,
  legacyHeaders: false,
});
const cigAdminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
  message: { error: "Too many administrator sign-in attempts. Please wait and try again." },
  standardHeaders: true,
  legacyHeaders: false,
});
const cigAdminTotpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
  message: { error: "Too many administrator authentication attempts. Please wait and try again." },
  standardHeaders: true,
  legacyHeaders: false,
});
const cigAdminRecoveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
  message: { error: "Too many administrator recovery attempts. Please wait and try again." },
  standardHeaders: true,
  legacyHeaders: false,
});
const cigAdminStepUpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => `${req.session.cigAdminId ?? "anonymous"}:${ipKeyGenerator(req.ip ?? "")}`,
  message: { error: "Too many fresh authentication attempts. Please wait and try again." },
  standardHeaders: true,
  legacyHeaders: false,
});
const CIG_ADMIN_STEP_UP_TTL_MS = 10 * 60 * 1000;
const CIG_ADMIN_ACCOUNT_LINK_TTL_MS = 60 * 60 * 1000;

class MasterMutationConflict extends Error {}
class CigAdminSessionVersionConflict extends Error {}

async function acquireCigAdminMutationLock(tx: Pick<typeof db, "execute">): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${CIG_ADMIN_MUTATION_LOCK})`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!
  ));
}

type EmailStatus = "sent" | "not-configured" | "failed";

async function sendCigAdminAccountLinkEmail(
  admin: { name: string; email: string },
  accountLinkUrl: string,
  purpose: "invitation" | "password-reset",
): Promise<EmailStatus> {
  if (!isEmailConfigured()) return "not-configured";

  const safeName = escapeHtml(admin.name);
  const safeAccountLinkUrl = escapeHtml(accountLinkUrl);
  const isInvitation = purpose === "invitation";
  try {
    await sendEmail({
      to: admin.email,
      subject: isInvitation
        ? "Set up your CIG sub-admin account — The Assisted Climb"
        : "Reset your CIG sub-admin password — The Assisted Climb",
      text: `Hi ${admin.name},\n\n${isInvitation
        ? "A CIG sub-admin account has been created for you."
        : "The Master CIG administrator requested a password reset for your CIG sub-admin account."}\n\nUse this one-time link to ${isInvitation ? "set your password and authenticator app" : "set a new password"} (expires in 1 hour):\n${accountLinkUrl}\n\nNo temporary password has been created or sent. If you did not expect this, contact the Master CIG administrator immediately.\n`,
      html: `
        <p>Hi ${safeName},</p>
        <p>${isInvitation
          ? "A CIG sub-admin account has been created for you."
          : "The Master CIG administrator requested a password reset for your CIG sub-admin account."}</p>
        <p><a href="${safeAccountLinkUrl}" style="background:#000;color:#fff;padding:12px 24px;border-radius:12px;text-decoration:none;display:inline-block;font-size:14px;">${isInvitation ? "Set up my account" : "Set a new password"}</a></p>
        <p style="color:#888;font-size:12px;">This one-time link expires in 1 hour. No temporary password has been created or sent.</p>
        <p style="color:#888;font-size:12px;">If you did not expect this, contact the Master CIG administrator immediately.</p>
        <p style="color:#bbb;font-size:11px;">Or copy this URL: ${safeAccountLinkUrl}</p>
      `,
    });
    return "sent";
  } catch {
    return "failed";
  }
}

async function sendSchoolAdminCredentialsEmail(
  admin: { name: string; email: string },
  password: string,
  schoolName: string,
): Promise<EmailStatus> {
  if (!isEmailConfigured()) return "not-configured";

  const loginUrl = `${getAppBaseUrl()}/teacher-login`;
  const safeName = escapeHtml(admin.name);
  const safeEmail = escapeHtml(admin.email);
  const safeSchoolName = escapeHtml(schoolName);
  try {
    await sendEmail({
      to: admin.email,
      subject: `Your school administrator account — ${schoolName}`,
      text: `Hi ${admin.name},\n\nYou have been made the school administrator for ${schoolName} in The Assisted Climb.\n\nSign in at: ${loginUrl}\nEmail: ${admin.email}\nTemporary password: ${password}\n\nYou will be required to change this password when you sign in. Keep it private and do not share it.\n`,
      html: `
        <p>Hi ${safeName},</p>
        <p>You have been made the school administrator for <strong>${safeSchoolName}</strong> in The Assisted Climb.</p>
        <p><a href="${loginUrl}" style="background:#000;color:#fff;padding:12px 24px;border-radius:12px;text-decoration:none;display:inline-block;font-size:14px;">Sign in to your school</a></p>
        <p><strong>Email:</strong> ${safeEmail}<br><strong>Temporary password:</strong> ${escapeHtml(password)}</p>
        <p>You will be required to change this password when you sign in. Keep it private and do not share it.</p>
        <p style="color:#bbb;font-size:11px;">Or copy this URL: ${escapeHtml(loginUrl)}</p>
      `,
    });
    return "sent";
  } catch {
    return "failed";
  }
}

async function sendTeacherPasswordResetEmail(
  admin: { name: string; email: string },
  schoolName: string,
  resetUrl: string,
): Promise<EmailStatus> {
  if (!isEmailConfigured()) return "not-configured";

  const safeName = escapeHtml(admin.name);
  const safeSchoolName = escapeHtml(schoolName);
  const safeResetUrl = escapeHtml(resetUrl);
  try {
    await sendEmail({
      to: admin.email,
       subject: `Reset your School Admin password — ${schoolName}`,
       text: `Hi ${admin.name},\n\nA CIG administrator requested a password reset for your School Admin account for ${schoolName}.\n\nUse this link to set a new password (expires in 1 hour):\n${resetUrl}\n\nIf you did not request this, contact your CIG administrator.\n`,
      html: `
        <p>Hi ${safeName},</p>
         <p>A CIG administrator requested a password reset for your School Admin account for <strong>${safeSchoolName}</strong>.</p>
        <p><a href="${safeResetUrl}" style="background:#000;color:#fff;padding:12px 24px;border-radius:12px;text-decoration:none;display:inline-block;font-size:14px;">Reset my password</a></p>
        <p style="color:#888;font-size:12px;">This link expires in 1 hour and can only be used once. If you did not request this, contact your CIG administrator.</p>
        <p style="color:#bbb;font-size:11px;">Or copy this URL: ${safeResetUrl}</p>
      `,
    });
    return "sent";
  } catch {
    return "failed";
  }
}

async function sendMasterSecurityNotice(subject: string, text: string, html: string): Promise<boolean> {
  if (!isEmailConfigured()) return true;
  const [master] = await db.select({ email: cigAdminsTable.email })
    .from(cigAdminsTable)
    .where(eq(cigAdminsTable.role, "master"));
  const recipient = process.env.CIG_SECURITY_EMAIL ?? master?.email;
  if (!recipient) return false;
  try {
    await sendEmail({ to: recipient, subject, text, html });
    return true;
  } catch {
    return false;
  }
}

async function logAdminSecurityEvent(
  adminId: number | null,
  action: string,
  ipAddress: string | undefined,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(cigAdminSecurityEventsTable).values({
      adminId,
      action,
      ipAddress: ipAddress ?? null,
      metadata: metadata ? JSON.stringify(metadata) : null,
    });
  } catch {
    // Security logging must not hide the primary response.
  }
}

async function writeAdminSecurityEvent(
  tx: Pick<typeof db, "insert">,
  adminId: number | null,
  action: string,
  ipAddress: string | undefined,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx.insert(cigAdminSecurityEventsTable).values({
    adminId,
    action,
    ipAddress: ipAddress ?? null,
    metadata: metadata ? JSON.stringify(metadata) : null,
  });
}

type CigAdminSecurityTransaction = Pick<typeof db, "execute" | "update">;

async function revokeCigAdminSessions(
  tx: CigAdminSecurityTransaction,
  adminId: number,
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM "session"
    WHERE sess ->> 'cigAdminId' = ${String(adminId)}
       OR sess ->> 'pendingCigAdminId' = ${String(adminId)}
  `);
}

async function getSessionAdmin(req: Request) {
  const adminId = req.session.cigAdminId;
  if (!adminId) return null;
  const [admin] = await db.select().from(cigAdminsTable).where(eq(cigAdminsTable.id, adminId));
  return admin?.active && req.session.cigAdminSessionVersion === admin.sessionVersion ? admin : null;
}

async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const admin = await getSessionAdmin(req);
  if (!admin) {
    req.session.cigAdminId = undefined;
    req.session.cigAdminSessionVersion = undefined;
    res.status(401).json({ error: "CIG administrator sign-in required" });
    return;
  }
  next();
}

async function requireMaster(req: Request, res: Response, next: NextFunction): Promise<void> {
  const admin = await getSessionAdmin(req);
  if (!admin) {
    req.session.cigAdminId = undefined;
    req.session.cigAdminSessionVersion = undefined;
    res.status(401).json({ error: "CIG administrator sign-in required" });
    return;
  }
  if (admin.role !== "master") {
    res.status(403).json({ error: "Only the Master CIG administrator can manage administrator access and platform security." });
    return;
  }
  next();
}

async function requireFreshAdminMfa(req: Request, res: Response, next: NextFunction): Promise<void> {
  const admin = await getSessionAdmin(req);
  const stepUpAt = req.session.cigAdminMfaStepUpAt;
  const stepUpSessionVersion = req.session.cigAdminMfaStepUpSessionVersion;
  if (
    !admin
    || !stepUpAt
    || stepUpSessionVersion !== admin.sessionVersion
    || Date.now() - stepUpAt > CIG_ADMIN_STEP_UP_TTL_MS
  ) {
    req.session.cigAdminMfaStepUpAt = undefined;
    req.session.cigAdminMfaStepUpSessionVersion = undefined;
    res.status(403).json({
      error: "Confirm a fresh authenticator code before this high-risk action.",
      code: "FRESH_MFA_REQUIRED",
    });
    return;
  }
  next();
}

function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get("origin");
  const host = req.get("x-forwarded-host") ?? req.get("host");
  try {
    if (!origin || !host || new URL(origin).host !== host) throw new Error("untrusted origin");
  } catch {
    res.status(403).json({ error: "This request must come from the Platform Admin application." });
    return;
  }
  next();
}

async function clearPendingAdminLogin(req: Request): Promise<void> {
  req.session.pendingCigAdminId = undefined;
  req.session.pendingCigAdminSessionVersion = undefined;
  await new Promise<void>((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
}

function recoveryCodeValue(): string {
  return `CIG-${randomBytes(6).toString("base64url").toUpperCase()}`;
}

async function createRecoveryCodes(
  adminId: number,
  options: {
    revokeSessions?: boolean;
    expectedSessionVersion?: number;
    securityEvent?: { action: string; ipAddress?: string };
  } = {},
): Promise<string[]> {
  const codes = Array.from({ length: 10 }, recoveryCodeValue);
  const rows = await Promise.all(codes.map(async (code) => ({ adminId, codeHash: await bcrypt.hash(code, 12) })));
  await db.transaction(async (tx) => {
    await acquireCigAdminMutationLock(tx);
    if (options.expectedSessionVersion !== undefined) {
      const [admin] = await tx.select({ id: cigAdminsTable.id }).from(cigAdminsTable).where(and(
        eq(cigAdminsTable.id, adminId),
        eq(cigAdminsTable.active, true),
        eq(cigAdminsTable.sessionVersion, options.expectedSessionVersion),
      ));
      if (!admin) throw new CigAdminSessionVersionConflict();
    }
    await tx.delete(cigAdminRecoveryCodesTable).where(eq(cigAdminRecoveryCodesTable.adminId, adminId));
    await tx.insert(cigAdminRecoveryCodesTable).values(rows);
    if (options.revokeSessions !== false) {
      await tx.update(cigAdminsTable).set({
        sessionVersion: sql`${cigAdminsTable.sessionVersion} + 1`,
      }).where(eq(cigAdminsTable.id, adminId));
      await revokeCigAdminSessions(tx, adminId);
    }
    if (options.securityEvent) {
      await writeAdminSecurityEvent(tx, adminId, options.securityEvent.action, options.securityEvent.ipAddress);
    }
  });
  return codes;
}

async function completeAdminLogin(
  req: Request,
  adminId: number,
  expectedSessionVersion: number,
): Promise<boolean> {
  const [admin] = await db.select({
    id: cigAdminsTable.id,
    sessionVersion: cigAdminsTable.sessionVersion,
  }).from(cigAdminsTable)
    .where(and(
      eq(cigAdminsTable.id, adminId),
      eq(cigAdminsTable.active, true),
      eq(cigAdminsTable.sessionVersion, expectedSessionVersion),
    ));
  if (!admin) {
    await clearPendingAdminLogin(req);
    return false;
  }
  await regenerateSessionWithCookiePolicy(req);
  req.session.cigAdminId = adminId;
  req.session.cigAdminSessionVersion = admin.sessionVersion;
  req.session.pendingCigAdminId = undefined;
  req.session.cigAdminMfaStepUpAt = undefined;
  req.session.cigAdminMfaStepUpSessionVersion = undefined;
  req.session.teacherId = undefined;
  req.session.studentSessionId = undefined;
  req.session.sessionStartedAt = Date.now();
  req.session.lastActivityAt = req.session.sessionStartedAt;
  await new Promise<void>((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
  return true;
}

async function beginAdminTotpSetup(req: Request, adminId: number): Promise<boolean> {
  const [admin] = await db.select({ sessionVersion: cigAdminsTable.sessionVersion })
    .from(cigAdminsTable)
    .where(and(eq(cigAdminsTable.id, adminId), eq(cigAdminsTable.active, true)));
  if (!admin) return false;
  const siteAuthed = req.session.siteAuthed;
  await regenerateSessionWithCookiePolicy(req);
  req.session.siteAuthed = siteAuthed;
  req.session.pendingCigAdminId = adminId;
  req.session.pendingCigAdminSessionVersion = admin.sessionVersion;
  await new Promise<void>((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
  return true;
}

function secretsMatch(provided: string, expected: string): boolean {
  const supplied = Buffer.from(provided);
  const target = Buffer.from(expected);
  return supplied.length === target.length && timingSafeEqual(supplied, target);
}

const BootstrapBody = z.object({
  bootstrapSecret: z.string().min(1),
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(12),
});
const AdminLoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });
const TotpCodeBody = z.object({ code: z.string().min(6).max(8) });
const AdminPasswordBody = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(12) });
const CreateCigAdminBody = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
});
const CigAdminAccountLinkBody = z.object({
  token: z.string().min(32).max(256),
  password: z.string().min(12),
});
const CigAdminActiveBody = z.object({ active: z.boolean() });
const CigAdminIdBody = z.object({ id: z.coerce.number().int().positive() });
const CigAdminRoleBody = z.object({ role: z.enum(cigAdminRoles) });
const SchoolMasterResetLinkBody = z.object({
  teacherId: z.coerce.number().int().positive(),
  deliveryMethod: z.enum(["email", "manual"]).optional().default("email"),
});
const DirectoryQuery = z.object({
  q: z.string().trim().max(120).optional().default(""),
  status: z.enum(["active", "suspended", "deleted"]).optional().default("active"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});
const DeviceRecoveryBody = z.object({
  email: z.string().email(),
  recoveryCode: z.string().min(8),
});
const AdminRecoveryBody = z.object({
  email: z.string().email(),
  newPassword: z.string().min(12),
  totpCode: z.string().min(6).max(8).optional(),
  recoveryCode: z.string().min(8).optional(),
}).refine((value) => Boolean(value.totpCode) !== Boolean(value.recoveryCode), {
  message: "Use either an authenticator code or one recovery code",
});

const GENERIC_RECOVERY_ERROR = "Unable to verify this recovery request.";
const DEVELOPMENT_MASTER_RECOVERY_ROTATION_GUIDANCE =
  "The configured development Master recovery credential is not usable. Run pnpm --filter @workspace/api-server run prepare:development-master-recovery, then try again. The command never prints the credential or its hash.";

function getRecoveryVerificationError(
  admin: { role: string },
  providedRecoveryCode: string,
): string {
  if (process.env.NODE_ENV !== "development" || admin.role !== "master") {
    return GENERIC_RECOVERY_ERROR;
  }

  const configuredRecoveryCode = process.env.ADMIN_RECOVERY_CODE?.trim();
  if (configuredRecoveryCode && secretsMatch(providedRecoveryCode, configuredRecoveryCode)) {
    return DEVELOPMENT_MASTER_RECOVERY_ROTATION_GUIDANCE;
  }
  return GENERIC_RECOVERY_ERROR;
}

router.get("/admin/auth/status", async (req, res): Promise<void> => {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(cigAdminsTable);
  const admin = await getSessionAdmin(req);
  res.json({
    hasAdmins: (row?.count ?? 0) > 0,
    signedIn: Boolean(admin),
    admin: admin ? { name: admin.name, email: admin.email, role: admin.role } : null,
  });
});

router.get("/admin/email-status", requireMaster, async (req, res): Promise<void> => {
  const admin = await getSessionAdmin(req);
  res.json({
    ...getEmailConfigurationSummary(),
    testRecipient: admin?.email ?? null,
  });
});

const HIBP_OUTAGE_EVENT_LIMIT = 25;

router.get("/admin/security/hibp-outages", requireMaster, async (_req, res): Promise<void> => {
  const events = await db
    .select({ occurredAt: auditLogTable.createdAt })
    .from(auditLogTable)
    .where(eq(auditLogTable.action, HIBP_UNAVAILABLE_ACKNOWLEDGED_ACTION))
    .orderBy(desc(auditLogTable.createdAt))
    .limit(HIBP_OUTAGE_EVENT_LIMIT);

  res.json({
    events: events.map((event) => ({ occurredAt: event.occurredAt.toISOString() })),
  });
});

router.get("/admin/archive-warning-deliveries", requireMaster, async (_req, res): Promise<void> => {
  res.json(await getArchiveWarningDeliveryReview());
});

router.get("/admin/activity-log", requireMaster, async (req, res): Promise<void> => {
  const parsed = platformActivityLogQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Use valid activity category, action, date, and pagination filters." });
    return;
  }
  if (parsed.data.from && parsed.data.to && parsed.data.from > parsed.data.to) {
    res.status(400).json({ error: "The activity start date must be before the end date." });
    return;
  }
  res.json(await getPlatformActivityLog(parsed.data));
});

router.get("/admin/activity-log/report", requireMaster, async (req, res): Promise<void> => {
  const parsed = platformActivityLogReportQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Use valid activity category, action, and date filters." });
    return;
  }
  if (parsed.data.from && parsed.data.to && parsed.data.from > parsed.data.to) {
    res.status(400).json({ error: "The activity start date must be before the end date." });
    return;
  }
  const report = await getPlatformActivityLogReport(parsed.data);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="platform-activity-report.csv"');
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Activity-Report-Count", String(report.items.length));
  res.setHeader("X-Activity-Report-Truncated", String(report.truncated));
  res.send(buildPlatformActivityLogCsv(report.items));
});

router.get("/admin/documents/:document", requireMaster, (req, res): void => {
  const document = MASTER_DOCUMENTS[String(req.params.document)];
  if (!document) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  res.download(
    resolve(process.cwd(), "../../docs/internal", document.fileName),
    document.downloadName,
    (error) => {
      if (error && !res.headersSent) {
        res.status(500).json({ error: "Document could not be downloaded" });
      }
    },
  );
});

router.post("/admin/email-test", requireMaster, requireSameOrigin, adminEmailTestLimiter, async (req, res): Promise<void> => {
  const admin = await getSessionAdmin(req);
  if (!admin) {
    res.status(401).json({ error: "CIG administrator sign-in required" });
    return;
  }
  if (!isEmailConfigured()) {
    res.status(400).json({ status: "not-configured", error: "SMTP is not configured in the deployment environment." });
    return;
  }

  try {
    await sendEmail({
      to: admin.email,
      subject: "Platform email test — The Assisted Climb",
      text: `Hi ${admin.name},\n\nThis is a test email from The Assisted Climb. It confirms that the platform-wide email service is configured and can deliver messages.\n`,
      html: `
        <p>Hi ${escapeHtml(admin.name)},</p>
        <p>This is a test email from <strong>The Assisted Climb</strong>.</p>
        <p style="color:#16a34a;font-weight:600;">✓ The platform-wide email service is delivering messages.</p>
      `,
    });
    await logAdminSecurityEvent(admin.id, "cig_admin.platform_email_test_sent", req.ip);
    res.json({ ok: true, status: "sent" });
  } catch (error) {
    req.log?.error({ err: error }, "Platform email test failed");
    await logAdminSecurityEvent(admin.id, "cig_admin.platform_email_test_failed", req.ip);
    res.status(502).json({ status: "failed", error: "Unable to send the test email. Check the deployment email configuration." });
  }
});

router.post("/admin/auth/bootstrap", cigAdminRecoveryLimiter, async (req, res): Promise<void> => {
  const parsed = BootstrapBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Enter a name, email address, and password of at least 12 characters." }); return; }
  const [existingCount] = await db.select({ count: sql<number>`count(*)::int` }).from(cigAdminsTable);
  if ((existingCount?.count ?? 0) > 0) { res.status(403).json({ error: "CIG administrator setup is already complete." }); return; }
  const bootstrapSecret = process.env.PLATFORM_ADMIN_SECRET;
  if (!bootstrapSecret || !secretsMatch(parsed.data.bootstrapSecret, bootstrapSecret)) {
    res.status(403).json({ error: "Invalid setup secret" });
    return;
  }
  const secret = generateSecret();
  const [admin] = await db.insert(cigAdminsTable).values({
    name: parsed.data.name.trim(),
    email: parsed.data.email.toLowerCase(),
    passwordHash: await bcrypt.hash(parsed.data.password, 12),
    role: "master",
    totpSecretEncrypted: encrypt(secret),
  }).returning();
  if (!await beginAdminTotpSetup(req, admin.id)) {
    res.status(403).json({ error: "This administrator account is no longer active." });
    return;
  }
  const uri = generateURI({ issuer: "The Assisted Climb", label: admin.email, secret });
  await logAdminSecurityEvent(admin.id, "cig_admin.bootstrap_started", req.ip);
  res.status(201).json({ qrCode: await QRCode.toDataURL(uri), secret });
});

router.post("/admin/auth/setup-totp", cigAdminTotpLimiter, async (req, res): Promise<void> => {
  const parsed = TotpCodeBody.safeParse(req.body);
  const pendingId = req.session.pendingCigAdminId;
  const pendingSessionVersion = req.session.pendingCigAdminSessionVersion;
  if (!pendingId || pendingSessionVersion === undefined || !parsed.success) { res.status(400).json({ error: "Start administrator setup again." }); return; }
  const [admin] = await db.select().from(cigAdminsTable).where(eq(cigAdminsTable.id, pendingId));
  if (!admin?.active) {
    await clearPendingAdminLogin(req);
    res.status(403).json({ error: "This administrator account is no longer active." });
    return;
  }
  if (admin.sessionVersion !== pendingSessionVersion) {
    await clearPendingAdminLogin(req);
    res.status(403).json({ error: "This administrator account is no longer active." });
    return;
  }
  if (admin?.lockedUntil && admin.lockedUntil > new Date()) {
    await clearPendingAdminLogin(req);
    res.status(429).json({ error: "This account is temporarily locked. Please start again later." });
    return;
  }
  if (!admin?.totpSecretEncrypted || !verifyCigAdminTotp(parsed.data.code, admin.totpSecretEncrypted)) {
    let locked = false;
    if (admin) {
      const [failure] = await db.update(cigAdminsTable).set({
        failedLoginAttempts: sql`${cigAdminsTable.failedLoginAttempts} + 1`,
        lockedUntil: sql`CASE WHEN ${cigAdminsTable.failedLoginAttempts} + 1 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE NULL END`,
      }).where(eq(cigAdminsTable.id, admin.id)).returning({ lockedUntil: cigAdminsTable.lockedUntil });
      locked = Boolean(failure?.lockedUntil);
      if (locked) await clearPendingAdminLogin(req);
    }
    await logAdminSecurityEvent(admin?.id ?? null, locked ? "cig_admin.mfa_setup_locked" : "cig_admin.mfa_setup_failed", req.ip);
    res.status(401).json({ error: "Invalid authenticator code" });
    return;
  }
  const [enabled] = await db.update(cigAdminsTable).set({ totpEnabled: true, failedLoginAttempts: 0, lockedUntil: null })
    .where(and(
      eq(cigAdminsTable.id, admin.id),
      eq(cigAdminsTable.active, true),
      eq(cigAdminsTable.sessionVersion, pendingSessionVersion),
    ))
    .returning({ id: cigAdminsTable.id });
  if (!enabled) {
    await clearPendingAdminLogin(req);
    res.status(403).json({ error: "This administrator account is no longer active." });
    return;
  }
  let recoveryCodes: string[];
  try {
    recoveryCodes = await createRecoveryCodes(admin.id, {
      revokeSessions: false,
      expectedSessionVersion: pendingSessionVersion,
    });
  } catch (error) {
    if (!(error instanceof CigAdminSessionVersionConflict)) throw error;
    await clearPendingAdminLogin(req);
    res.status(403).json({ error: "This administrator account is no longer active." });
    return;
  }
  if (!await completeAdminLogin(req, admin.id, pendingSessionVersion)) {
    res.status(403).json({ error: "This administrator account is no longer active." });
    return;
  }
  await logAdminSecurityEvent(admin.id, "cig_admin.mfa_enabled", req.ip);
  res.json({ recoveryCodes });
});

router.post("/admin/auth/login", cigAdminLoginLimiter, async (req, res): Promise<void> => {
  const parsed = AdminLoginBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Enter your email address and password." }); return; }
  const [admin] = await db.select().from(cigAdminsTable).where(eq(cigAdminsTable.email, parsed.data.email.toLowerCase()));
  if (!admin || !admin.active) { res.status(401).json({ error: "Invalid email or password" }); return; }
  if (admin.lockedUntil && admin.lockedUntil > new Date()) {
    res.status(429).json({ error: "This account is temporarily locked. Please try again later." });
    return;
  }
  if (!await bcrypt.compare(parsed.data.password, admin.passwordHash)) {
    const attempts = admin.failedLoginAttempts + 1;
    const lockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
    await db.update(cigAdminsTable).set({ failedLoginAttempts: attempts, lockedUntil }).where(eq(cigAdminsTable.id, admin.id));
    await logAdminSecurityEvent(admin.id, lockedUntil ? "cig_admin.login_locked" : "cig_admin.login_failed", req.ip);
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  if (!admin.totpSecretEncrypted) {
    res.status(403).json({ error: "Authenticator setup is unavailable. Contact another CIG administrator." });
    return;
  }
  await db.update(cigAdminsTable).set({ failedLoginAttempts: 0, lockedUntil: null }).where(eq(cigAdminsTable.id, admin.id));
  if (!await beginAdminTotpSetup(req, admin.id)) {
    res.status(403).json({ error: "This administrator account is no longer active." });
    return;
  }
  if (!admin.totpEnabled) {
    const secret = decrypt(admin.totpSecretEncrypted);
    const uri = generateURI({ issuer: "The Assisted Climb", label: admin.email, secret });
    res.json({ setupRequired: true, qrCode: await QRCode.toDataURL(uri), secret });
    return;
  }
  res.json({ totpRequired: true });
});

router.post("/admin/auth/verify-totp", cigAdminTotpLimiter, async (req, res): Promise<void> => {
  const parsed = TotpCodeBody.safeParse(req.body);
  const pendingId = req.session.pendingCigAdminId;
  const pendingSessionVersion = req.session.pendingCigAdminSessionVersion;
  if (!pendingId || pendingSessionVersion === undefined || !parsed.success) { res.status(400).json({ error: "Start sign-in again." }); return; }
  const [admin] = await db.select().from(cigAdminsTable).where(eq(cigAdminsTable.id, pendingId));
  if (
    !admin?.active
    || admin.sessionVersion !== pendingSessionVersion
    || !admin.totpSecretEncrypted
    || !verifyCigAdminTotp(parsed.data.code, admin.totpSecretEncrypted)
  ) {
    let locked = false;
    if (admin) {
      const [failure] = await db.update(cigAdminsTable).set({
        failedLoginAttempts: sql`${cigAdminsTable.failedLoginAttempts} + 1`,
        lockedUntil: sql`CASE WHEN ${cigAdminsTable.failedLoginAttempts} + 1 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE NULL END`,
      }).where(eq(cigAdminsTable.id, admin.id)).returning({ lockedUntil: cigAdminsTable.lockedUntil });
      locked = Boolean(failure?.lockedUntil);
      if (locked) await clearPendingAdminLogin(req);
    }
    await logAdminSecurityEvent(admin?.id ?? null, locked ? "cig_admin.totp_locked" : "cig_admin.totp_failed", req.ip);
    res.status(401).json({ error: "Invalid authenticator code" });
    return;
  }
  await db.update(cigAdminsTable).set({ failedLoginAttempts: 0, lockedUntil: null }).where(eq(cigAdminsTable.id, admin.id));
  if (!await completeAdminLogin(req, admin.id, pendingSessionVersion)) {
    res.status(403).json({ error: "This administrator account is no longer active." });
    return;
  }
  await logAdminSecurityEvent(admin.id, "cig_admin.login", req.ip);
  res.json({ ok: true, admin: { name: admin.name, email: admin.email, role: admin.role } });
});

router.post("/admin/auth/step-up", requireAdmin, requireSameOrigin, cigAdminStepUpLimiter, async (req, res): Promise<void> => {
  const parsed = TotpCodeBody.safeParse(req.body);
  const admin = await getSessionAdmin(req);
  if (!parsed.success || !admin?.totpSecretEncrypted || !admin.totpEnabled) {
    res.status(400).json({ error: "Enter a current authenticator code." });
    return;
  }
  if (!verifyCigAdminTotp(parsed.data.code, admin.totpSecretEncrypted)) {
    await logAdminSecurityEvent(admin.id, "cig_admin.step_up_failed", req.ip);
    res.status(401).json({ error: "Invalid authenticator code." });
    return;
  }
  try {
    await writeAdminSecurityEvent(db, admin.id, "cig_admin.step_up_succeeded", req.ip);
    req.session.cigAdminMfaStepUpAt = Date.now();
    req.session.cigAdminMfaStepUpSessionVersion = admin.sessionVersion;
    await new Promise<void>((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
  } catch (error) {
    req.log?.error({ err: error }, "Unable to record administrator MFA step-up");
    res.status(503).json({ error: "Fresh authentication could not be recorded. Please try again." });
    return;
  }
  res.json({ ok: true, expiresAt: new Date(Date.now() + CIG_ADMIN_STEP_UP_TTL_MS).toISOString() });
});

router.get("/admin/auth/me", requireAdmin, async (req, res): Promise<void> => {
  const admin = await getSessionAdmin(req);
  res.json({ admin: { name: admin!.name, email: admin!.email, role: admin!.role } });
});

router.post("/admin/auth/logout", requireAdmin, requireSameOrigin, async (req, res): Promise<void> => {
  const admin = await getSessionAdmin(req);
  if (admin) await logAdminSecurityEvent(admin.id, "cig_admin.logout", req.ip);
  await regenerateAnonymousSessionPreservingSiteAccess(req);
  res.sendStatus(204);
});

router.post("/admin/auth/change-password", requireAdmin, requireFreshAdminMfa, requireSameOrigin, async (req, res): Promise<void> => {
  const parsed = AdminPasswordBody.safeParse(req.body);
  const admin = await getSessionAdmin(req);
  if (!parsed.success || !admin) { res.status(400).json({ error: "Enter your current password and a new password of at least 12 characters." }); return; }
  if (!await bcrypt.compare(parsed.data.currentPassword, admin.passwordHash)) { res.status(401).json({ error: "Current password is incorrect" }); return; }
  const changed = await db.transaction(async (tx) => {
    await acquireCigAdminMutationLock(tx);
    const [updated] = await tx.update(cigAdminsTable).set({
      passwordHash: await bcrypt.hash(parsed.data.newPassword, 12),
      sessionVersion: sql`${cigAdminsTable.sessionVersion} + 1`,
    }).where(and(
      eq(cigAdminsTable.id, admin.id),
      eq(cigAdminsTable.sessionVersion, admin.sessionVersion),
    )).returning({ id: cigAdminsTable.id });
    if (!updated) return false;
    await revokeCigAdminSessions(tx, admin.id);
    return true;
  });
  if (!changed) {
    res.status(401).json({ error: "Your session has expired. Please sign in again." });
    return;
  }
  await logAdminSecurityEvent(admin.id, "cig_admin.password_changed", req.ip);
  res.json({ ok: true });
});

router.post("/admin/auth/cig-admins", requireMaster, requireFreshAdminMfa, requireSameOrigin, async (req, res): Promise<void> => {
  const parsed = CreateCigAdminBody.safeParse(req.body);
  const creator = await getSessionAdmin(req);
  if (!parsed.success || !creator) {
    res.status(400).json({ error: "Enter a name and email address for the CIG sub-admin." });
    return;
  }
  const accountLinkToken = randomBytes(32).toString("base64url");
  const accountLinkExpiresAt = new Date(Date.now() + CIG_ADMIN_ACCOUNT_LINK_TTL_MS);
  const unavailablePasswordHash = await bcrypt.hash(generateTempPassword(), 12);
  const creation = await db.transaction(async (tx) => {
    await acquireCigAdminMutationLock(tx);
    const [currentMaster] = await tx.select({ id: cigAdminsTable.id })
      .from(cigAdminsTable)
      .where(and(
        eq(cigAdminsTable.id, creator.id),
        eq(cigAdminsTable.role, "master"),
        eq(cigAdminsTable.active, true),
        eq(cigAdminsTable.sessionVersion, creator.sessionVersion),
      ));
    if (!currentMaster) return { status: "not-master" as const };
    const [existing] = await tx.select({ id: cigAdminsTable.id })
      .from(cigAdminsTable)
      .where(eq(cigAdminsTable.email, parsed.data.email.toLowerCase()));
    if (existing) return { status: "duplicate" as const };
    const [created] = await tx.insert(cigAdminsTable).values({
      name: parsed.data.name.trim(),
      email: parsed.data.email.toLowerCase(),
      passwordHash: unavailablePasswordHash,
      role: "subadmin",
      totpSecretEncrypted: encrypt(generateSecret()),
      accountLinkTokenHash: hashPasswordResetToken(accountLinkToken),
      accountLinkExpiresAt,
    }).returning({ id: cigAdminsTable.id, name: cigAdminsTable.name, email: cigAdminsTable.email, role: cigAdminsTable.role });
    await writeAdminSecurityEvent(tx, creator.id, "cig_admin.created", req.ip, { createdAdminId: created.id, invitationExpiresAt: accountLinkExpiresAt.toISOString() });
    return { status: "created" as const, created };
  });
  if (creation.status === "not-master") {
    res.status(409).json({ error: "Master access changed. Refresh and try again." });
    return;
  }
  if (creation.status === "duplicate") {
    res.status(409).json({ error: "A CIG administrator with that email already exists." });
    return;
  }
  const { created } = creation;
  let accountLinkUrl: string;
  try {
    accountLinkUrl = `${getAppBaseUrl()}/admin?cigAccountToken=${encodeURIComponent(accountLinkToken)}`;
  } catch {
    res.status(503).json({ error: "The account-link service is unavailable. Check the public application URL and try again." });
    return;
  }
  const emailStatus = await sendCigAdminAccountLinkEmail(created, accountLinkUrl, "invitation");
  if (!await sendMasterSecurityNotice(
    "CIG sub-admin account created",
    `A CIG sub-admin account was created for ${created.email}.`,
    `<p>A CIG sub-admin account was created for <strong>${escapeHtml(created.email)}</strong>.</p>`,
  )) {
    await logAdminSecurityEvent(creator.id, "cig_admin.creation_notification_failed", req.ip, { createdAdminId: created.id });
  }

  res.status(201).json({ admin: created, emailStatus });
});

router.post("/admin/auth/cig-admins/:id/manual-account-link", requireMaster, requireFreshAdminMfa, requireSameOrigin, cigAdminAccountLinkLimiter, async (req, res): Promise<void> => {
  const id = CigAdminIdBody.safeParse({ id: req.params.id });
  const actor = await getSessionAdmin(req);
  if (!id.success || !actor) {
    res.status(400).json({ error: "Choose a valid CIG sub-admin." });
    return;
  }

  let accountLinkUrl: string;
  try {
    const accountLinkToken = randomBytes(32).toString("base64url");
    const accountLinkExpiresAt = new Date(Date.now() + CIG_ADMIN_ACCOUNT_LINK_TTL_MS);
    accountLinkUrl = `${getAppBaseUrl()}/admin?cigAccountToken=${encodeURIComponent(accountLinkToken)}`;

    const mutation = await db.transaction(async (tx) => {
      await acquireCigAdminMutationLock(tx);
      const [currentMaster] = await tx.select({ id: cigAdminsTable.id })
        .from(cigAdminsTable)
        .where(and(
          eq(cigAdminsTable.id, actor.id),
          eq(cigAdminsTable.role, "master"),
          eq(cigAdminsTable.active, true),
          eq(cigAdminsTable.sessionVersion, actor.sessionVersion),
        ));
      if (!currentMaster) return { status: "not-master" as const };

      const [target] = await tx.select({
        id: cigAdminsTable.id,
        name: cigAdminsTable.name,
        email: cigAdminsTable.email,
        role: cigAdminsTable.role,
      }).from(cigAdminsTable).where(and(
        eq(cigAdminsTable.id, id.data.id),
        eq(cigAdminsTable.role, "subadmin"),
        eq(cigAdminsTable.active, true),
      ));
      if (!target) return { status: "missing" as const };

      const [updated] = await tx.update(cigAdminsTable).set({
        accountLinkTokenHash: hashPasswordResetToken(accountLinkToken),
        accountLinkExpiresAt,
      }).where(and(
        eq(cigAdminsTable.id, target.id),
        eq(cigAdminsTable.role, "subadmin"),
        eq(cigAdminsTable.active, true),
      )).returning({
        id: cigAdminsTable.id,
        name: cigAdminsTable.name,
        email: cigAdminsTable.email,
        role: cigAdminsTable.role,
      });
      if (!updated) return { status: "conflict" as const };

      await writeAdminSecurityEvent(tx, actor.id, "cig_admin.manual_account_link_created", req.ip, {
        targetAdminId: target.id,
        accountLinkExpiresAt: accountLinkExpiresAt.toISOString(),
      });
      return { status: "updated" as const, updated, accountLinkExpiresAt };
    });

    if (mutation.status === "missing") {
      res.status(404).json({ error: "Active CIG sub-admin not found." });
      return;
    }
    if (mutation.status !== "updated") {
      res.status(409).json({ error: "Master access or the sub-admin account changed. Refresh and try again." });
      return;
    }
    res.json({
      ok: true,
      admin: mutation.updated,
      manualAccountLinkUrl: accountLinkUrl,
      expiresAt: mutation.accountLinkExpiresAt.toISOString(),
    });
  } catch {
    res.status(503).json({ error: "The manual account-link service is unavailable. Check the public application URL and try again." });
  }
});

router.post("/admin/auth/claim-account-link", cigAdminRecoveryLimiter, async (req, res): Promise<void> => {
  const parsed = CigAdminAccountLinkBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Use a valid account link and a password of at least 12 characters." });
    return;
  }
  const tokenHash = hashPasswordResetToken(parsed.data.token);
  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  const accepted = await db.transaction(async (tx) => {
    await acquireCigAdminMutationLock(tx);
    const [admin] = await tx.update(cigAdminsTable).set({
      passwordHash,
      accountLinkTokenHash: null,
      accountLinkExpiresAt: null,
      failedLoginAttempts: 0,
      lockedUntil: null,
      recoveryFailedAttempts: 0,
      recoveryLockedUntil: null,
      sessionVersion: sql`${cigAdminsTable.sessionVersion} + 1`,
    }).where(and(
      eq(cigAdminsTable.accountLinkTokenHash, tokenHash),
      gt(cigAdminsTable.accountLinkExpiresAt, new Date()),
      eq(cigAdminsTable.active, true),
    )).returning({
      id: cigAdminsTable.id,
      email: cigAdminsTable.email,
      sessionVersion: cigAdminsTable.sessionVersion,
      totpSecretEncrypted: cigAdminsTable.totpSecretEncrypted,
      totpEnabled: cigAdminsTable.totpEnabled,
    });
    if (!admin?.totpSecretEncrypted) return null;
    await revokeCigAdminSessions(tx, admin.id);
    await writeAdminSecurityEvent(tx, admin.id, "cig_admin.account_link_claimed", req.ip, {
      mfaSetupRequired: !admin.totpEnabled,
    });
    return admin;
  });
  if (!accepted) {
    res.status(400).json({ error: "This account link is invalid, expired, already used, or the account is unavailable." });
    return;
  }
  if (!await beginAdminTotpSetup(req, accepted.id)) {
    res.status(403).json({ error: "This account is no longer active. Contact the Master CIG administrator." });
    return;
  }
  if (!accepted.totpEnabled) {
    const encryptedTotpSecret = accepted.totpSecretEncrypted;
    if (!encryptedTotpSecret) {
      res.status(403).json({ error: "Authenticator setup is unavailable. Contact the Master CIG administrator." });
      return;
    }
    const secret = decrypt(encryptedTotpSecret);
    const uri = generateURI({ issuer: "The Assisted Climb", label: accepted.email, secret });
    res.json({ setupRequired: true, qrCode: await QRCode.toDataURL(uri), secret });
    return;
  }
  res.json({ ok: true, totpRequired: true });
});

router.get("/admin/auth/cig-admins", requireMaster, async (req, res): Promise<void> => {
  const query = DirectoryQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Use valid administrator search, status, date, and pagination filters." });
    return;
  }
  const { q, status, from, to, page, pageSize } = query.data;
  if (from && to && from > to) {
    res.status(400).json({ error: "The start date must be before the end date." });
    return;
  }
  if (status === "deleted") {
    const conditions = [
      from ? gte(cigAdminDeletionShadowsTable.deletedAt, new Date(`${from}T00:00:00.000Z`)) : undefined,
      to ? lte(cigAdminDeletionShadowsTable.deletedAt, new Date(`${to}T23:59:59.999Z`)) : undefined,
      q ? sql`(${cigAdminDeletionShadowsTable.name} ILIKE ${`%${q}%`} OR ${cigAdminDeletionShadowsTable.email} ILIKE ${`%${q}%`})` : undefined,
    ].filter(Boolean);
    const where = conditions.length ? and(...conditions) : undefined;
    const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(cigAdminDeletionShadowsTable).where(where);
    const rows = await db.select().from(cigAdminDeletionShadowsTable).where(where).orderBy(desc(cigAdminDeletionShadowsTable.deletedAt)).limit(pageSize).offset((page - 1) * pageSize);
    const total = countRow?.count ?? 0;
    const items = rows.map((shadow) => ({ id: shadow.cigAdminId, name: shadow.name, email: shadow.email, role: "subadmin" as const, active: false, totpEnabled: false, createdAt: shadow.deletedAt, deleted: true as const, deletedAt: shadow.deletedAt }));
    res.json({ admins: items, items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
    return;
  }
  const conditions = [
    status === "active" ? eq(cigAdminsTable.active, true) : status === "suspended" ? eq(cigAdminsTable.active, false) : undefined,
    from ? gte(cigAdminsTable.createdAt, new Date(`${from}T00:00:00.000Z`)) : undefined,
    to ? lte(cigAdminsTable.createdAt, new Date(`${to}T23:59:59.999Z`)) : undefined,
    q ? sql`(${cigAdminsTable.name} ILIKE ${`%${q}%`} OR ${cigAdminsTable.email} ILIKE ${`%${q}%`})` : undefined,
  ].filter(Boolean);
  const where = conditions.length ? and(...conditions) : undefined;
  const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(cigAdminsTable).where(where);
  const pageItems = await db.select({
    id: cigAdminsTable.id, name: cigAdminsTable.name, email: cigAdminsTable.email, role: cigAdminsTable.role,
    active: cigAdminsTable.active, totpEnabled: cigAdminsTable.totpEnabled, createdAt: cigAdminsTable.createdAt,
    deleted: sql<boolean>`false`, deletedAt: sql<Date | null>`NULL`,
  }).from(cigAdminsTable).where(where).orderBy(desc(cigAdminsTable.createdAt)).limit(pageSize).offset((page - 1) * pageSize);
  const pageTotal = countRow?.count ?? 0;
  res.json({ admins: pageItems, items: pageItems, total: pageTotal, page, pageSize, totalPages: Math.max(1, Math.ceil(pageTotal / pageSize)) });
  return;
  const [admins, deletionShadows] = await Promise.all([
    db.select({
    id: cigAdminsTable.id,
    name: cigAdminsTable.name,
    email: cigAdminsTable.email,
    role: cigAdminsTable.role,
    active: cigAdminsTable.active,
    totpEnabled: cigAdminsTable.totpEnabled,
    createdAt: cigAdminsTable.createdAt,
    deleted: sql<boolean>`false`,
    deletedAt: sql<Date | null>`NULL`,
  }).from(cigAdminsTable).orderBy(cigAdminsTable.createdAt),
    db.select().from(cigAdminDeletionShadowsTable).orderBy(cigAdminDeletionShadowsTable.deletedAt),
  ]);
  const deletedAdmins = deletionShadows.map((shadow) => ({
    id: shadow.cigAdminId,
    name: shadow.name,
    email: shadow.email,
    role: "subadmin" as const,
    active: false,
    totpEnabled: false,
    createdAt: shadow.deletedAt,
    deleted: true as const,
    deletedAt: shadow.deletedAt,
  }));
  const needle = q.toLocaleLowerCase();
  const matching = [...admins, ...deletedAdmins]
    .filter((admin) => {
      const statusMatch = (status === "deleted" && admin.deleted)
        || (status === "active" && !admin.deleted && admin.active)
        || (status === "suspended" && !admin.deleted && !admin.active);
      const date = new Date(admin.deleted ? admin.deletedAt! : admin.createdAt).toISOString().slice(0, 10);
      return statusMatch
        && (!needle || `${admin.name} ${admin.email}`.toLocaleLowerCase().includes(needle))
        && (!from || date >= from)
        && (!to || date <= to);
    })
    .sort((left, right) => new Date(right.deleted ? right.deletedAt! : right.createdAt).getTime() - new Date(left.deleted ? left.deletedAt! : left.createdAt).getTime());
  const total = matching.length;
  const items = matching.slice((page - 1) * pageSize, page * pageSize);
  res.json({ admins: items, items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
});

router.patch("/admin/auth/cig-admins/:id/active", requireMaster, requireFreshAdminMfa, requireSameOrigin, async (req, res): Promise<void> => {
  const id = CigAdminIdBody.safeParse({ id: req.params.id });
  const parsed = CigAdminActiveBody.safeParse(req.body);
  const actor = await getSessionAdmin(req);
  if (!id.success || !parsed.success || !actor) {
    res.status(400).json({ error: "Enter a valid administrator and status." });
    return;
  }
  const mutation = await db.transaction(async (tx) => {
    await acquireCigAdminMutationLock(tx);
    const [currentMaster] = await tx.select({ id: cigAdminsTable.id }).from(cigAdminsTable)
      .where(and(
        eq(cigAdminsTable.id, actor.id),
        eq(cigAdminsTable.role, "master"),
        eq(cigAdminsTable.active, true),
        eq(cigAdminsTable.sessionVersion, actor.sessionVersion),
      ));
    if (!currentMaster) return { status: "not-master" as const };
    const [target] = await tx.select({
      id: cigAdminsTable.id,
      name: cigAdminsTable.name,
      email: cigAdminsTable.email,
      role: cigAdminsTable.role,
    }).from(cigAdminsTable)
      .where(eq(cigAdminsTable.id, id.data.id));
    if (!target) return { status: "missing" as const };
    if (target.role !== "subadmin") return { status: "protected" as const };
    const [updated] = await tx.update(cigAdminsTable).set({ active: parsed.data.active })
      .where(and(eq(cigAdminsTable.id, target.id), eq(cigAdminsTable.role, "subadmin")))
      .returning({ id: cigAdminsTable.id, name: cigAdminsTable.name, email: cigAdminsTable.email, role: cigAdminsTable.role, active: cigAdminsTable.active });
    if (!updated) return { status: "conflict" as const };
    return { status: "updated" as const, updated };
  });
  if (mutation.status === "missing") {
    res.status(404).json({ error: "CIG administrator not found." });
    return;
  }
  if (mutation.status !== "updated") {
    res.status(409).json({ error: mutation.status === "protected" ? "The Master CIG administrator cannot be disabled." : "Master access changed. Refresh and try again." });
    return;
  }
  const { updated } = mutation;
  await logAdminSecurityEvent(actor.id, parsed.data.active ? "cig_admin.subadmin_activated" : "cig_admin.subadmin_disabled", req.ip, { targetAdminId: id.data.id });
  res.json({ admin: updated });
});

router.patch("/admin/auth/cig-admins/:id/role", requireMaster, requireFreshAdminMfa, requireSameOrigin, async (req, res): Promise<void> => {
  const id = CigAdminIdBody.safeParse({ id: req.params.id });
  const parsed = CigAdminRoleBody.safeParse(req.body);
  const actor = await getSessionAdmin(req);
  if (!id.success || !parsed.success || !actor) {
    res.status(400).json({ error: "Enter a valid administrator role change." });
    return;
  }
  if (id.data.id === actor.id) {
    res.status(400).json({ error: "Choose an active sub-admin to transfer Master responsibility." });
    return;
  }
  if (parsed.data.role !== "master") {
    res.status(400).json({ error: "There must always be one Master CIG administrator. Transfer responsibility instead." });
    return;
  }
  let transferred: { id: number; name: string; email: string; role: "master" | "subadmin" } | null = null;
  try {
    transferred = await db.transaction(async (tx) => {
      await acquireCigAdminMutationLock(tx);
      const [currentMaster] = await tx.select({ id: cigAdminsTable.id }).from(cigAdminsTable)
        .where(and(
          eq(cigAdminsTable.id, actor.id),
          eq(cigAdminsTable.role, "master"),
          eq(cigAdminsTable.active, true),
          eq(cigAdminsTable.sessionVersion, actor.sessionVersion),
        ));
      if (!currentMaster) return null;
    const [candidate] = await tx.select({
      id: cigAdminsTable.id,
      name: cigAdminsTable.name,
      email: cigAdminsTable.email,
      role: cigAdminsTable.role,
      active: cigAdminsTable.active,
    }).from(cigAdminsTable).where(eq(cigAdminsTable.id, id.data.id));
    if (!candidate || !candidate.active || candidate.role !== "subadmin") return null;

    const [demoted] = await tx.update(cigAdminsTable).set({ role: "subadmin" })
      .where(and(eq(cigAdminsTable.id, actor.id), eq(cigAdminsTable.role, "master"), eq(cigAdminsTable.active, true)))
      .returning({ id: cigAdminsTable.id });
    if (!demoted) throw new MasterMutationConflict();

    const [promoted] = await tx.update(cigAdminsTable).set({ role: "master" })
      .where(and(eq(cigAdminsTable.id, candidate.id), eq(cigAdminsTable.role, "subadmin"), eq(cigAdminsTable.active, true)))
      .returning({ id: cigAdminsTable.id, name: cigAdminsTable.name, email: cigAdminsTable.email, role: cigAdminsTable.role });
      if (!promoted) throw new MasterMutationConflict();
      await writeAdminSecurityEvent(tx, actor.id, "cig_admin.master_transferred", req.ip, { successorAdminId: promoted.id });
      return promoted;
    });
  } catch (error) {
    if (!(error instanceof MasterMutationConflict)) throw error;
  }
  if (!transferred) {
    res.status(409).json({ error: "Master responsibility could not be transferred. Check that the selected sub-admin is active." });
    return;
  }
  if (!await sendMasterSecurityNotice(
    "CIG Master responsibility transferred",
    `Master CIG administrator responsibility was transferred to ${transferred.email}.`,
    `<p>Master CIG administrator responsibility was transferred to <strong>${escapeHtml(transferred.email)}</strong>.</p>`,
  )) {
    await logAdminSecurityEvent(actor.id, "cig_admin.master_transfer_notification_failed", req.ip, { successorAdminId: transferred.id });
  }
  res.json({ admin: transferred });
});

router.post("/admin/auth/cig-admins/:id/reset-password", requireMaster, requireFreshAdminMfa, requireSameOrigin, async (req, res): Promise<void> => {
  const id = CigAdminIdBody.safeParse({ id: req.params.id });
  const actor = await getSessionAdmin(req);
  if (!id.success || !actor) {
    res.status(400).json({ error: "Enter a valid CIG administrator." });
    return;
  }
  const accountLinkToken = randomBytes(32).toString("base64url");
  const accountLinkExpiresAt = new Date(Date.now() + CIG_ADMIN_ACCOUNT_LINK_TTL_MS);
  const unavailablePasswordHash = await bcrypt.hash(generateTempPassword(), 12);
  const mutation = await db.transaction(async (tx) => {
    await acquireCigAdminMutationLock(tx);
    const [currentMaster] = await tx.select({ id: cigAdminsTable.id }).from(cigAdminsTable)
      .where(and(
        eq(cigAdminsTable.id, actor.id),
        eq(cigAdminsTable.role, "master"),
        eq(cigAdminsTable.active, true),
        eq(cigAdminsTable.sessionVersion, actor.sessionVersion),
      ));
    if (!currentMaster) return { status: "not-master" as const };
    const [target] = await tx.select({ id: cigAdminsTable.id, name: cigAdminsTable.name, email: cigAdminsTable.email, role: cigAdminsTable.role })
      .from(cigAdminsTable).where(eq(cigAdminsTable.id, id.data.id));
    if (!target) return { status: "missing" as const };
    if (target.role !== "subadmin") return { status: "protected" as const };
    const [updated] = await tx.update(cigAdminsTable).set({
      passwordHash: unavailablePasswordHash,
      accountLinkTokenHash: hashPasswordResetToken(accountLinkToken),
      accountLinkExpiresAt,
      sessionVersion: sql`${cigAdminsTable.sessionVersion} + 1`,
      failedLoginAttempts: 0,
      lockedUntil: null,
      recoveryFailedAttempts: 0,
      recoveryLockedUntil: null,
    }).where(and(eq(cigAdminsTable.id, target.id), eq(cigAdminsTable.role, "subadmin")))
      .returning({ id: cigAdminsTable.id });
    if (!updated) return { status: "conflict" as const };
    await revokeCigAdminSessions(tx, target.id);
    await writeAdminSecurityEvent(tx, actor.id, "cig_admin.subadmin_password_reset", req.ip, {
      targetAdminId: target.id,
      accountLinkExpiresAt: accountLinkExpiresAt.toISOString(),
    });
    return { status: "updated" as const, target };
  });
  if (mutation.status === "missing") {
    res.status(404).json({ error: "CIG administrator not found." });
    return;
  }
  if (mutation.status !== "updated") {
    res.status(409).json({ error: mutation.status === "protected" ? "The Master CIG administrator's password cannot be changed by another administrator." : "Master access changed. Refresh and try again." });
    return;
  }
  const { target } = mutation;
  let accountLinkUrl: string;
  try {
    accountLinkUrl = `${getAppBaseUrl()}/admin?cigAccountToken=${encodeURIComponent(accountLinkToken)}`;
  } catch {
    res.status(503).json({ error: "The account-link service is unavailable. Check the public application URL and try again." });
    return;
  }
  const emailStatus = await sendCigAdminAccountLinkEmail(target, accountLinkUrl, "password-reset");
  res.json({ ok: true, emailStatus });
});

router.post("/admin/auth/cig-admins/:id/reset-mfa", requireMaster, requireFreshAdminMfa, requireSameOrigin, async (req, res): Promise<void> => {
  const id = CigAdminIdBody.safeParse({ id: req.params.id });
  const actor = await getSessionAdmin(req);
  if (!id.success || !actor) {
    res.status(400).json({ error: "Enter a valid CIG administrator." });
    return;
  }
  const newTotpSecret = encrypt(generateSecret());
  const mutation = await db.transaction(async (tx) => {
    await acquireCigAdminMutationLock(tx);
    const [currentMaster] = await tx.select({ id: cigAdminsTable.id }).from(cigAdminsTable)
      .where(and(
        eq(cigAdminsTable.id, actor.id),
        eq(cigAdminsTable.role, "master"),
        eq(cigAdminsTable.active, true),
        eq(cigAdminsTable.sessionVersion, actor.sessionVersion),
      ));
    if (!currentMaster) return { status: "not-master" as const };
    const [target] = await tx.select({ id: cigAdminsTable.id, name: cigAdminsTable.name, email: cigAdminsTable.email, role: cigAdminsTable.role })
      .from(cigAdminsTable).where(eq(cigAdminsTable.id, id.data.id));
    if (!target) return { status: "missing" as const };
    if (target.role !== "subadmin") return { status: "protected" as const };
    const [updated] = await tx.update(cigAdminsTable).set({
      totpSecretEncrypted: newTotpSecret,
      totpEnabled: false,
      sessionVersion: sql`${cigAdminsTable.sessionVersion} + 1`,
      failedLoginAttempts: 0,
      lockedUntil: null,
    }).where(and(eq(cigAdminsTable.id, target.id), eq(cigAdminsTable.role, "subadmin")))
      .returning({ id: cigAdminsTable.id });
    if (!updated) return { status: "conflict" as const };
    await tx.update(cigAdminRecoveryCodesTable).set({ usedAt: new Date() })
      .where(and(eq(cigAdminRecoveryCodesTable.adminId, target.id), sql`${cigAdminRecoveryCodesTable.usedAt} IS NULL`));
    await revokeCigAdminSessions(tx, target.id);
    await writeAdminSecurityEvent(tx, actor.id, "cig_admin.subadmin_mfa_reset", req.ip, { targetAdminId: target.id });
    return { status: "updated" as const, target };
  });
  if (mutation.status === "missing") {
    res.status(404).json({ error: "CIG administrator not found." });
    return;
  }
  if (mutation.status !== "updated") {
    res.status(409).json({ error: mutation.status === "protected" ? "The Master CIG administrator's authenticator cannot be reset by another administrator." : "Master access changed. Refresh and try again." });
    return;
  }
  const { target } = mutation;
  let emailStatus: EmailStatus = "not-configured";
  if (isEmailConfigured()) {
    try {
      await sendEmail({
        to: target.email,
        subject: "Your CIG sub-admin authenticator was reset",
        text: `Your CIG sub-admin authenticator was reset by the Master CIG administrator. Sign in to The Assisted Climb with your password to set up a new authenticator app. If you did not expect this, contact the Master CIG administrator immediately.`,
        html: `<p>Your CIG sub-admin authenticator was reset by the Master CIG administrator.</p><p>Sign in to The Assisted Climb with your password to set up a new authenticator app. If you did not expect this, contact the Master CIG administrator immediately.</p>`,
      });
      emailStatus = "sent";
    } catch {
      emailStatus = "failed";
    }
  }
  res.json({ ok: true, emailStatus });
});

router.delete("/admin/auth/cig-admins/:id", requireMaster, requireFreshAdminMfa, requireSameOrigin, async (req, res): Promise<void> => {
  const id = CigAdminIdBody.safeParse({ id: req.params.id });
  const actor = await getSessionAdmin(req);
  if (!id.success || !actor) {
    res.status(400).json({ error: "Enter a valid CIG administrator." });
    return;
  }
  const mutation = await db.transaction(async (tx) => {
    await acquireCigAdminMutationLock(tx);
    const [currentMaster] = await tx.select({ id: cigAdminsTable.id }).from(cigAdminsTable)
      .where(and(eq(cigAdminsTable.id, actor.id), eq(cigAdminsTable.role, "master"), eq(cigAdminsTable.active, true)));
    if (!currentMaster) return { status: "not-master" as const };
    const [target] = await tx.select({
      id: cigAdminsTable.id,
      name: cigAdminsTable.name,
      email: cigAdminsTable.email,
      role: cigAdminsTable.role,
    }).from(cigAdminsTable)
      .where(eq(cigAdminsTable.id, id.data.id));
    if (!target) return { status: "missing" as const };
    if (target.role !== "subadmin") return { status: "protected" as const };
    await tx.insert(cigAdminDeletionShadowsTable).values({
      cigAdminId: target.id,
      name: target.name,
      email: target.email,
      deletedByCigAdminId: actor.id,
    });
    const [removed] = await tx.delete(cigAdminsTable)
      .where(and(eq(cigAdminsTable.id, target.id), eq(cigAdminsTable.role, "subadmin")))
      .returning({ id: cigAdminsTable.id });
    if (!removed) return { status: "conflict" as const };
    await writeAdminSecurityEvent(tx, actor.id, "cig_admin.subadmin_removed", req.ip, { removedAdminId: target.id });
    return { status: "removed" as const, targetId: target.id };
  });
  if (mutation.status === "missing") {
    res.status(404).json({ error: "CIG administrator not found." });
    return;
  }
  if (mutation.status !== "removed") {
    res.status(409).json({ error: mutation.status === "protected" ? "The Master CIG administrator cannot be removed." : "Master access changed. Refresh and try again." });
    return;
  }
  res.json({ ok: true });
});

router.post("/admin/auth/regenerate-recovery-codes", requireAdmin, requireFreshAdminMfa, requireSameOrigin, async (req, res): Promise<void> => {
  const admin = await getSessionAdmin(req);
  if (!admin) {
    res.status(401).json({ error: "CIG administrator sign-in required" });
    return;
  }
  let recoveryCodes: string[];
  try {
    recoveryCodes = await createRecoveryCodes(admin.id, {
      expectedSessionVersion: admin.sessionVersion,
      securityEvent: { action: "cig_admin.recovery_codes_rotated", ipAddress: req.ip },
    });
  } catch (error) {
    if (!(error instanceof CigAdminSessionVersionConflict)) throw error;
    res.status(401).json({ error: "Your session has expired. Please sign in again." });
    return;
  }
  res.json({ recoveryCodes });
});

router.post("/admin/auth/recover-device", cigAdminRecoveryLimiter, async (req, res): Promise<void> => {
  const parsed = DeviceRecoveryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter your email address and one recovery code." });
    return;
  }
  const [admin] = await db.select().from(cigAdminsTable).where(eq(cigAdminsTable.email, parsed.data.email.toLowerCase()));
  if (!admin || !admin.active || (admin.recoveryLockedUntil && admin.recoveryLockedUntil > new Date())) {
    res.status(400).json({ error: "Unable to verify this recovery request." });
    return;
  }

  const codes = await db.select().from(cigAdminRecoveryCodesTable)
    .where(and(eq(cigAdminRecoveryCodesTable.adminId, admin.id), sql`${cigAdminRecoveryCodesTable.usedAt} IS NULL`));
  let matchedCodeId: number | null = null;
  for (const code of codes) {
    if (await bcrypt.compare(parsed.data.recoveryCode, code.codeHash)) {
      matchedCodeId = code.id;
      break;
    }
  }
  if (!matchedCodeId) {
    const [failure] = await db.update(cigAdminsTable).set({
      recoveryFailedAttempts: sql`${cigAdminsTable.recoveryFailedAttempts} + 1`,
      recoveryLockedUntil: sql`CASE WHEN ${cigAdminsTable.recoveryFailedAttempts} + 1 >= 3 THEN NOW() + INTERVAL '15 minutes' ELSE NULL END`,
    }).where(eq(cigAdminsTable.id, admin.id)).returning({ recoveryLockedUntil: cigAdminsTable.recoveryLockedUntil });
    await logAdminSecurityEvent(admin.id, failure?.recoveryLockedUntil ? "cig_admin.device_recovery_locked" : "cig_admin.device_recovery_failed", req.ip);
    res.status(401).json({ error: getRecoveryVerificationError(admin, parsed.data.recoveryCode) });
    return;
  }

  const secret = generateSecret();
  let recovered = false;
  try {
    recovered = await db.transaction(async (tx) => {
      await acquireCigAdminMutationLock(tx);
      const [activeAdmin] = await tx.select({ id: cigAdminsTable.id }).from(cigAdminsTable)
        .where(and(
          eq(cigAdminsTable.id, admin.id),
          eq(cigAdminsTable.active, true),
          eq(cigAdminsTable.sessionVersion, admin.sessionVersion),
        ));
      if (!activeAdmin) return false;
      const [claimed] = await tx.update(cigAdminRecoveryCodesTable)
        .set({ usedAt: new Date() })
        .where(and(eq(cigAdminRecoveryCodesTable.id, matchedCodeId), sql`${cigAdminRecoveryCodesTable.usedAt} IS NULL`))
        .returning({ id: cigAdminRecoveryCodesTable.id });
      if (!claimed) return false;
      await tx.update(cigAdminRecoveryCodesTable).set({ usedAt: new Date() })
        .where(and(eq(cigAdminRecoveryCodesTable.adminId, admin.id), sql`${cigAdminRecoveryCodesTable.usedAt} IS NULL`));
      const [updated] = await tx.update(cigAdminsTable).set({
        totpSecretEncrypted: encrypt(secret),
        totpEnabled: false,
        sessionVersion: sql`${cigAdminsTable.sessionVersion} + 1`,
        failedLoginAttempts: 0,
        lockedUntil: null,
        recoveryFailedAttempts: 0,
        recoveryLockedUntil: null,
      }).where(and(eq(cigAdminsTable.id, admin.id), eq(cigAdminsTable.active, true)))
        .returning({ id: cigAdminsTable.id });
      if (!updated) throw new MasterMutationConflict();
      await revokeCigAdminSessions(tx, admin.id);
      return true;
    });
  } catch (error) {
    if (!(error instanceof MasterMutationConflict)) throw error;
  }
  if (!recovered) {
    res.status(401).json({ error: "Unable to verify this recovery request." });
    return;
  }

  if (!await beginAdminTotpSetup(req, admin.id)) {
    res.status(401).json({ error: "Unable to verify this recovery request." });
    return;
  }
  await logAdminSecurityEvent(admin.id, "cig_admin.device_recovery_started", req.ip, { role: admin.role });
  const message = `A CIG administrator device recovery was started for ${admin.email}. A new authenticator must now be enrolled.`;
  if (!await sendMasterSecurityNotice(
    "CIG administrator device recovery started",
    message,
    `<p>${escapeHtml(message)}</p>`,
  )) {
    await logAdminSecurityEvent(admin.id, "cig_admin.device_recovery_notification_failed", req.ip);
  }
  if (isEmailConfigured() && process.env.CIG_SECURITY_EMAIL?.toLowerCase() !== admin.email.toLowerCase()) {
    try {
      await sendEmail({
        to: admin.email,
        subject: "CIG administrator device recovery started",
        text: `${message} If this was not you, contact the Master CIG administrator immediately.`,
        html: `<p>${escapeHtml(message)}</p><p>If this was not you, contact the Master CIG administrator immediately.</p>`,
      });
    } catch {
      await logAdminSecurityEvent(admin.id, "cig_admin.device_recovery_account_notification_failed", req.ip);
    }
  }
  const uri = generateURI({ issuer: "The Assisted Climb", label: admin.email, secret });
  res.json({ qrCode: await QRCode.toDataURL(uri), secret });
});

router.post("/admin/auth/recover", cigAdminRecoveryLimiter, async (req, res): Promise<void> => {
  const parsed = AdminRecoveryBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Enter your email, new password, and either an authenticator or recovery code." }); return; }
  const [admin] = await db.select().from(cigAdminsTable).where(eq(cigAdminsTable.email, parsed.data.email.toLowerCase()));
  if (!admin || !admin.active) { res.status(400).json({ error: "Unable to verify this recovery request." }); return; }
  if (admin.recoveryLockedUntil && admin.recoveryLockedUntil > new Date()) {
    res.status(429).json({ error: "Password recovery is temporarily locked. Please try again later." });
    return;
  }
  let verified = false;
  let matchedRecoveryCodeId: number | null = null;
  if (parsed.data.totpCode && admin.totpSecretEncrypted) {
    verified = verifyCigAdminTotp(parsed.data.totpCode, admin.totpSecretEncrypted);
  } else if (parsed.data.recoveryCode) {
    const codes = await db.select().from(cigAdminRecoveryCodesTable)
      .where(and(eq(cigAdminRecoveryCodesTable.adminId, admin.id), sql`${cigAdminRecoveryCodesTable.usedAt} IS NULL`));
    for (const code of codes) {
      if (await bcrypt.compare(parsed.data.recoveryCode, code.codeHash)) {
        verified = true;
        matchedRecoveryCodeId = code.id;
        break;
      }
    }
  }
  if (!verified) {
    const [failure] = await db.update(cigAdminsTable).set({
      recoveryFailedAttempts: sql`${cigAdminsTable.recoveryFailedAttempts} + 1`,
      recoveryLockedUntil: sql`CASE WHEN ${cigAdminsTable.recoveryFailedAttempts} + 1 >= 3 THEN NOW() + INTERVAL '15 minutes' ELSE NULL END`,
    }).where(eq(cigAdminsTable.id, admin.id)).returning({ recoveryLockedUntil: cigAdminsTable.recoveryLockedUntil });
    await logAdminSecurityEvent(admin.id, failure?.recoveryLockedUntil ? "cig_admin.recovery_locked" : "cig_admin.recovery_failed", req.ip);
    res.status(401).json({
      error: parsed.data.recoveryCode
        ? getRecoveryVerificationError(admin, parsed.data.recoveryCode)
        : GENERIC_RECOVERY_ERROR,
    });
    return;
  }
  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
  const recovered = await db.transaction(async (tx) => {
    await acquireCigAdminMutationLock(tx);
    const [activeAdmin] = await tx.select({ id: cigAdminsTable.id }).from(cigAdminsTable)
      .where(and(
        eq(cigAdminsTable.id, admin.id),
        eq(cigAdminsTable.active, true),
        eq(cigAdminsTable.sessionVersion, admin.sessionVersion),
      ));
    if (!activeAdmin) return false;
    if (matchedRecoveryCodeId) {
      const [claimed] = await tx.update(cigAdminRecoveryCodesTable)
        .set({ usedAt: new Date() })
        .where(and(eq(cigAdminRecoveryCodesTable.id, matchedRecoveryCodeId), sql`${cigAdminRecoveryCodesTable.usedAt} IS NULL`))
        .returning({ id: cigAdminRecoveryCodesTable.id });
      if (!claimed) return false;
    }
    await tx.update(cigAdminsTable).set({
      passwordHash,
      sessionVersion: sql`${cigAdminsTable.sessionVersion} + 1`,
      recoveryFailedAttempts: 0,
      recoveryLockedUntil: null,
    }).where(eq(cigAdminsTable.id, admin.id));
    await revokeCigAdminSessions(tx, admin.id);
    return true;
  });
  if (!recovered) {
    res.status(401).json({ error: "Unable to verify this recovery request." });
    return;
  }
  await logAdminSecurityEvent(admin.id, "cig_admin.password_recovered", req.ip, { method: matchedRecoveryCodeId ? "recovery_code" : "totp" });
  const recoveryNotice = `A CIG administrator password recovery was completed for ${admin.email}. If this was not expected, change the account password and regenerate recovery codes immediately.`;
  if (!await sendMasterSecurityNotice(
    "CIG administrator password recovery used",
    recoveryNotice,
    `<p>${escapeHtml(recoveryNotice)}</p>`,
  )) {
    await logAdminSecurityEvent(admin.id, "cig_admin.recovery_notification_failed", req.ip);
  }
  if (isEmailConfigured() && process.env.CIG_SECURITY_EMAIL?.toLowerCase() !== admin.email.toLowerCase()) {
    try {
      await sendEmail({
        to: admin.email,
        subject: "CIG administrator password recovery used",
        text: recoveryNotice,
        html: `<p>${escapeHtml(recoveryNotice)}</p>`,
      });
    } catch {
      await logAdminSecurityEvent(admin.id, "cig_admin.recovery_account_notification_failed", req.ip);
    }
  }
  res.json({ ok: true });
});

function generateInviteCode(): string {
  return randomBytes(4).toString("hex").toUpperCase();
}

const CreateOrgBody = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/,
    "Slug must use lowercase letters, numbers, hyphens, and dots, without leading or trailing separators",
  ),
  itAdminEmail: z.string().email(),
  itAdminPassword: z.string().min(12),
  itAdminName: z.string().min(1),
  acceptHibpWarning: z.boolean().optional().default(false),
});

router.post("/admin/organisations", requireMaster, requireSameOrigin, async (req, res): Promise<void> => {
  const parsed = CreateOrgBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, slug, itAdminEmail, itAdminPassword, itAdminName } = parsed.data;
  const passwordPolicy = await checkPasswordPolicy(itAdminPassword);
  if (!passwordPolicy.ok) {
    res.status(400).json({ error: passwordPolicy.error });
    return;
  }
  if (passwordPolicy.warningCode === HIBP_UNAVAILABLE_CODE && !parsed.data.acceptHibpWarning) {
    res.status(409).json({
      error: passwordPolicy.warning,
      code: HIBP_UNAVAILABLE_CODE,
      warning: passwordPolicy.warning,
    });
    return;
  }

  const [existing] = await db
    .select({ id: organisationsTable.id })
    .from(organisationsTable)
    .where(eq(organisationsTable.slug, slug));

  if (existing) {
    res.status(409).json({ error: "Slug already in use" });
    return;
  }

  const [existingEmail] = await db
    .select({ id: teachersTable.id })
    .from(teachersTable)
    .where(eq(teachersTable.email, itAdminEmail.toLowerCase()));

  if (existingEmail) {
    res.status(409).json({ error: "IT admin email already in use" });
    return;
  }

  const teacherInviteCode = generateInviteCode();

  const [org] = await db
    .insert(organisationsTable)
    .values({ name, slug, active: true, teacherInviteCode })
    .returning();

  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.hash(itAdminPassword, 12);

  const [itAdmin] = await db
    .insert(teachersTable)
    .values({
      organisationId: org.id,
      email: itAdminEmail.toLowerCase(),
      passwordHash,
      name: itAdminName,
      isItAdmin: true,
      schoolAdminRole: "master",
      approvalStatus: "approved",
    })
    .returning({ id: teachersTable.id, email: teachersTable.email, name: teachersTable.name });
  await recordTeacherPassword(itAdmin.id, passwordHash);
  if (passwordPolicy.warningCode === HIBP_UNAVAILABLE_CODE && parsed.data.acceptHibpWarning) {
    await recordHibpUnavailableAcknowledgement();
  }
  const emailStatus = await sendSchoolAdminCredentialsEmail(itAdmin, itAdminPassword, org.name);

  res.status(201).json({
    organisation: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      active: org.active,
      teacherInviteCode: org.teacherInviteCode,
      createdAt: org.createdAt,
    },
    itAdmin: { id: itAdmin.id, email: itAdmin.email, name: itAdmin.name },
    emailStatus,
    ...(passwordPolicy.warning ? { warning: passwordPolicy.warning } : {}),
  });
});

router.get("/admin/organisations", requireAdmin, async (req, res): Promise<void> => {
  const actor = await getSessionAdmin(req);
  const canViewSensitiveSchoolAdministration = actor?.role === "master";
  const query = DirectoryQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Use valid school search, status, date, and pagination filters." });
    return;
  }
  const { q, status, from, to, page, pageSize } = query.data;
  if (from && to && from > to) {
    res.status(400).json({ error: "The start date must be before the end date." });
    return;
  }
  const directoryDate = status === "deleted" ? organisationsTable.deletedAt : organisationsTable.createdAt;
  const searchCondition = q
    ? canViewSensitiveSchoolAdministration
      ? sql`(${organisationsTable.name} ILIKE ${`%${q}%`} OR ${organisationsTable.slug} ILIKE ${`%${q}%`} OR EXISTS (
          SELECT 1 FROM teachers it_admin WHERE it_admin.organisation_id = ${organisationsTable.id}
          AND it_admin.is_it_admin = true AND (it_admin.name ILIKE ${`%${q}%`} OR it_admin.email ILIKE ${`%${q}%`})
        ))`
      : sql`(${organisationsTable.name} ILIKE ${`%${q}%`} OR ${organisationsTable.slug} ILIKE ${`%${q}%`})`
    : undefined;
  const organisationConditions = [
    status === "deleted" ? isNotNull(organisationsTable.deletedAt) : isNull(organisationsTable.deletedAt),
    status === "active" ? eq(organisationsTable.active, true) : status === "suspended" ? eq(organisationsTable.active, false) : undefined,
    from ? gte(directoryDate, new Date(`${from}T00:00:00.000Z`)) : undefined,
    to ? lte(directoryDate, new Date(`${to}T23:59:59.999Z`)) : undefined,
    searchCondition,
  ].filter(Boolean);
  const organisationWhere = organisationConditions.length ? and(...organisationConditions) : undefined;
  const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(organisationsTable).where(organisationWhere);
  const pageOrgs = await db.select().from(organisationsTable).where(organisationWhere)
    .orderBy(desc(organisationsTable.createdAt)).limit(pageSize).offset((page - 1) * pageSize);
  const ids = pageOrgs.map((org) => org.id);
  if (ids.length === 0) {
    const total = countRow?.count ?? 0;
    res.json({ items: [], total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
    return;
  }
  const [teacherStats, itAdmins, classStats, studentStats, climbStats] = await Promise.all([
    db.select({ orgId: teachersTable.organisationId, count: sql<number>`count(*)::int` }).from(teachersTable).where(inArray(teachersTable.organisationId, ids)).groupBy(teachersTable.organisationId),
    db.select({ orgId: teachersTable.organisationId, id: teachersTable.id, name: teachersTable.name, email: teachersTable.email }).from(teachersTable).where(and(
      inArray(teachersTable.organisationId, ids),
      eq(teachersTable.isItAdmin, true),
      eq(teachersTable.schoolAdminRole, "master"),
      eq(teachersTable.accountStatus, "active"),
    )),
    db.select({ orgId: teachersTable.organisationId, count: sql<number>`count(*)::int` }).from(classesTable).innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id)).where(inArray(teachersTable.organisationId, ids)).groupBy(teachersTable.organisationId),
    db.select({ orgId: teachersTable.organisationId, count: sql<number>`count(*)::int`, lastActive: max(studentSessionsTable.createdAt) }).from(studentSessionsTable).innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id)).innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id)).where(inArray(teachersTable.organisationId, ids)).groupBy(teachersTable.organisationId),
    db.select({ orgId: teachersTable.organisationId, count: sql<number>`count(distinct ${stageEntriesTable.sessionId})::int` }).from(stageEntriesTable).innerJoin(studentSessionsTable, eq(stageEntriesTable.sessionId, studentSessionsTable.id)).innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id)).innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id)).where(inArray(teachersTable.organisationId, ids)).groupBy(teachersTable.organisationId),
  ]);
  const toMap = <T extends { orgId: number | null }>(rows: T[]) => new Map(rows.filter((row) => row.orgId !== null).map((row) => [row.orgId!, row]));
  const teachersByOrg = toMap(teacherStats); const adminsByOrg = toMap(itAdmins); const classesByOrg = toMap(classStats); const studentsByOrg = toMap(studentStats); const climbsByOrg = toMap(climbStats);
  const pageTotal = countRow?.count ?? 0;
  res.json({ items: pageOrgs.map((org) => ({
    id: org.id, name: org.name, slug: org.slug, active: org.active,
    status: org.deletedAt ? "deleted" : org.active ? "active" : "suspended",
    deleted: Boolean(org.deletedAt), deletedAt: org.deletedAt,
    teacherInviteCode: canViewSensitiveSchoolAdministration ? org.teacherInviteCode : null,
    allowedEmailDomains: canViewSensitiveSchoolAdministration ? org.allowedEmailDomains ?? [] : [],
    teacherCount: teachersByOrg.get(org.id)?.count ?? 0, classCount: classesByOrg.get(org.id)?.count ?? 0,
    studentCount: studentsByOrg.get(org.id)?.count ?? 0, climbsStarted: climbsByOrg.get(org.id)?.count ?? 0,
    lastActiveAt: canViewSensitiveSchoolAdministration ? studentsByOrg.get(org.id)?.lastActive ?? null : null,
    createdAt: org.createdAt,
    itAdmin: canViewSensitiveSchoolAdministration ? adminsByOrg.get(org.id) ?? null : null,
  })), total: pageTotal, page, pageSize, totalPages: Math.max(1, Math.ceil(pageTotal / pageSize)) });
  return;
  const [orgs, deletionShadows] = await Promise.all([
    db.select().from(organisationsTable).orderBy(organisationsTable.createdAt),
    db.select().from(organisationDeletionShadowsTable).orderBy(organisationDeletionShadowsTable.deletedAt),
  ]);

  const orgsWithStats = await Promise.all(
    orgs.map(async (org) => {
      const [teacherRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(teachersTable)
        .where(eq(teachersTable.organisationId, org.id));

      const [itAdmin] = await db
        .select({ id: teachersTable.id, name: teachersTable.name, email: teachersTable.email })
        .from(teachersTable)
        .where(and(eq(teachersTable.organisationId, org.id), eq(teachersTable.schoolAdminRole, "master")));

      // Classes created across all teachers in this org
      const [classRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(classesTable)
        .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
        .where(eq(teachersTable.organisationId, org.id));

      // Students joined + last activity across all classes in this org
      const [studentRow] = await db
        .select({
          count: sql<number>`count(*)::int`,
          lastActive: max(studentSessionsTable.createdAt),
        })
        .from(studentSessionsTable)
        .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
        .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
        .where(eq(teachersTable.organisationId, org.id));

      // Climbs started = distinct student sessions with at least one stage entry
      const [climbRow] = await db
        .select({ count: sql<number>`count(distinct ${stageEntriesTable.sessionId})::int` })
        .from(stageEntriesTable)
        .innerJoin(studentSessionsTable, eq(stageEntriesTable.sessionId, studentSessionsTable.id))
        .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
        .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
        .where(eq(teachersTable.organisationId, org.id));

      return {
        id: org.id,
        name: org.name,
        slug: org.slug,
        active: org.active,
        status: org.active ? "active" as const : "suspended" as const,
        deleted: false as const,
        deletedAt: null,
        teacherInviteCode: org.teacherInviteCode,
        allowedEmailDomains: org.allowedEmailDomains ?? [],
        teacherCount: teacherRow?.count ?? 0,
        classCount: classRow?.count ?? 0,
        studentCount: studentRow?.count ?? 0,
        climbsStarted: climbRow?.count ?? 0,
        lastActiveAt: studentRow?.lastActive ?? null,
        createdAt: org.createdAt,
        itAdmin: itAdmin ?? null,
      };
    }),
  );

  const deletedSchools = deletionShadows.map((shadow) => ({
    id: shadow.organisationId,
    name: shadow.name,
    slug: shadow.slug,
    active: false as const,
    status: "deleted" as const,
    deleted: true as const,
    deletedAt: shadow.deletedAt,
    teacherInviteCode: null,
    allowedEmailDomains: [],
    teacherCount: 0,
    classCount: 0,
    studentCount: 0,
    climbsStarted: 0,
    lastActiveAt: null,
    createdAt: shadow.deletedAt,
    itAdmin: null,
  }));

  const needle = q.toLocaleLowerCase();
  const matching = [...orgsWithStats, ...deletedSchools]
    .filter((organisation) => {
      const statusMatch = (status === "deleted" && organisation.deleted)
        || (status === "active" && !organisation.deleted && organisation.active)
        || (status === "suspended" && !organisation.deleted && !organisation.active);
      const date = new Date(organisation.deleted ? organisation.deletedAt! : organisation.createdAt).toISOString().slice(0, 10);
      const searchable = `${organisation.name} ${organisation.slug} ${organisation.itAdmin?.name ?? ""} ${organisation.itAdmin?.email ?? ""}`.toLocaleLowerCase();
      return statusMatch && (!needle || searchable.includes(needle)) && (!from || date >= from) && (!to || date <= to);
    })
    .sort((left, right) => new Date(right.deleted ? right.deletedAt! : right.createdAt).getTime() - new Date(left.deleted ? left.deletedAt! : left.createdAt).getTime());
  const total = matching.length;
  const items = matching.slice((page - 1) * pageSize, page * pageSize);
  res.json({ items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
});

router.post("/admin/organisations/:id/school-master/reset-link", requireMaster, requireFreshAdminMfa, requireSameOrigin, schoolMasterResetLimiter, async (req, res): Promise<void> => {
  const organisationId = Number(req.params.id);
  const actor = await getSessionAdmin(req);
  const parsed = SchoolMasterResetLinkBody.safeParse(req.body);
  if (!Number.isInteger(organisationId) || !actor || !parsed.success) {
     res.status(400).json({ error: "Invalid School Admin reset request" });
    return;
  }

  const resetToken = randomBytes(32).toString("base64url");
  const resetExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const bcrypt = await import("bcryptjs");
  // The replacement is never disclosed. The account holder normally receives
  // the link by email; a manually handed-off link requires fresh CIG MFA and
  // is returned only after the administrator explicitly chooses that fallback.
  const invalidatedPasswordHash = await bcrypt.hash(generateTempPassword(), 12);
  let resetUrl: string;
  try {
    resetUrl = `${getAppBaseUrl()}/reset-password?token=${encodeURIComponent(resetToken)}`;
  } catch {
    res.status(503).json({ error: "The password reset email service is not available. Check the public application URL and try again." });
    return;
  }
  let schoolMaster: { id: number; name: string; email: string; schoolName: string } | undefined;

  try {
    schoolMaster = await db.transaction(async (tx) => {
      const [target] = await tx
        .select({
          id: teachersTable.id,
          name: teachersTable.name,
          email: teachersTable.email,
          schoolName: organisationsTable.name,
        })
        .from(teachersTable)
        .innerJoin(organisationsTable, eq(teachersTable.organisationId, organisationsTable.id))
        .where(and(
          eq(organisationsTable.id, organisationId),
          eq(teachersTable.id, parsed.data.teacherId),
          isNull(organisationsTable.deletedAt),
          eq(teachersTable.isItAdmin, true),
          eq(teachersTable.schoolAdminRole, "master"),
          eq(teachersTable.accountStatus, "active"),
        ));

      if (!target) return undefined;

      const [updated] = await tx
        .update(teachersTable)
        .set({
          passwordHash: invalidatedPasswordHash,
          mustChangePassword: true,
          passwordResetToken: hashPasswordResetToken(resetToken),
          passwordResetExpiresAt: resetExpiresAt,
        })
        .where(and(
          eq(teachersTable.id, target.id),
          eq(teachersTable.organisationId, organisationId),
          eq(teachersTable.isItAdmin, true),
          eq(teachersTable.schoolAdminRole, "master"),
          eq(teachersTable.accountStatus, "active"),
        ))
        .returning({ id: teachersTable.id });

      if (!updated) return undefined;

      await revokeTeacherSessionsInTransaction(tx, target.id);
      await tx.insert(auditLogTable).values({
        organisationId,
        teacherId: target.id,
        action: "teacher.password_reset_requested",
        metadata: {
          method: parsed.data.deliveryMethod === "manual" ? "cig-admin-manual-link" : "cig-admin",
          credentialInvalidated: true,
          initiatedByCigAdminId: actor.id,
        },
        ipAddress: req.ip,
      });

      return target;
    });
  } catch (error) {
    req.log?.error({ err: error, organisationId }, "Unable to create School Admin reset link");
    res.status(503).json({ error: "The School Admin reset link could not be created. Please try again." });
    return;
  }

  if (!schoolMaster) {
    res.status(404).json({ error: "No active School Admin was found for this school." });
    return;
  }

  if (parsed.data.deliveryMethod === "manual") {
    await logAudit({
      organisationId,
      teacherId: schoolMaster.id,
      action: "teacher.password_reset_manual_link_created",
      metadata: {
        method: "cig-admin-manual-link",
        initiatedByCigAdminId: actor.id,
        expiresAt: resetExpiresAt.toISOString(),
      },
      ipAddress: req.ip,
    });
    res.json({ ok: true, deliveryMethod: "manual", manualResetUrl: resetUrl, expiresAt: resetExpiresAt.toISOString() });
    return;
  }

  const emailStatus = await sendTeacherPasswordResetEmail(schoolMaster, schoolMaster.schoolName, resetUrl);
  if (emailStatus !== "sent") {
    await logAudit({
      organisationId,
      teacherId: schoolMaster.id,
      action: "teacher.password_reset_delivery_failed",
      metadata: { method: "cig-admin", deliveryStatus: emailStatus, initiatedByCigAdminId: actor.id },
      ipAddress: req.ip,
    });
  }

  res.json({ ok: true, emailStatus });
});

router.get("/admin/reports", requireMaster, async (_req, res): Promise<void> => {
  const result = await db.execute(sql`
    SELECT
      o.id, o.name, o.slug, o.active, o.created_at AS "createdAt",
      count(DISTINCT t.id)::int AS "teacherCount",
      count(DISTINCT c.id)::int AS "classCount",
      count(DISTINCT ss.id)::int AS "studentCount",
      count(DISTINCT se.session_id)::int AS "climbsStarted",
      count(DISTINCT ss.id) FILTER (
        WHERE ss.locked_at IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM teacher_feedback tf
            WHERE tf.session_id = ss.id
              AND tf.stage = 'OVERALL'
              AND tf.grade IS NOT NULL
              AND btrim(tf.comment) <> ''
          )
      )::int AS "climbsFinished",
      count(DISTINCT se.session_id) FILTER (
        WHERE NOT EXISTS (
          SELECT 1
          FROM teacher_feedback tf
          WHERE tf.session_id = ss.id
            AND tf.stage = 'OVERALL'
            AND tf.grade IS NOT NULL
            AND btrim(tf.comment) <> ''
            AND ss.locked_at IS NOT NULL
        )
      )::int AS "climbsInProgress"
    FROM organisations o
    LEFT JOIN teachers t ON t.organisation_id = o.id
    LEFT JOIN classes c ON c.teacher_id = t.id
    LEFT JOIN student_sessions ss ON ss.class_id = c.id
    LEFT JOIN stage_entries se ON se.session_id = ss.id
    WHERE o.deleted_at IS NULL
    GROUP BY o.id, o.name, o.slug, o.active, o.created_at
    ORDER BY o.created_at DESC
  `);
  const items = (result.rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    slug: String(row.slug),
    active: Boolean(row.active),
    status: row.active ? "active" : "suspended",
    deleted: false,
    deletedAt: null,
    teacherCount: Number(row.teacherCount ?? 0),
    classCount: Number(row.classCount ?? 0),
    studentCount: Number(row.studentCount ?? 0),
    climbsStarted: Number(row.climbsStarted ?? 0),
    climbsFinished: Number(row.climbsFinished ?? 0),
    climbsInProgress: Number(row.climbsInProgress ?? 0),
    createdAt: row.createdAt,
  }));
  res.json({ generatedAt: new Date().toISOString(), items });
});

router.patch("/admin/organisations/:id/active", requireMaster, requireFreshAdminMfa, requireSameOrigin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid organisation ID" });
    return;
  }

  const { active } = req.body ?? {};
  if (typeof active !== "boolean") {
    res.status(400).json({ error: "active (boolean) required" });
    return;
  }

  const [org] = await db
    .update(organisationsTable)
    .set({ active })
    .where(and(eq(organisationsTable.id, id), isNull(organisationsTable.deletedAt)))
    .returning({ id: organisationsTable.id, name: organisationsTable.name, active: organisationsTable.active });

  if (!org) {
    res.status(404).json({ error: "Organisation not found" });
    return;
  }

  res.json(org);
});

router.get("/admin/organisations/:id/invite-code", requireMaster, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid organisation ID" });
    return;
  }

  const [org] = await db
    .select({ id: organisationsTable.id, name: organisationsTable.name, teacherInviteCode: organisationsTable.teacherInviteCode })
    .from(organisationsTable)
    .where(and(eq(organisationsTable.id, id), isNull(organisationsTable.deletedAt)));

  if (!org) {
    res.status(404).json({ error: "Organisation not found" });
    return;
  }

  res.json({ id: org.id, name: org.name, teacherInviteCode: org.teacherInviteCode });
});

const CreateItAdminBody = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(12),
  acceptHibpWarning: z.boolean().optional().default(false),
});

router.post("/admin/organisations/:id/it-admin", requireMaster, requireFreshAdminMfa, requireSameOrigin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid organisation ID" });
    return;
  }

  const parsed = CreateItAdminBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const actor = await getSessionAdmin(req);
  const { name, email, password } = parsed.data;
  const passwordPolicy = await checkPasswordPolicy(password);
  if (!passwordPolicy.ok) {
    res.status(400).json({ error: passwordPolicy.error });
    return;
  }
  if (passwordPolicy.warningCode === HIBP_UNAVAILABLE_CODE && !parsed.data.acceptHibpWarning) {
    res.status(409).json({
      error: passwordPolicy.warning,
      code: HIBP_UNAVAILABLE_CODE,
      warning: passwordPolicy.warning,
    });
    return;
  }

  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.hash(password, 12);

  const appointment = await db.transaction(async (tx) => {
    await acquireCigAdminMutationLock(tx);
    const [currentMaster] = await tx.select({ id: cigAdminsTable.id })
      .from(cigAdminsTable)
      .where(and(
        eq(cigAdminsTable.id, actor!.id),
        eq(cigAdminsTable.role, "master"),
        eq(cigAdminsTable.active, true),
        eq(cigAdminsTable.sessionVersion, actor!.sessionVersion),
      ));
    if (!currentMaster) return { status: "not-master" as const };

    const [org] = await tx.select({ id: organisationsTable.id, name: organisationsTable.name })
      .from(organisationsTable)
      .where(and(eq(organisationsTable.id, id), isNull(organisationsTable.deletedAt)));
    if (!org) return { status: "missing-org" as const };

    const [existingMaster] = await tx.select({ id: teachersTable.id })
      .from(teachersTable)
      .where(and(
        eq(teachersTable.organisationId, id),
        eq(teachersTable.schoolAdminRole, "master"),
        eq(teachersTable.accountStatus, "active"),
      ));
    if (existingMaster) return { status: "existing-master" as const };

    const [existing] = await tx.select({ id: teachersTable.id })
      .from(teachersTable)
      .where(eq(teachersTable.email, email.toLowerCase()));
    if (existing) return { status: "duplicate-email" as const };

    const [created] = await tx.insert(teachersTable)
      .values({
        organisationId: id,
        email: email.toLowerCase(),
        passwordHash,
        name,
        isItAdmin: true,
        schoolAdminRole: "master",
        approvalStatus: "approved",
        mustChangePassword: true,
      })
      .returning({ id: teachersTable.id, name: teachersTable.name, email: teachersTable.email });
    return { status: "created" as const, created, org };
  });
  if (appointment.status === "not-master") {
    res.status(409).json({ error: "Master access changed. Refresh and try again." });
    return;
  }
  if (appointment.status === "missing-org") {
    res.status(404).json({ error: "Organisation not found" });
    return;
  }
  if (appointment.status === "existing-master") {
    res.status(409).json({ error: "This school already has an active School Admin. Send that account a reset link if access is needed." });
    return;
  }
  if (appointment.status === "duplicate-email") {
    res.status(409).json({ error: "A teacher with that email already exists" });
    return;
  }
  const { created, org } = appointment;
  await recordTeacherPassword(created.id, passwordHash);
  if (passwordPolicy.warningCode === HIBP_UNAVAILABLE_CODE && parsed.data.acceptHibpWarning) {
    await recordHibpUnavailableAcknowledgement();
  }
  const emailStatus = await sendSchoolAdminCredentialsEmail(created, password, org.name);

  res.status(201).json({ ok: true, teacher: created, emailStatus, ...(passwordPolicy.warning ? { warning: passwordPolicy.warning } : {}) });
});

router.get("/admin/organisations/:id/teachers", requireMaster, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid organisation ID" });
    return;
  }
  const [organisation] = await db
    .select({ id: organisationsTable.id })
    .from(organisationsTable)
    .where(and(eq(organisationsTable.id, id), isNull(organisationsTable.deletedAt)));
  if (!organisation) {
    res.status(404).json({ error: "Organisation not found" });
    return;
  }

  const teachers = await db
    .select({
      id: teachersTable.id,
      name: teachersTable.name,
      email: teachersTable.email,
      isItAdmin: teachersTable.isItAdmin,
      schoolAdminRole: teachersTable.schoolAdminRole,
      createdAt: teachersTable.createdAt,
    })
    .from(teachersTable)
    .where(eq(teachersTable.organisationId, id))
    .orderBy(teachersTable.createdAt);

  res.json(teachers);
});

router.post("/admin/teachers/:teacherId/reset-password", requireMaster, requireFreshAdminMfa, requireSameOrigin, async (req, res): Promise<void> => {
  const teacherId = Number(req.params.teacherId);
  if (isNaN(teacherId)) {
    res.status(400).json({ error: "Invalid teacher ID" });
    return;
  }

  const actor = await getSessionAdmin(req);
  const [teacher] = await db
    .select({
      id: teachersTable.id,
      email: teachersTable.email,
      name: teachersTable.name,
      organisationId: teachersTable.organisationId,
      schoolName: organisationsTable.name,
    })
    .from(teachersTable)
    .innerJoin(organisationsTable, eq(teachersTable.organisationId, organisationsTable.id))
    .where(and(
      eq(teachersTable.id, teacherId),
      eq(teachersTable.accountStatus, "active"),
      isNull(organisationsTable.deletedAt),
    ));

  if (!teacher) {
    res.status(404).json({ error: "Active teacher not found in an available school." });
    return;
  }
  const resetToken = randomBytes(32).toString("base64url");
  const resetExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const bcrypt = await import("bcryptjs");
  // This random replacement is never returned to Central CIG or sent by
  // email. It immediately makes the prior password unusable until the
  // teacher completes the one-time reset-link flow.
  const invalidatedPasswordHash = await bcrypt.hash(generateTempPassword(), 12);
  let resetUrl: string;
  try {
    resetUrl = `${getAppBaseUrl()}/reset-password?token=${encodeURIComponent(resetToken)}`;
  } catch {
    res.status(503).json({ error: "The password reset email service is not available. Check the public application URL and try again." });
    return;
  }

  try {
    const created = await db.transaction(async (tx) => {
      const [updated] = await tx.update(teachersTable)
        .set({
          passwordHash: invalidatedPasswordHash,
          mustChangePassword: true,
          passwordResetToken: hashPasswordResetToken(resetToken),
          passwordResetExpiresAt: resetExpiresAt,
          failedLoginAttempts: 0,
          lockedUntil: null,
        })
        .where(and(
          eq(teachersTable.id, teacher.id),
          eq(teachersTable.organisationId, teacher.organisationId!),
          eq(teachersTable.accountStatus, "active"),
        ))
        .returning({ id: teachersTable.id });
      if (!updated) return false;

      await revokeTeacherSessionsInTransaction(tx, teacher.id);
      await tx.insert(auditLogTable).values({
        organisationId: teacher.organisationId,
        teacherId: teacher.id,
        action: "teacher.password_reset_requested",
        metadata: { method: "cig-admin", credentialInvalidated: true, initiatedByCigAdminId: actor!.id },
        ipAddress: req.ip,
      });
      return true;
    });
    if (!created) {
      res.status(409).json({ error: "The teacher account changed. Refresh and try again." });
      return;
    }
  } catch (error) {
    req.log?.error({ err: error, teacherId }, "Unable to create teacher reset link");
    res.status(503).json({ error: "The teacher reset link could not be created. Please try again." });
    return;
  }

  const emailStatus = await sendTeacherPasswordResetEmail(
    teacher,
    teacher.schoolName,
    resetUrl,
  );
  if (emailStatus !== "sent") {
    await logAudit({
      organisationId: teacher.organisationId,
      teacherId: teacher.id,
      action: "teacher.password_reset_delivery_failed",
      metadata: { method: "cig-admin", deliveryStatus: emailStatus, initiatedByCigAdminId: actor!.id },
      ipAddress: req.ip,
    });
  }
  res.json({ ok: true, emailStatus });
});

router.get("/admin/retention-settings", requireMaster, async (_req, res): Promise<void> => {
  res.json(await getPlatformRetentionDefaults());
});

router.put("/admin/retention-settings", requireMaster, requireFreshAdminMfa, requireSameOrigin, async (req, res): Promise<void> => {
  const parsed = PlatformRetentionSettingsBody.safeParse(req.body);
  const actor = await getSessionAdmin(req);
  if (!parsed.success || !actor) {
    res.status(400).json({ error: parsed.success ? "Administrator session unavailable." : parsed.error.issues[0]?.message });
    return;
  }
  const previous = await getPlatformRetentionDefaults();
  const next = {
    defaultArchiveRetentionDays: parsed.data.defaultArchiveRetentionDays,
    minimumDays: parsed.data.minimumDays,
    maximumDays: parsed.data.maximumDays,
    standardChoices: [...new Set(parsed.data.standardChoices)].sort((a, b) => a - b),
  };
  await db.transaction(async (tx) => {
    await acquireCigAdminMutationLock(tx);
    const values: Array<[string, string]> = [
      ["archive_retention_days", String(next.defaultArchiveRetentionDays)],
      ["archive_retention_min_days", String(next.minimumDays)],
      ["archive_retention_max_days", String(next.maximumDays)],
      ["archive_retention_choices", JSON.stringify(next.standardChoices)],
    ];
    for (const [key, value] of values) {
      await tx.insert(platformSettingsTable).values({ key, value, updatedAt: new Date() })
        .onConflictDoUpdate({ target: platformSettingsTable.key, set: { value, updatedAt: new Date() } });
    }
    await tx.insert(cigAdminSecurityEventsTable).values({
      adminId: actor.id,
      action: "cig_admin.platform_retention_settings_updated",
      metadata: JSON.stringify({
        actorRole: actor.role,
        previous,
        next,
        changedAt: new Date().toISOString(),
        affectedSchool: "platform default and school choice policy",
      }),
    });
  });
  res.json(await getPlatformRetentionDefaults());
});

async function getOrganisationDeletionSummary(organisationId: number) {
  const [organisation] = await db
    .select({ id: organisationsTable.id, name: organisationsTable.name })
    .from(organisationsTable)
    .where(eq(organisationsTable.id, organisationId));
  if (!organisation) return null;

  const count = sql<number>`count(*)::int`;
  const [
    [teacherCount],
    [classCount],
    [studentSessionCount],
    [stageEntryCount],
    [chatMessageCount],
    [feedbackCount],
    [taskCount],
    [auditLogCount],
  ] = await Promise.all([
    db.select({ count }).from(teachersTable).where(eq(teachersTable.organisationId, organisationId)),
    db.select({ count }).from(classesTable).innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
      .where(eq(teachersTable.organisationId, organisationId)),
    db.select({ count }).from(studentSessionsTable)
      .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
      .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
      .where(eq(teachersTable.organisationId, organisationId)),
    db.select({ count }).from(stageEntriesTable)
      .innerJoin(studentSessionsTable, eq(stageEntriesTable.sessionId, studentSessionsTable.id))
      .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
      .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
      .where(eq(teachersTable.organisationId, organisationId)),
    db.select({ count }).from(chatMessagesTable)
      .innerJoin(studentSessionsTable, eq(chatMessagesTable.sessionId, studentSessionsTable.id))
      .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
      .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
      .where(eq(teachersTable.organisationId, organisationId)),
    db.select({ count }).from(teacherFeedbackTable)
      .innerJoin(studentSessionsTable, eq(teacherFeedbackTable.sessionId, studentSessionsTable.id))
      .innerJoin(classesTable, eq(studentSessionsTable.classId, classesTable.id))
      .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
      .where(eq(teachersTable.organisationId, organisationId)),
    db.select({ count }).from(tasksTable)
      .innerJoin(classesTable, eq(tasksTable.classId, classesTable.id))
      .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
      .where(eq(teachersTable.organisationId, organisationId)),
    db.select({ count }).from(auditLogTable).where(eq(auditLogTable.organisationId, organisationId)),
  ]);

  return {
    id: organisation.id,
    name: organisation.name,
    teachers: teacherCount?.count ?? 0,
    classes: classCount?.count ?? 0,
    studentSessions: studentSessionCount?.count ?? 0,
    stageEntries: stageEntryCount?.count ?? 0,
    chatMessages: chatMessageCount?.count ?? 0,
    feedback: feedbackCount?.count ?? 0,
    tasks: taskCount?.count ?? 0,
    auditLogs: auditLogCount?.count ?? 0,
  };
}

router.get("/admin/organisations/:id/deletion-summary", requireMaster, async (req, res): Promise<void> => {
  const organisationId = Number(req.params.id);
  if (!Number.isInteger(organisationId)) { res.status(400).json({ error: "Invalid organisation ID" }); return; }
  const summary = await getOrganisationDeletionSummary(organisationId);
  if (!summary) { res.status(404).json({ error: "Organisation not found" }); return; }
  res.json(summary);
});

const DeleteOrganisationBody = z.object({ confirmation: z.string().min(1) });
const HardDeleteOrganisationBody = DeleteOrganisationBody.extend({ permanent: z.literal(true) });

router.delete("/admin/organisations/:id", requireMaster, requireFreshAdminMfa, requireSameOrigin, async (req, res): Promise<void> => {
  const organisationId = Number(req.params.id);
  const parsed = DeleteOrganisationBody.safeParse(req.body);
  const actor = await getSessionAdmin(req);
  if (!Number.isInteger(organisationId) || !parsed.success || !actor) { res.status(400).json({ error: "Invalid delete request" }); return; }
  const summary = await getOrganisationDeletionSummary(organisationId);
  if (!summary) { res.status(404).json({ error: "Organisation not found" }); return; }
  if (parsed.data.confirmation !== summary.name) {
    res.status(400).json({ error: "Type the school name exactly to confirm removal." });
    return;
  }
  let deletedAt: Date | null = null;
  try {
    deletedAt = await db.transaction(async (tx) => {
      await acquireCigAdminMutationLock(tx);
      const [currentMaster] = await tx.select({ id: cigAdminsTable.id }).from(cigAdminsTable)
        .where(and(eq(cigAdminsTable.id, actor.id), eq(cigAdminsTable.role, "master"), eq(cigAdminsTable.active, true)));
      if (!currentMaster) return null;
      const now = new Date();
      const [deletedOrganisation] = await tx.update(organisationsTable).set({
        deletedAt: now,
        deletedByCigAdminId: actor.id,
      }).where(and(
        eq(organisationsTable.id, organisationId),
        eq(organisationsTable.name, summary.name),
        isNull(organisationsTable.deletedAt),
      )).returning({
        id: organisationsTable.id,
        name: organisationsTable.name,
        slug: organisationsTable.slug,
        deletedAt: organisationsTable.deletedAt,
      });
      if (!deletedOrganisation?.deletedAt) return null;
      await tx.insert(auditLogTable).values({
        organisationId: deletedOrganisation.id,
        action: "organisation.soft_deleted",
        metadata: { deletedByCigAdminId: actor.id, retentionDays: ORGANISATION_DELETION_RETENTION_DAYS },
        ipAddress: req.ip,
      });
      return deletedOrganisation.deletedAt;
    });
  } catch (error) {
    req.log?.error({ err: error, organisationId }, "Unable to soft-delete organisation");
    res.status(503).json({ error: "The school could not be removed because its audit record could not be stored." });
    return;
  }
  if (!deletedAt) {
    res.status(409).json({ error: "Master access or the school record changed. Refresh and try again." });
    return;
  }
  await logAdminSecurityEvent(actor.id, "cig_admin.organisation_soft_deleted", req.ip, {
    ...summary,
    deletedAt: deletedAt.toISOString(),
    retentionDays: ORGANISATION_DELETION_RETENTION_DAYS,
  });
  res.json({
    ok: true,
    deletedAt,
    purgeAfter: new Date(deletedAt.getTime() + ORGANISATION_DELETION_RETENTION_DAYS * 24 * 60 * 60 * 1000),
  });
});

router.post("/admin/organisations/:id/restore", requireMaster, requireSameOrigin, async (req, res): Promise<void> => {
  const organisationId = Number(req.params.id);
  const parsed = DeleteOrganisationBody.safeParse(req.body);
  const actor = await getSessionAdmin(req);
  if (!Number.isInteger(organisationId) || !parsed.success || !actor) { res.status(400).json({ error: "Invalid restore request" }); return; }
  const restoreCutoff = new Date(Date.now() - ORGANISATION_DELETION_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const restored = await db.transaction(async (tx) => {
    await acquireCigAdminMutationLock(tx);
    const [currentMaster] = await tx.select({ id: cigAdminsTable.id }).from(cigAdminsTable)
      .where(and(eq(cigAdminsTable.id, actor.id), eq(cigAdminsTable.role, "master"), eq(cigAdminsTable.active, true)));
    if (!currentMaster) return null;
    const [organisation] = await tx.update(organisationsTable).set({
      deletedAt: null,
      deletedByCigAdminId: null,
    }).where(and(
      eq(organisationsTable.id, organisationId),
      eq(organisationsTable.name, parsed.data.confirmation),
      isNotNull(organisationsTable.deletedAt),
      gt(organisationsTable.deletedAt, restoreCutoff),
    )).returning({ id: organisationsTable.id, name: organisationsTable.name });
    if (!organisation) return null;
    await tx.insert(auditLogTable).values({
      organisationId: organisation.id,
      action: "organisation.restored",
      metadata: { restoredByCigAdminId: actor.id },
      ipAddress: req.ip,
    });
    return organisation;
  });

  if (!restored) {
    res.status(409).json({ error: "The school could not be restored. Its recovery window may have ended, or it may already be active, purged, or changed." });
    return;
  }
  await logAdminSecurityEvent(actor.id, "cig_admin.organisation_restored", req.ip, { organisationId: restored.id, organisationName: restored.name });
  res.json({ ok: true, organisation: restored });
});

router.delete("/admin/organisations/:id/permanent", requireMaster, requireFreshAdminMfa, requireSameOrigin, async (req, res): Promise<void> => {
  const organisationId = Number(req.params.id);
  const parsed = HardDeleteOrganisationBody.safeParse(req.body);
  const actor = await getSessionAdmin(req);
  if (!Number.isInteger(organisationId) || !parsed.success || !actor) {
    res.status(400).json({ error: "Confirm permanent deletion by typing the school name and acknowledging the destruction." });
    return;
  }
  const summary = await getOrganisationDeletionSummary(organisationId);
  if (!summary || summary.name !== parsed.data.confirmation) {
    res.status(400).json({ error: "Type the school name exactly to confirm permanent deletion." });
    return;
  }
  const deleted = await permanentlyDeleteSoftDeletedOrganisation(
    organisationId,
    "cig_admin.organisation_hard_deleted",
    actor.id,
    async (tx) => {
      await acquireCigAdminMutationLock(tx);
      const [currentMaster] = await tx.select({ id: cigAdminsTable.id }).from(cigAdminsTable)
        .where(and(eq(cigAdminsTable.id, actor.id), eq(cigAdminsTable.role, "master"), eq(cigAdminsTable.active, true)));
      return Boolean(currentMaster);
    },
  );
  if (!deleted || deleted.name !== summary.name) {
    res.status(409).json({ error: "The school could not be permanently deleted. Refresh and try again." });
    return;
  }
  res.json({ ok: true });
});

export default router;

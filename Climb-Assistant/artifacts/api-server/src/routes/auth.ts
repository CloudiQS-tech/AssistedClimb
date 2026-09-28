import 
{
 Router, type IRouter, type Request, type Response 
}
 from "express"
;

import bcrypt from "bcryptjs"
;

import 
{
 createHash, randomBytes, randomUUID 
}
 from "crypto"
;

import 
{
 and, eq, gt, isNull, sql 
}
 from "drizzle-orm"
;

import 
{
 db, teacherRecoveryCodesTable, teachersTable, organisationsTable, type Teacher 
}
 from "@workspace/db"
;

import 
{
  LoginTeacherBody, LoginTeacherResponse, GetTeacherMeResponse,
  VerifyTeacherEmailQueryParams, VerifyTeacherEmailResponse,
  ResendTeacherEmailVerificationBody, ResendTeacherEmailVerificationResponse,
}
 from "@workspace/api-zod"
;

import 
{
 z 
}
 from "zod/v4"
;

import rateLimit, { ipKeyGenerator } from "express-rate-limit"
;

import 
{
 generateSecret, generateURI, verifySync 
}
 from "otplib"
;

import QRCode from "qrcode"
;

import 
{
 logAudit 
}
 from "../lib/audit"
;

import 
{
 sendEmail, isEmailConfigured 
}
 from "../lib/email"
;
import { isEmailVerificationBypassed } from "../lib/email-verification-policy";

import 
{

  checkPasswordPolicy,
  HIBP_UNAVAILABLE_CODE,
  recordHibpUnavailableAcknowledgement,
  hashPasswordResetToken,
  recordTeacherPassword,
  teacherRecoveryCode,
  terminateTeacherSessions,
}
 from "../lib/teacher-security"
;

import 
{
 getAppBaseUrl 
}
 from "../lib/app-url"
;

import 
{

  applySessionCookiePolicy,
  regenerateAnonymousSessionPreservingSiteAccess,
  regenerateSessionWithCookiePolicy,
}
 from "../lib/session-cookie"
;

import 
{
 createPreviewTeacherSession 
}
 from "../lib/preview-session"
;

import 
{
 SESSION_ABSOLUTE_TIMEOUT_MS, SESSION_IDLE_TIMEOUT_MS 
}
 from "../lib/session-policy"
;
import { requireTeacher } from "../middlewares/teacherAuth";


const router: IRouter = Router()
;


const authLimiter = rateLimit(
{

  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 
{
 error: "Too many attempts. Please wait 15 minutes before trying again." 
}
,
  standardHeaders: true,
  legacyHeaders: false,
}
)
;


const totpLimiter = rateLimit(
{

  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => {
    const body = req.body && typeof req.body === "object"
      ? req.body as Record<string, unknown>
      : {};
    const requestToken = [body.loginToken, body.setupToken]
      .find((value): value is string => typeof value === "string" && value.length > 0);
    const pendingTeacherId = req.session.pendingTotpTeacherId
      ?? req.session.pendingTotpSetupTeacherId;
    const signInIdentity = pendingTeacherId !== undefined
      ? `teacher:${pendingTeacherId}`
      : requestToken
        ? `ticket:${createHash("sha256").update(requestToken).digest("hex")}`
        : "anonymous";
    return `${signInIdentity}:${ipKeyGenerator(req.ip ?? "")}`;
  },
  message: 
{
 error: "Too many authenticator attempts for this sign-in. Please wait 15 minutes or start sign-in again."
}
,
  standardHeaders: true,
  legacyHeaders: false,
}
)
;

const emailVerificationLimiter = rateLimit(
{
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: "Too many verification emails have been requested. Please wait before trying again." },
  standardHeaders: true,
  legacyHeaders: false,
}
)
;


// Authenticator devices and the server can differ by a few seconds. Accept the
// immediately adjacent 30-second TOTP windows while retaining rate limiting and
// account lockout protections against guessing.
const TOTP_CLOCK_SKEW_SECONDS = 30
;

const TOTP_SETUP_TOKEN_TTL_MS = 10 * 60 * 1000
;

const TOTP_LOGIN_TOKEN_TTL_MS = 10 * 60 * 1000
;

const POST_MFA_SESSION_TICKET_TTL_MS = 2 * 60 * 1000
;

const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000
;


const MIN_TOTP_SECRET_BYTES = 16
;


const TOTP_BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
;


const INVALID_TOTP_SETUP_ERROR = "Authenticator setup is no longer available. Please sign in again."
;


function isValidTotpSecret(secret: unknown): secret is string
{

  if (typeof secret !== "string" || secret.length === 0 || secret.length % 8 === 1) return false
;

  let remainingBits = 0
;
  let remainingValue = 0
;
  let decodedByteLength = 0
;

  for (const character of secret.toUpperCase())
{

    const value = TOTP_BASE32_ALPHABET.indexOf(character);
    if (value < 0) return false
;

    remainingValue = (remainingValue << 5) | value;
    remainingBits += 5;
    if (remainingBits >= 8)
{

      remainingBits -= 8;
      decodedByteLength += 1;
      remainingValue &= (1 << remainingBits) - 1;

}

}

  return decodedByteLength >= MIN_TOTP_SECRET_BYTES
    && (remainingBits === 0 || remainingValue === 0)
;

}


function verifyTeacherTotp(token: string, secret: string): boolean 
{

  if (!isValidTotpSecret(secret)) return false
;

  try
{

    return verifySync(
{
 token, secret, epochTolerance: TOTP_CLOCK_SKEW_SECONDS 
}
).valid
;

}
 catch
{

    // A malformed stored secret must never turn an authentication request into
    // an unhandled server error if the TOTP library adds stricter validation.
    return false
;

}

}


function hashTotpSetupToken(token: string): string 
{

  return createHash("sha256").update(token).digest("hex")
;

}

async function sendTeacherEmailVerification(teacher: Teacher): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS);
  await db
    .update(teachersTable)
    .set({
      emailVerificationTokenHash: hashTotpSetupToken(token),
      emailVerificationExpiresAt: expiresAt,
    })
    .where(eq(teachersTable.id, teacher.id));

  const verificationUrl = `${getAppBaseUrl()}/teacher/verify-email?token=${encodeURIComponent(token)}`;
  const safeTeacherName = escapeHtml(teacher.name);
  await sendEmail({
    to: teacher.email,
    subject: "Verify your school email — The Assisted Climb",
    text: `Hi ${teacher.name},\n\nVerify your school email before using The Assisted Climb:\n${verificationUrl}\n\nThis one-time link expires in 24 hours. If you did not create this account, you can ignore this email.\n`,
    html: `
      <p>Hi ${safeTeacherName},</p>
      <p>Verify your school email before using <strong>The Assisted Climb</strong>.</p>
      <p><a href="${verificationUrl}" style="background:#000;color:#fff;padding:12px 24px;border-radius:12px;text-decoration:none;display:inline-block;font-size:14px;">Verify my email</a></p>
      <p style="color:#888;font-size:12px;">This one-time link expires in 24 hours. If you did not create this account, you can ignore this email.</p>
    `,
  });
}


async function isTeacherOrganisationAvailable(teacher: Pick<Teacher, "organisationId">): Promise<boolean> 
{

  if (!teacher.organisationId) return true
;

  const [organisation] = await db
    .select(
{
 id: organisationsTable.id 
}
)
    .from(organisationsTable)
    .where(and(
      eq(organisationsTable.id, teacher.organisationId),
      eq(organisationsTable.active, true),
      isNull(organisationsTable.deletedAt),
    ))
;

  return Boolean(organisation)
;

}


async function claimTotpLoginTicket(teacherId: number, loginToken: string): Promise<boolean> 
{

  const [claimed] = await db
    .update(teachersTable)
    .set(
{

      pendingTotpLoginTokenHash: null,
      pendingTotpLoginTokenExpiresAt: null,
    
}
)
    .where(and(
      eq(teachersTable.id, teacherId),
      eq(teachersTable.pendingTotpLoginTokenHash, hashTotpSetupToken(loginToken)),
      gt(teachersTable.pendingTotpLoginTokenExpiresAt, new Date()),
    ))
    .returning(
{
 id: teachersTable.id 
}
)
;

  return Boolean(claimed)
;

}


const siteAccessLimiter = rateLimit(
{

  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 
{
 error: "Too many access attempts. Please wait 15 minutes before trying again." 
}
,
  standardHeaders: true,
  legacyHeaders: false,
}
)
;


const testEmailLimiter = rateLimit(
{

  windowMs: 10 * 60 * 1000,
  max: 3,
  message: 
{
 error: "Too many test emails sent. Please wait 10 minutes before trying again."
}
,
  standardHeaders: true,
  legacyHeaders: false,
}
)
;


function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!
  ));
}

async function regenerateSessionPreservingSiteAccess(req: Request): Promise<void> {
  const siteAuthed = req.session.siteAuthed;
  await regenerateSessionWithCookiePolicy(req);
  if (siteAuthed) req.session.siteAuthed = true;
}

async function establishTeacherSession(req: Request, teacherId: number): Promise<void> {
  await regenerateSessionPreservingSiteAccess(req);
  req.session.teacherId = teacherId;
  req.session.studentSessionId = undefined;
  req.session.pendingTotpTeacherId = undefined;
  req.session.pendingTotpSetupTeacherId = undefined;
  req.session.sessionStartedAt = Date.now();
  req.session.lastActivityAt = req.session.sessionStartedAt;
  await new Promise<void>((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
}

async function beginPendingTeacherTotpSession(
  req: Request,
  teacherId: number,
  setupRequired: boolean,
): Promise<string | undefined> {
  // Always issue a fresh session after password/recovery verification. This
  // prevents a legacy preview cookie from carrying stale Secure/SameSite flags
  // into the separate authenticator-code request.
  let loginToken: string | undefined;
  if (!setupRequired) {
    loginToken = randomBytes(32).toString("base64url");
    await db.update(teachersTable).set({
      pendingTotpLoginTokenHash: hashTotpSetupToken(loginToken),
      pendingTotpLoginTokenExpiresAt: new Date(Date.now() + TOTP_LOGIN_TOKEN_TTL_MS),
    }).where(eq(teachersTable.id, teacherId));
  }
  await regenerateSessionPreservingSiteAccess(req);
  if (setupRequired) {
    req.session.pendingTotpSetupTeacherId = teacherId;
  } else {
    req.session.pendingTotpTeacherId = teacherId;
  }
  await new Promise<void>((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
  return loginToken;
}

async function completeLogin(req: Request, res: Response, teacher: Teacher, extra: Record<string, unknown> = {}): Promise<void> {
  const sessionResumeToken = randomBytes(32).toString("base64url");
  const [updated] = await db
    .update(teachersTable)
    .set({
      loginToken: null,
      failedLoginAttempts: 0,
      lockedUntil: null,
      pendingTotpLoginTokenHash: null,
      pendingTotpLoginTokenExpiresAt: null,
      postMfaSessionTicketHash: hashTotpSetupToken(sessionResumeToken),
      postMfaSessionTicketExpiresAt: new Date(Date.now() + POST_MFA_SESSION_TICKET_TTL_MS),
    })
    .where(and(
      eq(teachersTable.id, teacher.id),
      eq(teachersTable.accountStatus, "active"),
      eq(teachersTable.approvalStatus, "approved"),
    ))
    .returning();
  if (!updated) {
    req.session.destroy(() => {});
    res.status(403).json({ error: "Your teacher account is awaiting approval from a school administrator.", approvalStatus: "pending" });
    return;
  }

  await establishTeacherSession(req, updated.id);
  const previewSessionToken = createPreviewTeacherSession(updated.id);

  await logAudit({
    organisationId: teacher.organisationId,
    teacherId: teacher.id,
    action: "teacher.login",
    ipAddress: req.ip,
  });

  res.json({
    ...LoginTeacherResponse.parse(updated),
    mustChangePassword: updated.mustChangePassword,
    totpEnabled: updated.totpEnabled,
    emailVerified: updated.emailVerified || isEmailVerificationBypassed(),
    sessionResumeToken,
    ...(previewSessionToken ? { previewSessionToken } : {}),
    ...extra,
  });
}

async function beginTotpSetup(req: Request, teacher: Teacher): Promise<{ secret: string; qrCode: string; setupToken: string }> {
  // Each fresh setup attempt replaces any unconfirmed secret. This ensures a
  // QR/manual secret exposed in an abandoned setup screen cannot be reused.
  const secret = generateSecret();
  if (!isValidTotpSecret(secret)) {
    throw new Error("Unable to generate a valid authenticator secret");
  }
  const setupToken = randomBytes(32).toString("base64url");
  await db.update(teachersTable).set({
    totpSecret: secret,
    totpEnabled: false,
    totpSetupTokenHash: hashTotpSetupToken(setupToken),
    totpSetupTokenExpiresAt: new Date(Date.now() + TOTP_SETUP_TOKEN_TTL_MS),
    pendingTotpLoginTokenHash: null,
    pendingTotpLoginTokenExpiresAt: null,
  }).where(eq(teachersTable.id, teacher.id));
  await beginPendingTeacherTotpSession(req, teacher.id, true);
  const uri = generateURI({ issuer: "The Assisted Climb", label: teacher.email, secret });
  return { secret, qrCode: await QRCode.toDataURL(uri), setupToken };
}

async function createTeacherRecoveryCodes(teacherId: number): Promise<string[]> {
  const codes = Array.from({ length: 10 }, teacherRecoveryCode);
  const rows = await Promise.all(codes.map(async (code) => ({ teacherId, codeHash: await bcrypt.hash(code, 12) })));
  await db.transaction(async (tx) => {
    await tx.delete(teacherRecoveryCodesTable).where(eq(teacherRecoveryCodesTable.teacherId, teacherId));
    await tx.insert(teacherRecoveryCodesTable).values(rows);
  });
  return codes;
}

// ── Register ──────────────────────────────────────────────────────────────────

const RegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(12),
  name: z.string().trim().min(1).max(120),
  inviteCode: z.string().trim().min(1).max(64),
  acceptHibpWarning: z.boolean().optional().default(false),
});

router.post("/auth/register", authLimiter, async (req, res): Promise<void> => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { email, password, name, inviteCode } = parsed.data;
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

  let organisationId: number | null = null;

  {
    const [org] = await db
      .select({
        id: organisationsTable.id,
        active: organisationsTable.active,
        deletedAt: organisationsTable.deletedAt,
        allowedEmailDomains: organisationsTable.allowedEmailDomains,
      })
      .from(organisationsTable)
      .where(eq(organisationsTable.teacherInviteCode, inviteCode.toUpperCase()));

    if (!org) {
      res.status(400).json({ error: "Invalid invite code" });
      return;
    }

    if (!org.active || org.deletedAt) {
      res.status(403).json({ error: "This school account is currently suspended" });
      return;
    }

    if (org.allowedEmailDomains && org.allowedEmailDomains.length > 0) {
      const emailDomain = email.toLowerCase().split("@")[1] ?? "";
      const allowed = org.allowedEmailDomains.map((d) => d.toLowerCase().replace(/^@/, ""));
      if (!allowed.includes(emailDomain)) {
        res.status(403).json({
          error: `Registration is restricted to school email addresses (${allowed.map((d) => `@${d}`).join(", ")})`,
        });
        return;
      }
    }

    organisationId = org.id;
  }

  const [existing] = await db
    .select({ id: teachersTable.id })
    .from(teachersTable)
    .where(eq(teachersTable.email, email.toLowerCase()));

  if (existing) {
    res.status(409).json({ error: "Email already in use" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const [teacher] = await db
    .insert(teachersTable)
    .values({
      email: email.toLowerCase(),
      passwordHash,
      name,
      organisationId,
      emailVerified: false,
      approvalStatus: "pending",
    })
    .returning();
  await recordTeacherPassword(teacher.id, passwordHash);
  if (passwordPolicy.warningCode === HIBP_UNAVAILABLE_CODE && parsed.data.acceptHibpWarning) {
    await recordHibpUnavailableAcknowledgement();
  }

  await logAudit({
    organisationId: teacher.organisationId,
    teacherId: teacher.id,
    action: "teacher.registered",
    ipAddress: req.ip,
  });
  if (!isEmailVerificationBypassed()) {
    try {
      await sendTeacherEmailVerification(teacher);
      await logAudit({
        organisationId: teacher.organisationId,
        teacherId: teacher.id,
        action: "teacher.email_verification_requested",
        metadata: { reason: "registration" },
        ipAddress: req.ip,
      });
    } catch (err) {
      req.log?.error({ err, teacherId: teacher.id }, "Unable to send teacher email verification");
    }
  }

  const setup = await beginTotpSetup(req, teacher);
  res.status(201).json({
    totpSetupRequired: true,
    approvalPending: true,
    message: "Your account is awaiting approval from a school administrator. Verify your email and finish authenticator setup while you wait.",
    ...setup,
    ...(passwordPolicy.warning ? { warning: passwordPolicy.warning } : {}),
  });
});

// ── Login ─────────────────────────────────────────────────────────────────────

router.post("/auth/login", authLimiter, async (req, res): Promise<void> => {
  const parsed = LoginTeacherBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { email, password } = parsed.data;

  const [teacher] = await db
    .select()
    .from(teachersTable)
    .where(eq(teachersTable.email, email.toLowerCase()));

  if (!teacher) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  if (teacher.accountStatus !== "active") {
    res.status(403).json({
      error: teacher.accountStatus === "suspended"
        ? "This teacher account is suspended. Please contact your school administrator."
        : "This teacher account is no longer available.",
    });
    return;
  }
  if (teacher.approvalStatus !== "approved") {
    res.status(403).json({
      error: teacher.approvalStatus === "pending"
        ? "Your teacher account is awaiting approval from a school administrator."
        : "Your teacher account registration was not approved. Please contact your school administrator.",
      approvalStatus: teacher.approvalStatus,
    });
    return;
  }
  if (!await isTeacherOrganisationAvailable(teacher)) {
    res.status(403).json({ error: "This school account is no longer available. Please contact your platform administrator." });
    return;
  }

  // Account lockout check
  if (teacher.lockedUntil && teacher.lockedUntil > new Date()) {
    const minutesLeft = Math.ceil((teacher.lockedUntil.getTime() - Date.now()) / 60000);
    res.status(429).json({
      error: `Account temporarily locked after too many failed attempts. Try again in ${minutesLeft} minute${minutesLeft !== 1 ? "s" : ""}.`,
    });
    return;
  }

  const valid = await bcrypt.compare(password, teacher.passwordHash);
  if (!valid) {
    const newAttempts = teacher.failedLoginAttempts + 1;
    const shouldLock = newAttempts >= 5;
    const lockedUntil = shouldLock ? new Date(Date.now() + 15 * 60 * 1000) : undefined;

    await db
      .update(teachersTable)
      .set({ failedLoginAttempts: newAttempts, ...(lockedUntil ? { lockedUntil } : {}) })
      .where(eq(teachersTable.id, teacher.id));

    if (shouldLock) {
      await logAudit({
        organisationId: teacher.organisationId,
        teacherId: teacher.id,
        action: "teacher.account_locked",
        metadata: { reason: "5 consecutive failed login attempts" },
        ipAddress: req.ip,
      });
    }

    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  // Org active check
  if (teacher.organisationId) {
    const [org] = await db
      .select({ active: organisationsTable.active, deletedAt: organisationsTable.deletedAt })
      .from(organisationsTable)
      .where(eq(organisationsTable.id, teacher.organisationId));

    if (!org || org.deletedAt || !org.active) {
      res.status(403).json({ error: "Your school account has been suspended. Please contact your platform administrator." });
      return;
    }
  }

  if (!teacher.emailVerified && !isEmailVerificationBypassed()) {
    res.status(403).json({ error: "Please verify your school email before signing in." });
    return;
  }

  await db.update(teachersTable).set({ failedLoginAttempts: 0, lockedUntil: null }).where(eq(teachersTable.id, teacher.id));

  // TOTP enrollment is mandatory before any usable teacher session is created.
  if (!teacher.totpSecret) {
    const setup = await beginTotpSetup(req, teacher);
    res.json({ totpSetupRequired: true, ...setup });
    return;
  }
  if (!isValidTotpSecret(teacher.totpSecret)) {
    res.status(400).json({ error: INVALID_TOTP_SETUP_ERROR });
    return;
  }
  if (!teacher.totpEnabled) {
    const setup = await beginTotpSetup(req, teacher);
    res.json({ totpSetupRequired: true, ...setup });
    return;
  }

  // TOTP second factor
  if (teacher.totpEnabled && teacher.totpSecret) {
    const totpLoginToken = await beginPendingTeacherTotpSession(req, teacher.id, false);
    if (!totpLoginToken) {
      res.status(500).json({ error: "Unable to start two-factor verification. Please try again." });
      return;
    }
    res.json({ totpRequired: true, totpLoginToken });
    return;
  }
});

router.get("/auth/verify-email", async (req, res): Promise<void> => {
  const parsed = VerifyTeacherEmailQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "This verification link is invalid or incomplete." });
    return;
  }
  const tokenHash = hashTotpSetupToken(parsed.data.token);
  const [teacher] = await db
    .update(teachersTable)
    .set({
      emailVerified: true,
      emailVerificationTokenHash: null,
      emailVerificationExpiresAt: null,
    })
    .where(and(
      eq(teachersTable.emailVerificationTokenHash, tokenHash),
      gt(teachersTable.emailVerificationExpiresAt, new Date()),
      eq(teachersTable.accountStatus, "active"),
    ))
    .returning();
  if (!teacher) {
    res.status(400).json({ error: "This verification link is invalid, expired, or has already been used. Request a new link to continue." });
    return;
  }
  await logAudit({
    organisationId: teacher.organisationId,
    teacherId: teacher.id,
    action: "teacher.email_verified",
    ipAddress: req.ip,
  });
  res.json(VerifyTeacherEmailResponse.parse({ ok: true, emailVerified: true }));
});

router.post("/auth/resend-verification", emailVerificationLimiter, async (req, res): Promise<void> => {
  const parsed = ResendTeacherEmailVerificationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a valid school email address." });
    return;
  }
  const [teacher] = await db
    .select()
    .from(teachersTable)
    .where(and(
      eq(teachersTable.email, parsed.data.email.toLowerCase()),
      eq(teachersTable.accountStatus, "active"),
    ));
  if (teacher && !teacher.emailVerified && await isTeacherOrganisationAvailable(teacher)) {
    try {
      await sendTeacherEmailVerification(teacher);
      await logAudit({
        organisationId: teacher.organisationId,
        teacherId: teacher.id,
        action: "teacher.email_verification_requested",
        metadata: { reason: "resend" },
        ipAddress: req.ip,
      });
    } catch (err) {
      req.log?.error({ err, teacherId: teacher.id }, "Unable to resend teacher email verification");
    }
  }
  // Keep the response generic so this route cannot confirm that an email has an account.
  res.json(ResendTeacherEmailVerificationResponse.parse({ ok: true, emailVerified: false }));
});

// ── TOTP second-factor verify ─────────────────────────────────────────────────

const TotpCodeBody = z.object({ code: z.string().min(6).max(8) });
const TotpVerifyBody = TotpCodeBody.extend({ loginToken: z.string().min(40).max(200).optional() });
const TotpEnableBody = TotpCodeBody.extend({ setupToken: z.string().min(40).max(200) });
const SessionResumeBody = z.object({ sessionResumeToken: z.string().min(40).max(200) });

async function recordTotpFailure(req: Request, teacher: Teacher): Promise<boolean> {
  const [failure] = await db.update(teachersTable).set({
    failedLoginAttempts: sql`${teachersTable.failedLoginAttempts} + 1`,
    lockedUntil: sql`CASE WHEN ${teachersTable.failedLoginAttempts} + 1 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE NULL END`,
  }).where(eq(teachersTable.id, teacher.id)).returning({ lockedUntil: teachersTable.lockedUntil });
  const locked = Boolean(failure?.lockedUntil);
  if (locked) {
    await db.update(teachersTable).set({
      pendingTotpLoginTokenHash: null,
      pendingTotpLoginTokenExpiresAt: null,
    }).where(eq(teachersTable.id, teacher.id));
    req.session.pendingTotpTeacherId = undefined;
    req.session.pendingTotpSetupTeacherId = undefined;
    await new Promise<void>((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
  }
  return locked;
}

router.post("/auth/totp/verify", totpLimiter, async (req, res): Promise<void> => {
  const parsed = TotpVerifyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "6-digit authenticator code required" });
    return;
  }

  let pendingId = req.session.pendingTotpTeacherId;
  let ticketTeacherId: number | undefined;
  if (parsed.data.loginToken) {
    const [ticketTeacher] = await db.select({ id: teachersTable.id })
      .from(teachersTable)
      .where(and(
        eq(teachersTable.pendingTotpLoginTokenHash, hashTotpSetupToken(parsed.data.loginToken)),
        gt(teachersTable.pendingTotpLoginTokenExpiresAt, new Date()),
      ));
    ticketTeacherId = ticketTeacher?.id;
    pendingId = ticketTeacherId ?? pendingId;
  }
  if (!pendingId) {
    res.status(400).json({ error: "No pending login. Please start the login process again." });
    return;
  }

  const [teacher] = await db.select().from(teachersTable).where(eq(teachersTable.id, pendingId));
  if (!teacher || teacher.accountStatus !== "active" || teacher.approvalStatus !== "approved" || !await isTeacherOrganisationAvailable(teacher)) {
    req.session.destroy(() => {});
    res.status(403).json({ error: "This teacher account is no longer available." });
    return;
  }
  if (!teacher?.totpSecret || !teacher.totpEnabled) {
    res.status(400).json({ error: "Invalid session state" });
    return;
  }
  if (!isValidTotpSecret(teacher.totpSecret)) {
    res.status(400).json({ error: INVALID_TOTP_SETUP_ERROR });
    return;
  }
  if (teacher.lockedUntil && teacher.lockedUntil > new Date()) {
    res.status(429).json({ error: "This account is temporarily locked. Please start sign-in again later." });
    return;
  }

  const isValid = verifyTeacherTotp(parsed.data.code, teacher.totpSecret);
  if (!isValid) {
    const locked = await recordTotpFailure(req, teacher);
    await logAudit({
      organisationId: teacher.organisationId,
      teacherId: teacher.id,
      action: locked ? "teacher.totp_locked" : "teacher.totp_failed",
      ipAddress: req.ip,
    });
    res.status(401).json({ error: "Invalid authenticator code. Please check your app and try again." });
    return;
  }

  if (ticketTeacherId && parsed.data.loginToken && !await claimTotpLoginTicket(ticketTeacherId, parsed.data.loginToken)) {
    res.status(400).json({ error: "This two-factor check has already been used. Please sign in again." });
    return;
  }

  await completeLogin(req, res, teacher);
});

router.post("/auth/totp/enable", totpLimiter, async (req, res): Promise<void> => {
  const pendingId = req.session.pendingTotpSetupTeacherId;
  const parsed = TotpEnableBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Start authenticator setup again." });
    return;
  }
  const [teacher] = await db
    .select()
    .from(teachersTable)
    .where(eq(teachersTable.totpSetupTokenHash, hashTotpSetupToken(parsed.data.setupToken)));
  if (
    !teacher?.totpSecret
    || teacher.accountStatus !== "active"
    || !await isTeacherOrganisationAvailable(teacher)
    || !teacher.totpSetupTokenExpiresAt
    || teacher.totpSetupTokenExpiresAt <= new Date()
    || (pendingId !== undefined && pendingId !== teacher.id)
  ) {
    res.status(400).json({ error: INVALID_TOTP_SETUP_ERROR });
    return;
  }
  if (!isValidTotpSecret(teacher.totpSecret)) {
    res.status(400).json({ error: INVALID_TOTP_SETUP_ERROR });
    return;
  }
  if (teacher.lockedUntil && teacher.lockedUntil > new Date()) {
    res.status(429).json({ error: "This account is temporarily locked. Please start sign-in again later." });
    return;
  }
  if (!verifyTeacherTotp(parsed.data.code, teacher.totpSecret)) {
    const locked = await recordTotpFailure(req, teacher);
    await logAudit({
      organisationId: teacher.organisationId,
      teacherId: teacher.id,
      action: locked ? "teacher.totp_setup_locked" : "teacher.totp_setup_failed",
      ipAddress: req.ip,
    });
    res.status(401).json({ error: "Invalid authenticator code. Please check your app and try again." });
    return;
  }

  await db.update(teachersTable).set({
    totpEnabled: true,
    totpSetupTokenHash: null,
    totpSetupTokenExpiresAt: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
    recoveryFailedAttempts: 0,
    recoveryLockedUntil: null,
  }).where(eq(teachersTable.id, teacher.id));
  const recoveryCodes = await createTeacherRecoveryCodes(teacher.id);
  await logAudit({
    organisationId: teacher.organisationId,
    teacherId: teacher.id,
    action: "teacher.totp_enabled",
    ipAddress: req.ip,
  });
  if (teacher.approvalStatus !== "approved") {
    res.json({
      recoveryCodes,
      approvalPending: true,
      message: "Authenticator setup is complete. Your account is awaiting approval from a school administrator.",
    });
    return;
  }
  await completeLogin(req, res, teacher, { recoveryCodes });
});

router.post("/auth/session/restore", authLimiter, async (req, res): Promise<void> => {
  const parsed = SessionResumeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "The sign-in recovery request is invalid. Please sign in again." });
    return;
  }

  const [teacher] = await db
    .update(teachersTable)
    .set({
      postMfaSessionTicketHash: null,
      postMfaSessionTicketExpiresAt: null,
    })
    .where(and(
      eq(teachersTable.postMfaSessionTicketHash, hashTotpSetupToken(parsed.data.sessionResumeToken)),
      gt(teachersTable.postMfaSessionTicketExpiresAt, new Date()),
      eq(teachersTable.accountStatus, "active"),
      eq(teachersTable.approvalStatus, "approved"),
    ))
    .returning();

  if (!teacher || !await isTeacherOrganisationAvailable(teacher)) {
    res.status(401).json({ error: "This sign-in recovery request has expired. Please sign in again." });
    return;
  }

  await establishTeacherSession(req, teacher.id);
  await logAudit({
    organisationId: teacher.organisationId,
    teacherId: teacher.id,
    action: "teacher.session_resumed_after_webview_cookie_loss",
    ipAddress: req.ip,
  });
  res.json({
    ...LoginTeacherResponse.parse(teacher),
    mustChangePassword: teacher.mustChangePassword,
    totpEnabled: teacher.totpEnabled,
    emailVerified: teacher.emailVerified || isEmailVerificationBypassed(),
  });
});

const TotpRecoveryBody = z.object({
  code: z.string().min(8).max(80),
  loginToken: z.string().min(40).max(200).optional(),
});

const TeacherDeviceRecoveryBody = z.object({
  email: z.string().email(),
  recoveryCode: z.string().min(8).max(80),
});

const TeacherPasswordRecoveryBody = z.object({
  email: z.string().email(),
  newPassword: z.string().min(12),
  totpCode: z.string().min(6).max(8).optional(),
  recoveryCode: z.string().min(8).max(80).optional(),
  acceptHibpWarning: z.boolean().optional().default(false),
}).refine((value) => Boolean(value.totpCode) !== Boolean(value.recoveryCode), {
  message: "Use either an authenticator code or one recovery code.",
});

async function recordTeacherRecoveryFailure(req: Request, teacher: Teacher, action: string): Promise<void> {
  const [failure] = await db.update(teachersTable).set({
    recoveryFailedAttempts: sql`${teachersTable.recoveryFailedAttempts} + 1`,
    recoveryLockedUntil: sql`CASE WHEN ${teachersTable.recoveryFailedAttempts} + 1 >= 3 THEN NOW() + INTERVAL '15 minutes' ELSE NULL END`,
  }).where(eq(teachersTable.id, teacher.id)).returning({ recoveryLockedUntil: teachersTable.recoveryLockedUntil });
  await logAudit({
    organisationId: teacher.organisationId,
    teacherId: teacher.id,
    action: failure?.recoveryLockedUntil ? `${action}_locked` : `${action}_failed`,
    ipAddress: req.ip,
  });
}

async function findUnusedTeacherRecoveryCode(teacherId: number, recoveryCode: string): Promise<number | null> {
  const codes = await db.select().from(teacherRecoveryCodesTable)
    .where(and(eq(teacherRecoveryCodesTable.teacherId, teacherId), sql`${teacherRecoveryCodesTable.usedAt} IS NULL`));
  for (const entry of codes) {
    if (await bcrypt.compare(recoveryCode, entry.codeHash)) return entry.id;
  }
  return null;
}

router.post("/auth/recover-device", authLimiter, async (req, res): Promise<void> => {
  const parsed = TeacherDeviceRecoveryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter your school email address and one recovery code." });
    return;
  }
  const [teacher] = await db.select().from(teachersTable)
    .where(eq(teachersTable.email, parsed.data.email.toLowerCase()));
  if (!teacher || teacher.accountStatus !== "active" || !await isTeacherOrganisationAvailable(teacher) || !teacher.totpEnabled || !teacher.totpSecret) {
    res.status(400).json({ error: "Authenticator recovery is not available for this account." });
    return;
  }
  if (teacher.recoveryLockedUntil && teacher.recoveryLockedUntil > new Date()) {
    res.status(429).json({ error: "Authenticator recovery is temporarily locked. Please try again later." });
    return;
  }

  const matchedCodeId = await findUnusedTeacherRecoveryCode(teacher.id, parsed.data.recoveryCode);
  if (!matchedCodeId) {
    await recordTeacherRecoveryFailure(req, teacher, "teacher.direct_totp_recovery");
    res.status(401).json({ error: "Unable to verify that recovery code." });
    return;
  }

  const replaced = await db.transaction(async (tx) => {
    const [claimed] = await tx.update(teacherRecoveryCodesTable)
      .set({ usedAt: new Date() })
      .where(and(eq(teacherRecoveryCodesTable.id, matchedCodeId), sql`${teacherRecoveryCodesTable.usedAt} IS NULL`))
      .returning({ id: teacherRecoveryCodesTable.id });
    if (!claimed) return false;
    await tx.update(teachersTable).set({
      totpSecret: null,
      totpEnabled: false,
      totpSetupTokenHash: null,
      totpSetupTokenExpiresAt: null,
      recoveryFailedAttempts: 0,
      recoveryLockedUntil: null,
    }).where(eq(teachersTable.id, teacher.id));
    return true;
  });
  if (!replaced) {
    res.status(401).json({ error: "Unable to verify that recovery code." });
    return;
  }

  await terminateTeacherSessions(teacher.id);
  const setup = await beginTotpSetup(req, teacher);
  await logAudit({
    organisationId: teacher.organisationId,
    teacherId: teacher.id,
    action: "teacher.totp_recovered",
    ipAddress: req.ip,
    metadata: { method: "self_service_recovery_code" },
  });
  res.json({ totpSetupRequired: true, deviceReplacement: true, ...setup });
});

router.post("/auth/recover-password", authLimiter, async (req, res): Promise<void> => {
  const parsed = TeacherPasswordRecoveryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter your school email, new password, and either an authenticator or recovery code." });
    return;
  }
  const [teacher] = await db.select().from(teachersTable)
    .where(eq(teachersTable.email, parsed.data.email.toLowerCase()));
  if (!teacher || teacher.accountStatus !== "active" || !await isTeacherOrganisationAvailable(teacher) || !teacher.totpEnabled || !teacher.totpSecret) {
    res.status(400).json({ error: "Unable to verify this recovery request." });
    return;
  }
  if (parsed.data.totpCode && !isValidTotpSecret(teacher.totpSecret)) {
    res.status(400).json({ error: "Unable to verify this recovery request." });
    return;
  }
  if (teacher.recoveryLockedUntil && teacher.recoveryLockedUntil > new Date()) {
    res.status(429).json({ error: "Password recovery is temporarily locked. Please try again later." });
    return;
  }

  let matchedCodeId: number | null = null;
  const verified = parsed.data.totpCode
    ? verifyTeacherTotp(parsed.data.totpCode, teacher.totpSecret)
    : Boolean(matchedCodeId = await findUnusedTeacherRecoveryCode(teacher.id, parsed.data.recoveryCode!));
  if (!verified) {
    await recordTeacherRecoveryFailure(req, teacher, "teacher.password_recovery");
    res.status(401).json({ error: "Unable to verify this recovery request." });
    return;
  }

  const passwordPolicy = await checkPasswordPolicy(parsed.data.newPassword, teacher.id, teacher.passwordHash);
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
  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
  const recovered = await db.transaction(async (tx) => {
    if (matchedCodeId) {
      const [claimed] = await tx.update(teacherRecoveryCodesTable)
        .set({ usedAt: new Date() })
        .where(and(eq(teacherRecoveryCodesTable.id, matchedCodeId), sql`${teacherRecoveryCodesTable.usedAt} IS NULL`))
        .returning({ id: teacherRecoveryCodesTable.id });
      if (!claimed) return false;
    }
    const [updated] = await tx.update(teachersTable).set({
      passwordHash,
      mustChangePassword: false,
      recoveryFailedAttempts: 0,
      recoveryLockedUntil: null,
    }).where(eq(teachersTable.id, teacher.id)).returning({ id: teachersTable.id });
    return Boolean(updated);
  });
  if (!recovered) {
    res.status(401).json({ error: "Unable to verify this recovery request." });
    return;
  }

  await recordTeacherPassword(teacher.id, passwordHash);
  await terminateTeacherSessions(teacher.id);
  if (passwordPolicy.warningCode === HIBP_UNAVAILABLE_CODE && parsed.data.acceptHibpWarning) {
    await recordHibpUnavailableAcknowledgement();
  }
  await logAudit({
    organisationId: teacher.organisationId,
    teacherId: teacher.id,
    action: "teacher.password_recovered",
    ipAddress: req.ip,
    metadata: { method: matchedCodeId ? "recovery_code" : "authenticator" },
  });
  res.json({ ok: true, sessionsTerminated: true, ...(passwordPolicy.warning ? { warning: passwordPolicy.warning } : {}) });
});

router.post("/auth/totp/recover", totpLimiter, async (req, res): Promise<void> => {
  const parsed = TotpRecoveryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Start sign-in again, then enter one recovery code." });
    return;
  }
  let pendingId = req.session.pendingTotpTeacherId;
  if (parsed.data.loginToken) {
    const [ticketTeacher] = await db.select({ id: teachersTable.id })
      .from(teachersTable)
      .where(and(
        eq(teachersTable.pendingTotpLoginTokenHash, hashTotpSetupToken(parsed.data.loginToken)),
        gt(teachersTable.pendingTotpLoginTokenExpiresAt, new Date()),
      ));
    pendingId = ticketTeacher?.id ?? pendingId;
  }
  if (!pendingId) {
    res.status(400).json({ error: "Start sign-in again, then enter one recovery code." });
    return;
  }
  const [teacher] = await db.select().from(teachersTable).where(eq(teachersTable.id, pendingId));
  if (!teacher || teacher.accountStatus !== "active" || !await isTeacherOrganisationAvailable(teacher)) {
    req.session.destroy(() => {});
    res.status(403).json({ error: "This teacher account is no longer available." });
    return;
  }
  if (!teacher?.totpEnabled || !teacher.totpSecret) {
    res.status(400).json({ error: "Authenticator recovery is not available for this account." });
    return;
  }
  if (teacher.recoveryLockedUntil && teacher.recoveryLockedUntil > new Date()) {
    res.status(429).json({ error: "Authenticator recovery is temporarily locked. Please try again later." });
    return;
  }

  const codes = await db.select().from(teacherRecoveryCodesTable)
    .where(and(eq(teacherRecoveryCodesTable.teacherId, teacher.id), sql`${teacherRecoveryCodesTable.usedAt} IS NULL`));
  let matchedCodeId: number | null = null;
  for (const entry of codes) {
    if (await bcrypt.compare(parsed.data.code, entry.codeHash)) {
      matchedCodeId = entry.id;
      break;
    }
  }
  if (!matchedCodeId) {
    const [failure] = await db.update(teachersTable).set({
      recoveryFailedAttempts: sql`${teachersTable.recoveryFailedAttempts} + 1`,
      recoveryLockedUntil: sql`CASE WHEN ${teachersTable.recoveryFailedAttempts} + 1 >= 3 THEN NOW() + INTERVAL '15 minutes' ELSE NULL END`,
    }).where(eq(teachersTable.id, teacher.id)).returning({ recoveryLockedUntil: teachersTable.recoveryLockedUntil });
    await logAudit({
      organisationId: teacher.organisationId,
      teacherId: teacher.id,
      action: failure?.recoveryLockedUntil ? "teacher.totp_recovery_locked" : "teacher.totp_recovery_failed",
      ipAddress: req.ip,
    });
    res.status(401).json({ error: "Unable to verify that recovery code." });
    return;
  }

  const replacementSecret = generateSecret();
  const claimed = await db.transaction(async (tx) => {
    const [code] = await tx.update(teacherRecoveryCodesTable)
      .set({ usedAt: new Date() })
      .where(and(eq(teacherRecoveryCodesTable.id, matchedCodeId), sql`${teacherRecoveryCodesTable.usedAt} IS NULL`))
      .returning({ id: teacherRecoveryCodesTable.id });
    if (!code) return false;
    await tx.update(teachersTable).set({
      totpSecret: replacementSecret,
      totpEnabled: false,
      totpSetupTokenHash: null,
      totpSetupTokenExpiresAt: null,
      recoveryFailedAttempts: 0,
      recoveryLockedUntil: null,
    }).where(eq(teachersTable.id, teacher.id));
    return true;
  });
  if (!claimed) {
    res.status(401).json({ error: "Unable to verify that recovery code." });
    return;
  }

  await terminateTeacherSessions(teacher.id);
  const setup = await beginTotpSetup(req, { ...teacher, totpSecret: replacementSecret, totpEnabled: false });
  await logAudit({
    organisationId: teacher.organisationId,
    teacherId: teacher.id,
    action: "teacher.totp_recovered",
    ipAddress: req.ip,
  });
  res.json({ totpSetupRequired: true, deviceReplacement: true, ...setup });
});

// ── Change password (force-change flow) ──────────────────────────────────────

const ChangePasswordBody = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().min(12),
  acceptHibpWarning: z.boolean().optional().default(false),
});

router.post("/auth/change-password", async (req, res): Promise<void> => {
  const teacherId = req.session.teacherId;
  let teacher: Teacher | undefined;

  if (teacherId) {
    const [found] = await db.select().from(teachersTable).where(eq(teachersTable.id, teacherId));
    if (found) teacher = found;
  }

  if (!teacher || teacher.accountStatus !== "active" || !await isTeacherOrganisationAvailable(teacher)) {
    req.session.destroy(() => {});
    res.status(403).json({ error: "This teacher account is no longer available." });
    return;
  }

  if (!teacher?.totpEnabled || !teacher.totpSecret) {
    req.session.destroy(() => {});
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const parsed = ChangePasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "New password must be at least 12 characters" });
    return;
  }

  // Verify current password when teacher is not in a forced-change flow
  if (!teacher.mustChangePassword) {
    if (!parsed.data.currentPassword) {
      res.status(400).json({ error: "Current password is required" });
      return;
    }
    const match = await bcrypt.compare(parsed.data.currentPassword, teacher.passwordHash ?? "");
    if (!match) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }
  }

  const passwordPolicy = await checkPasswordPolicy(parsed.data.newPassword, teacher.id, teacher.passwordHash);
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
  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);

  await db
    .update(teachersTable)
    .set({ passwordHash, mustChangePassword: false })
    .where(eq(teachersTable.id, teacher.id));
  await recordTeacherPassword(teacher.id, passwordHash);
  await terminateTeacherSessions(teacher.id);
  if (passwordPolicy.warningCode === HIBP_UNAVAILABLE_CODE && parsed.data.acceptHibpWarning) {
    await recordHibpUnavailableAcknowledgement();
  }

  await logAudit({
    organisationId: teacher.organisationId,
    teacherId: teacher.id,
    action: "teacher.password_changed",
    ipAddress: req.ip,
  });

  res.json({ ok: true, sessionsTerminated: true, ...(passwordPolicy.warning ? { warning: passwordPolicy.warning } : {}) });
});

// ── Forgot password (email-based self-service) ────────────────────────────────

const ForgotPasswordBody = z.object({ email: z.string().email() });

router.post("/auth/forgot-password", authLimiter, async (req, res): Promise<void> => {
  const parsed = ForgotPasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A valid email address is required" });
    return;
  }

  const { email } = parsed.data;

  // Always return 200 to avoid email enumeration
  res.json({ ok: true });

  // Do the work after responding
  try {
    const [teacher] = await db
      .select()
      .from(teachersTable)
      .where(eq(teachersTable.email, email.toLowerCase()));

    if (!teacher || !await isTeacherOrganisationAvailable(teacher)) return;

    const resetToken = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db
      .update(teachersTable)
      .set({ passwordResetToken: hashPasswordResetToken(resetToken), passwordResetExpiresAt: expiresAt })
      .where(eq(teachersTable.id, teacher.id));

    await logAudit({
      organisationId: teacher.organisationId,
      teacherId: teacher.id,
      action: "teacher.password_reset_requested",
      metadata: { method: "self-service" },
    });

    const baseUrl = getAppBaseUrl();
    const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(resetToken)}`;
    const safeTeacherName = escapeHtml(teacher.name);

    await sendEmail({
      to: email,
      subject: "Reset your password — The Assisted Climb",
      text: `Hi ${teacher.name},\n\nYou requested a password reset for your Assisted Climb account.\n\nClick the link below to set a new password (expires in 1 hour):\n${resetUrl}\n\nIf you didn't request this, you can ignore this email — your password won't change.\n`,
      html: `
        <p>Hi ${safeTeacherName},</p>
        <p>You requested a password reset for your Assisted Climb account.</p>
        <p><a href="$
{
resetUrl
}
" style="background:#000
;
color:#fff
;
padding:12px 24px
;
border-radius:12px
;
text-decoration:none
;
display:inline-block
;
font-size:14px
;
">Reset my password</a></p>
        <p style="color:#888
;
font-size:12px
;
">This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>
        <p style="color:#bbb
;
font-size:11px
;
">Or copy this URL: ${resetUrl}</p>
      `,
    });
  } catch (err) {
    req.log?.error({ err }, "Failed to send password reset email");
  }
});

// ── Password reset (token-based, no email required) ───────────────────────────

const ResetPasswordBody = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(12),
  acceptHibpWarning: z.boolean().optional().default(false),
});

router.post("/auth/reset-password", authLimiter, async (req, res): Promise<void> => {
  const parsed = ResetPasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { token, newPassword } = parsed.data;
  const tokenHash = hashPasswordResetToken(token);

  const [teacher] = await db
    .select()
    .from(teachersTable)
    .where(eq(teachersTable.passwordResetToken, tokenHash));

  if (!teacher) {
    res.status(400).json({ error: "Invalid or expired reset link" });
    return;
  }

  if (teacher.accountStatus !== "active" || !await isTeacherOrganisationAvailable(teacher)) {
    res.status(400).json({ error: "This account is no longer available." });
    return;
  }

  if (!teacher.passwordResetExpiresAt || teacher.passwordResetExpiresAt < new Date()) {
    res.status(400).json({ error: "This reset link has expired. Please request a new one." });
    return;
  }

  const passwordPolicy = await checkPasswordPolicy(newPassword, teacher.id, teacher.passwordHash);
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
  const passwordHash = await bcrypt.hash(newPassword, 12);

  const [consumedReset] = await db
    .update(teachersTable)
    .set({ passwordHash, passwordResetToken: null, passwordResetExpiresAt: null, mustChangePassword: teacher.mustChangePassword, failedLoginAttempts: 0, lockedUntil: null })
    .where(
      and(
        eq(teachersTable.id, teacher.id),
        eq(teachersTable.passwordResetToken, tokenHash),
        gt(teachersTable.passwordResetExpiresAt, new Date()),
      ),
    )
    .returning({ id: teachersTable.id });

  if (!consumedReset) {
    res.status(400).json({ error: "Invalid or expired reset link" });
    return;
  }

  await recordTeacherPassword(teacher.id, passwordHash);
  await terminateTeacherSessions(teacher.id);
  if (passwordPolicy.warningCode === HIBP_UNAVAILABLE_CODE && parsed.data.acceptHibpWarning) {
    await recordHibpUnavailableAcknowledgement();
  }

  await logAudit({
    organisationId: teacher.organisationId,
    teacherId: teacher.id,
    action: "teacher.password_reset",
    ipAddress: req.ip,
  });

  res.json({ ok: true, sessionsTerminated: true, ...(passwordPolicy.warning ? { warning: passwordPolicy.warning } : {}) });
});

// ── /auth/me ──────────────────────────────────────────────────────────────────

router.get("/auth/me", async (req, res): Promise<void> => {
  // Authentication state must never be satisfied from a browser or proxy
  // cache. A 304 response has no JSON body and can look like a failed login
  // to the client immediately after MFA rotates the session cookie.
  res.set("Cache-Control", "no-store");
  let teacher: Teacher | undefined;

  const teacherId = req.session.teacherId;
  if (teacherId) {
    const [found] = await db.select().from(teachersTable).where(eq(teachersTable.id, teacherId));
    if (found && found.accountStatus === "active" && found.approvalStatus === "approved" && await isTeacherOrganisationAvailable(found)) teacher = found;
    else req.session.destroy(() => {});
  }

  if (!teacher) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  res.json({
    ...GetTeacherMeResponse.parse(teacher),
    mustChangePassword: teacher.mustChangePassword,
    totpEnabled: teacher.totpEnabled,
    emailVerified: teacher.emailVerified || isEmailVerificationBypassed(),
  });
});

async function getSessionStatus(req: Request, res: Response): Promise<void> {
  res.set("Cache-Control", "no-store");
  if (req.session.teacherId) {
    const [teacher] = await db.select().from(teachersTable).where(eq(teachersTable.id, req.session.teacherId));
    if (!teacher || teacher.accountStatus !== "active" || teacher.approvalStatus !== "approved" || !await isTeacherOrganisationAvailable(teacher)) {
      req.session.destroy(() => {});
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
  }
  if (!req.session.teacherId && !req.session.studentSessionId && !req.session.cigAdminId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const startedAt = req.session.sessionStartedAt ?? Date.now();
  const lastActivityAt = req.session.lastActivityAt ?? startedAt;
  res.json({
    absoluteExpiresAt: new Date(startedAt + SESSION_ABSOLUTE_TIMEOUT_MS).toISOString(),
    idleExpiresAt: new Date(lastActivityAt + SESSION_IDLE_TIMEOUT_MS).toISOString(),
  });
}

router.get("/session/status", getSessionStatus);
router.post("/session/keep-alive", getSessionStatus);

// ── Email / SMTP status (IT admins only) ─────────────────────────────────────

router.get("/auth/email-status", requireTeacher, async (req, res): Promise<void> => {
  if (req.teacher?.schoolAdminRole !== "master") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  res.json({ configured: isEmailConfigured() });
});

// ── Test email (IT admins only) ───────────────────────────────────────────────

router.post("/auth/test-email", requireTeacher, testEmailLimiter, async (req, res): Promise<void> => {
  const teacher = req.teacher!;
  if (teacher.schoolAdminRole !== "master") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  if (!isEmailConfigured()) {
    res.status(400).json({ error: "SMTP is not configured" });
    return;
  }

  try {
    await sendEmail({
      to: teacher.email,
      subject: "Test email — The Assisted Climb",
      text: `Hi ${teacher.name},\n\nThis is a test email from The Assisted Climb to verify your SMTP configuration is working correctly.\n\nIf you received this, email delivery is working.\n`,
      html: `
        <p>Hi ${escapeHtml(teacher.name)},</p>
        <p>This is a test email from <strong>The Assisted Climb</strong> to verify your SMTP configuration is working correctly.</p>
        <p style="color:#16a34a
;
font-weight:600
;
">✓ Email delivery is working.</p>
        <p style="color:#888
;
font-size:12px
;
">You can dismiss this message — no action is required.</p>
      `,
    });
    await logAudit({
      organisationId: teacher.organisationId,
      teacherId: teacher.id,
      action: "teacher.email_test_sent",
      ipAddress: req.ip,
    });
    res.json({ ok: true });
  } catch (err) {
    req.log?.error({ err }, "Test email failed");
    res.status(500).json({ error: "Unable to send the test email. Check the SMTP configuration and try again." });
  }
});

// ── Site gate ─────────────────────────────────────────────────────────────────

router.get("/auth/site-status", (req, res): void => {
  const locked = !!process.env.SITE_PASSWORD?.trim();
  const authed = !locked || !!req.session.siteAuthed;
  res.json({ locked, authed });
});

const SiteAccessBody = z.object({ password: z.string().min(1).max(512) });

router.post("/auth/site-access", siteAccessLimiter, (req, res): void => {
  const sitePassword = process.env.SITE_PASSWORD?.trim();
  if (!sitePassword) { res.json({ ok: true }); return; }
  const parsed = SiteAccessBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A valid password is required" });
    return;
  }
  const { password } = parsed.data;
  if (password !== sitePassword) {
    res.status(401).json({ error: "Incorrect password" });
    return;
  }
  applySessionCookiePolicy(req);
  req.session.siteAuthed = true;
  res.json({ ok: true });
});

// ── Logout ────────────────────────────────────────────────────────────────────

router.post("/auth/logout", async (req, res): Promise<void> => {
  const teacherId = req.session.teacherId;
  if (teacherId) {
    await db.update(teachersTable).set({
      loginToken: null,
      postMfaSessionTicketHash: null,
      postMfaSessionTicketExpiresAt: null,
    }).where(eq(teachersTable.id, teacherId));
    await logAudit({ teacherId, action: "teacher.logout", ipAddress: req.ip });
  }
  await regenerateAnonymousSessionPreservingSiteAccess(req);
  res.sendStatus(204);
});

export default router;

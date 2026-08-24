import { Router, type IRouter, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db, teachersTable, organisationsTable, type Teacher } from "@workspace/db";
import { LoginTeacherBody, LoginTeacherResponse, GetTeacherMeResponse } from "@workspace/api-zod";
import { z } from "zod/v4";
import rateLimit from "express-rate-limit";
import { verifySync } from "otplib";
import { logAudit } from "../lib/audit";
import { sendEmail, isEmailConfigured } from "../lib/email";

const router: IRouter = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many attempts. Please wait 15 minutes before trying again." },
  standardHeaders: true,
  legacyHeaders: false,
});

async function completeLogin(req: Request, res: Response, teacher: Teacher): Promise<void> {
  const loginToken = randomUUID();
  const [updated] = await db
    .update(teachersTable)
    .set({ loginToken, failedLoginAttempts: 0, lockedUntil: null })
    .where(eq(teachersTable.id, teacher.id))
    .returning();

  req.session.teacherId = teacher.id;
  // Do NOT clear req.session.studentSessionId — teacher and student sessions
  // must be able to coexist in the same browser cookie (see Error 4).
  req.session.pendingTotpTeacherId = undefined;

  await logAudit({
    organisationId: teacher.organisationId,
    teacherId: teacher.id,
    action: "teacher.login",
    ipAddress: req.ip,
  });

  res.json({
    ...LoginTeacherResponse.parse(updated),
    loginToken,
    mustChangePassword: updated.mustChangePassword,
    totpEnabled: updated.totpEnabled,
  });
}

// ── Register ──────────────────────────────────────────────────────────────────

const RegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  inviteCode: z.string().optional(),
});

router.post("/auth/register", authLimiter, async (req, res): Promise<void> => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { email, password, name, inviteCode } = parsed.data;

  let organisationId: number | null = null;

  if (inviteCode) {
    const [org] = await db
      .select({ id: organisationsTable.id, active: organisationsTable.active, allowedEmailDomains: organisationsTable.allowedEmailDomains })
      .from(organisationsTable)
      .where(eq(organisationsTable.teacherInviteCode, inviteCode.toUpperCase()));

    if (!org) {
      res.status(400).json({ error: "Invalid invite code" });
      return;
    }

    if (!org.active) {
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
  const loginToken = randomUUID();

  const [teacher] = await db
    .insert(teachersTable)
    .values({ email: email.toLowerCase(), passwordHash, name, loginToken, organisationId })
    .returning();

  req.session.teacherId = teacher.id;
  // Do NOT clear req.session.studentSessionId — teacher and student sessions
  // must be able to coexist in the same browser cookie (see Error 4).

  await logAudit({
    organisationId: teacher.organisationId,
    teacherId: teacher.id,
    action: "teacher.registered",
    ipAddress: req.ip,
  });

  res.status(201).json({
    ...LoginTeacherResponse.parse(teacher),
    loginToken,
    mustChangePassword: teacher.mustChangePassword,
    totpEnabled: teacher.totpEnabled,
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
      .select({ active: organisationsTable.active })
      .from(organisationsTable)
      .where(eq(organisationsTable.id, teacher.organisationId));

    if (org && !org.active) {
      res.status(403).json({ error: "Your school account has been suspended. Please contact your platform administrator." });
      return;
    }
  }

  // TOTP second factor
  if (teacher.totpEnabled && teacher.totpSecret) {
    req.session.pendingTotpTeacherId = teacher.id;
    res.json({ totpRequired: true });
    return;
  }

  await completeLogin(req, res, teacher);
});

// ── TOTP second-factor verify ─────────────────────────────────────────────────

const TotpVerifyBody = z.object({ code: z.string().min(6).max(8) });

router.post("/auth/totp/verify", async (req, res): Promise<void> => {
  const pendingId = req.session.pendingTotpTeacherId;
  if (!pendingId) {
    res.status(400).json({ error: "No pending login. Please start the login process again." });
    return;
  }

  const parsed = TotpVerifyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "6-digit authenticator code required" });
    return;
  }

  const [teacher] = await db.select().from(teachersTable).where(eq(teachersTable.id, pendingId));
  if (!teacher?.totpSecret) {
    res.status(400).json({ error: "Invalid session state" });
    return;
  }

  const isValid = verifySync({ token: parsed.data.code, secret: teacher.totpSecret }).valid;
  if (!isValid) {
    res.status(401).json({ error: "Invalid authenticator code. Please check your app and try again." });
    return;
  }

  await completeLogin(req, res, teacher);
});

// ── Change password (force-change flow) ──────────────────────────────────────

const ChangePasswordBody = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8),
});

router.post("/auth/change-password", async (req, res): Promise<void> => {
  const teacherId = req.session.teacherId;
  const headerToken = req.headers["x-teacher-token"];

  let teacher: Teacher | undefined;

  if (teacherId) {
    const [found] = await db.select().from(teachersTable).where(eq(teachersTable.id, teacherId));
    if (found) teacher = found;
  } else if (typeof headerToken === "string") {
    const [found] = await db.select().from(teachersTable).where(eq(teachersTable.loginToken, headerToken));
    if (found) teacher = found;
  }

  if (!teacher) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const parsed = ChangePasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "New password must be at least 8 characters" });
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

  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);

  await db
    .update(teachersTable)
    .set({ passwordHash, mustChangePassword: false })
    .where(eq(teachersTable.id, teacher.id));

  await logAudit({
    organisationId: teacher.organisationId,
    teacherId: teacher.id,
    action: "teacher.password_changed",
    ipAddress: req.ip,
  });

  res.json({ ok: true });
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

    if (!teacher) return;

    const resetToken = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db
      .update(teachersTable)
      .set({ passwordResetToken: resetToken, passwordResetExpiresAt: expiresAt })
      .where(eq(teachersTable.id, teacher.id));

    await logAudit({
      organisationId: teacher.organisationId,
      teacherId: teacher.id,
      action: "teacher.password_reset_requested",
      metadata: { method: "self-service" },
    });

    const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0];
    const baseUrl = process.env.APP_URL
      ?? (replitDomain ? `https://${replitDomain}` : `http://localhost:${process.env.PORT ?? 8080}`);
    const resetUrl = `${baseUrl}/reset-password?token=${resetToken}`;

    await sendEmail({
      to: email,
      subject: "Reset your password — The Assisted Climb",
      text: `Hi ${teacher.name},\n\nYou requested a password reset for your Assisted Climb account.\n\nClick the link below to set a new password (expires in 1 hour):\n${resetUrl}\n\nIf you didn't request this, you can ignore this email — your password won't change.\n`,
      html: `
        <p>Hi ${teacher.name},</p>
        <p>You requested a password reset for your Assisted Climb account.</p>
        <p><a href="${resetUrl}" style="background:#000;color:#fff;padding:12px 24px;border-radius:12px;text-decoration:none;display:inline-block;font-size:14px;">Reset my password</a></p>
        <p style="color:#888;font-size:12px;">This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>
        <p style="color:#bbb;font-size:11px;">Or copy this URL: ${resetUrl}</p>
      `,
    });
  } catch (err) {
    req.log?.error({ err }, "Failed to send password reset email");
  }
});

// ── Password reset (token-based, no email required) ───────────────────────────

const ResetPasswordBody = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
});

router.post("/auth/reset-password", async (req, res): Promise<void> => {
  const parsed = ResetPasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { token, newPassword } = parsed.data;

  const [teacher] = await db
    .select()
    .from(teachersTable)
    .where(eq(teachersTable.passwordResetToken, token));

  if (!teacher) {
    res.status(400).json({ error: "Invalid or expired reset link" });
    return;
  }

  if (!teacher.passwordResetExpiresAt || teacher.passwordResetExpiresAt < new Date()) {
    res.status(400).json({ error: "This reset link has expired. Please request a new one." });
    return;
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);

  await db
    .update(teachersTable)
    .set({ passwordHash, passwordResetToken: null, passwordResetExpiresAt: null, mustChangePassword: false, failedLoginAttempts: 0, lockedUntil: null })
    .where(eq(teachersTable.id, teacher.id));

  await logAudit({
    organisationId: teacher.organisationId,
    teacherId: teacher.id,
    action: "teacher.password_reset",
    ipAddress: req.ip,
  });

  res.json({ ok: true });
});

// ── /auth/me ──────────────────────────────────────────────────────────────────

router.get("/auth/me", async (req, res): Promise<void> => {
  let teacher: Teacher | undefined;

  const teacherId = req.session.teacherId;
  if (teacherId) {
    const [found] = await db.select().from(teachersTable).where(eq(teachersTable.id, teacherId));
    if (found) teacher = found;
    else req.session.destroy(() => {});
  }

  if (!teacher) {
    const headerToken = req.headers["x-teacher-token"];
    if (typeof headerToken === "string" && headerToken.length > 0) {
      const [found] = await db.select().from(teachersTable).where(eq(teachersTable.loginToken, headerToken));
      if (found) teacher = found;
    }
  }

  if (!teacher) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  res.json({
    ...GetTeacherMeResponse.parse(teacher),
    mustChangePassword: teacher.mustChangePassword,
    totpEnabled: teacher.totpEnabled,
  });
});

// ── Email / SMTP status (IT admins only) ─────────────────────────────────────

router.get("/auth/email-status", async (req, res): Promise<void> => {
  const teacherId = req.session.teacherId;
  const headerToken = req.headers["x-teacher-token"];

  let teacher: Teacher | undefined;
  if (teacherId) {
    const [found] = await db.select().from(teachersTable).where(eq(teachersTable.id, teacherId));
    if (found) teacher = found;
  } else if (typeof headerToken === "string") {
    const [found] = await db.select().from(teachersTable).where(eq(teachersTable.loginToken, headerToken));
    if (found) teacher = found;
  }

  if (!teacher?.isItAdmin) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  res.json({ configured: isEmailConfigured() });
});

// ── Test email (IT admins only) ───────────────────────────────────────────────

router.post("/auth/test-email", async (req, res): Promise<void> => {
  const teacherId = req.session.teacherId;
  const headerToken = req.headers["x-teacher-token"];

  let teacher: Teacher | undefined;
  if (teacherId) {
    const [found] = await db.select().from(teachersTable).where(eq(teachersTable.id, teacherId));
    if (found) teacher = found;
  } else if (typeof headerToken === "string") {
    const [found] = await db.select().from(teachersTable).where(eq(teachersTable.loginToken, headerToken));
    if (found) teacher = found;
  }

  if (!teacher?.isItAdmin) {
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
        <p>Hi ${teacher.name},</p>
        <p>This is a test email from <strong>The Assisted Climb</strong> to verify your SMTP configuration is working correctly.</p>
        <p style="color:#16a34a;font-weight:600;">✓ Email delivery is working.</p>
        <p style="color:#888;font-size:12px;">You can dismiss this message — no action is required.</p>
      `,
    });
    res.json({ ok: true });
  } catch (err: any) {
    req.log?.error({ err }, "Test email failed");
    res.status(500).json({ error: err?.message ?? "Failed to send test email" });
  }
});

// ── Site gate ─────────────────────────────────────────────────────────────────

router.get("/auth/site-status", (req, res): void => {
  const locked = !!process.env.SITE_PASSWORD;
  const authed = !locked || !!req.session.siteAuthed;
  res.json({ locked, authed });
});

router.post("/auth/site-access", (req, res): void => {
  const sitePassword = process.env.SITE_PASSWORD;
  if (!sitePassword) { res.json({ ok: true }); return; }
  const { password } = req.body ?? {};
  if (password !== sitePassword) {
    res.status(401).json({ error: "Incorrect password" });
    return;
  }
  req.session.siteAuthed = true;
  res.json({ ok: true });
});

// ── Platform admin — emergency password reset ─────────────────────────────────

router.post("/auth/admin-reset-password", async (req, res): Promise<void> => {
  const secret = process.env.SESSION_SECRET;
  if (!secret || req.headers["x-admin-token"] !== secret) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const { email, newPassword } = req.body ?? {};
  if (!email || !newPassword) {
    res.status(400).json({ error: "email and newPassword required" });
    return;
  }
  const passwordHash = await bcrypt.hash(newPassword, 12);
  const [updated] = await db
    .update(teachersTable)
    .set({ passwordHash, mustChangePassword: true, failedLoginAttempts: 0, lockedUntil: null })
    .where(eq(teachersTable.email, (email as string).toLowerCase()))
    .returning({ id: teachersTable.id, email: teachersTable.email });
  if (!updated) {
    res.status(404).json({ error: "Teacher not found" });
    return;
  }
  res.json({ ok: true, email: updated.email });
});

// ── Logout ────────────────────────────────────────────────────────────────────

router.post("/auth/logout", async (req, res): Promise<void> => {
  const teacherId = req.session.teacherId;
  if (teacherId) {
    await db.update(teachersTable).set({ loginToken: null }).where(eq(teachersTable.id, teacherId));
    await logAudit({ teacherId, action: "teacher.logout", ipAddress: req.ip });
  }
  req.session.destroy(() => { res.sendStatus(204); });
});

export default router;

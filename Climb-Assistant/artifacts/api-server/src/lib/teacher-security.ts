import { createHash, randomBytes } from "crypto";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { db, teacherPasswordHistoryTable, teacherRecoveryCodesTable, teachersTable } from "@workspace/db";
import bcrypt from "bcryptjs";
import { logAudit } from "./audit";
import { revokePreviewTeacherSessions } from "./preview-session";

export async function terminateTeacherSessions(teacherId: number): Promise<void> {
  await db.transaction((tx) => revokeTeacherSessionsInTransaction(tx, teacherId));
}

type TeacherSecurityTransaction = Pick<typeof db, "update" | "delete" | "execute">;
export async function revokeTeacherSessionsInTransaction(
  tx: TeacherSecurityTransaction,
  teacherId: number,
): Promise<void> {
  // These hashes back short-lived, cookie-less recovery paths. They must be
  // cleared alongside persisted sessions or a pending sign-in could finish
  // after an administrator has reset the account's password.
  await tx.update(teachersTable).set({
    loginToken: null,
    totpSetupTokenHash: null,
    totpSetupTokenExpiresAt: null,
    pendingTotpLoginTokenHash: null,
    pendingTotpLoginTokenExpiresAt: null,
    postMfaSessionTicketHash: null,
    postMfaSessionTicketExpiresAt: null,
  }).where(eq(teachersTable.id, teacherId));
  // connect-pg-simple's default table is "session"; sess is JSON containing
  // either an authenticated or pending teacher session.
  await tx.execute(sql`
    DELETE FROM "session"
    WHERE sess ->> 'teacherId' = ${String(teacherId)}
       OR sess ->> 'pendingTotpTeacherId' = ${String(teacherId)}
       OR sess ->> 'pendingTotpSetupTeacherId' = ${String(teacherId)}
  `);
  revokePreviewTeacherSessions(teacherId);
}

export async function checkPasswordPolicy(
  password: string,
  teacherId?: number,
  currentPasswordHash?: string | null,
): Promise<
  | { ok: true; warning?: string; warningCode?: typeof HIBP_UNAVAILABLE_CODE }
  | { ok: false; error: string }
> {
  if (password.length < 12) {
    return { ok: false, error: "Password must be at least 12 characters." };
  }

  const hashes = currentPasswordHash ? [currentPasswordHash] : [];
  if (teacherId) {
    const history = await db
      .select({ passwordHash: teacherPasswordHistoryTable.passwordHash })
      .from(teacherPasswordHistoryTable)
      .where(eq(teacherPasswordHistoryTable.teacherId, teacherId))
      .orderBy(desc(teacherPasswordHistoryTable.createdAt), desc(teacherPasswordHistoryTable.id))
      // The history includes the current password, so inspect it plus five prior passwords.
      .limit(6);
    hashes.push(...history.map((entry) => entry.passwordHash));
  }
  for (const hash of hashes) {
    if (await bcrypt.compare(password, hash)) {
      return { ok: false, error: "You cannot reuse your current or last five passwords." };
    }
  }

  const digest = createHash("sha1").update(password).digest("hex").toUpperCase();
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);
  try {
    const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { "Add-Padding": "true", "User-Agent": "The Assisted Climb password security check" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return { ok: true, warning: HIBP_UNAVAILABLE_WARNING, warningCode: HIBP_UNAVAILABLE_CODE };
    }
    const breached = (await response.text()).split(/\r?\n/).some((line) => line.split(":")[0]?.trim().toUpperCase() === suffix);
    if (breached) {
      return { ok: false, error: "Choose a different password. This password has appeared in known data breaches." };
    }
  } catch {
    return { ok: true, warning: HIBP_UNAVAILABLE_WARNING, warningCode: HIBP_UNAVAILABLE_CODE };
  }
  return { ok: true };
}

export async function recordTeacherPassword(teacherId: number, passwordHash: string): Promise<void> {
  await db.insert(teacherPasswordHistoryTable).values({ teacherId, passwordHash });
  const entries = await db
    .select({ id: teacherPasswordHistoryTable.id })
    .from(teacherPasswordHistoryTable)
    .where(eq(teacherPasswordHistoryTable.teacherId, teacherId))
    .orderBy(desc(teacherPasswordHistoryTable.createdAt), desc(teacherPasswordHistoryTable.id));
  // Keep the current password and the five prior passwords promised by policy.
  const keep = entries.slice(0, 6).map((entry) => entry.id);
  if (keep.length > 0 && entries.length > keep.length) {
    await db.delete(teacherPasswordHistoryTable).where(
      and(eq(teacherPasswordHistoryTable.teacherId, teacherId), notInArray(teacherPasswordHistoryTable.id, keep)),
    );
  }
}

export function teacherRecoveryCode(): string {
  return `TAC-${randomBytes(6).toString("base64url").toUpperCase()}`;
}

export function hashPasswordResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const HIBP_UNAVAILABLE_CODE = "HIBP_UNAVAILABLE";

export const HIBP_UNAVAILABLE_WARNING =
  "We couldn't check this password against known breaches because the password security service is temporarily unavailable. You can continue, but choose a unique password and change it if the check later identifies a breach.";

export async function resetTeacherTotpAndSessionsInTransaction(
  tx: TeacherSecurityTransaction,
  teacherId: number,
): Promise<void> {
  await tx.update(teachersTable).set({
    totpSecret: null,
    totpEnabled: false,
    totpSetupTokenHash: null,
    totpSetupTokenExpiresAt: null,
    pendingTotpLoginTokenHash: null,
    pendingTotpLoginTokenExpiresAt: null,
    postMfaSessionTicketHash: null,
    postMfaSessionTicketExpiresAt: null,
    recoveryFailedAttempts: 0,
    recoveryLockedUntil: null,
  }).where(eq(teachersTable.id, teacherId));
  await tx.delete(teacherRecoveryCodesTable).where(eq(teacherRecoveryCodesTable.teacherId, teacherId));
  await revokeTeacherSessionsInTransaction(tx, teacherId);
}

export async function resetTeacherTotpAndSessions(teacherId: number): Promise<void> {
  await db.transaction((tx) => resetTeacherTotpAndSessionsInTransaction(tx, teacherId));
}

export const HIBP_UNAVAILABLE_ACKNOWLEDGED_ACTION = "security.password_change_hibp_unavailable_acknowledged";

export async function recordHibpUnavailableAcknowledgement(): Promise<void> {
  await logAudit({ action: HIBP_UNAVAILABLE_ACKNOWLEDGED_ACTION });
}

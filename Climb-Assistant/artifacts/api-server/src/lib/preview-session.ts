import { createHash, randomBytes } from "crypto";
import {
  getSessionIdleTimeoutMs,
  SESSION_ABSOLUTE_TIMEOUT_MS,
} from "./session-policy";

export const PREVIEW_SESSION_HEADER = "x-assisted-climb-preview-session";

type PreviewTeacherSession = {
  kind: "teacher";
  teacherId: number;
  startedAt: number;
  lastActivityAt: number;
};

type PreviewStudentSession = {
  kind: "student";
  studentSessionId: number;
  studentNonce: string;
  studentActivityId?: number;
  startedAt: number;
  lastActivityAt: number;
};

type PreviewSession = PreviewTeacherSession | PreviewStudentSession;

const previewSessions = new Map<string, PreviewSession>();

function hashPreviewSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isPreviewSessionEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

function discardExpiredPreviewSessions(now: number): void {
  for (const [tokenHash, session] of previewSessions) {
    if (
      now - session.startedAt >= SESSION_ABSOLUTE_TIMEOUT_MS
      || now - session.lastActivityAt >= getSessionIdleTimeoutMs(session.kind)
    ) {
      previewSessions.delete(tokenHash);
    }
  }
}

/**
 * Some Replit development webviews reject HTTP preview cookies even after MFA
 * succeeds. This process-local bridge keeps the current preview usable without
 * adding a browser-persisted token or changing production authentication.
 */
export function createPreviewTeacherSession(teacherId: number): string | undefined {
  if (!isPreviewSessionEnabled()) return undefined;

  const now = Date.now();
  discardExpiredPreviewSessions(now);
  const token = randomBytes(32).toString("base64url");
  previewSessions.set(hashPreviewSessionToken(token), {
    kind: "teacher",
    teacherId,
    startedAt: now,
    lastActivityAt: now,
  });
  return token;
}

export function resolvePreviewTeacherSession(token: string | undefined, refreshActivity: boolean): number | undefined {
  if (!isPreviewSessionEnabled() || !token || token.length < 40 || token.length > 200) {
    return undefined;
  }

  const now = Date.now();
  const tokenHash = hashPreviewSessionToken(token);
  const session = previewSessions.get(tokenHash);
  if (!session || session.kind !== "teacher") return undefined;

  if (
    now - session.startedAt >= SESSION_ABSOLUTE_TIMEOUT_MS
    || now - session.lastActivityAt >= getSessionIdleTimeoutMs(session.kind)
  ) {
    previewSessions.delete(tokenHash);
    return undefined;
  }

  if (refreshActivity) {
    session.lastActivityAt = now;
  }
  return session.teacherId;
}

export function revokePreviewTeacherSessions(teacherId: number): void {
  for (const [tokenHash, session] of previewSessions) {
    if (session.kind === "teacher" && session.teacherId === teacherId) {
      previewSessions.delete(tokenHash);
    }
  }
}

export function createPreviewStudentSession(
  studentSessionId: number,
  studentNonce: string,
  studentActivityId?: number,
): string | undefined {
  if (!isPreviewSessionEnabled()) return undefined;
  const now = Date.now();
  discardExpiredPreviewSessions(now);
  const token = randomBytes(32).toString("base64url");
  previewSessions.set(hashPreviewSessionToken(token), {
    kind: "student",
    studentSessionId,
    studentNonce,
    studentActivityId,
    startedAt: now,
    lastActivityAt: now,
  });
  return token;
}

export function resolvePreviewStudentSession(
  token: string | undefined,
  refreshActivity: boolean,
): Omit<PreviewStudentSession, "kind"> | undefined {
  if (!isPreviewSessionEnabled() || !token || token.length < 40 || token.length > 200) return undefined;
  const now = Date.now();
  const tokenHash = hashPreviewSessionToken(token);
  const session = previewSessions.get(tokenHash);
  if (!session || session.kind !== "student") return undefined;
  if (
    now - session.startedAt >= SESSION_ABSOLUTE_TIMEOUT_MS
    || now - session.lastActivityAt >= getSessionIdleTimeoutMs(session.kind)
  ) {
    previewSessions.delete(tokenHash);
    return undefined;
  }
  if (refreshActivity) session.lastActivityAt = now;
  return session;
}

export function updatePreviewStudentActivitySession(
  token: string | undefined,
  studentActivityId: number | undefined,
): void {
  if (!isPreviewSessionEnabled() || !token) return;
  const session = previewSessions.get(hashPreviewSessionToken(token));
  if (!session || session.kind !== "student") return;
  session.studentActivityId = studentActivityId;
}
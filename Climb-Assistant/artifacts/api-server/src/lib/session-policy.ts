export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const SESSION_IDLE_TIMEOUT_SECONDS = SESSION_IDLE_TIMEOUT_MS / 1000;
export const SESSION_ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1000;
export const SCHOOL_SESSION_IDLE_TIMEOUT_MS = 8 * 60 * 1000;

export type AuthenticatedSessionRole = "student" | "teacher" | "admin";

export function getSessionIdleTimeoutMs(role: AuthenticatedSessionRole): number {
  return role === "student" || role === "teacher"
    ? SCHOOL_SESSION_IDLE_TIMEOUT_MS
    : SESSION_IDLE_TIMEOUT_MS;
}
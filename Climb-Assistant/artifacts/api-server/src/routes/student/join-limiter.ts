import rateLimit, { ipKeyGenerator } from "express-rate-limit";

export const STUDENT_JOIN_WINDOW_MS = 15 * 60 * 1000;
export const STUDENT_JOIN_REQUEST_LIMIT = 20;

export function createStudentJoinLimiter() {
  const acceptanceRateLimitNamespace = process.env.NODE_ENV !== "production"
    ? process.env.ACCEPTANCE_BROWSER_PROOF_ID?.trim()
    : undefined;

  return rateLimit({
    windowMs: STUDENT_JOIN_WINDOW_MS,
    max: STUDENT_JOIN_REQUEST_LIMIT,
    keyGenerator: (req) => acceptanceRateLimitNamespace
      ? `acceptance:${acceptanceRateLimitNamespace}:${ipKeyGenerator(req.ip ?? "")}`
      : ipKeyGenerator(req.ip ?? ""),
    message: { error: "Too many attempts. Please wait 15 minutes before trying again." },
    standardHeaders: true,
    legacyHeaders: false,
  });
}
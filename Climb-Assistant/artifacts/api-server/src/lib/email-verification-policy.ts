/**
 * Email verification remains mandatory in production by default.
 *
 * This development-only switch lets the team exercise account and MFA flows
 * before SMTP is configured. It must never become a production bypass, even
 * if the environment variable is accidentally carried over.
 */
function isDevelopmentBypassEnabled(): boolean {
  return process.env.NODE_ENV !== "production"
    && process.env.ALLOW_UNVERIFIED_EMAIL_LOGIN === "true";
}

/**
 * PILOT-ONLY BYPASS - decided 2026-10-02.
 *
 * Dawn (CIG) raised a data-protection concern about routing verification
 * emails through a third-party Gmail account during the pilot, and asked
 * for email verification to be disabled for now rather than resolve the
 * email-provider question first. Explicitly confirmed by Sita to proceed
 * on this basis: "this is pilot, once we move to production we will see."
 *
 * This is a DELIBERATE, SCOPED, TIME-LIMITED decision for the pilot phase
 * only. It must be revisited before any real production rollout - without
 * email verification, any email address (real or fabricated) can register
 * as a teacher and gain full access to real students' work, AI
 * conversations, and personal data, with no proof of who they actually are.
 *
 * Controlled independently of NODE_ENV so it can be enabled in production
 * (unlike the development-only switch above) but remains a single, explicit,
 * named environment variable - not a side effect of some other setting - so
 * it is easy to find and remove when the pilot moves to real production.
 * To re-enable email verification: remove PILOT_BYPASS_EMAIL_VERIFICATION
 * from the task definition and redeploy. No code change needed to revert.
 */
function isPilotBypassEnabled(): boolean {
  return process.env.PILOT_BYPASS_EMAIL_VERIFICATION === "true";
}

export function isEmailVerificationBypassed(): boolean {
  return isDevelopmentBypassEnabled() || isPilotBypassEnabled();
}
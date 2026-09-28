/**
 * Email verification remains mandatory in production.
 *
 * This explicit development-only switch lets the team exercise account and
 * MFA flows before SMTP is configured. It must never become a production
 * bypass, even if the environment variable is accidentally carried over.
 */
export function isEmailVerificationBypassed(): boolean {
  return process.env.NODE_ENV !== "production"
    && process.env.ALLOW_UNVERIFIED_EMAIL_LOGIN === "true";
}
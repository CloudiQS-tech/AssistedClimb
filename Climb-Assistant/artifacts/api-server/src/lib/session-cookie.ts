import type { Request } from "express";

function shouldUseSecureCookie(req: Request): boolean {
  if (process.env.NODE_ENV === "production") return true;

  // Replit's embedded HTTP webview can pass through more than one proxy. A
  // chain such as "https, http" must remain non-Secure: choosing only the
  // first value causes the browser to drop the renewed post-MFA cookie.
  const forwardedProtocols = (req.get("x-forwarded-proto") ?? "")
    .split(",")
    .map((protocol) => protocol.trim().toLowerCase())
    .filter(Boolean);
  if (forwardedProtocols.includes("http")) return false;

  return req.secure || forwardedProtocols.includes("https");
}

/**
 * HTTPS previews run inside an embedded, cross-site frame and need a Secure,
 * SameSite=None cookie. The HTTP preview proxy cannot accept Secure cookies,
 * so it retains the Lax fallback used for local development.
 */
export function applySessionCookiePolicy(req: Request): void {
  const secure = shouldUseSecureCookie(req);
  req.session.cookie.secure = secure;
  req.session.cookie.sameSite = secure ? "none" : "lax";
}

export async function regenerateSessionWithCookiePolicy(req: Request): Promise<void> {
  await new Promise<void>((resolve, reject) => req.session.regenerate((error) => (error ? reject(error) : resolve())));
  applySessionCookiePolicy(req);
}

/**
 * Authentication and SiteGate access have different purposes. When a role
 * session ends, rotate to a fresh anonymous session so no role or MFA state
 * survives, while allowing a browser that already passed SiteGate to reach
 * its normal sign-in screen.
 */
export async function regenerateAnonymousSessionPreservingSiteAccess(req: Request): Promise<void> {
  const siteAuthed = req.session.siteAuthed;
  await regenerateSessionWithCookiePolicy(req);
  if (siteAuthed) req.session.siteAuthed = true;
  await new Promise<void>((resolve, reject) => req.session.save((error) => (error ? reject(error) : resolve())));
}
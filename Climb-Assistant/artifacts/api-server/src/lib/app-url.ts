/**
 * Returns the public URL used in links sent by the application.
 *
 * Production must provide APP_URL explicitly so account emails never point to
 * a development host, localhost, or a platform-specific preview domain.
 */
export function getAppBaseUrl(): string {
  const configuredUrl = process.env.APP_URL?.trim();
  if (configuredUrl) {
    let parsed: URL;
    try {
      parsed = new URL(configuredUrl);
    } catch {
      throw new Error("APP_URL must be a valid absolute URL");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("APP_URL must use HTTP or HTTPS");
    }
    if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
      throw new Error("APP_URL must use HTTPS in production");
    }
    return configuredUrl.replace(/\/$/, "");
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("APP_URL must be configured in production");
  }

  const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  return replitDomain ? `https://${replitDomain}` : `http://localhost:${process.env.PORT ?? 8080}`;
}
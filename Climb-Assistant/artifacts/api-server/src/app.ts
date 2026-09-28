import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import router from "./routes";
import { logger } from "./lib/logger";
import {
  applySessionCookiePolicy,
  regenerateAnonymousSessionPreservingSiteAccess,
} from "./lib/session-cookie";
import { PREVIEW_SESSION_HEADER, resolvePreviewStudentSession, resolvePreviewTeacherSession } from "./lib/preview-session";
import {
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_IDLE_TIMEOUT_SECONDS,
} from "./lib/session-policy";
import { getRestorationAdmissionState } from "./lib/restoration-quarantine";

const PgStore = connectPgSimple(session);
const SESSION_ACTIVITY_REFRESH_MS = 30 * 1000;
const NON_ACTIVITY_SESSION_PATHS = new Set([
  "/api/student/activity/heartbeat",
  "/api/student/activity/pause",
]);

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET environment variable is required");
}

function getAllowedOrigins(): string[] {
  const origins: string[] = [];
  const configuredAppUrl = process.env.APP_URL?.trim();
  if (configuredAppUrl) {
    try {
      origins.push(new URL(configuredAppUrl).origin);
    } catch {
      logger.warn("Ignoring invalid APP_URL while building allowed origins");
    }
  }
  const configuredAdditionalOrigins = process.env.APP_ALLOWED_ORIGINS;
  if (configuredAdditionalOrigins) {
    configuredAdditionalOrigins.split(",").forEach((origin) => {
      const trimmed = origin.trim();
      if (trimmed) origins.push(trimmed.replace(/\/$/, ""));
    });
  }
  if (process.env.NODE_ENV !== "production") {
    const replitDomains = process.env.REPLIT_DOMAINS;
    if (replitDomains) {
      replitDomains.split(",").forEach((d) => {
        const domain = d.trim();
        if (domain) origins.push(`https://${domain}`);
      });
    }
    const devDomain = process.env.REPLIT_DEV_DOMAIN;
    if (devDomain) {
      origins.push(`https://${devDomain}`);
    }
  }
  if (process.env.NODE_ENV !== "production") {
    origins.push("http://localhost:80", "http://localhost", "http://localhost:3000", "http://localhost:5173");
  }
  return origins;
}

function hasTrustedRequestOrigin(req: Request): boolean {
  const source = req.get("origin") ?? req.get("referer");
  const host = (req.get("x-forwarded-host") ?? req.get("host"))?.split(",")[0]?.trim();
  if (!source || !host) return false;

  try {
    const sourceOrigin = new URL(source).origin;
    const forwardedProtocol = req.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? req.protocol;
    const requestOrigin = new URL(`${forwardedProtocol}://${host}`).origin;
    return sourceOrigin === requestOrigin || getAllowedOrigins().includes(sourceOrigin);
  } catch {
    return false;
  }
}

const app: Express = express();

// Trust the reverse proxy so req.secure reflects the original HTTPS connection.
// Without this, Express sees plain HTTP internally and won't emit Secure cookies.
app.set("trust proxy", 1);
// API responses include authentication and student data. Do not let Express
// turn conditional GETs into body-less 304 responses that client-side callers
// can mistake for a lost login session.
app.disable("etag");

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      const allowed = getAllowedOrigins();
      if (allowed.includes(origin)) {
        callback(null, true);
      } else {
        logger.warn({ origin }, "CORS blocked request from untrusted origin");
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  }),
);

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  if (req.path.startsWith("/api")) {
    res.setHeader("Cache-Control", "no-store");
  }
  if (process.env.NODE_ENV === "production") {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000",
    );
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'",
    );
  }
  next();
});

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET environment variable must be set");
}

// Development previews can be opened through either the HTTPS dev domain or
// the HTTP webview proxy. A Secure cookie is silently dropped by the latter,
// which would lose the pending MFA setup session between login and code entry.
// Production remains HTTPS-only and cross-origin capable.
const useSecureSessionCookies = process.env.NODE_ENV === "production";

app.use(
  session({
    store: new PgStore({
      conString: process.env.DATABASE_URL,
      schemaName: "public",
      createTableIfMissing: false,
      ttl: SESSION_IDLE_TIMEOUT_SECONDS,
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: useSecureSessionCookies,
      maxAge: SESSION_IDLE_TIMEOUT_MS,
      sameSite: useSecureSessionCookies ? "none" : "lax",
    },
  }),
);

app.use((req, _res, next) => {
  const requestPath = req.originalUrl.split("?")[0];
  const teacherId = resolvePreviewTeacherSession(
    req.get(PREVIEW_SESSION_HEADER) ?? undefined,
    !NON_ACTIVITY_SESSION_PATHS.has(requestPath),
  );
  if (teacherId) {
    // This is enabled only outside production and exists for the HTTP preview
    // webview, which can drop every Set-Cookie response after MFA. Routes keep
    // using the normal server-session shape and all existing authorisation
    // checks, idle limits, and same-origin write protections still apply.
    req.session.teacherId = teacherId;
    req.session.studentSessionId = undefined;
    req.session.cigAdminId = undefined;
    req.session.sessionStartedAt = Date.now();
    req.session.lastActivityAt = Date.now();
  } else {
    const student = resolvePreviewStudentSession(
      req.get(PREVIEW_SESSION_HEADER) ?? undefined,
      !NON_ACTIVITY_SESSION_PATHS.has(requestPath),
    );
    if (student) {
      req.session.studentSessionId = student.studentSessionId;
      req.session.studentNonce = student.studentNonce;
      req.session.studentActivityId = student.studentActivityId;
      req.session.teacherId = undefined;
      req.session.cigAdminId = undefined;
      req.session.sessionStartedAt = student.startedAt;
      req.session.lastActivityAt = student.lastActivityAt;
    }
  }
  next();
});

app.use(async (req, res, next) => {
  const requestPath = req.originalUrl.split("?")[0];
  if (req.method === "GET" && requestPath === "/api/healthz") {
    next();
    return;
  }
  const restorationState = await getRestorationAdmissionState();
  if (restorationState !== "ready") {
    res.status(503).json({
      error: "The application database is quarantined while backup restoration checks are completed.",
      code: "DATABASE_RESTORATION_QUARANTINE",
    });
    return;
  }
  next();
});

app.use(async (req, res, next) => {
  const hasAuthenticatedRole = Boolean(
    req.session.teacherId
    || req.session.studentSessionId
    || req.session.cigAdminId,
  );
  if (!hasAuthenticatedRole) {
    next();
    return;
  }

  const now = Date.now();
  const startedAt = req.session.sessionStartedAt ?? now;
  const lastActivityAt = req.session.lastActivityAt ?? startedAt;
  if (
    now - startedAt >= SESSION_ABSOLUTE_TIMEOUT_MS
    || now - lastActivityAt >= SESSION_IDLE_TIMEOUT_MS
  ) {
    try {
      await regenerateAnonymousSessionPreservingSiteAccess(req);
      res.status(401).json({ error: "Your session has expired. Please sign in again." });
    } catch (error) {
      next(error);
    }
    return;
  }

  const requestPath = req.originalUrl.split("?")[0];
  if (
    !NON_ACTIVITY_SESSION_PATHS.has(requestPath)
    && now - lastActivityAt >= SESSION_ACTIVITY_REFRESH_MS
  ) {
    // Background telemetry must never extend an otherwise idle login.
    req.session.lastActivityAt = now;
  }
  if (!req.session.sessionStartedAt) {
    req.session.sessionStartedAt = startedAt;
  }
  next();
});

app.use((req, _res, next) => {
  applySessionCookiePolicy(req);
  next();
});

app.use((req, res, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method) || hasTrustedRequestOrigin(req)) {
    next();
    return;
  }
  res.status(403).json({ error: "This request must come from The Assisted Climb application." });
});

app.use("/api", router);

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err: error }, "Unhandled API error");
  if (res.headersSent) return;
  if (error instanceof Error && error.message === "Not allowed by CORS") {
    res.status(403).json({ error: "Request origin is not allowed." });
    return;
  }
  res.status(500).json({ error: "An unexpected server error occurred." });
});

export default app;

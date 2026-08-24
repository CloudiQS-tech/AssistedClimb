import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import router from "./routes";
import { logger } from "./lib/logger";

const PgStore = connectPgSimple(session);

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET environment variable is required");
}

function getAllowedOrigins(): string[] {
  const origins: string[] = [];
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
  // Allow explicitly configured origins (comma-separated, full origin with protocol)
  const allowedOrigins = process.env.ALLOWED_ORIGINS;
  if (allowedOrigins) {
    allowedOrigins.split(",").forEach((o) => {
      const origin = o.trim();
      if (origin) origins.push(origin);
    });
  }
  if (process.env.NODE_ENV !== "production") {
    origins.push("http://localhost:80", "http://localhost", "http://localhost:3000", "http://localhost:5173");
  }
  return origins;
}

const app: Express = express();

// Trust the reverse proxy so req.secure reflects the original HTTPS connection.
// Without this, Express sees plain HTTP internally and won't emit Secure cookies.
app.set("trust proxy", 1);

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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET environment variable must be set");
}

// Use sameSite:"none" + secure:true whenever the app is served over HTTPS —
// this covers both production and the Replit dev preview (which is always HTTPS
// via the dev domain). Plain localhost dev stays on lax/false.
const isCrossOriginIframe =
  process.env.NODE_ENV === "production" || !!process.env.REPLIT_DEV_DOMAIN;

app.use(
  session({
    store: new PgStore({
      conString: process.env.DATABASE_URL,
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: isCrossOriginIframe,
      maxAge: 8 * 60 * 60 * 1000,
      sameSite: isCrossOriginIframe ? "none" : "lax",
    },
  }),
);

app.use("/api", router);

export default app;

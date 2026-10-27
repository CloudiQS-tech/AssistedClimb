import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export function serializeErrorForLog(error: unknown): Record<string, string | number> {
  if (!error || typeof error !== "object") {
    return { kind: typeof error };
  }

  const details = error as Record<string, unknown>;
  const status = typeof details.statusCode === "number"
    ? details.statusCode
    : details.status;
  const code = typeof details.code === "string"
    && /^[A-Z0-9_.-]{1,40}$/.test(details.code)
    ? details.code
    : undefined;

  return {
    kind: error instanceof Error ? "Error" : "Object",
    ...(typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
      ? { status }
      : {}),
    ...(code ? { code } : {}),
  };
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
    "req.headers['api-key']",
    "req.headers['x-api-key']",
    "req.headers['x-goog-api-key']",
    "req.body.aiKey",
    "req.body.apiKey",
    "req.body.api_key",
    "req.body.credentials",
    "*.apiKey",
    "*.api_key",
    "*.aiKey",
    "*.aiKeyEncrypted",
    "*.aiKeySecretRef",
    "*.SecretString",
    "*.SecretBinary",
    "*.secretName",
    "*.secretId",
    "*.secretArn",
    "*.secretString",
    "*.secretBinary",
    "*.headers",
    "*.config",
    "*.cause",
    "*.request",
    "*.response",
  ],
  serializers: {
    err: serializeErrorForLog,
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});

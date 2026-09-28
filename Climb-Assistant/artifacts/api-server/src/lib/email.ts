import { logger } from "./logger";

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export interface EmailConfigurationSummary {
  configured: boolean;
  host: string | null;
  port: number | null;
  secure: boolean;
  from: string | null;
  credentialSource: "environment";
}

function getSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  return {
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    user,
    pass,
    from: process.env.SMTP_FROM ?? `The Assisted Climb <${user}>`,
  };
}

export function getEmailConfigurationSummary(): EmailConfigurationSummary {
  const config = getSmtpConfig();
  const portValue = Number(process.env.SMTP_PORT ?? 587);
  return {
    configured: config !== null,
    host: process.env.SMTP_HOST ?? null,
    port: Number.isFinite(portValue) ? portValue : null,
    secure: process.env.SMTP_SECURE === "true",
    from: process.env.SMTP_FROM ?? (process.env.SMTP_USER ? `The Assisted Climb <${process.env.SMTP_USER}>` : null),
    credentialSource: "environment",
  };
}

export function isEmailConfigured(): boolean {
  return getSmtpConfig() !== null;
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
  messageId?: string;
}): Promise<void> {
  const config = getSmtpConfig();

  if (!config) {
    logger.warn(
      { to: opts.to, subject: opts.subject },
      "SMTP not configured — email not sent"
    );
    return;
  }

  const nodemailer = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    auth: { user: config.user, pass: config.pass },
  });

  await transporter.sendMail({
    from: config.from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    messageId: opts.messageId,
  });
}

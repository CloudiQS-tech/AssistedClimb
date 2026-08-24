import { logger } from "./logger";

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
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

export function isEmailConfigured(): boolean {
  return getSmtpConfig() !== null;
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  const config = getSmtpConfig();

  if (!config) {
    logger.warn(
      { to: opts.to, subject: opts.subject },
      "SMTP not configured — email not sent (reset link logged below for development)"
    );
    logger.info({ to: opts.to, body: opts.text }, "📧 [DEV EMAIL — would be sent to teacher]");
    return;
  }

  const nodemailer = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
  });

  await transporter.sendMail({
    from: config.from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
  });
}

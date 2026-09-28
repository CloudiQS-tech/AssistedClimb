import { getAppBaseUrl } from "./app-url";
import { isEmailConfigured, sendEmail } from "./email";
import { logger } from "./logger";

export type ArchiveExpiryWarningEmailStatus = "sent" | "not-configured" | "failed";
export type RecoverableDeletionWarningEmailStatus = "sent" | "not-configured" | "failed";

export function getArchiveExpiryWarningMessageId(classId: number, archiveExpiresAt: Date): string {
  return `<archive-expiry-${classId}-${archiveExpiresAt.getTime()}@the-assisted-climb.local>`;
}

export function getRecoverableDeletionWarningMessageId(
  targetType: "class" | "student_record",
  targetId: number,
  deletionScheduledFor: Date,
): string {
  return `<deletion-recovery-${targetType}-${targetId}-${deletionScheduledFor.getTime()}@the-assisted-climb.local>`;
}

export function isDefinitiveArchiveWarningDeliveryFailure(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("responseCode" in error)) return false;
  const responseCode = Number((error as { responseCode?: unknown }).responseCode);
  return Number.isInteger(responseCode) && responseCode >= 400 && responseCode <= 599;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!
  ));
}

function formatUtcDate(value: Date): string {
  return value.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export async function sendArchiveExpiryWarningEmail(input: {
  classId: number;
  className: string;
  recipientName: string;
  recipientEmail: string;
  archiveExpiresAt: Date;
  warningWindowDays: number;
}): Promise<ArchiveExpiryWarningEmailStatus> {
  if (!isEmailConfigured()) return "not-configured";

  const archiveUrl = `${getAppBaseUrl()}/teacher/archive`;
  const expiryDate = formatUtcDate(input.archiveExpiresAt);
  const safeName = escapeHtml(input.recipientName);
  const safeClassName = escapeHtml(input.className);
  const safeArchiveUrl = escapeHtml(archiveUrl);
  const messageId = getArchiveExpiryWarningMessageId(input.classId, input.archiveExpiresAt);

  try {
    await sendEmail({
      to: input.recipientEmail,
      messageId,
      subject: "An archived class is approaching deletion recovery — The Assisted Climb",
      text: `Hi ${input.recipientName},

The archived class "${input.className}" is due to reach the end of its retention period on ${expiryDate}. If it remains archived and is not protected by a legal hold, it will then enter the separate deletion-recovery period.

Review the archive before that date:
${archiveUrl}

This notice was sent ${input.warningWindowDays} days before the recorded expiry date. It contains no student names or learning content.
`,
      html: `
        <p>Hi ${safeName},</p>
        <p>The archived class <strong>${safeClassName}</strong> is due to reach the end of its retention period on <strong>${expiryDate}</strong>.</p>
        <p>If it remains archived and is not protected by a legal hold, it will then enter the separate deletion-recovery period.</p>
        <p><a href="${safeArchiveUrl}" style="background:#000;color:#fff;padding:12px 24px;border-radius:12px;text-decoration:none;display:inline-block;font-size:14px;">Review the school archive</a></p>
        <p style="color:#666;font-size:12px;">This notice was sent ${input.warningWindowDays} days before the recorded expiry date. It contains no student names or learning content.</p>
      `,
    });
    return "sent";
  } catch (error) {
    logger.error({ err: error, classId: input.classId }, "Archive expiry warning email failed");
    if (isDefinitiveArchiveWarningDeliveryFailure(error)) return "failed";
    throw error;
  }
}

export async function sendRecoverableDeletionWarningEmail(input: {
  targetType: "class" | "student_record";
  targetId: number;
  targetLabel: string;
  recipientName: string;
  recipientEmail: string;
  deletionScheduledFor: Date;
  warningWindowDays: number;
}): Promise<RecoverableDeletionWarningEmailStatus> {
  if (!isEmailConfigured()) return "not-configured";

  const archiveUrl = `${getAppBaseUrl()}/teacher/archive`;
  const deletionDate = formatUtcDate(input.deletionScheduledFor);
  const safeName = escapeHtml(input.recipientName);
  const safeLabel = escapeHtml(input.targetLabel);
  const safeArchiveUrl = escapeHtml(archiveUrl);
  const messageId = getRecoverableDeletionWarningMessageId(
    input.targetType,
    input.targetId,
    input.deletionScheduledFor,
  );
  const targetDescription = input.targetType === "class"
    ? `class "${input.targetLabel}"`
    : `a Student record in class "${input.targetLabel}"`;

  try {
    await sendEmail({
      to: input.recipientEmail,
      messageId,
      subject: "A deleted school record is approaching permanent deletion — The Assisted Climb",
      text: `Hi ${input.recipientName},

${input.targetType === "class" ? `The deleted class "${input.targetLabel}"` : `A deleted Student record in class "${input.targetLabel}"`} is approaching permanent deletion. It is already unavailable for normal use.

Unless protected by a valid hold, this ${targetDescription} is scheduled for permanent deletion on ${deletionDate}. Review Scheduled deletions before that date if the school needs to restore it:
${archiveUrl}

This notice was sent ${input.warningWindowDays} days before the recorded permanent-deletion date. It contains no Student names or learning content.
`,
      html: `
        <p>Hi ${safeName},</p>
        <p>The deleted ${input.targetType === "class" ? "class" : "Student record"} <strong>${safeLabel}</strong> is approaching permanent deletion. It is already unavailable for normal use.</p>
        <p>Unless protected by a valid hold, it is scheduled for permanent deletion on <strong>${deletionDate}</strong>.</p>
        <p><a href="${safeArchiveUrl}" style="background:#000;color:#fff;padding:12px 24px;border-radius:12px;text-decoration:none;display:inline-block;font-size:14px;">Review scheduled deletions</a></p>
        <p style="color:#666;font-size:12px;">This notice was sent ${input.warningWindowDays} days before the recorded permanent-deletion date. It contains no Student names or learning content.</p>
      `,
    });
    return "sent";
  } catch (error) {
    logger.error({ err: error, targetType: input.targetType, targetId: input.targetId }, "Recoverable deletion warning email failed");
    if (isDefinitiveArchiveWarningDeliveryFailure(error)) return "failed";
    throw error;
  }
}
import { pgTable, serial, text, timestamp, boolean, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organisationsTable } from "./organisations";

export const schoolAdminRoles = ["master", "subadmin"] as const;
export const teacherAccountStatuses = ["active", "suspended", "deleted"] as const;
export const teacherApprovalStatuses = ["pending", "approved", "rejected"] as const;

export const teachersTable = pgTable("teachers", {
  id: serial("id").primaryKey(),
  organisationId: integer("organisation_id").references(() => organisationsTable.id, { onDelete: "set null" }),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  isItAdmin: boolean("is_it_admin").notNull().default(false),
  schoolAdminRole: text("school_admin_role", { enum: schoolAdminRoles }),
  accountStatus: text("account_status", { enum: teacherAccountStatuses }).notNull().default("active"),
  accountStatusChangedAt: timestamp("account_status_changed_at", { withTimezone: true }),
  approvalStatus: text("approval_status", { enum: teacherApprovalStatuses }).notNull().default("approved"),
  approvalReviewedAt: timestamp("approval_reviewed_at", { withTimezone: true }),
  approvalReviewedBy: integer("approval_reviewed_by"),
  approvalReason: text("approval_reason"),
  loginToken: text("login_token"),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  totpSecret: text("totp_secret"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  totpSetupTokenHash: text("totp_setup_token_hash"),
  totpSetupTokenExpiresAt: timestamp("totp_setup_token_expires_at", { withTimezone: true }),
  pendingTotpLoginTokenHash: text("pending_totp_login_token_hash"),
  pendingTotpLoginTokenExpiresAt: timestamp("pending_totp_login_token_expires_at", { withTimezone: true }),
  postMfaSessionTicketHash: text("post_mfa_session_ticket_hash"),
  postMfaSessionTicketExpiresAt: timestamp("post_mfa_session_ticket_expires_at", { withTimezone: true }),
  passwordResetToken: text("password_reset_token"),
  passwordResetExpiresAt: timestamp("password_reset_expires_at", { withTimezone: true }),
  emailVerified: boolean("email_verified").notNull().default(false),
  emailVerificationTokenHash: text("email_verification_token_hash"),
  emailVerificationExpiresAt: timestamp("email_verification_expires_at", { withTimezone: true }),
  recoveryFailedAttempts: integer("recovery_failed_attempts").notNull().default(0),
  recoveryLockedUntil: timestamp("recovery_locked_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertTeacherSchema = createInsertSchema(teachersTable).omit({
  id: true,
  createdAt: true,
});
export type InsertTeacher = z.infer<typeof insertTeacherSchema>;
export type Teacher = typeof teachersTable.$inferSelect;

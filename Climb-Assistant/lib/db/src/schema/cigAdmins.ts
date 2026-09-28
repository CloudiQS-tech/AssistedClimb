import { boolean, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const cigAdminRoles = ["master", "subadmin"] as const;
export type CigAdminRole = (typeof cigAdminRoles)[number];

export const cigAdminsTable = pgTable("cig_admins", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique("cig_admins_email_key"),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: cigAdminRoles }).notNull().default("subadmin"),
  totpSecretEncrypted: text("totp_secret_encrypted"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  active: boolean("active").notNull().default(true),
  sessionVersion: integer("session_version").notNull().default(0),
  failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  recoveryFailedAttempts: integer("recovery_failed_attempts").notNull().default(0),
  recoveryLockedUntil: timestamp("recovery_locked_until", { withTimezone: true }),
  accountLinkTokenHash: text("account_link_token_hash"),
  accountLinkExpiresAt: timestamp("account_link_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const cigAdminRecoveryCodesTable = pgTable("cig_admin_recovery_codes", {
  id: serial("id").primaryKey(),
  adminId: integer("admin_id").notNull().references(() => cigAdminsTable.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cigAdminSecurityEventsTable = pgTable("cig_admin_security_events", {
  id: serial("id").primaryKey(),
  adminId: integer("admin_id").references(() => cigAdminsTable.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  metadata: text("metadata"),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CigAdmin = typeof cigAdminsTable.$inferSelect;
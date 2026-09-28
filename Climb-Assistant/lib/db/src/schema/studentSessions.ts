import { pgTable, serial, text, timestamp, integer, boolean, json } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { classesTable } from "./classes";
import { teachersTable } from "./teachers";

export const studentRegistrationStatuses = ["pending", "approved", "rejected"] as const;

export const studentSessionsTable = pgTable("student_sessions", {
  id: serial("id").primaryKey(),
  classId: integer("class_id")
    .notNull()
    .references(() => classesTable.id, { onDelete: "cascade" }),
  studentName: text("student_name").notNull(),
  pinHash: text("pin_hash"),
  pinVersion: integer("pin_version").notNull().default(2),
  registrationStatus: text("registration_status", { enum: studentRegistrationStatuses }).notNull().default("pending"),
  registrationReviewedAt: timestamp("registration_reviewed_at", { withTimezone: true }),
  registrationReviewedBy: integer("registration_reviewed_by").references(() => teachersTable.id, { onDelete: "set null" }),
  isBlocked: boolean("is_blocked").notNull().default(false),
  failedPinAttempts: integer("failed_pin_attempts").notNull().default(0),
  pinLockedUntil: timestamp("pin_locked_until", { withTimezone: true }),
  sessionNonce: text("session_nonce"),
  researchId: text("research_id"),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lockedBy: integer("locked_by").references(() => teachersTable.id, { onDelete: "set null" }),
  // A retained student record stays in its original class. `lockedAt` is its
  // finalised state; these fields record the separate, recoverable archive
  // lifecycle before the application permanently purges the record.
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archiveExpiresAt: timestamp("archive_expires_at", { withTimezone: true }),
  archiveLifecycleStatus: text("archive_lifecycle_status").notNull().default("active"),
  archiveExpiryNotifiedAt: timestamp("archive_expiry_notified_at", { withTimezone: true }),
  deletionWarningAttemptedAt: timestamp("deletion_warning_attempted_at", { withTimezone: true }),
  deletionWarningSentAt: timestamp("deletion_warning_sent_at", { withTimezone: true }),
  retentionUntil: timestamp("retention_until", { withTimezone: true }),
  archivedBy: integer("archived_by").references(() => teachersTable.id, { onDelete: "set null" }),
  deletionRequestedAt: timestamp("deletion_requested_at", { withTimezone: true }),
  deletionScheduledFor: timestamp("deletion_scheduled_for", { withTimezone: true }),
  deletionRequestedBy: integer("deletion_requested_by")
    .references(() => teachersTable.id, { onDelete: "set null" }),
  deletionReason: text("deletion_reason"),
  answerFeedbackAttempts: json("answer_feedback_attempts").$type<unknown[]>().notNull().default([]),
  studentInsights: json("student_insights").$type<Record<string, unknown>>().notNull().default({}),
  developmentAnalysisReport: json("development_analysis_report").$type<Record<string, unknown> | null>(),
  developmentAnalysisGeneratedAt: timestamp("development_analysis_generated_at", { withTimezone: true }),
  developmentAnalysisSourceHash: text("development_analysis_source_hash"),
  developmentAnalysisStatus: text("development_analysis_status"),
  developmentAnalysisError: text("development_analysis_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertStudentSessionSchema = createInsertSchema(studentSessionsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertStudentSession = z.infer<typeof insertStudentSessionSchema>;
export type StudentSession = typeof studentSessionsTable.$inferSelect;

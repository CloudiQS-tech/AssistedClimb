import { boolean, pgTable, serial, text, timestamp, integer, json } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { teachersTable } from "./teachers";

export const classesTable = pgTable("classes", {
  id: serial("id").primaryKey(),
  teacherId: integer("teacher_id")
    .notNull()
    .references(() => teachersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  subject: text("subject"),
  code: text("code").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archiveExpiresAt: timestamp("archive_expires_at", { withTimezone: true }),
  archiveLifecycleStatus: text("archive_lifecycle_status").notNull().default("active"),
  archiveLegalHold: boolean("archive_legal_hold").notNull().default(false),
  archiveExpiryNotifiedAt: timestamp("archive_expiry_notified_at", { withTimezone: true }),
  archiveExpiryWarningAttemptedAt: timestamp("archive_expiry_warning_attempted_at", { withTimezone: true }),
  archiveExpiryWarningSentAt: timestamp("archive_expiry_warning_sent_at", { withTimezone: true }),
  deletionWarningAttemptedAt: timestamp("deletion_warning_attempted_at", { withTimezone: true }),
  deletionWarningSentAt: timestamp("deletion_warning_sent_at", { withTimezone: true }),
  deletionRequestedAt: timestamp("deletion_requested_at", { withTimezone: true }),
  deletionScheduledFor: timestamp("deletion_scheduled_for", { withTimezone: true }),
  deletionRequestedBy: integer("deletion_requested_by")
    .references(() => teachersTable.id, { onDelete: "set null" }),
  deletionReason: text("deletion_reason"),
  lastInsights: json("last_insights"),
  lastInsightsAt: timestamp("last_insights_at", { withTimezone: true }),
  insightsHistory: json("insights_history").notNull().default([]),
  classJourneyAnalysisReport: json("class_journey_analysis_report"),
  classJourneyAnalysisStatus: text("class_journey_analysis_status"),
  classJourneyAnalysisGeneratedAt: timestamp("class_journey_analysis_generated_at", { withTimezone: true }),
  classJourneyAnalysisSourceHash: text("class_journey_analysis_source_hash"),
  classJourneyAnalysisError: text("class_journey_analysis_error"),
});

export const insertClassSchema = createInsertSchema(classesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertClass = z.infer<typeof insertClassSchema>;
export type Class = typeof classesTable.$inferSelect;

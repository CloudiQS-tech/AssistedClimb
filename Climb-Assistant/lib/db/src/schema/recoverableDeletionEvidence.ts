import { pgTable, serial, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organisationsTable } from "./organisations";
import { teachersTable } from "./teachers";

export const recoverableDeletionTargetTypes = ["student_record", "class"] as const;
export const recoverableDeletionReasons = ["teacher_requested", "departure_requested", "archive_retention_expired"] as const;

/**
 * This is intentionally detached from the deleted class or student row. It
 * records only the minimum application-side evidence that survives the final
 * cascade; external backup and provider lifecycle is outside this record.
 */
export const recoverableDeletionEvidenceTable = pgTable(
  "recoverable_deletion_evidence",
  {
    id: serial("id").primaryKey(),
    organisationId: integer("organisation_id")
      .notNull()
      .references(() => organisationsTable.id, { onDelete: "cascade" }),
    targetType: text("target_type", { enum: recoverableDeletionTargetTypes }).notNull(),
    targetId: integer("target_id").notNull(),
    classId: integer("class_id").notNull(),
    deletionRequestedAt: timestamp("deletion_requested_at", { withTimezone: true }).notNull(),
    deletionScheduledFor: timestamp("deletion_scheduled_for", { withTimezone: true }).notNull(),
    deletionReason: text("deletion_reason", { enum: recoverableDeletionReasons }).notNull(),
    deletedByTeacherId: integer("deleted_by_teacher_id")
      .references(() => teachersTable.id, { onDelete: "set null" }),
    applicationRecordsPurgedAt: timestamp("application_records_purged_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("recoverable_deletion_evidence_org_created_idx").on(table.organisationId, table.createdAt),
  ],
);

export const insertRecoverableDeletionEvidenceSchema = createInsertSchema(recoverableDeletionEvidenceTable).omit({
  id: true,
  applicationRecordsPurgedAt: true,
  createdAt: true,
});
export type InsertRecoverableDeletionEvidence = z.infer<typeof insertRecoverableDeletionEvidenceSchema>;
export type RecoverableDeletionEvidence = typeof recoverableDeletionEvidenceTable.$inferSelect;
import { pgTable, serial, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organisationsTable } from "./organisations";
import { teachersTable } from "./teachers";

export const studentRecordDeletionReasons = [
  "retention_expired",
  "school_master_requested",
] as const;

/**
 * Deliberately has no foreign key to the deleted student record. It is the
 * minimum in-application evidence that survives the cascading application
 * deletion; it does not make claims about backups or external providers.
 */
export const studentRecordDeletionEvidenceTable = pgTable(
  "student_record_deletion_evidence",
  {
    id: serial("id").primaryKey(),
    organisationId: integer("organisation_id")
      .notNull()
      .references(() => organisationsTable.id, { onDelete: "cascade" }),
    deletedStudentSessionId: integer("deleted_student_session_id").notNull(),
    classId: integer("class_id").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }).notNull(),
    retentionUntil: timestamp("retention_until", { withTimezone: true }).notNull(),
    applicationRecordsPurgedAt: timestamp("application_records_purged_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletionReason: text("deletion_reason", { enum: studentRecordDeletionReasons }).notNull(),
    deletedByTeacherId: integer("deleted_by_teacher_id")
      .references(() => teachersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("student_record_deletion_evidence_org_created_idx").on(table.organisationId, table.createdAt),
  ],
);

export const insertStudentRecordDeletionEvidenceSchema = createInsertSchema(studentRecordDeletionEvidenceTable).omit({
  id: true,
  applicationRecordsPurgedAt: true,
  createdAt: true,
});
export type InsertStudentRecordDeletionEvidence = z.infer<typeof insertStudentRecordDeletionEvidenceSchema>;
export type StudentRecordDeletionEvidence = typeof studentRecordDeletionEvidenceTable.$inferSelect;
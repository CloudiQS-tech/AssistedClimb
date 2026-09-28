import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organisationsTable } from "./organisations";
import { teachersTable } from "./teachers";

export const backupStorageLifecycleStatuses = [
  "pending_configuration",
  "expiry_pending",
  "verified",
] as const;

export const teacherRecordDeletionEvidenceTable = pgTable("teacher_record_deletion_evidence", {
  id: serial("id").primaryKey(),
  organisationId: integer("organisation_id")
    .notNull()
    .references(() => organisationsTable.id, { onDelete: "cascade" }),
  // These identifiers are deliberately not foreign keys: this table is the
  // minimal evidence retained after the teacher and their archive are purged.
  deletedTeacherId: integer("deleted_teacher_id").notNull(),
  archiveId: integer("archive_id").notNull(),
  applicationRecordsPurgedAt: timestamp("application_records_purged_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  managedFileObjectsStatus: text("managed_file_objects_status", {
    enum: ["not_applicable", "purged"] as const,
  }).notNull().default("not_applicable"),
  backupStorageLifecycleStatus: text("backup_storage_lifecycle_status", {
    enum: backupStorageLifecycleStatuses,
  }).notNull(),
  backupStorageExpiryAt: timestamp("backup_storage_expiry_at", { withTimezone: true }),
  backupStorageEvidenceReference: text("backup_storage_evidence_reference"),
  backupStorageVerifiedAt: timestamp("backup_storage_verified_at", { withTimezone: true }),
  deletedByTeacherId: integer("deleted_by_teacher_id")
    .references(() => teachersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertTeacherRecordDeletionEvidenceSchema = createInsertSchema(teacherRecordDeletionEvidenceTable).omit({
  id: true,
  applicationRecordsPurgedAt: true,
  createdAt: true,
});
export type InsertTeacherRecordDeletionEvidence = z.infer<typeof insertTeacherRecordDeletionEvidenceSchema>;
export type TeacherRecordDeletionEvidence = typeof teacherRecordDeletionEvidenceTable.$inferSelect;
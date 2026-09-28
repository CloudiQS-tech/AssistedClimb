import { pgTable, serial, text, timestamp, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organisationsTable } from "./organisations";
import { teachersTable } from "./teachers";

export const teacherRecordArchivesTable = pgTable("teacher_record_archives", {
  id: serial("id").primaryKey(),
  organisationId: integer("organisation_id")
    .notNull()
    .references(() => organisationsTable.id, { onDelete: "cascade" }),
  teacherId: integer("teacher_id")
    .notNull()
    .references(() => teachersTable.id, { onDelete: "cascade" }),
  retentionUntil: timestamp("retention_until", { withTimezone: true }).notNull(),
  reason: text("reason").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }).notNull().defaultNow(),
  archivedByTeacherId: integer("archived_by_teacher_id")
    .references(() => teachersTable.id, { onDelete: "set null" }),
}, (table) => [
  uniqueIndex("teacher_record_archives_teacher_id_unique").on(table.teacherId),
]);

export const insertTeacherRecordArchiveSchema = createInsertSchema(teacherRecordArchivesTable).omit({
  id: true,
  archivedAt: true,
});
export type InsertTeacherRecordArchive = z.infer<typeof insertTeacherRecordArchiveSchema>;
export type TeacherRecordArchive = typeof teacherRecordArchivesTable.$inferSelect;
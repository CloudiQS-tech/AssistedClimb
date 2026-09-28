import { pgTable, serial, text, timestamp, integer, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { studentSessionsTable } from "./studentSessions";
import { teachersTable } from "./teachers";

export const teacherMessagesTable = pgTable("teacher_messages", {
  id: serial("id").primaryKey(),
  studentSessionId: integer("student_session_id")
    .notNull()
    .references(() => studentSessionsTable.id, { onDelete: "cascade" }),
  teacherId: integer("teacher_id")
    .references(() => teachersTable.id, { onDelete: "set null" }),
  senderType: text("sender_type").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  teacherReadAt: timestamp("teacher_read_at", { withTimezone: true }),
  studentReadAt: timestamp("student_read_at", { withTimezone: true }),
}, (table) => [
  check("teacher_messages_sender_type", sql`${table.senderType} in ('teacher', 'student')`),
  check("teacher_messages_content_length", sql`char_length(${table.content}) between 1 and 500`),
]);

export type TeacherMessage = typeof teacherMessagesTable.$inferSelect;
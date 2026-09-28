import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { teachersTable } from "./teachers";

export const teacherPasswordHistoryTable = pgTable("teacher_password_history", {
  id: serial("id").primaryKey(),
  teacherId: integer("teacher_id").notNull().references(() => teachersTable.id, { onDelete: "cascade" }),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TeacherPasswordHistory = typeof teacherPasswordHistoryTable.$inferSelect;
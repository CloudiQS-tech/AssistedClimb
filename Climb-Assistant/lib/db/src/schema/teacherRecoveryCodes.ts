import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { teachersTable } from "./teachers";

export const teacherRecoveryCodesTable = pgTable("teacher_recovery_codes", {
  id: serial("id").primaryKey(),
  teacherId: integer("teacher_id").notNull().references(() => teachersTable.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TeacherRecoveryCode = typeof teacherRecoveryCodesTable.$inferSelect;
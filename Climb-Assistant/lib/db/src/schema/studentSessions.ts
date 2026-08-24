import { pgTable, serial, text, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { classesTable } from "./classes";

export const studentSessionsTable = pgTable("student_sessions", {
  id: serial("id").primaryKey(),
  classId: integer("class_id")
    .notNull()
    .references(() => classesTable.id, { onDelete: "cascade" }),
  studentName: text("student_name").notNull(),
  pinHash: text("pin_hash"),
  isBlocked: boolean("is_blocked").notNull().default(false),
  failedPinAttempts: integer("failed_pin_attempts").notNull().default(0),
  pinLockedUntil: timestamp("pin_locked_until", { withTimezone: true }),
  sessionNonce: text("session_nonce"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertStudentSessionSchema = createInsertSchema(studentSessionsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertStudentSession = z.infer<typeof insertStudentSessionSchema>;
export type StudentSession = typeof studentSessionsTable.$inferSelect;

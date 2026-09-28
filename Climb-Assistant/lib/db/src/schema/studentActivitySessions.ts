import { sql } from "drizzle-orm";
import { pgTable, serial, text, timestamp, integer, index, jsonb, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { studentSessionsTable } from "./studentSessions";
import { stageEnum, type StageType } from "./stageEntries";

export const studentActivitySessionsTable = pgTable(
  "student_activity_sessions",
  {
    id: serial("id").primaryKey(),
    studentSessionId: integer("student_session_id")
      .notNull()
      .references(() => studentSessionsTable.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endReason: text("end_reason"),
    loginSessionId: uuid("login_session_id"),
    activeStage: text("active_stage").$type<StageType | null>(),
    pageDurations: jsonb("page_durations").$type<Partial<Record<StageType, number>> | null>(),
  },
  (table) => [
    index("student_activity_sessions_student_session_idx").on(table.studentSessionId),
    index("student_activity_sessions_login_session_idx").on(table.studentSessionId, table.loginSessionId),
    index("student_activity_sessions_open_idx").on(table.studentSessionId, table.endedAt),
    uniqueIndex("student_activity_sessions_one_open_per_student_idx")
      .on(table.studentSessionId)
      .where(sql`ended_at IS NULL`),
  ],
);

export const insertStudentActivitySessionSchema = createInsertSchema(studentActivitySessionsTable).omit({
  id: true,
  startedAt: true,
  lastSeenAt: true,
});
export type InsertStudentActivitySession = z.infer<typeof insertStudentActivitySessionSchema>;
export type StudentActivitySession = typeof studentActivitySessionsTable.$inferSelect;
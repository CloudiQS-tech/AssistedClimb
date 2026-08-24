import { pgTable, serial, text, timestamp, integer, unique, boolean } from "drizzle-orm/pg-core";
import { studentSessionsTable } from "./studentSessions";

export const GRADE_VALUES = ["emerging", "developing", "secure", "exceeding"] as const;
export type GradeType = (typeof GRADE_VALUES)[number];

export const teacherFeedbackTable = pgTable(
  "teacher_feedback",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => studentSessionsTable.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(),
    grade: text("grade").$type<GradeType | null>(),
    comment: text("comment").notNull().default(""),
    formativeComment: text("formative_comment").notNull().default(""),
    studentAcknowledged: boolean("student_acknowledged").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [unique("teacher_feedback_session_stage_unique").on(t.sessionId, t.stage)],
);

export type TeacherFeedback = typeof teacherFeedbackTable.$inferSelect;

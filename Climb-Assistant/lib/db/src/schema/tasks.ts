import { pgTable, serial, text, timestamp, integer, json, unique, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { classesTable } from "./classes";

export const taskExamBoards = ["AQA", "Pearson Edexcel", "OCR", "WJEC/Eduqas", "CCEA"] as const;

export const tasksTable = pgTable("tasks", {
  id: serial("id").primaryKey(),
  classId: integer("class_id")
    .notNull()
    .references(() => classesTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  subject: text("subject"),
  examBoard: text("exam_board"),
  question: text("question").notNull(),
  notes: text("notes"),
  learningFramework: text("learning_framework", { enum: ["bloom", "knowledge_dimensions"] }).notNull().default("bloom"),
  yearGroup: text("year_group"),
  bloomLevels: json("bloom_levels").$type<string[]>().notNull().default([]),
  knowledgeDimensions: json("knowledge_dimensions").$type<string[]>().notNull().default([]),
  dueDate: text("due_date"),
  formativeAssessmentDate: text("formative_assessment_date"),
  summativeAssessmentDate: text("summative_assessment_date"),
  lateEditingAllowed: boolean("late_editing_allowed").notNull().default(false),
  successCriteria: json("success_criteria").$type<string[]>().notNull().default([]),
  keyVocabulary: json("key_vocabulary").$type<string[]>().notNull().default([]),
  enabledStages: json("enabled_stages").$type<string[]>().notNull().default(["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"]),
  stageInstructions: json("stage_instructions").$type<{ map?: string; torch?: string; compass?: string; embed?: string }>().notNull().default({}),
  expectedLength: text("expected_length"),
  resources: json("resources").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  unique("tasks_class_id_unique").on(t.classId),
]);

export const insertTaskSchema = createInsertSchema(tasksTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasksTable.$inferSelect;

import { integer, json, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organisationsTable } from "./organisations";
import { teachersTable } from "./teachers";
import { taskExamBoards } from "./tasks";

export const taskTemplateStatuses = ["draft", "ready"] as const;

export const taskTemplatesTable = pgTable("task_templates", {
  id: serial("id").primaryKey(),
  teacherId: integer("teacher_id")
    .notNull()
    .references(() => teachersTable.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id")
    .references(() => organisationsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  subject: text("subject"),
  examBoard: text("exam_board"),
  question: text("question").notNull().default(""),
  notes: text("notes"),
  learningFramework: text("learning_framework", { enum: ["bloom", "knowledge_dimensions"] }).notNull().default("bloom"),
  yearGroup: text("year_group"),
  bloomLevels: json("bloom_levels").$type<string[]>().notNull().default([]),
  knowledgeDimensions: json("knowledge_dimensions").$type<string[]>().notNull().default([]),
  dueDate: text("due_date"),
  successCriteria: json("success_criteria").$type<string[]>().notNull().default([]),
  keyVocabulary: json("key_vocabulary").$type<string[]>().notNull().default([]),
  enabledStages: json("enabled_stages").$type<string[]>().notNull().default(["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"]),
  stageInstructions: json("stage_instructions").$type<{ map?: string; torch?: string; compass?: string; embed?: string }>().notNull().default({}),
  expectedLength: text("expected_length"),
  resources: json("resources").$type<string[]>().notNull().default([]),
  status: text("status", { enum: taskTemplateStatuses }).notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertTaskTemplateSchema = createInsertSchema(taskTemplatesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertTaskTemplate = z.infer<typeof insertTaskTemplateSchema>;
export type TaskTemplate = typeof taskTemplatesTable.$inferSelect;
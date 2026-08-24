import { pgTable, serial, text, timestamp, integer, json, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { classesTable } from "./classes";

export const tasksTable = pgTable("tasks", {
  id: serial("id").primaryKey(),
  classId: integer("class_id")
    .notNull()
    .references(() => classesTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  question: text("question").notNull(),
  notes: text("notes"),
  bloomLevels: json("bloom_levels").$type<string[]>().notNull().default([]),
  dueDate: text("due_date"),
  successCriteria: json("success_criteria").$type<string[]>().notNull().default([]),
  keyVocabulary: json("key_vocabulary").$type<string[]>().notNull().default([]),
  enabledStages: json("enabled_stages").$type<string[]>().notNull().default(["MAP", "TORCH", "COMPASS", "EMBED", "RESEARCH"]),
  stageInstructions: json("stage_instructions").$type<{ map?: string; torch?: string; compass?: string; embed?: string; research?: string }>().notNull().default({}),
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

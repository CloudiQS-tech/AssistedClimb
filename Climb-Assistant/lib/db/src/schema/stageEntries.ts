import { pgTable, serial, text, timestamp, integer, json } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { studentSessionsTable } from "./studentSessions";

export const stageEnum = ["MAP", "TORCH", "RESEARCH", "COMPASS", "EMBED"] as const;
export type StageType = (typeof stageEnum)[number];

export const stageEntriesTable = pgTable("stage_entries", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id")
    .notNull()
    .references(() => studentSessionsTable.id, { onDelete: "cascade" }),
  stage: text("stage").notNull().$type<StageType>(),
  contentJson: json("content_json").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertStageEntrySchema = createInsertSchema(stageEntriesTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertStageEntry = z.infer<typeof insertStageEntrySchema>;
export type StageEntry = typeof stageEntriesTable.$inferSelect;

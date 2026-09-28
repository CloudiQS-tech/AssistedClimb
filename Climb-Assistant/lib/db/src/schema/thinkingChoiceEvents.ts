import { pgTable, serial, text, timestamp, integer, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { classesTable } from "./classes";
import { studentSessionsTable } from "./studentSessions";

export const thinkingChoiceEventTypes = ["selected", "inserted", "edited", "submitted"] as const;
export type ThinkingChoiceEventType = (typeof thinkingChoiceEventTypes)[number];

export const thinkingChoiceEventsTable = pgTable("thinking_choice_events", {
  id: serial("id").primaryKey(),
  organisationId: integer("organisation_id").notNull(),
  classId: integer("class_id").notNull().references(() => classesTable.id, { onDelete: "cascade" }),
  sessionId: integer("session_id").notNull().references(() => studentSessionsTable.id, { onDelete: "cascade" }),
  researchId: text("research_id").notNull(),
  optionName: text("option_name").notNull(),
  questionId: text("question_id"),
  eventType: text("event_type", { enum: thinkingChoiceEventTypes }).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  stage: text("stage").notNull().default("TORCH"),
  conversationTurn: integer("conversation_turn").notNull().default(0),
  afterFormativeFeedback: boolean("after_formative_feedback").notNull().default(false),
  firstUseOrder: integer("first_use_order"),
  idempotencyKey: text("idempotency_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  eventKey: uniqueIndex("thinking_choice_events_idempotency_key_idx").on(table.sessionId, table.idempotencyKey),
  sessionTime: index("thinking_choice_events_session_time_idx").on(table.sessionId, table.occurredAt),
  classTime: index("thinking_choice_events_class_time_idx").on(table.classId, table.occurredAt),
}));

export const insertThinkingChoiceEventSchema = createInsertSchema(thinkingChoiceEventsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertThinkingChoiceEvent = z.infer<typeof insertThinkingChoiceEventSchema>;
export type ThinkingChoiceEvent = typeof thinkingChoiceEventsTable.$inferSelect;
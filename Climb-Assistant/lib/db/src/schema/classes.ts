import { pgTable, serial, text, timestamp, integer, json } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { teachersTable } from "./teachers";

export const classesTable = pgTable("classes", {
  id: serial("id").primaryKey(),
  teacherId: integer("teacher_id")
    .notNull()
    .references(() => teachersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  subject: text("subject"),
  code: text("code").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastInsights: json("last_insights"),
  lastInsightsAt: timestamp("last_insights_at", { withTimezone: true }),
});

export const insertClassSchema = createInsertSchema(classesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertClass = z.infer<typeof insertClassSchema>;
export type Class = typeof classesTable.$inferSelect;

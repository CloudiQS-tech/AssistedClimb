import { sql } from "drizzle-orm";
import { pgTable, serial, text, timestamp, integer, json, unique, check } from "drizzle-orm/pg-core";
import { studentSessionsTable } from "./studentSessions";
import { teachersTable } from "./teachers";

export const developmentSnapshotKinds = [
  "climb_formative",
  "climb_summative",
  "answer_assessment_finalisation",
] as const;
export type DevelopmentSnapshotKind = (typeof developmentSnapshotKinds)[number];

export const developmentSnapshotsTable = pgTable(
  "development_snapshots",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => studentSessionsTable.id, { onDelete: "cascade" }),
    snapshotKind: text("snapshot_kind", { enum: developmentSnapshotKinds }).notNull(),
    payload: json("payload").$type<Record<string, unknown>>().notNull(),
    triggerEvent: text("trigger_event").notNull(),
    teacherId: integer("teacher_id").references(() => teachersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("development_snapshots_session_kind_unique").on(table.sessionId, table.snapshotKind),
    check(
      "development_snapshots_snapshot_kind_check",
      sql`${table.snapshotKind} IN ('climb_formative', 'climb_summative', 'answer_assessment_finalisation')`,
    ),
  ],
);

export type DevelopmentSnapshot = typeof developmentSnapshotsTable.$inferSelect;
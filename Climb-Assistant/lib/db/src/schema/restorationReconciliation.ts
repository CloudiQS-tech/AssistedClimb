import { pgTable, smallint, text, timestamp, integer, jsonb, uuid } from "drizzle-orm/pg-core";

export const restorationStates = ["ready", "quarantined", "reconciling", "failed"] as const;

export const restorationControlTable = pgTable("restoration_control", {
  id: smallint("id").primaryKey(),
  state: text("state", { enum: restorationStates }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastCompletedRunId: uuid("last_completed_run_id"),
  releaseFenceId: text("release_fence_id"),
});

export const restorationReconciliationRunsTable = pgTable("restoration_reconciliation_runs", {
  id: uuid("id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  status: text("status", { enum: ["running", "completed", "failed"] as const }).notNull(),
  tombstonesChecked: integer("tombstones_checked").notNull().default(0),
  recordsRedeleted: jsonb("records_redeleted").$type<Record<string, number>>(),
  failureCode: text("failure_code"),
});
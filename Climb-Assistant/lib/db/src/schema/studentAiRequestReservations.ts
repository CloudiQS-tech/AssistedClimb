import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organisationsTable } from "./organisations";
import { studentSessionsTable } from "./studentSessions";

/**
 * Short-lived leases for paid student AI requests. They provide a distributed
 * concurrency limit while an external provider call is in progress.
 */
export const studentAiRequestReservationsTable = pgTable(
  "student_ai_request_reservations",
  {
    id: text("id").primaryKey(),
    organisationId: integer("organisation_id")
      .notNull()
      .references(() => organisationsTable.id, { onDelete: "cascade" }),
    studentSessionId: integer("student_session_id")
      .notNull()
      .references(() => studentSessionsTable.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("student_ai_request_reservations_organisation_expires_idx")
      .on(table.organisationId, table.expiresAt),
    index("student_ai_request_reservations_session_expires_idx")
      .on(table.studentSessionId, table.expiresAt),
    index("student_ai_request_reservations_organisation_created_idx")
      .on(table.organisationId, table.createdAt),
    index("student_ai_request_reservations_session_created_idx")
      .on(table.studentSessionId, table.createdAt),
  ],
);

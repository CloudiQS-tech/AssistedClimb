import { pgTable, serial, text, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { organisationsTable } from "./organisations";
import { teachersTable } from "./teachers";

export const auditLogTable = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  organisationId: integer("organisation_id").references(() => organisationsTable.id, { onDelete: "set null" }),
  teacherId: integer("teacher_id").references(() => teachersTable.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  metadata: jsonb("metadata"),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AuditLog = typeof auditLogTable.$inferSelect;

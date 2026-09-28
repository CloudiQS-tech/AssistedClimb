import { boolean, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { organisationsTable } from "./organisations";

export const organisationRetentionDefaultsTable = pgTable(
  "organisation_retention_defaults",
  {
    id: serial("id").primaryKey(),
    organisationId: integer("organisation_id").notNull().references(() => organisationsTable.id, { onDelete: "cascade" }),
    retentionDays: integer("retention_days").notNull(),
    archiveRetentionDays: integer("archive_retention_days").notNull().default(365),
    deletionRecoveryDays: integer("deletion_recovery_days").notNull().default(30),
    reviewDate: timestamp("review_date", { withTimezone: true }).notNull(),
    deletionStatus: text("deletion_status").notNull().default("retained"),
    notes: text("notes"),
    legalHold: boolean("legal_hold").notNull().default(false),
    operatorVerifiedAt: timestamp("operator_verified_at", { withTimezone: true }),
    operatorVerifiedByTeacherId: integer("operator_verified_by_teacher_id"),
    updatedByTeacherId: integer("updated_by_teacher_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organisationUnique: unique("organisation_retention_default_org_unique").on(table.organisationId),
  }),
);

export type OrganisationRetentionDefault = typeof organisationRetentionDefaultsTable.$inferSelect;
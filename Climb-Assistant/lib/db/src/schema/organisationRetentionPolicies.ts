import { boolean, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { organisationsTable } from "./organisations";

export const organisationRetentionPoliciesTable = pgTable(
  "organisation_retention_policies",
  {
    id: serial("id").primaryKey(),
    organisationId: integer("organisation_id").notNull().references(() => organisationsTable.id, { onDelete: "cascade" }),
    dataCategory: text("data_category").notNull(),
    retentionDays: integer("retention_days").notNull(),
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
    organisationCategoryUnique: unique("organisation_retention_policy_org_category_unique").on(
      table.organisationId,
      table.dataCategory,
    ),
  }),
);

export type OrganisationRetentionPolicy = typeof organisationRetentionPoliciesTable.$inferSelect;
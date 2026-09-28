import { boolean, date, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organisationsTable } from "./organisations";
import { teachersTable } from "./teachers";

export const organisationDataRequestProceduresTable = pgTable("organisation_data_request_procedures", {
  id: serial("id").primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisationsTable.id, { onDelete: "cascade" }),
  privacyContact: text("privacy_contact").notNull(),
  safeguardingContactName: text("safeguarding_contact_name").notNull().default(""),
  safeguardingContactEmail: text("safeguarding_contact_email").notNull().default(""),
  checksCompleted: jsonb("checks_completed").$type<string[]>().notNull().default([]),
  conditionsOrRestrictions: text("conditions_or_restrictions").notNull().default(""),
  reviewDate: date("review_date", { mode: "string" }),
  finalConfirmation: boolean("final_confirmation").notNull().default(false),
  secureTransferRoute: text("secure_transfer_route").notNull(),
  safeguardingContact: text("safeguarding_contact").notNull(),
  incidentEscalationContact: text("incident_escalation_contact").notNull(),
  complaintRoute: text("complaint_route").notNull(),
  responseTargets: text("response_targets").notNull(),
  retentionSchedule: text("retention_schedule").notNull(),
  staffPublicationLocation: text("staff_publication_location").notNull(),
  privacyMaterialsLink: text("privacy_materials_link").notNull(),
  procedureVersion: text("procedure_version").notNull(),
  nextReviewDate: date("next_review_date", { mode: "string" }).notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  updatedByTeacherId: integer("updated_by_teacher_id").references(() => teachersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  organisationUnique: uniqueIndex("organisation_data_request_procedures_organisation_unique").on(table.organisationId),
}));

export const insertOrganisationDataRequestProcedureSchema = createInsertSchema(organisationDataRequestProceduresTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertOrganisationDataRequestProcedure = z.infer<typeof insertOrganisationDataRequestProcedureSchema>;
export type OrganisationDataRequestProcedure = typeof organisationDataRequestProceduresTable.$inferSelect;

export const organisationDataRequestApprovalsTable = pgTable("organisation_data_request_approvals", {
  id: serial("id").primaryKey(),
  procedureId: integer("procedure_id").notNull().references(() => organisationDataRequestProceduresTable.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  approverName: text("approver_name").notNull(),
  approverRole: text("approver_role"),
  evidenceReference: text("evidence_reference").notNull(),
  approvedOn: date("approved_on", { mode: "string" }).notNull(),
  outcome: text("outcome"),
  decision: text("decision"),
  actionsRequired: text("actions_required"),
  nextReviewDate: date("next_review_date", { mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  procedureRoleUnique: uniqueIndex("organisation_data_request_approvals_procedure_role_unique").on(table.procedureId, table.role),
}));

export const insertOrganisationDataRequestApprovalSchema = createInsertSchema(organisationDataRequestApprovalsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertOrganisationDataRequestApproval = z.infer<typeof insertOrganisationDataRequestApprovalSchema>;
export type OrganisationDataRequestApproval = typeof organisationDataRequestApprovalsTable.$inferSelect;

export const organisationDataRequestPublicationsTable = pgTable("organisation_data_request_publications", {
  id: serial("id").primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisationsTable.id, { onDelete: "cascade" }),
  procedureId: integer("procedure_id").notNull().references(() => organisationDataRequestProceduresTable.id, { onDelete: "cascade" }),
  procedureVersion: text("procedure_version").notNull(),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  publishedByTeacherId: integer("published_by_teacher_id").references(() => teachersTable.id, { onDelete: "set null" }),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  organisationPublishedAtIndex: index("organisation_data_request_publications_org_published_idx").on(table.organisationId, table.publishedAt),
}));

export const insertOrganisationDataRequestPublicationSchema = createInsertSchema(organisationDataRequestPublicationsTable).omit({
  id: true,
  publishedAt: true,
});

export type InsertOrganisationDataRequestPublication = z.infer<typeof insertOrganisationDataRequestPublicationSchema>;
export type OrganisationDataRequestPublication = typeof organisationDataRequestPublicationsTable.$inferSelect;
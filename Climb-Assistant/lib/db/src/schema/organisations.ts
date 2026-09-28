import { pgTable, serial, text, timestamp, boolean, integer } from "drizzle-orm/pg-core";
import { cigAdminsTable } from "./cigAdmins";

export const organisationsTable = pgTable("organisations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  active: boolean("active").notNull().default(true),
  aiProvider: text("ai_provider"),
  aiKeyEncrypted: text("ai_key_encrypted"),
  azureEndpoint: text("azure_endpoint"),
  aiDataProcessingAcknowledged: boolean("ai_data_processing_acknowledged").notNull().default(false),
  aiDataProcessingAcknowledgedAt: timestamp("ai_data_processing_acknowledged_at", { withTimezone: true }),
  aiDataProcessingAcknowledgedByTeacherId: integer("ai_data_processing_acknowledged_by_teacher_id"),
  aiDataProcessingPolicyVersion: text("ai_data_processing_policy_version"),
  aiDataProcessingEvidenceReference: text("ai_data_processing_evidence_reference"),
  aiDataProcessingRegion: text("ai_data_processing_region"),
  aiDataRetentionNoTrainingConfirmed: boolean("ai_data_retention_no_training_confirmed").notNull().default(false),
  aiSchoolPoliciesConfirmed: boolean("ai_school_policies_confirmed").notNull().default(false),
  aiDataProcessingReviewDate: timestamp("ai_data_processing_review_date", { withTimezone: true }),
  researchProcessingBlocked: boolean("research_processing_blocked").notNull().default(true),
  researchGovernanceReference: text("research_governance_reference"),
  researchGovernanceReviewDate: timestamp("research_governance_review_date", { withTimezone: true }),
  teacherInviteCode: text("teacher_invite_code").notNull().unique(),
  allowedEmailDomains: text("allowed_email_domains").array(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedByCigAdminId: integer("deleted_by_cig_admin_id")
    .references(() => cigAdminsTable.id, { onDelete: "set null" }),
  deletionLegalHold: boolean("deletion_legal_hold").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Organisation = typeof organisationsTable.$inferSelect;

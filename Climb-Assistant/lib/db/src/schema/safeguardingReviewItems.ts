import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organisationsTable } from "./organisations";
import { classesTable } from "./classes";
import { studentSessionsTable } from "./studentSessions";
import { teachersTable } from "./teachers";

export const safeguardingReviewStatuses = ["new", "under_review", "closed"] as const;
export const safeguardingSourceTypes = ["student_ai", "climb"] as const;
export const safeguardingCategories = [
  "self_harm_or_suicide",
  "harm_by_another_person",
  "sexual_abuse_or_exploitation",
  "serious_violence_or_threat",
  "grooming_coercion_or_blackmail",
  "immediate_danger",
  "other_serious_concern",
  "provider_safety_signal",
] as const;

export type SafeguardingCategory = typeof safeguardingCategories[number];
export type SafeguardingDetectedBy = "local" | "provider" | "both";

export type SafeguardingProviderSignal = {
  provider: "azure" | "gemini";
  categories: string[];
};

export const safeguardingReviewItemsTable = pgTable(
  "safeguarding_review_items",
  {
    id: serial("id").primaryKey(),
    organisationId: integer("organisation_id")
      .notNull()
      .references(() => organisationsTable.id, { onDelete: "cascade" }),
    classId: integer("class_id")
      .notNull()
      .references(() => classesTable.id, { onDelete: "cascade" }),
    studentSessionId: integer("student_session_id")
      .notNull()
      .references(() => studentSessionsTable.id, { onDelete: "cascade" }),
    sourceType: text("source_type", { enum: safeguardingSourceTypes }).notNull(),
    sourceSubmissionId: text("source_submission_id").notNull(),
    stage: text("stage"),
    dedupeKey: text("dedupe_key").notNull(),
    category: text("category", { enum: safeguardingCategories }).notNull(),
    technicalReason: text("technical_reason").notNull(),
    excerpt: text("excerpt").notNull(),
    surroundingContext: text("surrounding_context").notNull().default(""),
    detectedBy: text("detected_by", { enum: ["local", "provider", "both"] }).notNull(),
    providerSignals: jsonb("provider_signals")
      .$type<SafeguardingProviderSignal[]>()
      .notNull()
      .default([]),
    status: text("status", { enum: safeguardingReviewStatuses }).notNull().default("new"),
    reviewerId: integer("reviewer_id").references(() => teachersTable.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    actionTaken: text("action_taken"),
    decision: text("decision"),
    rationale: text("rationale"),
    outcome: text("outcome"),
    externalReference: text("external_reference"),
    notificationStatus: text("notification_status", {
      enum: ["pending", "sent", "partial", "failed", "ambiguous", "not_configured", "no_reviewer"],
    }).notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("safeguarding_review_items_session_dedupe_uq").on(
      table.studentSessionId,
      table.dedupeKey,
    ),
    index("safeguarding_review_items_org_status_created_idx").on(
      table.organisationId,
      table.status,
      table.createdAt,
    ),
    index("safeguarding_review_items_class_created_idx").on(table.classId, table.createdAt),
  ],
);

export type SafeguardingReviewItem = typeof safeguardingReviewItemsTable.$inferSelect;
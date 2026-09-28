import { pgTable, serial, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { organisationsTable } from "./organisations";
import { studentSessionsTable } from "./studentSessions";
import { teachersTable } from "./teachers";

export const studentDataRequestTypes = ["access", "correction", "deletion"] as const;
export type StudentDataRequestType = (typeof studentDataRequestTypes)[number];

export const studentDataRequestStatuses = ["open", "in_review", "completed", "refused", "escalated"] as const;
export type StudentDataRequestStatus = (typeof studentDataRequestStatuses)[number];

export const studentDataRequestsTable = pgTable(
  "student_data_requests",
  {
    id: serial("id").primaryKey(),
    organisationId: integer("organisation_id")
      .notNull()
      .references(() => organisationsTable.id, { onDelete: "cascade" }),
    studentSessionId: integer("student_session_id")
      .references(() => studentSessionsTable.id, { onDelete: "set null" }),
    studentNameSnapshot: text("student_name_snapshot").notNull(),
    classIdSnapshot: integer("class_id_snapshot"),
    classNameSnapshot: text("class_name_snapshot").notNull(),
    requestType: text("request_type").notNull().$type<StudentDataRequestType>(),
    reason: text("reason").notNull(),
    approvalBasis: text("approval_basis"),
    status: text("status").notNull().default("open").$type<StudentDataRequestStatus>(),
    outcome: text("outcome"),
    createdByTeacherId: integer("created_by_teacher_id").references(() => teachersTable.id, { onDelete: "set null" }),
    reviewedByTeacherId: integer("reviewed_by_teacher_id").references(() => teachersTable.id, { onDelete: "set null" }),
    exportCount: integer("export_count").notNull().default(0),
    lastExportedAt: timestamp("last_exported_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("student_data_requests_organisation_created_idx").on(table.organisationId, table.createdAt),
    index("student_data_requests_organisation_status_idx").on(table.organisationId, table.status),
  ],
);

export type StudentDataRequest = typeof studentDataRequestsTable.$inferSelect;

export const studentDataRequestControlKinds = ["restriction", "legal_hold", "safeguarding_hold"] as const;
export type StudentDataRequestControlKind = (typeof studentDataRequestControlKinds)[number];

export const studentDataRequestControlReasonCategories = [
  "accuracy_dispute",
  "objection",
  "legal_claim",
  "complaint",
  "investigation",
  "safeguarding",
  "retention_duty",
  "other",
] as const;
export type StudentDataRequestControlReasonCategory = (typeof studentDataRequestControlReasonCategories)[number];

export const studentDataRequestControlLifecycleStates = ["active", "expired", "lifted"] as const;
export type StudentDataRequestControlLifecycleState = (typeof studentDataRequestControlLifecycleStates)[number];

export const studentDataRequestControlAccessLimits = ["export"] as const;
export type StudentDataRequestControlAccessLimit = (typeof studentDataRequestControlAccessLimits)[number];

export const studentDataRequestControlProcessingLimits = [
  "deletion",
  "export",
] as const;
export type StudentDataRequestControlProcessingLimit = (typeof studentDataRequestControlProcessingLimits)[number];

export const studentDataRequestControlEventTypes = ["applied", "reviewed", "expired", "lifted"] as const;
export type StudentDataRequestControlEventType = (typeof studentDataRequestControlEventTypes)[number];

export const studentDataRequestControlsTable = pgTable(
  "student_data_request_controls",
  {
    id: serial("id").primaryKey(),
    organisationId: integer("organisation_id")
      .notNull()
      .references(() => organisationsTable.id, { onDelete: "cascade" }),
    requestId: integer("request_id")
      .references(() => studentDataRequestsTable.id, { onDelete: "set null" }),
    accountableOwnerTeacherId: integer("accountable_owner_teacher_id")
      .references(() => teachersTable.id, { onDelete: "set null" }),
    affectedStudentSessionId: integer("affected_student_session_id"),
    affectedClassId: integer("affected_class_id"),
    affectedDataCategories: text("affected_data_categories").array().notNull(),
    kind: text("kind").notNull().$type<StudentDataRequestControlKind>(),
    reasonCategory: text("reason_category").notNull().$type<StudentDataRequestControlReasonCategory>(),
    reasonSummary: text("reason_summary").notNull(),
    accessLimits: text("access_limits").array().notNull(),
    processingLimits: text("processing_limits").array().notNull(),
    startDate: timestamp("start_date", { withTimezone: true }).notNull(),
    reviewDate: timestamp("review_date", { withTimezone: true }).notNull(),
    expiryDate: timestamp("expiry_date", { withTimezone: true }),
    lifecycleState: text("lifecycle_state").notNull().default("active").$type<StudentDataRequestControlLifecycleState>(),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("student_data_request_controls_org_state_idx").on(table.organisationId, table.lifecycleState),
    index("student_data_request_controls_student_idx").on(table.organisationId, table.affectedStudentSessionId),
    index("student_data_request_controls_request_idx").on(table.organisationId, table.requestId),
  ],
);

export const studentDataRequestControlEventsTable = pgTable(
  "student_data_request_control_events",
  {
    id: serial("id").primaryKey(),
    organisationId: integer("organisation_id")
      .notNull()
      .references(() => organisationsTable.id, { onDelete: "cascade" }),
    controlId: integer("control_id")
      .notNull()
      .references(() => studentDataRequestControlsTable.id),
    eventType: text("event_type").notNull().$type<StudentDataRequestControlEventType>(),
    note: text("note").notNull(),
    lifecycleState: text("lifecycle_state").notNull().$type<StudentDataRequestControlLifecycleState>(),
    actorTeacherId: integer("actor_teacher_id").references(() => teachersTable.id, { onDelete: "set null" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("student_data_request_control_events_control_idx").on(table.controlId, table.occurredAt),
    index("student_data_request_control_events_org_idx").on(table.organisationId, table.occurredAt),
  ],
);

export type StudentDataRequestControl = typeof studentDataRequestControlsTable.$inferSelect;
export type StudentDataRequestControlEvent = typeof studentDataRequestControlEventsTable.$inferSelect;
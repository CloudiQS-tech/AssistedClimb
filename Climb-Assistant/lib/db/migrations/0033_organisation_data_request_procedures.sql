CREATE TABLE IF NOT EXISTS "organisation_data_request_procedures" (
  "id" serial PRIMARY KEY,
  "organisation_id" integer NOT NULL REFERENCES "organisations"("id") ON DELETE CASCADE,
  "privacy_contact" text NOT NULL,
  "secure_transfer_route" text NOT NULL,
  "safeguarding_contact" text NOT NULL,
  "incident_escalation_contact" text NOT NULL,
  "complaint_route" text NOT NULL,
  "response_targets" text NOT NULL,
  "retention_schedule" text NOT NULL,
  "staff_publication_location" text NOT NULL,
  "privacy_materials_link" text NOT NULL,
  "procedure_version" text NOT NULL,
  "next_review_date" date NOT NULL,
  "approved_at" timestamp with time zone NOT NULL,
  "published_at" timestamp with time zone NOT NULL,
  "updated_by_teacher_id" integer REFERENCES "teachers"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "organisation_data_request_procedures_organisation_unique"
  ON "organisation_data_request_procedures" ("organisation_id");

CREATE TABLE IF NOT EXISTS "organisation_data_request_approvals" (
  "id" serial PRIMARY KEY,
  "procedure_id" integer NOT NULL REFERENCES "organisation_data_request_procedures"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "approver_name" text NOT NULL,
  "evidence_reference" text NOT NULL,
  "approved_on" date NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "organisation_data_request_approvals_procedure_role_unique"
  ON "organisation_data_request_approvals" ("procedure_id", "role");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organisation_data_request_approvals_role_allowed') THEN
    ALTER TABLE "organisation_data_request_approvals"
      ADD CONSTRAINT "organisation_data_request_approvals_role_allowed"
      CHECK ("role" IN ('dpo', 'safeguarding_lead', 'school_master', 'it_owner', 'controller_legal_reviewer'));
  END IF;
END $$;
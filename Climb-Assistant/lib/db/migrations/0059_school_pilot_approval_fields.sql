ALTER TABLE "organisation_data_request_procedures"
  ADD COLUMN IF NOT EXISTS "safeguarding_contact_name" text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "safeguarding_contact_email" text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "checks_completed" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "conditions_or_restrictions" text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "review_date" date,
  ADD COLUMN IF NOT EXISTS "final_confirmation" boolean NOT NULL DEFAULT false;
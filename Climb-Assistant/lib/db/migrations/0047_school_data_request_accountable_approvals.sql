ALTER TABLE "organisation_data_request_approvals"
  ADD COLUMN IF NOT EXISTS "approver_role" text,
  ADD COLUMN IF NOT EXISTS "outcome" text,
  ADD COLUMN IF NOT EXISTS "decision" text,
  ADD COLUMN IF NOT EXISTS "actions_required" text,
  ADD COLUMN IF NOT EXISTS "next_review_date" date;
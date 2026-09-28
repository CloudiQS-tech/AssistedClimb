ALTER TABLE "student_sessions"
  ADD COLUMN IF NOT EXISTS "development_analysis_report" json,
  ADD COLUMN IF NOT EXISTS "development_analysis_generated_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "development_analysis_source_hash" text,
  ADD COLUMN IF NOT EXISTS "development_analysis_status" text,
  ADD COLUMN IF NOT EXISTS "development_analysis_error" text;
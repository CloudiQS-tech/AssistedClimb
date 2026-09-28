ALTER TABLE "classes"
  ADD COLUMN IF NOT EXISTS "class_journey_analysis_report" jsonb,
  ADD COLUMN IF NOT EXISTS "class_journey_analysis_status" text,
  ADD COLUMN IF NOT EXISTS "class_journey_analysis_generated_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "class_journey_analysis_source_hash" text,
  ADD COLUMN IF NOT EXISTS "class_journey_analysis_error" text;
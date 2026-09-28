ALTER TABLE "classes"
  ADD COLUMN IF NOT EXISTS "insights_history" json NOT NULL DEFAULT '[]'::json;
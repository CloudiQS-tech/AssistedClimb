ALTER TABLE "student_sessions"
  ADD COLUMN IF NOT EXISTS "student_insights" json NOT NULL DEFAULT '{}'::json;
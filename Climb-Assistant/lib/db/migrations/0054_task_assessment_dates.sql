ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "formative_assessment_date" TEXT,
  ADD COLUMN IF NOT EXISTS "summative_assessment_date" TEXT;
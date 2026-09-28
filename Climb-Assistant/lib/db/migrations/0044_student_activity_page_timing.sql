ALTER TABLE student_activity_sessions
  ADD COLUMN IF NOT EXISTS active_stage TEXT,
  ADD COLUMN IF NOT EXISTS page_durations JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'student_activity_sessions_active_stage_check'
  ) THEN
    ALTER TABLE student_activity_sessions
      ADD CONSTRAINT student_activity_sessions_active_stage_check
      CHECK (active_stage IS NULL OR active_stage IN ('MAP', 'TORCH', 'RESEARCH', 'COMPASS', 'EMBED'));
  END IF;
END $$;
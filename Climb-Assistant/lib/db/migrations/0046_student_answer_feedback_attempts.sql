ALTER TABLE student_sessions
  ADD COLUMN IF NOT EXISTS answer_feedback_attempts JSONB NOT NULL DEFAULT '[]'::jsonb;
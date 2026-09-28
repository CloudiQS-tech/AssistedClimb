ALTER TABLE "student_activity_sessions"
  ADD COLUMN IF NOT EXISTS "login_session_id" uuid;

CREATE INDEX IF NOT EXISTS "student_activity_sessions_login_session_idx"
  ON "student_activity_sessions" ("student_session_id", "login_session_id");
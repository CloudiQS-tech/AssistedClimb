CREATE TABLE IF NOT EXISTS student_ai_request_reservations (
  id TEXT PRIMARY KEY,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  student_session_id INTEGER NOT NULL REFERENCES student_sessions(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS student_ai_request_reservations_organisation_expires_idx
  ON student_ai_request_reservations (organisation_id, expires_at);

CREATE INDEX IF NOT EXISTS student_ai_request_reservations_session_expires_idx
  ON student_ai_request_reservations (student_session_id, expires_at);

CREATE INDEX IF NOT EXISTS student_ai_request_reservations_organisation_created_idx
  ON student_ai_request_reservations (organisation_id, created_at);

CREATE INDEX IF NOT EXISTS student_ai_request_reservations_session_created_idx
  ON student_ai_request_reservations (student_session_id, created_at);
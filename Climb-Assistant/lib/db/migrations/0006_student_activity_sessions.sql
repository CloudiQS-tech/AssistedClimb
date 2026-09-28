CREATE TABLE IF NOT EXISTS student_activity_sessions (
  id SERIAL PRIMARY KEY,
  student_session_id INTEGER NOT NULL REFERENCES student_sessions(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  end_reason TEXT
);

CREATE INDEX IF NOT EXISTS student_activity_sessions_student_session_idx
  ON student_activity_sessions(student_session_id);

CREATE INDEX IF NOT EXISTS student_activity_sessions_open_idx
  ON student_activity_sessions(student_session_id, ended_at);
CREATE TABLE IF NOT EXISTS student_data_requests (
  id SERIAL PRIMARY KEY,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  student_session_id INTEGER REFERENCES student_sessions(id) ON DELETE SET NULL,
  student_name_snapshot TEXT NOT NULL,
  class_id_snapshot INTEGER,
  class_name_snapshot TEXT NOT NULL,
  request_type TEXT NOT NULL CHECK (request_type IN ('access', 'correction', 'deletion')),
  reason TEXT NOT NULL,
  approval_basis TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_review', 'completed', 'refused', 'escalated')),
  outcome TEXT,
  created_by_teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
  reviewed_by_teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
  export_count INTEGER NOT NULL DEFAULT 0,
  last_exported_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS student_data_requests_organisation_created_idx
  ON student_data_requests (organisation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS student_data_requests_organisation_status_idx
  ON student_data_requests (organisation_id, status);
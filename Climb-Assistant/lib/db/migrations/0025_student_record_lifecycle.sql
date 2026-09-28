ALTER TABLE student_sessions
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retention_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by INTEGER REFERENCES teachers(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'student_sessions_archive_retention_check'
  ) THEN
    ALTER TABLE student_sessions
      ADD CONSTRAINT student_sessions_archive_retention_check
      CHECK (
        (archived_at IS NULL AND retention_until IS NULL)
        OR (archived_at IS NOT NULL AND retention_until IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS student_sessions_archive_retention_idx
  ON student_sessions (archived_at, retention_until)
  WHERE archived_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS student_record_deletion_evidence (
  id SERIAL PRIMARY KEY,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  deleted_student_session_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL,
  retention_until TIMESTAMPTZ NOT NULL,
  application_records_purged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deletion_reason TEXT NOT NULL
    CHECK (deletion_reason IN ('retention_expired', 'school_master_requested')),
  deleted_by_teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS student_record_deletion_evidence_org_created_idx
  ON student_record_deletion_evidence (organisation_id, created_at DESC);
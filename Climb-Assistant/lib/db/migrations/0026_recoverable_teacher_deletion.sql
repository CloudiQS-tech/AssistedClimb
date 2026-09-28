ALTER TABLE classes
  ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deletion_scheduled_for TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deletion_requested_by INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deletion_reason TEXT;

ALTER TABLE student_sessions
  ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deletion_scheduled_for TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deletion_requested_by INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deletion_reason TEXT;

CREATE INDEX IF NOT EXISTS classes_recoverable_deletion_idx
  ON classes (deletion_scheduled_for)
  WHERE deletion_scheduled_for IS NOT NULL;

CREATE INDEX IF NOT EXISTS student_sessions_recoverable_deletion_idx
  ON student_sessions (deletion_scheduled_for)
  WHERE deletion_scheduled_for IS NOT NULL;

CREATE TABLE IF NOT EXISTS recoverable_deletion_evidence (
  id SERIAL PRIMARY KEY,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('student_record', 'class')),
  target_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  deletion_requested_at TIMESTAMPTZ NOT NULL,
  deletion_scheduled_for TIMESTAMPTZ NOT NULL,
  deletion_reason TEXT NOT NULL CHECK (deletion_reason IN ('teacher_requested', 'departure_requested')),
  deleted_by_teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
  application_records_purged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS recoverable_deletion_evidence_org_created_idx
  ON recoverable_deletion_evidence (organisation_id, created_at DESC);
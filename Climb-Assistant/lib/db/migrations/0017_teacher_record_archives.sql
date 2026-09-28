CREATE TABLE IF NOT EXISTS teacher_record_archives (
  id SERIAL PRIMARY KEY,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  retention_until TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_by_teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS teacher_record_archives_teacher_id_unique
  ON teacher_record_archives (teacher_id);

CREATE INDEX IF NOT EXISTS teacher_record_archives_organisation_retention_idx
  ON teacher_record_archives (organisation_id, retention_until);
CREATE TABLE IF NOT EXISTS teacher_record_deletion_evidence (
  id SERIAL PRIMARY KEY,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  deleted_teacher_id INTEGER NOT NULL,
  archive_id INTEGER NOT NULL,
  application_records_purged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  managed_file_objects_status TEXT NOT NULL DEFAULT 'not_applicable'
    CHECK (managed_file_objects_status IN ('not_applicable', 'purged')),
  backup_storage_lifecycle_status TEXT NOT NULL
    CHECK (backup_storage_lifecycle_status IN ('pending_configuration', 'expiry_pending', 'verified')),
  backup_storage_expiry_at TIMESTAMPTZ,
  backup_storage_evidence_reference TEXT,
  backup_storage_verified_at TIMESTAMPTZ,
  deleted_by_teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS teacher_record_deletion_evidence_organisation_created_idx
  ON teacher_record_deletion_evidence (organisation_id, created_at DESC);
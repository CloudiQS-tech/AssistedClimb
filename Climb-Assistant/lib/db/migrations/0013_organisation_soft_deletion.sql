ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by_cig_admin_id INTEGER
    REFERENCES cig_admins(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS organisations_deleted_at_idx
  ON organisations (deleted_at)
  WHERE deleted_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS organisation_deletion_shadows (
  id SERIAL PRIMARY KEY,
  organisation_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_by_cig_admin_id INTEGER REFERENCES cig_admins(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS organisation_deletion_shadows_deleted_at_idx
  ON organisation_deletion_shadows (deleted_at DESC);
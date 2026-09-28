CREATE TABLE IF NOT EXISTS cig_admin_deletion_shadows (
  id SERIAL PRIMARY KEY,
  cig_admin_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_by_cig_admin_id INTEGER REFERENCES cig_admins(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS cig_admin_deletion_shadows_deleted_at_idx
  ON cig_admin_deletion_shadows (deleted_at DESC);
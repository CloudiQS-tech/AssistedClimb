CREATE TABLE IF NOT EXISTS organisation_retention_defaults (
  id SERIAL PRIMARY KEY,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  retention_days INTEGER NOT NULL,
  review_date TIMESTAMPTZ NOT NULL,
  deletion_status TEXT NOT NULL DEFAULT 'retained',
  notes TEXT,
  updated_by_teacher_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT organisation_retention_default_org_unique UNIQUE (organisation_id)
);
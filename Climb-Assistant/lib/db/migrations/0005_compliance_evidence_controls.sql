ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS ai_data_processing_acknowledged_by_teacher_id INTEGER,
  ADD COLUMN IF NOT EXISTS ai_data_processing_policy_version TEXT,
  ADD COLUMN IF NOT EXISTS ai_data_processing_evidence_reference TEXT,
  ADD COLUMN IF NOT EXISTS ai_data_processing_region TEXT,
  ADD COLUMN IF NOT EXISTS ai_data_retention_no_training_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ai_data_processing_review_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS research_processing_blocked BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS research_governance_reference TEXT,
  ADD COLUMN IF NOT EXISTS research_governance_review_date TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS organisation_retention_policies (
  id SERIAL PRIMARY KEY,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  data_category TEXT NOT NULL,
  retention_days INTEGER NOT NULL,
  review_date TIMESTAMPTZ NOT NULL,
  deletion_status TEXT NOT NULL DEFAULT 'retained',
  notes TEXT,
  updated_by_teacher_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT organisation_retention_policy_org_category_unique UNIQUE (organisation_id, data_category)
);
ALTER TABLE organisation_retention_defaults
  ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS operator_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS operator_verified_by_teacher_id INTEGER;

ALTER TABLE organisation_retention_policies
  ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS operator_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS operator_verified_by_teacher_id INTEGER;
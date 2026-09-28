ALTER TABLE teachers
  ADD COLUMN IF NOT EXISTS account_status TEXT,
  ADD COLUMN IF NOT EXISTS account_status_changed_at TIMESTAMPTZ;

UPDATE teachers
SET account_status = 'active'
WHERE account_status IS NULL;

ALTER TABLE teachers
  ALTER COLUMN account_status SET DEFAULT 'active',
  ALTER COLUMN account_status SET NOT NULL;

ALTER TABLE teachers
  DROP CONSTRAINT IF EXISTS teachers_account_status_check;

ALTER TABLE teachers
  ADD CONSTRAINT teachers_account_status_check
  CHECK (account_status IN ('active', 'suspended', 'deleted'));

CREATE INDEX IF NOT EXISTS teachers_organisation_account_status_idx
  ON teachers (organisation_id, account_status);
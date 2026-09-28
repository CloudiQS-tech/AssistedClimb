ALTER TABLE teachers
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN,
  ADD COLUMN IF NOT EXISTS email_verification_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS email_verification_expires_at TIMESTAMPTZ;

-- Do not interrupt existing teachers during rollout. New registrations are
-- explicitly created unverified by the application.
UPDATE teachers
SET email_verified = TRUE
WHERE email_verified IS NULL;

ALTER TABLE teachers
  ALTER COLUMN email_verified SET DEFAULT FALSE,
  ALTER COLUMN email_verified SET NOT NULL;

CREATE INDEX IF NOT EXISTS teachers_email_verification_token_idx
  ON teachers (email_verification_token_hash)
  WHERE email_verification_token_hash IS NOT NULL;
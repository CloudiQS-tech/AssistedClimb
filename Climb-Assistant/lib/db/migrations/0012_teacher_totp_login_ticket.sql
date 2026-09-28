ALTER TABLE teachers
  ADD COLUMN IF NOT EXISTS pending_totp_login_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS pending_totp_login_token_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS teachers_pending_totp_login_token_idx
  ON teachers (pending_totp_login_token_hash)
  WHERE pending_totp_login_token_hash IS NOT NULL;
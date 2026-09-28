ALTER TABLE cig_admins
  ADD COLUMN IF NOT EXISTS account_link_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS account_link_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS cig_admins_account_link_token_idx
  ON cig_admins (account_link_token_hash)
  WHERE account_link_token_hash IS NOT NULL;
ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS ai_key_secret_ref text;
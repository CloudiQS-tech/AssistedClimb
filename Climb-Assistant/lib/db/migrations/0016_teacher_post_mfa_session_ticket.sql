ALTER TABLE teachers
  ADD COLUMN IF NOT EXISTS post_mfa_session_ticket_hash TEXT,
  ADD COLUMN IF NOT EXISTS post_mfa_session_ticket_expires_at TIMESTAMPTZ;
-- Adds totp_setup_token_hash and totp_setup_token_expires_at to teachers.
--
-- Defined in lib/db/src/schema/teachers.ts but never created by any migration.
-- Used in auth.ts, teacher-security.ts, and organisation-retention.ts for the
-- TOTP MFA setup flow - distinct from pending_totp_login_token_hash, which
-- migration 0012 does add correctly. Found 2026-09-23 during the same
-- column-drift sweep that found ai_school_policies_confirmed (migration 0061)
-- and school_admin_role (migration 0062) missing.
ALTER TABLE teachers
  ADD COLUMN IF NOT EXISTS totp_setup_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS totp_setup_token_expires_at TIMESTAMPTZ;

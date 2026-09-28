CREATE TABLE IF NOT EXISTS cig_admins (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'subadmin' CHECK (role IN ('master', 'subadmin')),
  totp_secret_encrypted TEXT,
  totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  recovery_failed_attempts INTEGER NOT NULL DEFAULT 0,
  recovery_locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS cig_admins_single_master_idx
  ON cig_admins (role)
  WHERE role = 'master';

CREATE TABLE IF NOT EXISTS cig_admin_recovery_codes (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES cig_admins(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cig_admin_security_events (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER REFERENCES cig_admins(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  metadata TEXT,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
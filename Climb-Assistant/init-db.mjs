// init-db.mjs — Run schema migration on startup, then start the app
import pg from 'pg';
import { execSync } from 'child_process';

const schema = `
CREATE TABLE IF NOT EXISTS organisations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  active BOOLEAN NOT NULL DEFAULT true,
  ai_provider TEXT,
  ai_key_encrypted TEXT,
  azure_endpoint TEXT,
  teacher_invite_code TEXT NOT NULL UNIQUE,
  allowed_email_domains TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS teachers (
  id SERIAL PRIMARY KEY,
  organisation_id INTEGER REFERENCES organisations(id) ON DELETE SET NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  is_it_admin BOOLEAN NOT NULL DEFAULT false,
  login_token TEXT,
  must_change_password BOOLEAN NOT NULL DEFAULT false,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  totp_secret TEXT,
  totp_enabled BOOLEAN NOT NULL DEFAULT false,
  password_reset_token TEXT,
  password_reset_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS classes (
  id SERIAL PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subject TEXT,
  code TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_insights JSON,
  last_insights_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS student_sessions (
  id SERIAL PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_name TEXT NOT NULL,
  pin_hash TEXT,
  is_blocked BOOLEAN NOT NULL DEFAULT false,
  failed_pin_attempts INTEGER NOT NULL DEFAULT 0,
  pin_locked_until TIMESTAMPTZ,
  session_nonce TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS stage_entries (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES student_sessions(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  content_json JSON NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES student_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  bloom_level TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  notes TEXT,
  bloom_levels JSON NOT NULL DEFAULT '[]',
  due_date TEXT,
  success_criteria JSON NOT NULL DEFAULT '[]',
  key_vocabulary JSON NOT NULL DEFAULT '[]',
  enabled_stages JSON NOT NULL DEFAULT '["MAP","TORCH","COMPASS","EMBED","RESEARCH"]',
  stage_instructions JSON NOT NULL DEFAULT '{}',
  expected_length TEXT,
  resources JSON NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tasks_class_id_unique UNIQUE (class_id)
);
-- Backfill columns on older tasks tables that predate the extended task fields.
-- CREATE TABLE IF NOT EXISTS above will not add columns to an existing table,
-- so we run explicit ALTERs. All are idempotent.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS success_criteria JSON NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS key_vocabulary JSON NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS enabled_stages JSON NOT NULL DEFAULT '["MAP","TORCH","COMPASS","EMBED","RESEARCH"]';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS stage_instructions JSON NOT NULL DEFAULT '{}';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS expected_length TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS resources JSON NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS teacher_feedback (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES student_sessions(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  grade TEXT,
  comment TEXT NOT NULL DEFAULT '',
  formative_comment TEXT NOT NULL DEFAULT '',
  student_acknowledged BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT teacher_feedback_session_stage_unique UNIQUE (session_id, stage)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  organisation_id INTEGER REFERENCES organisations(id) ON DELETE SET NULL,
  teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  metadata JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS "session" (
  "sid" VARCHAR NOT NULL COLLATE "default",
  "sess" JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
`;

if (process.env.DATABASE_URL) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    console.log('[init-db] Connected to database, pushing schema...');
    await client.query(schema);
    console.log('[init-db] Schema ready.');
  } catch (e) {
    console.error('[init-db] Schema push failed:', e.message);
  } finally {
    await client.end();
  }
} else {
  console.log('[init-db] No DATABASE_URL, skipping schema init');
}

// Now start the actual app
console.log('[init-db] Starting application...');
import('./dist/index.mjs');

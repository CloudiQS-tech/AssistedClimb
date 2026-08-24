/**
 * Database migration script - runs on startup to ensure tables exist AND
 * reconciles legacy tables that were created with the wrong column shape.
 *
 * All statements are idempotent so this is safe to run every deploy.
 */
import pg from 'pg';

const { Client } = pg;

// PL/pgSQL dollar-quoting delimiter — kept outside template literals
// to avoid Node.js interpreting $ as template expression start.
const D = '$$';

export async function runMigrations() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL not set, skipping migrations');
    return;
  }

  const client = new Client({
    connectionString: dbUrl,
    ssl: dbUrl.includes('sslmode=no-verify') ? { rejectUnauthorized: false } : undefined,
  });

  try {
    await client.connect();
    console.log('Running database migrations...');

    // 1. Base tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS organisations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        active BOOLEAN NOT NULL DEFAULT TRUE,
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
        is_it_admin BOOLEAN NOT NULL DEFAULT FALSE,
        login_token TEXT,
        must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
        failed_login_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TIMESTAMPTZ,
        totp_secret TEXT,
        totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
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
        is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
        failed_pin_attempts INTEGER NOT NULL DEFAULT 0,
        pin_locked_until TIMESTAMPTZ,
        session_nonce TEXT,
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
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

      CREATE TABLE IF NOT EXISTS teacher_feedback (
        id SERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES student_sessions(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        grade TEXT,
        comment TEXT NOT NULL DEFAULT '',
        formative_comment TEXT NOT NULL DEFAULT '',
        student_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    `);

    // 2. Backfill tasks columns + unique constraint
    await client.query(`
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS success_criteria JSON NOT NULL DEFAULT '[]';
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS key_vocabulary JSON NOT NULL DEFAULT '[]';
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS enabled_stages JSON NOT NULL DEFAULT '["MAP","TORCH","COMPASS","EMBED","RESEARCH"]';
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS stage_instructions JSON NOT NULL DEFAULT '{}';
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS expected_length TEXT;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS resources JSON NOT NULL DEFAULT '[]';
    `);

    await client.query(`
      DO ${D}
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'tasks_class_id_unique'
            AND conrelid = 'tasks'::regclass
        ) THEN
          DELETE FROM tasks a USING tasks b
          WHERE a.class_id = b.class_id AND a.id < b.id;
          ALTER TABLE tasks ADD CONSTRAINT tasks_class_id_unique UNIQUE (class_id);
        END IF;
      END
      ${D};
    `);

    // 3. Reconcile stage_entries
    await client.query(`
      DO ${D}
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'stage_entries' AND column_name = 'stage_key'
        ) THEN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'stage_entries' AND column_name = 'stage'
          ) THEN
            ALTER TABLE stage_entries ADD COLUMN stage TEXT;
          END IF;
          UPDATE stage_entries SET stage = stage_key WHERE stage IS NULL;
          ALTER TABLE stage_entries ALTER COLUMN stage_key DROP NOT NULL;
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'stage_entries' AND column_name = 'content'
        ) THEN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'stage_entries' AND column_name = 'content_json'
          ) THEN
            ALTER TABLE stage_entries ADD COLUMN content_json JSON NOT NULL DEFAULT '{}';
          END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'stage_entries' AND column_name = 'content'
        ) THEN
          ALTER TABLE stage_entries ALTER COLUMN content DROP NOT NULL;
          ALTER TABLE stage_entries ALTER COLUMN content DROP DEFAULT;
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'stage_entries' AND column_name = 'word_count'
        ) THEN
          ALTER TABLE stage_entries ALTER COLUMN word_count DROP NOT NULL;
          ALTER TABLE stage_entries ALTER COLUMN word_count SET DEFAULT 0;
        END IF;
      END
      ${D};
    `);

    await client.query(`
      ALTER TABLE stage_entries ADD COLUMN IF NOT EXISTS stage TEXT;
      ALTER TABLE stage_entries ADD COLUMN IF NOT EXISTS content_json JSON NOT NULL DEFAULT '{}';
      UPDATE stage_entries SET stage = 'MAP' WHERE stage IS NULL;
      ALTER TABLE stage_entries ALTER COLUMN stage SET NOT NULL;
    `);

    // 4. Reconcile chat_messages
    await client.query(`
      DO ${D}
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'chat_messages' AND column_name = 'stage_key'
        ) THEN
          ALTER TABLE chat_messages ALTER COLUMN stage_key DROP NOT NULL;
        END IF;
      END
      ${D};
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS bloom_level TEXT;
    `);

    // 5. Reconcile teacher_feedback
    await client.query(`
      DO ${D}
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'teacher_feedback' AND column_name = 'stage_key'
        ) THEN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'teacher_feedback' AND column_name = 'stage'
          ) THEN
            ALTER TABLE teacher_feedback ADD COLUMN stage TEXT;
          END IF;
          UPDATE teacher_feedback SET stage = stage_key WHERE stage IS NULL;
          ALTER TABLE teacher_feedback ALTER COLUMN stage_key DROP NOT NULL;
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'teacher_feedback' AND column_name = 'feedback'
        ) THEN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'teacher_feedback' AND column_name = 'comment'
          ) THEN
            ALTER TABLE teacher_feedback ADD COLUMN comment TEXT NOT NULL DEFAULT '';
          END IF;
          UPDATE teacher_feedback SET comment = COALESCE(feedback, '') WHERE comment = '';
          ALTER TABLE teacher_feedback ALTER COLUMN feedback DROP NOT NULL;
        END IF;
      END
      ${D};
    `);

    await client.query(`
      ALTER TABLE teacher_feedback ADD COLUMN IF NOT EXISTS stage TEXT;
      ALTER TABLE teacher_feedback ADD COLUMN IF NOT EXISTS grade TEXT;
      ALTER TABLE teacher_feedback ADD COLUMN IF NOT EXISTS comment TEXT NOT NULL DEFAULT '';
      ALTER TABLE teacher_feedback ADD COLUMN IF NOT EXISTS formative_comment TEXT NOT NULL DEFAULT '';
      ALTER TABLE teacher_feedback ADD COLUMN IF NOT EXISTS student_acknowledged BOOLEAN NOT NULL DEFAULT FALSE;
      UPDATE teacher_feedback SET stage = 'MAP' WHERE stage IS NULL;
      ALTER TABLE teacher_feedback ALTER COLUMN stage SET NOT NULL;
    `);

    await client.query(`
      DO ${D}
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'teacher_feedback_session_stage_unique'
            AND conrelid = 'teacher_feedback'::regclass
        ) THEN
          DELETE FROM teacher_feedback a USING teacher_feedback b
          WHERE a.session_id = b.session_id AND a.stage = b.stage AND a.id < b.id;
          ALTER TABLE teacher_feedback
            ADD CONSTRAINT teacher_feedback_session_stage_unique UNIQUE (session_id, stage);
        END IF;
      END
      ${D};
    `);

    // 6. Reconcile audit_log
    await client.query(`
      ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS organisation_id INTEGER;
      ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS metadata JSONB;
    `);

    await client.query(`
      DO ${D}
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'audit_log' AND column_name = 'details'
        ) THEN
          UPDATE audit_log
             SET metadata = details::jsonb
           WHERE metadata IS NULL AND details IS NOT NULL;
        END IF;
      END
      ${D};
    `);

    console.log('✅ Database migrations completed successfully!');
  } catch (err) {
    console.error('❌ Migration error:', err.message);
  } finally {
    await client.end();
  }
}

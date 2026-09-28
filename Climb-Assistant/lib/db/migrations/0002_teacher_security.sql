ALTER TABLE teachers
  ADD COLUMN IF NOT EXISTS recovery_failed_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recovery_locked_until TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS teacher_password_history (
  id SERIAL PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS teacher_recovery_codes (
  id SERIAL PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO teacher_password_history (teacher_id, password_hash)
SELECT t.id, t.password_hash
FROM teachers t
WHERE NOT EXISTS (
  SELECT 1
  FROM teacher_password_history h
  WHERE h.teacher_id = t.id
);
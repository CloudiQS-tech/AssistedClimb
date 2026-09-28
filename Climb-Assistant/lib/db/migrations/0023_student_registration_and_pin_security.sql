ALTER TABLE student_sessions
  ADD COLUMN IF NOT EXISTS pin_version INTEGER,
  ADD COLUMN IF NOT EXISTS registration_status TEXT,
  ADD COLUMN IF NOT EXISTS registration_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS registration_reviewed_by INTEGER REFERENCES teachers(id) ON DELETE SET NULL;

-- Existing sessions were created before teacher approval existed and remain
-- usable. New sessions use the pending default below.
UPDATE student_sessions
SET registration_status = 'approved'
WHERE registration_status IS NULL;

UPDATE student_sessions
SET pin_hash = NULL,
    failed_pin_attempts = 0,
    pin_locked_until = NULL
WHERE pin_hash IS NOT NULL
  AND (pin_version IS NULL OR pin_version < 2);

-- Some teacher-reset accounts intentionally have no PIN hash. They are still
-- legacy rows and must receive the new version before the column becomes
-- required, otherwise the migration would fail on those valid sessions.
UPDATE student_sessions
SET pin_version = 2
WHERE pin_version IS NULL
   OR pin_version < 2;

ALTER TABLE student_sessions
  ALTER COLUMN pin_version SET DEFAULT 2,
  ALTER COLUMN pin_version SET NOT NULL,
  ALTER COLUMN registration_status SET DEFAULT 'pending',
  ALTER COLUMN registration_status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'student_sessions_registration_status_check'
  ) THEN
    ALTER TABLE student_sessions
      ADD CONSTRAINT student_sessions_registration_status_check
      CHECK (registration_status IN ('pending', 'approved', 'rejected'));
  END IF;
END $$;
ALTER TABLE teachers
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS approval_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS approval_reviewed_by integer,
  ADD COLUMN IF NOT EXISTS approval_reason text;

UPDATE teachers
SET approval_status = 'approved'
WHERE approval_status IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'teachers_approval_status_check'
  ) THEN
    ALTER TABLE teachers
      ADD CONSTRAINT teachers_approval_status_check
      CHECK (approval_status IN ('pending', 'approved', 'rejected'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'teachers_approval_reviewed_by_fkey'
  ) THEN
    ALTER TABLE teachers
      ADD CONSTRAINT teachers_approval_reviewed_by_fkey
      FOREIGN KEY (approval_reviewed_by) REFERENCES teachers(id) ON DELETE SET NULL;
  END IF;
END $$;
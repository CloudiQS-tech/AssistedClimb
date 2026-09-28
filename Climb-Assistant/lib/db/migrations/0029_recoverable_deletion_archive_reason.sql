DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  IF to_regclass('public.recoverable_deletion_evidence') IS NULL THEN
    RETURN;
  END IF;

  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.recoverable_deletion_evidence'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%deletion_reason%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.recoverable_deletion_evidence DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;

  ALTER TABLE public.recoverable_deletion_evidence
    ADD CONSTRAINT recoverable_deletion_evidence_reason_check
    CHECK (deletion_reason IN (
      'teacher_requested',
      'departure_requested',
      'archive_retention_expired'
    ));
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'development_snapshots_snapshot_kind_check'
      AND conrelid = 'development_snapshots'::regclass
  ) THEN
    ALTER TABLE "development_snapshots"
      ADD CONSTRAINT "development_snapshots_snapshot_kind_check"
      CHECK (
        "snapshot_kind" IN (
          'climb_formative',
          'climb_summative',
          'answer_assessment_finalisation'
        )
      );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION prevent_development_snapshot_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.teacher_id IS NOT NULL
     AND NEW.teacher_id IS NULL
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.session_id IS NOT DISTINCT FROM OLD.session_id
     AND NEW.snapshot_kind IS NOT DISTINCT FROM OLD.snapshot_kind
     AND NEW.payload::jsonb IS NOT DISTINCT FROM OLD.payload::jsonb
     AND NEW.trigger_event IS NOT DISTINCT FROM OLD.trigger_event
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'development_snapshots is append-only';
END;
$$;

DROP TRIGGER IF EXISTS development_snapshots_immutable_update
  ON "development_snapshots";

CREATE TRIGGER development_snapshots_immutable_update
BEFORE UPDATE ON "development_snapshots"
FOR EACH ROW
EXECUTE FUNCTION prevent_development_snapshot_update();
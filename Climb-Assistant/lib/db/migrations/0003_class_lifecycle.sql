ALTER TABLE "classes"
  ADD COLUMN IF NOT EXISTS "archived_at" timestamptz;

ALTER TABLE "student_sessions"
  ADD COLUMN IF NOT EXISTS "locked_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "locked_by" integer REFERENCES "teachers"("id") ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION prevent_archived_class_student_join()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "classes"
    WHERE "id" = NEW."class_id" AND "archived_at" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'This class has been archived and is no longer accepting new students.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS student_join_requires_active_class ON "student_sessions";
CREATE TRIGGER student_join_requires_active_class
  BEFORE INSERT OR UPDATE OF "pin_hash", "session_nonce" ON "student_sessions"
  FOR EACH ROW
  EXECUTE FUNCTION prevent_archived_class_student_join();
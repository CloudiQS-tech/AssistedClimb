ALTER TABLE "teacher_messages"
  ADD COLUMN IF NOT EXISTS "sender_type" text;

UPDATE "teacher_messages"
SET "sender_type" = 'teacher'
WHERE "sender_type" IS NULL;

ALTER TABLE "teacher_messages"
  ALTER COLUMN "sender_type" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'teacher_messages'::regclass
      AND conname = 'teacher_messages_sender_type'
  ) THEN
    ALTER TABLE "teacher_messages"
      ADD CONSTRAINT "teacher_messages_sender_type"
      CHECK ("sender_type" IN ('teacher', 'student'));
  END IF;
END $$;

ALTER TABLE "teacher_messages"
  ADD COLUMN IF NOT EXISTS "teacher_read_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "student_read_at" timestamptz;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'teacher_messages'
      AND column_name = 'read_at'
  ) THEN
    UPDATE "teacher_messages"
    SET "student_read_at" = "read_at"
    WHERE "read_at" IS NOT NULL
      AND "student_read_at" IS NULL;
  END IF;
END $$;

ALTER TABLE "teacher_messages"
  DROP COLUMN IF EXISTS "read_at";
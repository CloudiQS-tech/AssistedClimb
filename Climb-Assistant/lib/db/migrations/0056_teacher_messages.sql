CREATE TABLE IF NOT EXISTS "teacher_messages" (
  "id" serial PRIMARY KEY NOT NULL,
  "student_session_id" integer NOT NULL REFERENCES "student_sessions"("id") ON DELETE CASCADE,
  "teacher_id" integer REFERENCES "teachers"("id") ON DELETE SET NULL,
  "content" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "read_at" timestamptz,
  CONSTRAINT "teacher_messages_content_length" CHECK (char_length("content") BETWEEN 1 AND 500)
);

ALTER TABLE "teacher_messages"
  ALTER COLUMN "teacher_id" DROP NOT NULL;
ALTER TABLE "teacher_messages"
  DROP CONSTRAINT IF EXISTS "teacher_messages_teacher_id_fkey";
ALTER TABLE "teacher_messages"
  ADD CONSTRAINT "teacher_messages_teacher_id_fkey"
  FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE SET NULL;
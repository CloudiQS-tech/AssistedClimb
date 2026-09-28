ALTER TABLE "classes"
  ADD COLUMN IF NOT EXISTS "deletion_warning_attempted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "deletion_warning_sent_at" timestamp with time zone;

ALTER TABLE "student_sessions"
  ADD COLUMN IF NOT EXISTS "deletion_warning_attempted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "deletion_warning_sent_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "classes_deletion_warning_due_idx"
  ON "classes" ("deletion_scheduled_for")
  WHERE "deletion_scheduled_for" IS NOT NULL
    AND "deletion_warning_attempted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "student_sessions_deletion_warning_due_idx"
  ON "student_sessions" ("deletion_scheduled_for")
  WHERE "deletion_scheduled_for" IS NOT NULL
    AND "deletion_warning_attempted_at" IS NULL;
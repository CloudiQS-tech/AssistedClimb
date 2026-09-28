ALTER TABLE "classes"
  ADD COLUMN IF NOT EXISTS "archive_expiry_warning_attempted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "archive_expiry_warning_sent_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "classes_archive_expiry_warning_due_idx"
  ON "classes" ("archive_expires_at")
  WHERE "archived_at" IS NOT NULL
    AND "deletion_scheduled_for" IS NULL
    AND "archive_expiry_warning_sent_at" IS NULL;
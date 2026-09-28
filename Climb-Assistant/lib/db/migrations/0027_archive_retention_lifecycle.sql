ALTER TABLE "organisation_retention_defaults"
  ADD COLUMN IF NOT EXISTS "archive_retention_days" integer NOT NULL DEFAULT 365,
  ADD COLUMN IF NOT EXISTS "deletion_recovery_days" integer NOT NULL DEFAULT 30;

UPDATE "organisation_retention_defaults"
SET "archive_retention_days" = "retention_days"
WHERE "archive_retention_days" = 365 AND "retention_days" <> 365;

ALTER TABLE "organisations"
  ADD COLUMN IF NOT EXISTS "deletion_legal_hold" boolean NOT NULL DEFAULT false;

ALTER TABLE "classes"
  ADD COLUMN IF NOT EXISTS "archive_expires_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "archive_lifecycle_status" text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "archive_legal_hold" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "archive_expiry_notified_at" timestamp with time zone;

ALTER TABLE "student_sessions"
  ADD COLUMN IF NOT EXISTS "archive_expires_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "archive_lifecycle_status" text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "archive_expiry_notified_at" timestamp with time zone;

UPDATE "classes"
SET
  "archive_lifecycle_status" = CASE
    WHEN "deletion_scheduled_for" IS NOT NULL THEN 'pending_deletion'
    WHEN "archived_at" IS NOT NULL THEN 'archived'
    ELSE 'active'
  END;

UPDATE "student_sessions"
SET
  "archive_lifecycle_status" = CASE
    WHEN "deletion_scheduled_for" IS NOT NULL THEN 'pending_deletion'
    WHEN "archived_at" IS NOT NULL THEN 'archived'
    ELSE 'active'
  END;

INSERT INTO "platform_settings" ("key", "value")
VALUES
  ('archive_retention_days', '30'),
  ('deletion_recovery_days', '30'),
  ('archive_retention_min_days', '1'),
  ('archive_retention_max_days', '3650'),
  ('archive_retention_choices', '[30,60,90,180,365]')
ON CONFLICT ("key") DO NOTHING;

-- NOTE: originally these constraints restricted archive_retention_days and
-- deletion_recovery_days to exactly the five UI preset values (30/60/90/180/365).
-- That contradicts the application's own validation in
-- artifacts/api-server/src/routes/teacher/index.ts (PUT /teacher/org/retention-policy/default),
-- which accepts any value between platform-configured minimumDays/maximumDays
-- (seeded above as 1 and 3650). Any teacher submitting an app-valid value outside
-- the five presets (e.g. 45 or 120) would pass application validation and then
-- fail on this constraint. Widened to match the application's actual accepted
-- range instead. The five values above remain the UI's suggested presets
-- (RETENTION_DAY_OPTIONS / archive_retention_choices) but are no longer enforced
-- as the only allowed values at the database level.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organisation_archive_retention_days_allowed') THEN
    ALTER TABLE "organisation_retention_defaults"
      ADD CONSTRAINT "organisation_archive_retention_days_allowed"
      CHECK ("archive_retention_days" BETWEEN 1 AND 3650);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organisation_deletion_recovery_days_allowed') THEN
    ALTER TABLE "organisation_retention_defaults"
      ADD CONSTRAINT "organisation_deletion_recovery_days_allowed"
      CHECK ("deletion_recovery_days" BETWEEN 1 AND 3650);
  END IF;
END $$;
-- Creates the platform_settings key/value table.
--
-- This table is required by migration 0027_archive_retention_lifecycle.sql (which
-- inserts default archive/retention settings into it) and is defined in
-- lib/db/src/schema/platformSettings.ts, but no migration in the original Sep 2026
-- security/privacy update package actually created it. Verified against the live
-- production database on 2026-09-22 (SELECT to_regclass('platform_settings') returned
-- NULL) before adding this. Numbered 0000 so it runs before every other migration,
-- since 0001-0026 are already taken and this must run before 0027.
CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Adds the school_admin_role column to teachers.
--
-- Defined in lib/db/src/schema/teachers.ts (schoolAdminRole, enum "master"|"subadmin")
-- but never created by any migration. This column gates subadmin permissions
-- throughout the app (auth.ts, admin.ts, teacher/index.ts, teacher-security.ts,
-- recoverable-deletion.ts, organisation-retention.ts, archive-retention.ts, and
-- the frontend teacher dashboard/settings/archive pages). Found 2026-09-23
-- during the same column-drift sweep that found ai_school_policies_confirmed
-- (migration 0061) missing from organisations.
ALTER TABLE teachers
  ADD COLUMN IF NOT EXISTS school_admin_role TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'teachers_school_admin_role_check'
  ) THEN
    ALTER TABLE teachers
      ADD CONSTRAINT teachers_school_admin_role_check
      CHECK (school_admin_role IS NULL OR school_admin_role IN ('master', 'subadmin'));
  END IF;
END $$;

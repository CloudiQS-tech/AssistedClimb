-- Adds the ai_school_policies_confirmed column to organisations.
--
-- This column is defined in lib/db/src/schema/organisations.ts but was never
-- actually added by any migration. Migration 0005_compliance_evidence_controls.sql
-- adds every other AI-data-processing/research-governance column from that
-- schema file in one ALTER TABLE statement, but omits this one specific column.
-- Discovered 2026-09-23 in production: GET /api/admin/organisations failed with
-- `column "ai_school_policies_confirmed" does not exist` the first time a CIG
-- admin tried to load the platform-admin dashboard after bootstrap. 0005 has
-- already run in production, so this is added as a new migration rather than
-- editing 0005 (which would create a mismatch with what already executed).
ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS ai_school_policies_confirmed BOOLEAN NOT NULL DEFAULT FALSE;

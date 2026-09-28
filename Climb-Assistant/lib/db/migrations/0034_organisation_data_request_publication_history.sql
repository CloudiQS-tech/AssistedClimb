CREATE TABLE IF NOT EXISTS "organisation_data_request_publications" (
  "id" serial PRIMARY KEY,
  "organisation_id" integer NOT NULL REFERENCES "organisations"("id") ON DELETE CASCADE,
  "procedure_id" integer NOT NULL REFERENCES "organisation_data_request_procedures"("id") ON DELETE CASCADE,
  "procedure_version" text NOT NULL,
  "snapshot" jsonb NOT NULL,
  "published_by_teacher_id" integer REFERENCES "teachers"("id") ON DELETE SET NULL,
  "published_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "organisation_data_request_publications_org_published_idx"
  ON "organisation_data_request_publications" ("organisation_id", "published_at");
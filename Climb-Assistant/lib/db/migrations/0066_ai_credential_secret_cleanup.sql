CREATE TABLE IF NOT EXISTS ai_credential_secret_cleanup (
  id serial PRIMARY KEY,
  organisation_id integer NOT NULL,
  secret_ref text NOT NULL CHECK (secret_ref ~ '^[a-f0-9]{32}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT ai_credential_secret_cleanup_unique_ref UNIQUE (organisation_id, secret_ref)
);

CREATE INDEX IF NOT EXISTS ai_credential_secret_cleanup_pending_idx
  ON ai_credential_secret_cleanup (completed_at, next_attempt_at);
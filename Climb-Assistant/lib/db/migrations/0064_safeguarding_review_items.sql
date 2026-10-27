ALTER TABLE teachers
  ADD COLUMN IF NOT EXISTS can_review_safeguarding boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS safeguarding_review_items (
  id serial PRIMARY KEY,
  organisation_id integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  class_id integer NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_session_id integer NOT NULL REFERENCES student_sessions(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('student_ai', 'climb')),
  source_submission_id text NOT NULL,
  stage text,
  dedupe_key text NOT NULL,
  category text NOT NULL CHECK (category IN (
    'self_harm_or_suicide',
    'harm_by_another_person',
    'sexual_abuse_or_exploitation',
    'serious_violence_or_threat',
    'grooming_coercion_or_blackmail',
    'immediate_danger',
    'other_serious_concern',
    'provider_safety_signal'
  )),
  technical_reason text NOT NULL,
  excerpt text NOT NULL,
  surrounding_context text NOT NULL DEFAULT '',
  detected_by text NOT NULL CHECK (detected_by IN ('local', 'provider', 'both')),
  provider_signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'under_review', 'closed')),
  reviewer_id integer REFERENCES teachers(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  action_taken text,
  decision text,
  rationale text,
  outcome text,
  external_reference text,
  notification_status text NOT NULL DEFAULT 'pending' CHECK (
    notification_status IN ('pending', 'sent', 'partial', 'failed', 'ambiguous', 'not_configured', 'no_reviewer')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS safeguarding_review_items_session_dedupe_uq
  ON safeguarding_review_items (student_session_id, dedupe_key);
CREATE INDEX IF NOT EXISTS safeguarding_review_items_org_status_created_idx
  ON safeguarding_review_items (organisation_id, status, created_at);
CREATE INDEX IF NOT EXISTS safeguarding_review_items_class_created_idx
  ON safeguarding_review_items (class_id, created_at);
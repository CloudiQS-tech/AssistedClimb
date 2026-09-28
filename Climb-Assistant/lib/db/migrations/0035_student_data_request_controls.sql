CREATE TABLE IF NOT EXISTS student_data_request_controls (
  id SERIAL PRIMARY KEY,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  request_id INTEGER REFERENCES student_data_requests(id) ON DELETE SET NULL,
  accountable_owner_teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
  affected_student_session_id INTEGER,
  affected_class_id INTEGER,
  affected_data_categories TEXT[] NOT NULL CHECK (cardinality(affected_data_categories) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('restriction', 'legal_hold', 'safeguarding_hold')),
  reason_category TEXT NOT NULL CHECK (reason_category IN (
    'accuracy_dispute', 'objection', 'legal_claim', 'complaint',
    'investigation', 'safeguarding', 'retention_duty', 'other'
  )),
  reason_summary TEXT NOT NULL CHECK (char_length(reason_summary) BETWEEN 3 AND 500),
  access_limits TEXT[] NOT NULL,
  processing_limits TEXT[] NOT NULL,
  start_date TIMESTAMPTZ NOT NULL,
  review_date TIMESTAMPTZ NOT NULL,
  expiry_date TIMESTAMPTZ,
  lifecycle_state TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_state IN ('active', 'expired', 'lifted')),
  last_reviewed_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (review_date >= start_date),
  CHECK (expiry_date IS NULL OR expiry_date >= review_date)
);

CREATE INDEX IF NOT EXISTS student_data_request_controls_org_state_idx
  ON student_data_request_controls (organisation_id, lifecycle_state);
CREATE INDEX IF NOT EXISTS student_data_request_controls_student_idx
  ON student_data_request_controls (organisation_id, affected_student_session_id);
CREATE INDEX IF NOT EXISTS student_data_request_controls_request_idx
  ON student_data_request_controls (organisation_id, request_id);

CREATE TABLE IF NOT EXISTS student_data_request_control_events (
  id SERIAL PRIMARY KEY,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  control_id INTEGER NOT NULL REFERENCES student_data_request_controls(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('applied', 'reviewed', 'expired', 'lifted')),
  note TEXT NOT NULL CHECK (char_length(note) BETWEEN 3 AND 1000),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'expired', 'lifted')),
  actor_teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS student_data_request_control_events_control_idx
  ON student_data_request_control_events (control_id, occurred_at);
CREATE INDEX IF NOT EXISTS student_data_request_control_events_org_idx
  ON student_data_request_control_events (organisation_id, occurred_at);

CREATE OR REPLACE FUNCTION prevent_student_data_request_control_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (
       SELECT 1 FROM organisations WHERE id = OLD.organisation_id
     ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'student data request control events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS student_data_request_control_events_immutable
  ON student_data_request_control_events;
CREATE TRIGGER student_data_request_control_events_immutable
  BEFORE UPDATE OR DELETE ON student_data_request_control_events
  FOR EACH ROW EXECUTE FUNCTION prevent_student_data_request_control_event_mutation();
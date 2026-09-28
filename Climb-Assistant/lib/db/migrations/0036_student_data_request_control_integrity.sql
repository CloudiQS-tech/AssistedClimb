DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute att
      ON att.attrelid = con.conrelid
     AND att.attnum = ANY (con.conkey)
    WHERE con.contype = 'f'
      AND (
        (con.conrelid = 'student_data_request_controls'::regclass
          AND att.attname IN ('request_id', 'accountable_owner_teacher_id'))
        OR
        (con.conrelid = 'student_data_request_control_events'::regclass
          AND att.attname = 'actor_teacher_id')
      )
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = constraint_name
        AND conrelid IN (
          'student_data_request_controls'::regclass,
          'student_data_request_control_events'::regclass
        )
    ) THEN
      IF constraint_name IN (
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'student_data_request_controls'::regclass
      ) THEN
        EXECUTE format('ALTER TABLE student_data_request_controls DROP CONSTRAINT %I', constraint_name);
      ELSE
        EXECUTE format('ALTER TABLE student_data_request_control_events DROP CONSTRAINT %I', constraint_name);
      END IF;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_student_data_request_control_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    OLD.organisation_id IS DISTINCT FROM NEW.organisation_id OR
    OLD.request_id IS DISTINCT FROM NEW.request_id OR
    OLD.accountable_owner_teacher_id IS DISTINCT FROM NEW.accountable_owner_teacher_id OR
    OLD.affected_student_session_id IS DISTINCT FROM NEW.affected_student_session_id OR
    OLD.affected_class_id IS DISTINCT FROM NEW.affected_class_id OR
    OLD.affected_data_categories IS DISTINCT FROM NEW.affected_data_categories OR
    OLD.kind IS DISTINCT FROM NEW.kind OR
    OLD.reason_category IS DISTINCT FROM NEW.reason_category OR
    OLD.reason_summary IS DISTINCT FROM NEW.reason_summary OR
    OLD.access_limits IS DISTINCT FROM NEW.access_limits OR
    OLD.processing_limits IS DISTINCT FROM NEW.processing_limits OR
    OLD.start_date IS DISTINCT FROM NEW.start_date OR
    OLD.review_date IS DISTINCT FROM NEW.review_date OR
    OLD.expiry_date IS DISTINCT FROM NEW.expiry_date OR
    OLD.created_at IS DISTINCT FROM NEW.created_at
  ) THEN
    RAISE EXCEPTION 'student data request control evidence is immutable';
  END IF;

  IF NEW.request_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM student_data_requests r
    WHERE r.id = NEW.request_id AND r.organisation_id = NEW.organisation_id
  ) THEN
    RAISE EXCEPTION 'request control must reference a request in the same organisation';
  END IF;
  IF NEW.accountable_owner_teacher_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM teachers t
    WHERE t.id = NEW.accountable_owner_teacher_id AND t.organisation_id = NEW.organisation_id
  ) THEN
    RAISE EXCEPTION 'request control owner must belong to the same organisation';
  END IF;
  IF NEW.affected_student_session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM student_sessions s
    JOIN classes c ON c.id = s.class_id
    JOIN teachers t ON t.id = c.teacher_id
    WHERE s.id = NEW.affected_student_session_id
      AND t.organisation_id = NEW.organisation_id
  ) THEN
    RAISE EXCEPTION 'request control student must belong to the same organisation';
  END IF;
  IF NEW.affected_class_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM classes c
    JOIN teachers t ON t.id = c.teacher_id
    WHERE c.id = NEW.affected_class_id
      AND t.organisation_id = NEW.organisation_id
  ) THEN
    RAISE EXCEPTION 'request control class must belong to the same organisation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.lifecycle_state <> 'active' THEN
      RAISE EXCEPTION 'terminal request controls cannot be changed';
    END IF;
    IF NEW.lifecycle_state NOT IN ('active', 'expired', 'lifted') THEN
      RAISE EXCEPTION 'invalid request control transition';
    END IF;
    IF NEW.lifecycle_state IN ('expired', 'lifted') AND NEW.ended_at IS NULL THEN
      RAISE EXCEPTION 'ended request controls require an end timestamp';
    END IF;
    IF NEW.lifecycle_state = 'active' AND (
      NEW.ended_at IS NOT NULL
      OR NEW.last_reviewed_at IS DISTINCT FROM NEW.updated_at
      OR NOT EXISTS (
        SELECT 1 FROM student_data_request_control_events e
        WHERE e.control_id = NEW.id
          AND e.organisation_id = NEW.organisation_id
          AND e.event_type = 'reviewed'
          AND e.lifecycle_state = 'active'
          AND e.occurred_at = NEW.updated_at
      )
    ) THEN
      RAISE EXCEPTION 'active control updates require matching review evidence';
    END IF;
    IF NEW.lifecycle_state IN ('expired', 'lifted') AND (
      NEW.ended_at IS DISTINCT FROM NEW.updated_at
      OR NEW.last_reviewed_at IS DISTINCT FROM OLD.last_reviewed_at
      OR NOT EXISTS (
        SELECT 1 FROM student_data_request_control_events e
        WHERE e.control_id = NEW.id
          AND e.organisation_id = NEW.organisation_id
          AND e.event_type = NEW.lifecycle_state
          AND e.lifecycle_state = NEW.lifecycle_state
          AND e.occurred_at = NEW.updated_at
      )
    ) THEN
      RAISE EXCEPTION 'terminal control updates require matching lifecycle evidence';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS student_data_request_controls_integrity
  ON student_data_request_controls;
CREATE TRIGGER student_data_request_controls_integrity
  BEFORE INSERT OR UPDATE ON student_data_request_controls
  FOR EACH ROW EXECUTE FUNCTION enforce_student_data_request_control_integrity();

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT con.conname INTO constraint_name
  FROM pg_constraint con
  JOIN pg_attribute att
    ON att.attrelid = con.conrelid
   AND att.attnum = ANY (con.conkey)
  WHERE con.contype = 'f'
    AND con.conrelid = 'student_data_request_control_events'::regclass
    AND att.attname = 'control_id'
  LIMIT 1;
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE student_data_request_control_events DROP CONSTRAINT %I', constraint_name);
  END IF;
END;
$$;

ALTER TABLE student_data_request_control_events
  ADD CONSTRAINT student_data_request_control_events_control_fk
  FOREIGN KEY (control_id) REFERENCES student_data_request_controls(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION prevent_student_data_request_control_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('app.organisation_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'student data request control events are append-only';
END;
$$;

ALTER TABLE student_data_request_controls
  DROP CONSTRAINT IF EXISTS student_data_request_controls_access_limits_check;
ALTER TABLE student_data_request_controls
  ADD CONSTRAINT student_data_request_controls_access_limits_check
  CHECK (access_limits <@ ARRAY['export']::TEXT[]);
ALTER TABLE student_data_request_controls
  DROP CONSTRAINT IF EXISTS student_data_request_controls_processing_limits_check;
ALTER TABLE student_data_request_controls
  ADD CONSTRAINT student_data_request_controls_processing_limits_check
  CHECK (processing_limits <@ ARRAY['deletion', 'export']::TEXT[]);

ALTER TABLE student_data_request_controls
  DROP CONSTRAINT IF EXISTS student_data_request_controls_reason_summary_check;
ALTER TABLE student_data_request_controls
  ADD CONSTRAINT student_data_request_controls_reason_summary_check
  CHECK (
    char_length(reason_summary) BETWEEN 3 AND 160
    AND reason_summary !~ E'[\\r\\n]'
  );

ALTER TABLE student_data_request_control_events
  DROP CONSTRAINT IF EXISTS student_data_request_control_events_note_check;
ALTER TABLE student_data_request_control_events
  ADD CONSTRAINT student_data_request_control_events_note_check
  CHECK (
    char_length(note) BETWEEN 3 AND 240
    AND note !~ E'[\\r\\n]'
  );
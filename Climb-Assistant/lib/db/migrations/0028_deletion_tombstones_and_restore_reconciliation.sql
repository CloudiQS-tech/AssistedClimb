CREATE TABLE IF NOT EXISTS deletion_tombstones (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN (
    'organisation', 'teacher', 'class', 'student_record',
    'stage_entry', 'chat_message', 'teacher_feedback', 'student_activity',
    'security_audit', 'student_identity', 'teacher_identity'
  )),
  entity_id INTEGER NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT deletion_tombstones_entity_unique UNIQUE (entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS deletion_tombstones_deleted_at_idx
  ON deletion_tombstones (deleted_at);
ALTER TABLE deletion_tombstones
  DROP CONSTRAINT IF EXISTS deletion_tombstones_entity_type_check;
ALTER TABLE deletion_tombstones
  ADD CONSTRAINT deletion_tombstones_entity_type_check CHECK (entity_type IN (
    'organisation', 'teacher', 'class', 'student_record',
    'stage_entry', 'chat_message', 'teacher_feedback', 'student_activity',
    'security_audit', 'student_identity', 'teacher_identity'
  ));

CREATE TABLE IF NOT EXISTS restoration_control (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL CHECK (state IN ('ready', 'quarantined', 'reconciling', 'failed')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_completed_run_id UUID,
  release_fence_id TEXT
);
INSERT INTO restoration_control (id, state)
VALUES (1, 'ready')
ON CONFLICT (id) DO NOTHING;
ALTER TABLE restoration_control ADD COLUMN IF NOT EXISTS release_fence_id TEXT;

CREATE TABLE IF NOT EXISTS restoration_reconciliation_runs (
  id UUID PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  tombstones_checked INTEGER NOT NULL DEFAULT 0 CHECK (tombstones_checked >= 0),
  records_redeleted JSONB,
  failure_code TEXT
);
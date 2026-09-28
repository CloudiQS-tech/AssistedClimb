CREATE TABLE IF NOT EXISTS task_templates (
  id SERIAL PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  organisation_id INTEGER REFERENCES organisations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  question TEXT NOT NULL DEFAULT '',
  notes TEXT,
  bloom_levels JSON NOT NULL DEFAULT '[]'::json,
  due_date TEXT,
  success_criteria JSON NOT NULL DEFAULT '[]'::json,
  key_vocabulary JSON NOT NULL DEFAULT '[]'::json,
  enabled_stages JSON NOT NULL DEFAULT '["MAP","TORCH","COMPASS","EMBED","RESEARCH"]'::json,
  stage_instructions JSON NOT NULL DEFAULT '{}'::json,
  expected_length TEXT,
  resources JSON NOT NULL DEFAULT '[]'::json,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT task_templates_status_check CHECK (status IN ('draft', 'ready'))
);

CREATE INDEX IF NOT EXISTS task_templates_teacher_id_idx ON task_templates(teacher_id);
CREATE INDEX IF NOT EXISTS task_templates_organisation_id_idx ON task_templates(organisation_id);
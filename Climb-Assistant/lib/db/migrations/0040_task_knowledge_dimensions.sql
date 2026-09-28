ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS knowledge_dimensions JSON NOT NULL DEFAULT '[]'::json;

ALTER TABLE task_templates
  ADD COLUMN IF NOT EXISTS knowledge_dimensions JSON NOT NULL DEFAULT '[]'::json;
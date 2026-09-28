ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS learning_framework TEXT;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS year_group TEXT;

UPDATE tasks
SET learning_framework = CASE
  WHEN json_array_length(COALESCE(knowledge_dimensions, '[]'::json)) > 0
    AND json_array_length(COALESCE(bloom_levels, '[]'::json)) = 0
    THEN 'knowledge_dimensions'
  ELSE 'bloom'
END
WHERE learning_framework IS NULL;

ALTER TABLE tasks
  ALTER COLUMN learning_framework SET DEFAULT 'bloom',
  ALTER COLUMN learning_framework SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE tasks
    ADD CONSTRAINT tasks_learning_framework_check
    CHECK (learning_framework IN ('bloom', 'knowledge_dimensions'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE task_templates
  ADD COLUMN IF NOT EXISTS learning_framework TEXT;

ALTER TABLE task_templates
  ADD COLUMN IF NOT EXISTS year_group TEXT;

UPDATE task_templates
SET learning_framework = CASE
  WHEN json_array_length(COALESCE(knowledge_dimensions, '[]'::json)) > 0
    AND json_array_length(COALESCE(bloom_levels, '[]'::json)) = 0
    THEN 'knowledge_dimensions'
  ELSE 'bloom'
END
WHERE learning_framework IS NULL;

ALTER TABLE task_templates
  ALTER COLUMN learning_framework SET DEFAULT 'bloom',
  ALTER COLUMN learning_framework SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE task_templates
    ADD CONSTRAINT task_templates_learning_framework_check
    CHECK (learning_framework IN ('bloom', 'knowledge_dimensions'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
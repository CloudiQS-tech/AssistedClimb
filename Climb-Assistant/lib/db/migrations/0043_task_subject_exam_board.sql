ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS subject text,
  ADD COLUMN IF NOT EXISTS exam_board text;

ALTER TABLE task_templates
  ADD COLUMN IF NOT EXISTS subject text,
  ADD COLUMN IF NOT EXISTS exam_board text;
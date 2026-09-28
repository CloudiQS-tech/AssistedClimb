ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS ai_data_processing_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ai_data_processing_acknowledged_at TIMESTAMPTZ;
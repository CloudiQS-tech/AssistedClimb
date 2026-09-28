ALTER TABLE "student_sessions" ADD COLUMN IF NOT EXISTS "research_id" text;

CREATE TABLE IF NOT EXISTS "thinking_choice_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "organisation_id" integer NOT NULL,
  "class_id" integer NOT NULL REFERENCES "classes"("id") ON DELETE CASCADE,
  "session_id" integer NOT NULL REFERENCES "student_sessions"("id") ON DELETE CASCADE,
  "research_id" text NOT NULL,
  "option_name" text NOT NULL,
  "question_id" text,
  "event_type" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "stage" text NOT NULL DEFAULT 'TORCH',
  "conversation_turn" integer NOT NULL DEFAULT 0,
  "after_formative_feedback" boolean NOT NULL DEFAULT false,
  "first_use_order" integer,
  "idempotency_key" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "thinking_choice_events_idempotency_key_idx"
  ON "thinking_choice_events" ("session_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "thinking_choice_events_session_time_idx"
  ON "thinking_choice_events" ("session_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "thinking_choice_events_class_time_idx"
  ON "thinking_choice_events" ("class_id", "occurred_at");
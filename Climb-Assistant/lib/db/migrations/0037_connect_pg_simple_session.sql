CREATE TABLE IF NOT EXISTS public."session" (
  "sid" VARCHAR NOT NULL COLLATE "default",
  "sess" JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.session'::regclass
       AND contype = 'p'
  ) THEN
    ALTER TABLE public."session"
      ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid");
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS "IDX_session_expire"
  ON public."session" ("expire");
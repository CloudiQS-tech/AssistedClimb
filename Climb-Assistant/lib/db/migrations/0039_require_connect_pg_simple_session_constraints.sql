DO $$
DECLARE
  primary_key_definition TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO primary_key_definition
    FROM pg_constraint
   WHERE conrelid = 'session'::regclass
     AND contype = 'p';

  IF primary_key_definition IS DISTINCT FROM 'PRIMARY KEY (sid)' THEN
    RAISE EXCEPTION
      'existing session table primary key must target sid, found %',
      COALESCE(primary_key_definition, 'none');
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_index index_definition
     WHERE index_definition.indexrelid = 'public."IDX_session_expire"'::regclass
       AND index_definition.indrelid = 'public.session'::regclass
       AND index_definition.indisvalid
       AND index_definition.indisready
       AND NOT index_definition.indisunique
       AND index_definition.indpred IS NULL
       AND index_definition.indexprs IS NULL
       AND index_definition.indnkeyatts = 1
       AND (
         SELECT attribute.attname
           FROM pg_attribute attribute
          WHERE attribute.attrelid = index_definition.indrelid
            AND attribute.attnum = index_definition.indkey[0]
       ) = 'expire'
  ) THEN
    RAISE EXCEPTION
      'existing IDX_session_expire index must be a valid non-unique index on session.expire';
  END IF;
END;
$$;
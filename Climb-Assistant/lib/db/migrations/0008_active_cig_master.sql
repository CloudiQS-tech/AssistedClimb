-- Repair installations that ran the original role migration before it
-- required an active Master administrator.
UPDATE cig_admins
SET role = 'subadmin'
WHERE role = 'master'
  AND active = FALSE
  AND EXISTS (
    SELECT 1
    FROM cig_admins
    WHERE role = 'subadmin'
      AND active = TRUE
  );

UPDATE cig_admins
SET role = 'master'
WHERE id = (
  SELECT id
  FROM cig_admins
  WHERE role = 'subadmin'
    AND active = TRUE
  ORDER BY created_at ASC, id ASC
  LIMIT 1
)
AND NOT EXISTS (
  SELECT 1
  FROM cig_admins
  WHERE role = 'master'
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cig_admins)
    AND NOT EXISTS (
      SELECT 1
      FROM cig_admins
      WHERE role = 'master'
        AND active = TRUE
    ) THEN
    RAISE EXCEPTION 'Cannot assign the CIG Master role because no active CIG administrator is available.';
  END IF;
END $$;
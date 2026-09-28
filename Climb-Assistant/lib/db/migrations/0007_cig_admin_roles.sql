ALTER TABLE cig_admins
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'subadmin';

ALTER TABLE cig_admins
  DROP CONSTRAINT IF EXISTS cig_admins_role_check;

ALTER TABLE cig_admins
  ADD CONSTRAINT cig_admins_role_check
  CHECK (role IN ('master', 'subadmin'));

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

CREATE UNIQUE INDEX IF NOT EXISTS cig_admins_single_master_idx
  ON cig_admins (role)
  WHERE role = 'master';
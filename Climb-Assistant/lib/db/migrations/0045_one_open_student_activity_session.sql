WITH ranked_open_activity AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY student_session_id
      ORDER BY last_seen_at DESC, id DESC
    ) AS open_rank
  FROM student_activity_sessions
  WHERE ended_at IS NULL
)
UPDATE student_activity_sessions AS activity
SET
  ended_at = activity.last_seen_at,
  end_reason = COALESCE(activity.end_reason, 'superseded')
FROM ranked_open_activity AS ranked
WHERE activity.id = ranked.id
  AND ranked.open_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS student_activity_sessions_one_open_per_student_idx
  ON student_activity_sessions(student_session_id)
  WHERE ended_at IS NULL;
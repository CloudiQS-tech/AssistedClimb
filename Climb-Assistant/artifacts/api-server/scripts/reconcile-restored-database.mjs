import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import pg from "pg";

const { Pool } = pg;
const command = process.argv[2];
const filePath = process.argv[3];

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!["status", "quarantine", "export-ledger", "import-ledger", "reconcile"].includes(command)) {
  throw new Error("Usage: reconcile-restored-database.mjs status|quarantine|export-ledger <file>|import-ledger <file>|reconcile");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const fenceId = process.env.RESTORATION_FENCE_ID?.trim();
const ledgerHmacKey = process.env.RESTORATION_LEDGER_HMAC_KEY;

function requireFence() {
  if (!fenceId) throw new Error("RESTORATION_FENCE_ID is required and must be rotated before every restore");
  return fenceId;
}

function requireLedgerKey() {
  if (!ledgerHmacKey) throw new Error("RESTORATION_LEDGER_HMAC_KEY is required");
  return ledgerHmacKey;
}

function canonicalLedger(fence, tombstones) {
  return JSON.stringify({
    format: "assisted-climb-deletion-ledger-v1",
    fenceId: fence,
    tombstones: [...tombstones].sort((a, b) =>
      a.entity_type.localeCompare(b.entity_type) || a.entity_id - b.entity_id),
  });
}

function signLedger(fence, tombstones) {
  return createHmac("sha256", requireLedgerKey()).update(canonicalLedger(fence, tombstones)).digest("hex");
}

async function requireSchema(client) {
  const result = await client.query(
    `SELECT to_regclass('public.deletion_tombstones') AS tombstones,
            to_regclass('public.restoration_control') AS control,
            to_regclass('public.restoration_reconciliation_runs') AS runs`,
  );
  if (!result.rows[0]?.tombstones || !result.rows[0]?.control || !result.rows[0]?.runs) {
    throw new Error("Restoration safeguard schema is missing; apply migration 0028 before continuing");
  }
}

async function status() {
  const expectedFence = requireFence();
  const result = await pool.query(
    `SELECT state, updated_at, last_completed_run_id,
            release_fence_id = $1 AS fence_matches
     FROM restoration_control WHERE id = 1`,
    [expectedFence],
  );
  console.log(JSON.stringify(result.rows[0] ?? { state: "unavailable" }));
}

async function quarantine() {
  requireFence();
  await pool.query(
    `INSERT INTO restoration_control (id, state, updated_at)
     VALUES (1, 'quarantined', NOW())
     ON CONFLICT (id) DO UPDATE SET state = 'quarantined', updated_at = NOW(),
       release_fence_id = NULL`,
  );
  console.log(JSON.stringify({ state: "quarantined" }));
}

async function exportLedger() {
  if (!filePath) throw new Error("export-ledger requires an output file path");
  const exportFence = requireFence();
  const control = await pool.query(`SELECT state FROM restoration_control WHERE id = 1`);
  if (control.rows[0]?.state !== "quarantined") {
    throw new Error("Database must be quarantined before exporting the authoritative ledger");
  }
  const result = await pool.query(
    `SELECT entity_type, entity_id, deleted_at
     FROM deletion_tombstones
     ORDER BY entity_type, entity_id`,
  );
  const tombstones = result.rows;
  await writeFile(filePath, `${JSON.stringify({
    format: "assisted-climb-deletion-ledger-v1",
    fenceId: exportFence,
    exportedAt: new Date().toISOString(),
    tombstoneCount: tombstones.length,
    tombstones,
    hmacSha256: signLedger(exportFence, tombstones),
  }, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ exported: result.rowCount, filePath }));
}

async function importLedger() {
  if (!filePath) throw new Error("import-ledger requires an input file path");
  const document = JSON.parse(await readFile(filePath, "utf8"));
  const importFence = requireFence();
  if (document?.format !== "assisted-climb-deletion-ledger-v1" || !Array.isArray(document.tombstones)) {
    throw new Error("Unsupported deletion-ledger document");
  }
  if (document.fenceId !== importFence || document.tombstoneCount !== document.tombstones.length) {
    throw new Error("Deletion ledger lineage or count does not match this restoration fence");
  }
  const expectedSignature = Buffer.from(signLedger(document.fenceId, document.tombstones), "hex");
  const suppliedSignature = Buffer.from(String(document.hmacSha256 ?? ""), "hex");
  if (expectedSignature.length !== suppliedSignature.length || !timingSafeEqual(expectedSignature, suppliedSignature)) {
    throw new Error("Deletion ledger integrity verification failed");
  }
  const allowedTypes = new Set([
    "organisation", "teacher", "class", "student_record",
    "stage_entry", "chat_message", "teacher_feedback", "student_activity",
    "security_audit", "student_identity", "teacher_identity",
  ]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await requireSchema(client);
    await client.query(
      `INSERT INTO restoration_control (id, state, updated_at)
       VALUES (1, 'quarantined', NOW())
       ON CONFLICT (id) DO UPDATE SET state = 'quarantined', updated_at = NOW()`,
    );
    for (const item of document.tombstones) {
      if (!allowedTypes.has(item?.entity_type) || !Number.isInteger(item?.entity_id) || item.entity_id <= 0) {
        throw new Error("Deletion ledger contains an invalid tombstone");
      }
      const deletedAt = new Date(item.deleted_at);
      if (Number.isNaN(deletedAt.getTime())) throw new Error("Deletion ledger contains an invalid timestamp");
      await client.query(
        `INSERT INTO deletion_tombstones (entity_type, entity_id, deleted_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (entity_type, entity_id) DO NOTHING`,
        [item.entity_type, item.entity_id, deletedAt],
      );
    }
    await client.query("COMMIT");
    console.log(JSON.stringify({ imported: document.tombstones.length, state: "quarantined" }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function reconcile() {
  const releaseFence = requireFence();
  const runId = randomUUID();
  const startedAt = new Date();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await requireSchema(client);
    const control = await client.query(`SELECT state FROM restoration_control WHERE id = 1 FOR UPDATE`);
    if (!["quarantined", "failed"].includes(control.rows[0]?.state)) {
      throw new Error("Database must be quarantined before reconciliation");
    }
    await client.query(`UPDATE restoration_control SET state = 'reconciling', updated_at = NOW() WHERE id = 1`);
    await client.query(
      `INSERT INTO restoration_reconciliation_runs (id, started_at, status)
       VALUES ($1, $2, 'running')`,
      [runId, startedAt],
    );
    const tombstoneCount = Number((await client.query(`SELECT count(*)::int AS count FROM deletion_tombstones`)).rows[0].count);
    const deleted = {};
    for (const [key, table, type] of [
      ["organisations", "organisations", "organisation"],
      ["teachers", "teachers", "teacher"],
      ["classes", "classes", "class"],
      ["studentRecords", "student_sessions", "student_record"],
    ]) {
      const result = await client.query(
        `DELETE FROM ${table}
         WHERE id IN (SELECT entity_id FROM deletion_tombstones WHERE entity_type = $1)
         RETURNING id`,
        [type],
      );
      deleted[key] = result.rowCount;
    }
    for (const [key, table, type] of [
      ["stageEntries", "stage_entries", "stage_entry"],
      ["chatMessages", "chat_messages", "chat_message"],
      ["teacherFeedback", "teacher_feedback", "teacher_feedback"],
      ["studentActivity", "student_activity_sessions", "student_activity"],
      ["securityAudit", "audit_log", "security_audit"],
    ]) {
      const result = await client.query(
        `DELETE FROM ${table}
         WHERE id IN (SELECT entity_id FROM deletion_tombstones WHERE entity_type = $1)
         RETURNING id`,
        [type],
      );
      deleted[key] = result.rowCount;
    }
    const studentIdentities = await client.query(
      `UPDATE student_sessions
       SET student_name = 'Archived student', pin_hash = NULL, session_nonce = NULL
       WHERE id IN (SELECT entity_id FROM deletion_tombstones WHERE entity_type = 'student_identity')
         AND (
           student_name IS DISTINCT FROM 'Archived student'
           OR pin_hash IS NOT NULL
           OR session_nonce IS NOT NULL
         )
       RETURNING id`,
    );
    deleted.studentIdentitiesReanonymised = studentIdentities.rowCount;
    const teacherIdentities = await client.query(
      `UPDATE teachers SET
         email = 'deleted-teacher-' || id || '@retained.invalid',
         name = 'Deleted teacher', password_hash = 'retention-anonymised',
         is_it_admin = FALSE, school_admin_role = NULL, login_token = NULL,
         must_change_password = FALSE, failed_login_attempts = 0, locked_until = NULL,
         totp_secret = NULL, totp_enabled = FALSE, totp_setup_token_hash = NULL,
         totp_setup_token_expires_at = NULL, pending_totp_login_token_hash = NULL,
         pending_totp_login_token_expires_at = NULL, post_mfa_session_ticket_hash = NULL,
         post_mfa_session_ticket_expires_at = NULL, password_reset_token = NULL,
          password_reset_expires_at = NULL, email_verification_token_hash = NULL,
          email_verification_expires_at = NULL, recovery_failed_attempts = 0, recovery_locked_until = NULL
       WHERE id IN (SELECT entity_id FROM deletion_tombstones WHERE entity_type = 'teacher_identity')
         AND (
           email IS DISTINCT FROM ('deleted-teacher-' || id || '@retained.invalid')
           OR name IS DISTINCT FROM 'Deleted teacher'
           OR password_hash IS DISTINCT FROM 'retention-anonymised'
           OR is_it_admin IS DISTINCT FROM FALSE
           OR school_admin_role IS NOT NULL
           OR login_token IS NOT NULL
           OR must_change_password IS DISTINCT FROM FALSE
           OR failed_login_attempts IS DISTINCT FROM 0
           OR locked_until IS NOT NULL
           OR totp_secret IS NOT NULL
           OR totp_enabled IS DISTINCT FROM FALSE
           OR totp_setup_token_hash IS NOT NULL
           OR totp_setup_token_expires_at IS NOT NULL
           OR pending_totp_login_token_hash IS NOT NULL
           OR pending_totp_login_token_expires_at IS NOT NULL
           OR post_mfa_session_ticket_hash IS NOT NULL
           OR post_mfa_session_ticket_expires_at IS NOT NULL
           OR password_reset_token IS NOT NULL
           OR password_reset_expires_at IS NOT NULL
           OR email_verification_token_hash IS NOT NULL
           OR email_verification_expires_at IS NOT NULL
           OR recovery_failed_attempts IS DISTINCT FROM 0
           OR recovery_locked_until IS NOT NULL
         )
       RETURNING id`,
    );
    deleted.teacherIdentitiesReanonymised = teacherIdentities.rowCount;
    const teacherPasswordHistory = await client.query(
      `DELETE FROM teacher_password_history
       WHERE teacher_id IN (SELECT entity_id FROM deletion_tombstones WHERE entity_type = 'teacher_identity')
       RETURNING id`,
    );
    deleted.teacherPasswordHistory = teacherPasswordHistory.rowCount;
    const teacherRecoveryCodes = await client.query(
      `DELETE FROM teacher_recovery_codes
       WHERE teacher_id IN (SELECT entity_id FROM deletion_tombstones WHERE entity_type = 'teacher_identity')
       RETURNING id`,
    );
    deleted.teacherRecoveryCodes = teacherRecoveryCodes.rowCount;
    await client.query(
      `UPDATE restoration_reconciliation_runs
       SET completed_at = NOW(), status = 'completed', tombstones_checked = $2,
           records_redeleted = $3::jsonb
       WHERE id = $1`,
      [runId, tombstoneCount, JSON.stringify(deleted)],
    );
    await client.query(
      `UPDATE restoration_control
       SET state = 'ready', updated_at = NOW(), last_completed_run_id = $1,
           release_fence_id = $2
       WHERE id = 1`,
      [runId, releaseFence],
    );
    await client.query("COMMIT");
    console.log(JSON.stringify({ runId, state: "ready", tombstonesChecked: tombstoneCount, recordsRedeleted: deleted }));
  } catch (error) {
    await client.query("ROLLBACK");
    const failureCode = error instanceof Error && error.message.includes("must be quarantined")
      ? "NOT_QUARANTINED"
      : "RECONCILIATION_FAILED";
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO restoration_control (id, state, updated_at)
         VALUES (1, 'failed', NOW())
         ON CONFLICT (id) DO UPDATE SET state = 'failed', updated_at = NOW()`,
      );
      await client.query(
        `INSERT INTO restoration_reconciliation_runs
          (id, started_at, completed_at, status, failure_code)
         VALUES ($1, $2, NOW(), 'failed', $3)
         ON CONFLICT (id) DO UPDATE SET completed_at = NOW(), status = 'failed', failure_code = EXCLUDED.failure_code`,
        [runId, startedAt, failureCode],
      );
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }
}

try {
  if (command === "status") await status();
  if (command === "quarantine") await quarantine();
  if (command === "export-ledger") await exportLedger();
  if (command === "import-ledger") await importLedger();
  if (command === "reconcile") await reconcile();
} finally {
  await pool.end();
}
import { pool } from "@workspace/db";
import {
  dryRunAiCredentialStorageMigration,
  migrateAiCredentialStorage,
  retireVerifiedAiCredentialCiphertexts,
  rollbackAiCredentialStorageMigration,
  verifyAiCredentialStorageMigration,
} from "./lib/ai-credential-storage-migration";

type MigrationMode = "--dry-run" | "--apply" | "--verify" | "--retire-legacy" | "--rollback";

const supportedModes: MigrationMode[] = [
  "--dry-run",
  "--apply",
  "--verify",
  "--retire-legacy",
  "--rollback",
];
const requestedModes = process.argv.slice(2);
const mode = (requestedModes[0] ?? "--dry-run") as MigrationMode;

async function main(): Promise<void> {
  if (requestedModes.length > 1 || !supportedModes.includes(mode)) {
    throw new Error("Unsupported AI credential migration mode.");
  }

  let result;
  switch (mode) {
    case "--dry-run":
      result = await dryRunAiCredentialStorageMigration();
      break;
    case "--apply":
      result = await migrateAiCredentialStorage();
      break;
    case "--verify":
      result = await verifyAiCredentialStorageMigration();
      break;
    case "--retire-legacy":
      result = await retireVerifiedAiCredentialCiphertexts();
      break;
    case "--rollback":
      result = await rollbackAiCredentialStorageMigration();
      break;
  }

  console.log(JSON.stringify({ mode, ...result }));
  if (result.failures > 0 || (mode === "--retire-legacy" && result.skipped > 0)) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch {
  console.error("AI credential migration failed; no credential values were logged.");
  process.exitCode = 1;
} finally {
  await pool.end();
}
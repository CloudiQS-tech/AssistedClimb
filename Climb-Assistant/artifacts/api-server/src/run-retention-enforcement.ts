import { pool } from "@workspace/db";
import { enforceRetentionForOrganisation } from "./lib/organisation-retention";

const organisationId = Number(process.argv[2]);
if (!Number.isInteger(organisationId) || organisationId <= 0) {
  throw new Error("Usage: run-retention-enforcement.mjs <positive organisation id>");
}

try {
  const result = await enforceRetentionForOrganisation(organisationId);
  if (!result) throw new Error(`Organisation ${organisationId} was not available for retention enforcement`);
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
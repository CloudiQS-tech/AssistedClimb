import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to apply database migrations");
}

const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const migrationNames = (await readdir(migrationsDirectory))
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
  .sort();

const database = new Client({ connectionString: databaseUrl });
await database.connect();

try {
  await database.query("SELECT set_config('search_path', 'public, pg_catalog', false)");
  await database.query("SELECT pg_advisory_lock($1, $2)", [8452103, 1]);
  await database.query("CREATE SCHEMA IF NOT EXISTS app_internal");
  await database.query(
    `CREATE TABLE IF NOT EXISTS app_internal.schema_migrations (
       filename TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
  );

  const applied = await database.query(
    "SELECT filename FROM app_internal.schema_migrations",
  );
  const appliedNames = new Set(applied.rows.map((row) => row.filename));

  for (const migrationName of migrationNames) {
    if (appliedNames.has(migrationName)) continue;
    const sql = await readFile(resolve(migrationsDirectory, migrationName), "utf8");
    await database.query("BEGIN");
    try {
      await database.query(sql);
      await database.query(
        "INSERT INTO app_internal.schema_migrations (filename) VALUES ($1)",
        [migrationName],
      );
      await database.query("COMMIT");
      console.log(`Applied database migration ${migrationName}`);
    } catch (error) {
      await database.query("ROLLBACK");
      throw new Error(`Database migration ${migrationName} failed`, { cause: error });
    }
  }
} finally {
  await database.query("SELECT pg_advisory_unlock($1, $2)", [8452103, 1]).catch(() => {});
  await database.end();
}
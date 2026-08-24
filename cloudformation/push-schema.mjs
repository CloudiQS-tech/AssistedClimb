import pg from 'pg';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

try {
  await client.connect();
  console.log('Connected to RDS');
  await client.query(sql);
  console.log('Schema pushed successfully!');
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
} finally {
  await client.end();
}

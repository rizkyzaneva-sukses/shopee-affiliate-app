/**
 * Initialize database schema + run migrations
 * Run: npm run db:init
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

// Layout differs between local dev (backend/src → ../../database) and the
// Docker image (/app/src → ../database), so resolve whichever actually exists.
const migrationDir = [
  path.join(__dirname, '../../database'),
  path.join(__dirname, '../database'),
].find((p) => fs.existsSync(path.join(p, 'schema.sql')));

async function init() {
  if (!migrationDir) {
    console.error('[DB-INIT] Folder database/ (schema.sql) tidak ditemukan.');
    process.exit(1);
  }
  const sql = fs.readFileSync(path.join(migrationDir, 'schema.sql'), 'utf8');

  console.log('[DB-INIT] Connecting...');
  const client = await pool.connect();
  try {
    console.log('[DB-INIT] Running schema.sql ...');
    await client.query(sql);
    console.log('[DB-INIT] Schema applied successfully.');

    // Run migrations
    const migrations = fs.readdirSync(migrationDir)
      .filter(f => f.startsWith('migration_') && f.endsWith('.sql'))
      .sort();
    for (const file of migrations) {
      const msql = fs.readFileSync(path.join(migrationDir, file), 'utf8');
      console.log(`[DB-INIT] Running migration: ${file}`);
      await client.query(msql);
    }
    console.log('[DB-INIT] All migrations applied.');
  } catch (e) {
    console.error('[DB-INIT] Failed:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

init();

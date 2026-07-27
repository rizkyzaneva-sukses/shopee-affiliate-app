/**
 * Initialize database schema + run migrations
 * Run: npm run db:init
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function init() {
  const schemaPath = path.join(__dirname, '../../database/schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  console.log('[DB-INIT] Connecting...');
  const client = await pool.connect();
  try {
    console.log('[DB-INIT] Running schema.sql ...');
    await client.query(sql);
    console.log('[DB-INIT] Schema applied successfully.');

    // Run migrations
    const migrationDir = path.join(__dirname, '../../database');
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

/**
 * Initialize database schema
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
  } catch (e) {
    console.error('[DB-INIT] Failed:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

init();

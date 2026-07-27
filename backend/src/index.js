require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const apiRoutes = require('./routes/api');
const { requireAdmin, getAdminToken } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Security & performance
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
// Frontend is served from this same origin, so no CORS headers are needed by
// default. Set CORS_ORIGIN only when hosting the frontend separately.
app.use(cors({ origin: process.env.CORS_ORIGIN || false }));
app.use(express.json({ limit: '2mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// API (admin-protected, except /api/health and /api/auth/callback)
app.use('/api', requireAdmin, apiRoutes);

// JSON 404 for unknown API routes — must come before the SPA fallback,
// otherwise a typo'd endpoint silently returns index.html with status 200.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Endpoint tidak ditemukan' });
});

// Serve frontend static.
// Layout differs between local dev (backend/src → ../../frontend) and the
// Docker image (/app/src → ../frontend), so resolve whichever actually exists.
const frontendPath = [
  path.join(__dirname, '../../frontend'),
  path.join(__dirname, '../frontend'),
].find((p) => fs.existsSync(path.join(p, 'index.html')));

if (!frontendPath) {
  console.error('[FATAL] Folder frontend tidak ditemukan. Dashboard tidak akan tersaji.');
}

app.use(express.static(frontendPath || path.join(__dirname, '../../frontend')));

// SPA fallback
app.get('*', (req, res) => {
  if (!frontendPath) {
    return res.status(500).send('Frontend tidak ter-deploy di container ini.');
  }
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

// Auto-run migrations on startup
const { pool: migrationPool } = require('./db');
(async () => {
  const migrationDir = path.join(__dirname, '../../database');
  try {
    const files = fs.readdirSync(migrationDir)
      .filter(f => f.startsWith('migration_') && f.endsWith('.sql'))
      .sort();
    const client = await migrationPool.connect();
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationDir, file), 'utf8');
      await client.query(sql);
      console.log(`[MIGRATE] Applied: ${file}`);
    }
    client.release();
  } catch (e) {
    console.error('[MIGRATE] Error:', e.message);
  }
  migrationPool.end();
})();

app.listen(PORT, '0.0.0.0', () => {
  const auth = getAdminToken() ? 'protected' : 'OPEN (!)';
  console.log(`
╔══════════════════════════════════════════════╗
║   Shopee Affiliate Manager                   ║
║   Mode : ${(process.env.APP_MODE || 'mock').padEnd(10)}                     ║
║   Port : ${String(PORT).padEnd(10)}                     ║
║   Auth : ${auth.padEnd(10)}                     ║
╚══════════════════════════════════════════════╝
  `);

  if (!getAdminToken()) {
    console.warn(
      '[WARN] ADMIN_TOKEN belum diset — API terbuka tanpa autentikasi.\n' +
      '       Wajib diisi sebelum deploy ke domain publik.'
    );
  }
  if (!process.env.SHOPEE_REDIRECT_URI) {
    console.warn('[WARN] SHOPEE_REDIRECT_URI belum diset — tombol "Hubungkan Toko" akan gagal.');
  }
});

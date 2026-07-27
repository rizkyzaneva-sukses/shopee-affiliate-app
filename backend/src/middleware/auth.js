/**
 * Admin authentication.
 *
 * Every /api route is protected except the ones listed in PUBLIC_PATHS.
 * The Shopee OAuth callback must stay public: Shopee redirects the seller's
 * browser there and cannot attach our header. It is protected instead by
 * requiring a valid one-time `code` that only Shopee can issue.
 */

const crypto = require('crypto');

const PUBLIC_PATHS = new Set([
  '/health',
  '/auth/callback',
]);

function getAdminToken() {
  return process.env.ADMIN_TOKEN || '';
}

/** Constant-time compare that does not leak length via early return. */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function extractToken(req) {
  const header = req.get('authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  return req.get('x-admin-token') || '';
}

function requireAdmin(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  const expected = getAdminToken();

  if (!expected) {
    // Fail closed in production; allow local dev to run without setup.
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({
        error: 'ADMIN_TOKEN belum diset. Set environment variable ADMIN_TOKEN untuk mengamankan API.',
      });
    }
    return next();
  }

  const provided = extractToken(req);
  if (!provided || !safeEqual(provided, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

module.exports = { requireAdmin, getAdminToken, safeEqual };

/**
 * At-rest encryption for shop access/refresh tokens (AES-256-GCM).
 *
 * Enabled by TOKEN_ENCRYPTION_KEY (any string; `openssl rand -hex 32`).
 * Encrypted values look like `enc:v1:<iv>:<tag>:<ciphertext>` (base64).
 * Values without that prefix are legacy plaintext and are returned as-is,
 * so turning the key on never breaks existing shops; encryptExistingTokens()
 * rewrites them on startup.
 */

const crypto = require('crypto');
const { query } = require('../db');

const PREFIX = 'enc:v1:';

function getKey() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY || '';
  return raw ? crypto.createHash('sha256').update(raw).digest() : null;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Encrypt a token for storage; passes through when no key is set. */
function encryptToken(value) {
  const key = getKey();
  if (!key || value == null || value === '' || isEncrypted(value)) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64')).join(':');
}

/** Decrypt a stored token; plaintext (legacy) values are returned unchanged. */
function decryptToken(value) {
  if (!isEncrypted(value)) return value;
  const key = getKey();
  if (!key) {
    throw new Error('Token toko terenkripsi tetapi TOKEN_ENCRYPTION_KEY tidak diset.');
  }
  const [iv, tag, ct] = value.slice(PREFIX.length).split(':').map((s) => Buffer.from(s, 'base64'));
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Gagal dekripsi token toko — TOKEN_ENCRYPTION_KEY berbeda dari saat token disimpan.');
  }
}

/**
 * Encrypt any plaintext tokens left from before the key was set.
 * Compare-and-set on the old value so a concurrent token refresh wins.
 */
async function encryptExistingTokens() {
  if (!getKey()) return 0;
  const { rows } = await query(
    `SELECT shop_id, access_token, refresh_token FROM shops
     WHERE (access_token IS NOT NULL AND access_token NOT LIKE '${PREFIX}%')
        OR (refresh_token IS NOT NULL AND refresh_token NOT LIKE '${PREFIX}%')`
  );
  let done = 0;
  for (const s of rows) {
    const { rowCount } = await query(
      `UPDATE shops SET access_token = $1, refresh_token = $2
       WHERE shop_id = $3
         AND access_token IS NOT DISTINCT FROM $4 AND refresh_token IS NOT DISTINCT FROM $5`,
      [encryptToken(s.access_token), encryptToken(s.refresh_token), s.shop_id, s.access_token, s.refresh_token]
    );
    done += rowCount;
  }
  return done;
}

module.exports = { encryptToken, decryptToken, isEncrypted, encryptExistingTokens };

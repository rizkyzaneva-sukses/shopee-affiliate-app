/**
 * Background token refresher.
 *
 * Tokens are otherwise refreshed only when a request needs one, so a shop
 * nobody touches for ~30 days loses its refresh_token and must be
 * re-authorized. This keeps every shop's token alive while the server runs.
 */

const { query } = require('../db');
const shopee = require('./shopee');
const daily = require('./daily');

const INTERVAL_MS = 60 * 60 * 1000; // tiap 1 jam
// Refresh anything expiring before the next tick (plus margin), so the
// access token never lapses between runs.
const BUFFER_MS = INTERVAL_MS + 15 * 60 * 1000;
const STARTUP_DELAY_MS = 15 * 1000;
const SYNC_LOG_RETENTION_DAYS = 90;

async function pruneSyncLogs() {
  const { rowCount } = await query(
    `DELETE FROM sync_logs WHERE created_at < NOW() - make_interval(days => $1)`,
    [SYNC_LOG_RETENTION_DAYS]
  );
  if (rowCount) console.log(`[CLEANUP] ${rowCount} sync log lama dihapus`);
}

async function refreshAll() {
  // 'expired' shops are retried too: if the failure was transient they heal
  // themselves; if the token is truly dead it's one cheap call per hour.
  const { rows: shops } = await query(
    `SELECT shop_id, shop_name FROM shops
     WHERE refresh_token IS NOT NULL AND status IN ('active', 'expired')`
  );

  let ok = 0;
  let failed = 0;
  for (const shop of shops) {
    try {
      await shopee.refreshShopToken(shop.shop_id, BUFFER_MS);
      ok++;
    } catch (e) {
      failed++;
      console.error(`[TOKEN] Shop ${shop.shop_name || shop.shop_id}: ${e.message}`);
    }
  }
  if (shops.length) {
    console.log(`[TOKEN] Cek token ${shops.length} toko — ok: ${ok}, gagal: ${failed}`);
  }
}

function startTokenScheduler() {
  if ((process.env.APP_MODE || 'mock') !== 'live') return;
  try {
    shopee.assertCredentials();
  } catch (e) {
    console.warn('[TOKEN] Scheduler tidak jalan:', e.message);
    return;
  }

  // Tokens first (the daily prefill needs them), then the trend's daily rows.
  const run = () => refreshAll()
    .catch((e) => console.error('[TOKEN] Scheduler error:', e.message))
    .then(() => daily.prefillAll())
    .catch((e) => console.error('[DAILY] Prefill error:', e.message))
    .then(() => pruneSyncLogs())
    .catch((e) => console.error('[CLEANUP] Prune sync_logs error:', e.message));
  setTimeout(run, STARTUP_DELAY_MS);
  setInterval(run, INTERVAL_MS);
  console.log('[TOKEN] Auto-refresh token + data harian aktif (tiap 1 jam)');
}

module.exports = { startTokenScheduler, refreshAll };

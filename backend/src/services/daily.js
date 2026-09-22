/**
 * Daily shop totals, stored in shop_daily_performance.
 *
 * get_affiliate_performance only gives totals for a whole period, so a daily
 * trend comes from get_shop_performance with period_type=Day — one call per
 * shop per day. Finished days are stored once; only the most recent days are
 * re-fetched, because Shopee keeps adjusting them (late confirmations).
 */

const { query } = require('../db');
const shopee = require('./shopee');

const MAX_BACKFILL_DAYS = 90;      // Shopee serves Day data for ~3 months
const REFRESH_RECENT_DAYS = 3;     // days before the latest date that still change
const DAY_CONCURRENCY = 5;         // parallel Day calls per shop

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const isoAddDays = (iso, n) =>
  new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

function daysBetween(fromIso, toIso) {
  const out = [];
  for (let d = fromIso; d <= toIso; d = isoAddDays(d, 1)) out.push(d);
  return out;
}

/** First day (YYYY-MM-DD) of a trend period ending on `latest`. */
function periodStart(period, latest) {
  if (period === 'Month') return latest.slice(0, 8) + '01';
  if (period === 'Last7d') return isoAddDays(latest, -6);
  return isoAddDays(latest, -29);
}

async function runLimited(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

// One fill per shop+channel at a time: the trend and comparison cards load
// together and would otherwise fetch the same days twice.
const inflight = new Map();

/**
 * Make sure every day from `fromIso` to the shop's latest data date is
 * stored, re-fetching the most recent few. Returns the latest data date.
 */
function ensureDaily(shop, fromIso, channel = 'AllChannel') {
  const key = `${shop.shop_id}|${channel}|${fromIso}`;
  if (!inflight.has(key)) {
    inflight.set(key, fill(shop, fromIso, channel).finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}

async function fill(shop, fromIso, channel) {
  const token = await shopee.ensureValidToken(shop);
  const latest = await shopee.getLatestDataDate(shop.shop_id, token);

  const earliest = isoAddDays(latest, -(MAX_BACKFILL_DAYS - 1));
  const from = fromIso < earliest ? earliest : fromIso;
  const wanted = daysBetween(from, latest);

  const { rows } = await query(
    `SELECT TO_CHAR(date, 'YYYY-MM-DD') AS d FROM shop_daily_performance
     WHERE shop_id = $1 AND channel = $2 AND date BETWEEN $3 AND $4`,
    [shop.shop_id, channel, from, latest]
  );
  const have = new Set(rows.map(r => r.d));
  const recentFrom = isoAddDays(latest, -(REFRESH_RECENT_DAYS - 1));
  const todo = wanted.filter(d => !have.has(d) || d >= recentFrom);

  await runLimited(todo, DAY_CONCURRENCY, async (day) => {
    const { startDate, endDate } = shopee.amsRange('Day', latest, day);
    const data = await shopee.getShopPerformance(shop.shop_id, token, {
      periodType: 'Day', startDate, endDate, channel,
    });
    const r = data.response || {};
    await query(
      `INSERT INTO shop_daily_performance
         (shop_id, date, channel, sales, orders, clicks, est_commission, items_sold, total_buyers, new_buyers, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (shop_id, date, channel) DO UPDATE SET
         sales = EXCLUDED.sales, orders = EXCLUDED.orders, clicks = EXCLUDED.clicks,
         est_commission = EXCLUDED.est_commission, items_sold = EXCLUDED.items_sold,
         total_buyers = EXCLUDED.total_buyers, new_buyers = EXCLUDED.new_buyers,
         synced_at = NOW()`,
      [shop.shop_id, day, channel, num(r.sales), num(r.orders), num(r.clicks),
       num(r.est_commission), num(r.gross_item_sold), num(r.total_buyers), num(r.new_buyers)]
    );
  });

  return latest;
}

/**
 * Fill every shop, then return per-day sums from `period` start to the
 * newest latest-data-date among the shops. Failing shops go to `errors`.
 */
async function dailySeries(shops, period, channel = 'AllChannel') {
  const errors = [];
  const latestDates = [];

  // The start depends on the latest date, which is per shop: resolve it first
  // with a generous window, then trim to the period.
  await Promise.all(shops.map(async (shop) => {
    try {
      const token = await shopee.ensureValidToken(shop);
      const latest = await shopee.getLatestDataDate(shop.shop_id, token);
      await ensureDaily(shop, periodStart(period, latest), channel);
      latestDates.push(latest);
    } catch (e) {
      console.warn(`[DAILY] Shop ${shop.shop_id} gagal:`, e.message);
      errors.push({ shop_id: shop.shop_id, name: shop.shop_name, error: e.message });
    }
  }));

  if (!latestDates.length) return { days: [], rows: {}, errors, latest: null };

  const latest = latestDates.sort().at(-1);
  const from = periodStart(period, latest);
  const days = daysBetween(from, latest);

  const { rows } = await query(
    `SELECT TO_CHAR(date, 'YYYY-MM-DD') AS d,
            SUM(sales) AS sales, SUM(orders) AS orders, SUM(clicks) AS clicks,
            SUM(est_commission) AS commission, SUM(items_sold) AS items_sold
     FROM shop_daily_performance
     WHERE shop_id = ANY($1) AND channel = $2 AND date BETWEEN $3 AND $4
     GROUP BY date`,
    [shops.map(s => s.shop_id), channel, from, latest]
  );
  const byDay = Object.fromEntries(rows.map(r => [r.d, {
    sales: num(r.sales), orders: num(r.orders), clicks: num(r.clicks),
    commission: num(r.commission), items_sold: num(r.items_sold),
  }]));

  return { days, rows: byDay, errors, latest };
}

/** Background prefill so the dashboard rarely waits on Shopee. */
async function prefillAll() {
  const { rows: shops } = await query(`SELECT * FROM shops WHERE status = 'active'`);
  for (const shop of shops) {
    try {
      const token = await shopee.ensureValidToken(shop);
      const latest = await shopee.getLatestDataDate(shop.shop_id, token);
      await ensureDaily(shop, isoAddDays(latest, -29));
    } catch (e) {
      console.warn(`[DAILY] Prefill shop ${shop.shop_id} gagal:`, e.message);
    }
  }
}

module.exports = { dailySeries, ensureDaily, prefillAll, periodStart, isoAddDays };

const express = require('express');
const router = express.Router();
const { query } = require('../db');
const shopee = require('../services/shopee');
const daily = require('../services/daily');

/** Finite number or 0 — Shopee sometimes sends "NaN" (e.g. ROI with zero commission). */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * SQL for the rows of each shop's most recent sync of one period + channel.
 * affiliate_performance keeps every past date range (each resync adds one),
 * so summing the raw table double counts, and taking the newest row per
 * affiliate would keep stale numbers for affiliates absent from the last sync.
 * Every sync writes one date range per shop, so match on that range.
 * Params: $1 period_type, $2 channel.
 */
const LATEST_SNAPSHOT_SQL = `
  SELECT ap.*
  FROM affiliate_performance ap
  JOIN (
    SELECT DISTINCT ON (shop_id) shop_id, start_date, end_date
    FROM affiliate_performance
    WHERE period_type = $1 AND channel = $2
    ORDER BY shop_id, synced_at DESC
  ) lr ON lr.shop_id = ap.shop_id AND lr.start_date = ap.start_date AND lr.end_date = ap.end_date
  WHERE ap.period_type = $1 AND ap.channel = $2
`;

async function latestSnapshotTotals(period, { shopId, channel = 'AllChannel' } = {}) {
  const params = [period, channel];
  let filter = '';
  if (shopId && shopId !== 'all') {
    params.push(shopId);
    filter = `WHERE shop_id = $${params.length}`;
  }
  const { rows } = await query(`
    SELECT
      COALESCE(SUM(gmv), 0) AS gmv,
      COALESCE(SUM(orders), 0) AS orders,
      COALESCE(SUM(est_commission), 0) AS commission,
      COALESCE(SUM(clicks), 0) AS clicks,
      COUNT(*) AS affiliates
    FROM (${LATEST_SNAPSHOT_SQL}) latest
    ${filter}
  `, params);
  const r = rows[0] || {};
  return {
    gmv: num(r.gmv),
    orders: num(r.orders),
    commission: num(r.commission),
    clicks: num(r.clicks),
    affiliates: num(r.affiliates),
  };
}

/** KPI totals over a full affiliate list (the table itself may be truncated). */
function summarizeAffiliates(list) {
  const t = { gmv: 0, orders: 0, commission: 0, clicks: 0, items_sold: 0, new_buyers: 0, total_buyers: 0, affiliates: list.length, active: 0 };
  for (const a of list) {
    t.gmv += num(a.gmv);
    t.orders += num(a.orders);
    t.commission += num(a.commission);
    t.clicks += num(a.clicks);
    t.items_sold += num(a.items_sold);
    t.new_buyers += num(a.new_buyers);
    t.total_buyers += num(a.total_buyers);
    if ((a.status || 'active') === 'active') t.active++;
  }
  return t;
}

// ---------- Health ----------
router.get('/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', mode: process.env.APP_MODE || 'mock', time: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ---------- Auth (admin session) ----------
router.post('/auth/login', (_req, res) => {
  // requireAdmin already validated the token before reaching here.
  res.json({ success: true });
});

// ---------- Authorization (Shopee OAuth) ----------

/**
 * Step 1 — frontend asks for the authorization URL and redirects the seller.
 * The link expires after 5 minutes, so it is built fresh on every call.
 */
router.get('/auth/url', (req, res) => {
  try {
    const url = shopee.buildAuthUrl(req.query.redirect_uri);
    res.json({ url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * Step 2 — Shopee redirects the seller's browser here with ?code=&shop_id=.
 * Public by design (see middleware/auth.js). Responds with a redirect back to
 * the dashboard rather than JSON, because a human is looking at this.
 */
router.get('/auth/callback', async (req, res) => {
  const { code, shop_id: shopId } = req.query;
  const back = (status, msg) =>
    res.redirect(`/?auth=${status}&msg=${encodeURIComponent(msg)}`);

  if (!code || !shopId) {
    return back('error', 'Callback tidak membawa code/shop_id. Pastikan redirect URI di Shopee Console sama persis dengan SHOPEE_REDIRECT_URI.');
  }

  try {
    const token = await shopee.getAccessToken(code, shopId);

    // Shop name is a nice-to-have — never fail authorization over it.
    let shopName = null;
    let region = null;
    try {
      const info = await shopee.getShopInfo(shopId, token.access_token);
      shopName = info.shop_name || null;
      region = info.region || null;
    } catch (infoErr) {
      console.warn('[AUTH] get_shop_info gagal:', infoErr.message);
    }

    const expireAt = new Date(Date.now() + (token.expire_in || 14400) * 1000);

    await query(
      `INSERT INTO shops (shop_id, shop_name, region, access_token, refresh_token, token_expire_at, status, auth_time)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW())
       ON CONFLICT (shop_id) DO UPDATE SET
         shop_name = COALESCE(EXCLUDED.shop_name, shops.shop_name),
         region = COALESCE(EXCLUDED.region, shops.region),
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         token_expire_at = EXCLUDED.token_expire_at,
         status = 'active',
         auth_time = NOW(),
         updated_at = NOW()`,
      [shopId, shopName, region || process.env.SHOPEE_REGION || 'ID',
       token.access_token, token.refresh_token, expireAt]
    );

    await query(
      `INSERT INTO sync_logs (shop_id, action, status, message) VALUES ($1, 'authorize', 'success', $2)`,
      [shopId, `Shop ${shopName || shopId} berhasil diotorisasi`]
    ).catch(() => {});

    return back('success', `Toko ${shopName || shopId} berhasil terhubung`);
  } catch (e) {
    console.error('[AUTH] callback gagal:', e.message);
    await query(
      `INSERT INTO sync_logs (shop_id, action, status, message) VALUES ($1, 'authorize', 'error', $2)`,
      [shopId, e.message]
    ).catch(() => {});
    return back('error', e.message);
  }
});

// ---------- Diagnostics ----------

/**
 * Reports which page_size values the AMS API accepts for a shop, and echoes
 * the raw first page. Use this to pin down parameter limits without guessing.
 */
router.get('/diag/page-size/:shopId', async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM shops WHERE shop_id = $1`, [req.params.shopId]);
    if (!rows.length) return res.status(404).json({ error: 'Shop not found' });

    const token = await shopee.ensureValidToken(rows[0]);
    const results = await shopee.probePageSizes(req.params.shopId, token);
    const accepted = results.filter((r) => r.ok).map((r) => r.page_size);

    res.json({
      shop_id: req.params.shopId,
      accepted,
      recommendation: accepted.length
        ? `Set SHOPEE_PAGE_SIZE=${Math.max(...accepted)}`
        : 'Tidak ada page_size yang diterima — masalahnya bukan di page_size.',
      results,
    });
  } catch (e) {
    res.status(500).json({ error: e.message, code: e.code });
  }
});

/**
 * Sends one raw request with fully caller-controlled params and returns
 * Shopee's untouched reply, so parameter names/values can be tested directly.
 */
router.get('/diag/raw/:shopId', async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM shops WHERE shop_id = $1`, [req.params.shopId]);
    if (!rows.length) return res.status(404).json({ error: 'Shop not found' });

    const token = await shopee.ensureValidToken(rows[0]);
    const { path, ...queryParams } = req.query;
    if (!path) return res.status(400).json({ error: 'Parameter "path" wajib diisi' });

    const data = await shopee.shopeeRequest({
      method: 'GET',
      path,
      shopId: req.params.shopId,
      accessToken: token,
      queryParams,
    });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ error: e.message, code: e.code, requestId: e.requestId });
  }
});

// ---------- Shops ----------
router.get('/shops', async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT shop_id, shop_name, region, status, last_sync_at, token_expire_at, created_at
       FROM shops ORDER BY shop_name`
    );
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Discover shops via get_shops_by_partner — fetches all shops that have
 * authorized the app and upserts them into the DB.
 */
router.post('/shops/discover', async (_req, res) => {
  try {
    const data = await shopee.getShopsByPartner();
    const list = data.response?.shop_list || [];
    let upserted = 0;

    for (const s of list) {
      const sid = s.shop_id;
      if (!sid) continue;
      await query(
        `INSERT INTO shops (shop_id, shop_name, region, status, raw_info)
         VALUES ($1, $2, $3, 'active', $4)
         ON CONFLICT (shop_id) DO UPDATE SET
           shop_name = COALESCE(EXCLUDED.shop_name, shops.shop_name),
           region = COALESCE(EXCLUDED.region, shops.region),
           raw_info = EXCLUDED.raw_info,
           updated_at = NOW()`,
        [sid, s.shop_name || null, s.region || process.env.SHOPEE_REGION || 'ID',
         JSON.stringify(s)]
      );
      upserted++;
    }

    await query(
      `INSERT INTO sync_logs (shop_id, action, status, message) VALUES (0, 'discover_shops', 'success', $1)`,
      [`Discovered ${upserted} shops from Shopee partner API`]
    ).catch(() => {});

    res.json({ success: true, shops: list.length, synced: upserted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Pull one shop's affiliate performance for a period and store it as a
 * snapshot keyed by the exact date range Shopee was asked for.
 */
async function syncShopAffiliates(shop, periodType, channelRaw) {
  const token = await shopee.ensureValidToken(shop);
  const channel = shopee.normalizeChannel(channelRaw);
  const { startDate, endDate } = await shopee.shopRange(shop.shop_id, token, periodType);

  const list = await shopee.getAllAffiliatePerformance(shop.shop_id, token, { periodType, channel, startDate, endDate });

  for (const a of list) {
    await query(
      `INSERT INTO affiliates (affiliate_id, shop_id, name, username, channel, status)
       VALUES ($1, $2, $3, $4, $5, 'active')
       ON CONFLICT (affiliate_id, shop_id) DO UPDATE SET
         name = EXCLUDED.name,
         username = EXCLUDED.username,
         channel = EXCLUDED.channel,
         updated_at = NOW()`,
      [a.affiliate_id, shop.shop_id, a.affiliate_name, a.affiliate_username, channel]
    );

    await query(
      `INSERT INTO affiliate_performance
         (affiliate_id, shop_id, period_type, start_date, end_date, channel,
          gmv, orders, clicks, items_sold, est_commission, roi, total_buyers, new_buyers, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
       ON CONFLICT (affiliate_id, shop_id, period_type, start_date, end_date, channel)
       DO UPDATE SET
         gmv = EXCLUDED.gmv, orders = EXCLUDED.orders, clicks = EXCLUDED.clicks,
         items_sold = EXCLUDED.items_sold,
         est_commission = EXCLUDED.est_commission, roi = EXCLUDED.roi,
         total_buyers = EXCLUDED.total_buyers, new_buyers = EXCLUDED.new_buyers,
         synced_at = NOW()`,
      [a.affiliate_id, shop.shop_id, periodType, startDate, endDate, channel,
       num(a.sales), num(a.orders), num(a.clicks), num(a.items_sold),
       num(a.est_commission), num(a.roi),
       num(a.total_buyers), num(a.new_buyers)]
    );
  }

  await query(`UPDATE shops SET last_sync_at = NOW() WHERE shop_id = $1`, [shop.shop_id]);
  return list.length;
}

/**
 * Sync all shops in one call — iterates each shop and syncs affiliate
 * performance. Useful for "Sync Semua" button on the frontend.
 */
router.post('/sync/all', async (req, res) => {
  const mode = process.env.APP_MODE || 'mock';
  if (mode !== 'live') {
    return res.json({ message: 'Mode mock — sync dilewati.', synced: 0 });
  }

  try {
    const { rows: shops } = await query(`SELECT * FROM shops WHERE status = 'active' ORDER BY shop_name`);
    if (!shops.length) return res.json({ message: 'Tidak ada toko aktif.', synced: 0 });

    const periodType = req.body?.period || 'Last30d';
    let totalSynced = 0;
    const results = [];

    for (const shop of shops) {
      try {
        const count = await syncShopAffiliates(shop, periodType, req.body?.channel);
        totalSynced += count;
        results.push({ shop_id: shop.shop_id, name: shop.shop_name, synced: count });
      } catch (e) {
        console.error(`[SYNC-ALL] Shop ${shop.shop_id} gagal:`, e.message);
        results.push({ shop_id: shop.shop_id, name: shop.shop_name, error: e.message });
      }
    }

    await query(
      `INSERT INTO sync_logs (shop_id, action, status, message) VALUES (0, 'sync_all', 'success', $1)`,
      [`Synced ${totalSynced} affiliates from ${shops.length} shops`]
    ).catch(() => {});

    res.json({ success: true, total: totalSynced, shops: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/shops', async (req, res) => {
  // Manual add / update shop tokens (after authorization callback)
  try {
    const { shop_id, shop_name, region, access_token, refresh_token, expire_in } = req.body;
    if (!shop_id) return res.status(400).json({ error: 'shop_id required' });

    const expireAt = expire_in
      ? new Date(Date.now() + expire_in * 1000)
      : null;

    await query(
      `INSERT INTO shops (shop_id, shop_name, region, access_token, refresh_token, token_expire_at, status, auth_time)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW())
       ON CONFLICT (shop_id) DO UPDATE SET
         shop_name = COALESCE(EXCLUDED.shop_name, shops.shop_name),
         region = COALESCE(EXCLUDED.region, shops.region),
         access_token = COALESCE(EXCLUDED.access_token, shops.access_token),
         refresh_token = COALESCE(EXCLUDED.refresh_token, shops.refresh_token),
         token_expire_at = COALESCE(EXCLUDED.token_expire_at, shops.token_expire_at),
         status = 'active',
         updated_at = NOW()`,
      [shop_id, shop_name || null, region || 'ID', access_token || null, refresh_token || null, expireAt]
    );

    res.json({ success: true, shop_id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Affiliates + Performance ----------

// Rows rendered in the tables; KPI totals always cover the full list.
const AFFILIATE_TABLE_LIMIT = 500;

router.get('/affiliates', async (req, res) => {
  try {
    const shopId = req.query.shop_id;
    const channel = shopee.normalizeChannel(req.query.channel && req.query.channel !== 'all' ? req.query.channel : null);
    const period = req.query.period || 'Last30d';
    const search = String(req.query.q || '').trim().toLowerCase();

    const respond = (list, source, extra = {}) => {
      const filtered = search
        ? list.filter(a => `${a.name || ''} ${a.username || ''}`.toLowerCase().includes(search))
        : list;
      filtered.sort((x, y) => y.gmv - x.gmv);
      res.json({
        data: filtered.slice(0, AFFILIATE_TABLE_LIMIT),
        totals: summarizeAffiliates(filtered),
        total_count: filtered.length,
        source,
        ...extra,
      });
    };

    // Try live performance first if mode=live and a single shop is selected
    const mode = process.env.APP_MODE || 'mock';
    let liveError = null;

    if (mode === 'live' && shopId && shopId !== 'all') {
      const { rows: shops } = await query(`SELECT * FROM shops WHERE shop_id = $1`, [shopId]);
      if (shops.length && shops[0].access_token) {
        try {
          const token = await shopee.ensureValidToken(shops[0]);
          // end_date must be Shopee's latest data date, not today.
          const { startDate, endDate } = await shopee.shopRange(shopId, token, period);
          const rows = await shopee.getAllAffiliatePerformance(shopId, token, {
            periodType: period,
            channel,
            startDate,
            endDate,
          });

          const list = rows.map((a) => ({
            affiliate_id: a.affiliate_id,
            shop_id: shops[0].shop_id,
            shop_name: shops[0].shop_name,
            name: a.affiliate_name,
            username: a.affiliate_username,
            gmv: num(a.sales),
            orders: num(a.orders),
            clicks: num(a.clicks),
            items_sold: num(a.items_sold),
            commission: num(a.est_commission),
            roi: num(a.roi),
            total_buyers: num(a.total_buyers),
            new_buyers: num(a.new_buyers),
            channel,
            status: 'active',
          }));

          return respond(list, 'live');
        } catch (apiErr) {
          // Falling back to cache keeps the dashboard usable, but the reason
          // must reach the client or a misconfigured filter looks like "no data".
          console.error('[API] Live fetch failed, fallback to cache:', apiErr.message);
          liveError = apiErr.message;
        }
      }
    }

    // Fallback: each shop's most recent synced snapshot for this period + channel.
    const params = [period, channel];
    let sql = `
      SELECT a.affiliate_id, a.name, a.username, a.status, a.followers, a.shop_id, a.last_active_at,
             s.shop_name, p.channel, p.gmv, p.orders, p.clicks, p.items_sold,
             p.est_commission AS commission, p.roi, p.total_buyers, p.new_buyers
      FROM (${LATEST_SNAPSHOT_SQL}) p
      JOIN affiliates a ON a.affiliate_id = p.affiliate_id AND a.shop_id = p.shop_id
      LEFT JOIN shops s ON s.shop_id = p.shop_id
    `;
    if (shopId && shopId !== 'all') {
      params.push(shopId);
      sql += ` WHERE p.shop_id = $${params.length}`;
    }

    const { rows } = await query(sql, params);
    const list = rows.map(r => ({
      ...r,
      gmv: num(r.gmv),
      orders: num(r.orders),
      clicks: num(r.clicks),
      items_sold: num(r.items_sold),
      commission: num(r.commission),
      roi: num(r.roi),
      total_buyers: num(r.total_buyers),
      new_buyers: num(r.new_buyers),
    }));

    respond(list, 'cache', liveError ? { live_error: liveError } : {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Campaigns ----------
router.get('/campaigns', async (req, res) => {
  try {
    const shopId = req.query.shop_id;
    let sql = `SELECT c.*, s.shop_name FROM campaigns c LEFT JOIN shops s ON s.shop_id = c.shop_id`;
    const params = [];
    if (shopId && shopId !== 'all') {
      sql += ` WHERE c.shop_id = $1`;
      params.push(shopId);
    }
    sql += ` ORDER BY c.period_start DESC NULLS LAST, c.updated_at DESC LIMIT 100`;
    const { rows } = await query(sql, params);
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Dashboard Trend (daily GMV/orders) ----------

// Sums of shop_daily_performance (filled from get_shop_performance, Day).
router.get('/dashboard/trend', async (req, res) => {
  try {
    if ((process.env.APP_MODE || 'mock') !== 'live') {
      return res.json({ labels: [], gmv: [], orders: [], commissions: [], source: 'mock' });
    }

    const period = req.query.period || 'Last30d';
    const channel = shopee.normalizeChannel(req.query.channel && req.query.channel !== 'all' ? req.query.channel : null);
    const shops = await resolveShops(req.query.shop_id);
    const { days, rows, errors, pending, latest } = await daily.dailySeries(shops, period, channel);

    res.json({
      labels: days.map(d => new Date(d + 'T00:00:00Z').toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' })),
      gmv: days.map(d => (rows[d]?.sales || 0) / 1e6), // millions
      orders: days.map(d => rows[d]?.orders || 0),
      commissions: days.map(d => rows[d]?.commission || 0),
      source: 'shop_daily',
      latest_date: latest,
      errors,
      pending,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Goals CRUD ----------
router.get('/goals', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM goals WHERE active = true ORDER BY created_at DESC`
    );
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/goals', async (req, res) => {
  try {
    const { name, target_gmv, target_orders, target_commission, period } = req.body;
    if (!name || !target_gmv) {
      return res.status(400).json({ error: 'name and target_gmv are required' });
    }
    const { rows } = await query(
      `INSERT INTO goals (name, target_gmv, target_orders, target_commission, period, active)
       VALUES ($1, $2, $3, $4, $5, true) RETURNING *`,
      [name, target_gmv, target_orders || 0, target_commission || 0, period || 'Month']
    );
    res.json({ success: true, data: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/goals/:id', async (req, res) => {
  try {
    const { name, target_gmv, target_orders, target_commission, period, active } = req.body;
    await query(
      `UPDATE goals SET name = COALESCE($1, name), target_gmv = COALESCE($2, target_gmv),
       target_orders = COALESCE($3, target_orders), target_commission = COALESCE($4, target_commission),
       period = COALESCE($5, period), active = COALESCE($6, active), updated_at = NOW()
       WHERE id = $7`,
      [name, target_gmv, target_orders, target_commission, period, active, req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/goals/:id', async (req, res) => {
  try {
    await query(`UPDATE goals SET active = false WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Dashboard summary ----------
router.get('/dashboard/summary', async (req, res) => {
  try {
    const period = req.query.period || 'Last30d';
    const channel = shopee.normalizeChannel(req.query.channel && req.query.channel !== 'all' ? req.query.channel : null);
    const t = await latestSnapshotTotals(period, { shopId: req.query.shop_id, channel });

    res.json({
      total_gmv: t.gmv,
      total_orders: t.orders,
      total_commission: t.commission,
      total_clicks: t.clicks,
      affiliate_count: t.affiliates,
      avg_roi: t.commission > 0 ? Number((t.gmv / t.commission).toFixed(2)) : 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Sync trigger (manual) ----------
router.post('/sync/:shopId', async (req, res) => {
  const shopId = req.params.shopId;
  const mode = process.env.APP_MODE || 'mock';

  if (mode !== 'live') {
    return res.json({ message: 'Mode mock — sync dilewati. Ganti APP_MODE=live untuk sync real.' });
  }

  try {
    const { rows } = await query(`SELECT * FROM shops WHERE shop_id = $1`, [shopId]);
    if (!rows.length) return res.status(404).json({ error: 'Shop not found' });

    const upserted = await syncShopAffiliates(rows[0], req.body?.period || 'Last30d', req.body?.channel);

    await query(
      `INSERT INTO sync_logs (shop_id, action, status, message) VALUES ($1, 'sync_performance', 'success', $2)`,
      [shopId, `Synced ${upserted} affiliates`]
    );

    res.json({ success: true, synced: upserted });
  } catch (e) {
    await query(
      `INSERT INTO sync_logs (shop_id, action, status, message) VALUES ($1, 'sync_performance', 'error', $2)`,
      [shopId, e.message]
    ).catch(() => {});
    res.status(500).json({ error: e.message });
  }
});

// ---------- Campaign sync ----------

// period_end_time 32503651199 (2999-12-31) means "no end date".
const NO_END_TIME = 32503651199;
const unixToDate = (v) => (v && Number(v) < NO_END_TIME ? new Date(Number(v) * 1000) : null);

/**
 * Store a shop's seller-created targeted campaigns. Campaigns no longer
 * returned by Shopee are removed so the list mirrors Seller Center.
 */
async function syncShopCampaigns(shop) {
  const token = await shopee.ensureValidToken(shop);
  const pageSize = 100;
  const list = [];
  for (let pageNo = 1; pageNo <= 50; pageNo++) {
    const r = await shopee.getTargetedCampaignList(shop.shop_id, token, pageNo, pageSize);
    const page = r.response?.campaign_list || [];
    list.push(...page);
    const total = r.response?.total_count;
    if (page.length < pageSize || (typeof total === 'number' && list.length >= total)) break;
  }

  const ids = [];
  for (const c of list) {
    if (!c.campaign_id) continue;
    ids.push(c.campaign_id);
    const rate = c.min_rate == null ? null
      : Number(c.min_rate) === Number(c.max_rate) ? `${c.min_rate}%` : `${c.min_rate}–${c.max_rate}%`;
    await query(
      `INSERT INTO campaigns (campaign_id, shop_id, name, type, status, commission_info,
                              products_count, affiliates_count, period_start, period_end, raw_data)
       VALUES ($1, $2, $3, 'Targeted', $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (campaign_id, shop_id) DO UPDATE SET
         name = EXCLUDED.name, type = EXCLUDED.type, status = EXCLUDED.status,
         commission_info = EXCLUDED.commission_info,
         products_count = EXCLUDED.products_count, affiliates_count = EXCLUDED.affiliates_count,
         period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end,
         raw_data = EXCLUDED.raw_data, updated_at = NOW()`,
      [c.campaign_id, shop.shop_id, c.campaign_name || null, c.campaign_status || null, rate,
       num(c.item_count), num(c.affiliate_count),
       unixToDate(c.period_start_time), unixToDate(c.period_end_time), JSON.stringify(c)]
    );
  }
  await query(
    `DELETE FROM campaigns WHERE shop_id = $1 AND NOT (campaign_id = ANY($2::bigint[]))`,
    [shop.shop_id, ids]
  );
  return ids.length;
}

router.post('/sync/campaigns/:shopId', async (req, res) => {
  if ((process.env.APP_MODE || 'mock') !== 'live') {
    return res.json({ message: 'Mode mock — sync campaigns dilewati.', synced: 0 });
  }
  const shopId = req.params.shopId;
  try {
    const { rows } = await query(`SELECT * FROM shops WHERE shop_id = $1`, [shopId]);
    if (!rows.length) return res.status(404).json({ error: 'Shop not found' });
    const synced = await syncShopCampaigns(rows[0]);
    await query(
      `INSERT INTO sync_logs (shop_id, action, status, message) VALUES ($1, 'sync_campaigns', 'success', $2)`,
      [shopId, `Synced ${synced} campaigns`]
    ).catch(() => {});
    res.json({ success: true, synced });
  } catch (e) {
    await query(
      `INSERT INTO sync_logs (shop_id, action, status, message) VALUES ($1, 'sync_campaigns', 'error', $2)`,
      [shopId, e.message]
    ).catch(() => {});
    res.status(500).json({ error: e.message });
  }
});

/** Sync campaigns for ALL active shops. */
router.post('/campaigns/sync-all', async (_req, res) => {
  if ((process.env.APP_MODE || 'mock') !== 'live') {
    return res.json({ message: 'Mode mock — sync campaigns dilewati.', synced: 0 });
  }
  try {
    const { rows: shops } = await query(`SELECT * FROM shops WHERE status = 'active' ORDER BY shop_name`);
    let total = 0;
    const results = [];
    for (const shop of shops) {
      try {
        const synced = await syncShopCampaigns(shop);
        total += synced;
        results.push({ shop_id: shop.shop_id, name: shop.shop_name, synced });
      } catch (e) {
        console.error(`[CAMPAIGN-SYNC-ALL] Shop ${shop.shop_id} gagal:`, e.message);
        results.push({ shop_id: shop.shop_id, name: shop.shop_name, error: e.message });
      }
    }
    res.json({ success: true, total, shops: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** The selected shop, or every active shop for "all". */
async function resolveShops(shopId) {
  const { rows } = shopId && shopId !== 'all'
    ? await query(`SELECT * FROM shops WHERE shop_id = $1`, [shopId])
    : await query(`SELECT * FROM shops WHERE status = 'active' ORDER BY shop_name`);
  return rows;
}

/**
 * Run `fetchShop` for each shop in parallel, tagging rows with their shop.
 * One failing shop is reported in `errors` instead of failing the whole list.
 */
async function collectFromShops(shops, fetchShop) {
  const data = [];
  const errors = [];
  await Promise.all(shops.map(async (shop) => {
    try {
      const rows = await fetchShop(shop);
      data.push(...rows.map(r => ({ ...r, shop_id: shop.shop_id, shop_name: shop.shop_name })));
    } catch (e) {
      console.warn(`[SHOP ${shop.shop_id}]`, e.message);
      errors.push({ shop_id: shop.shop_id, name: shop.shop_name, error: e.message });
    }
  }));
  return { data, errors };
}

// ---------- Products (from Shopee API) ----------
router.get('/products', async (req, res) => {
  try {
    if ((process.env.APP_MODE || 'mock') !== 'live') {
      return res.json({ data: [], source: 'mock' });
    }

    const period = req.query.period || 'Last30d';
    const channel = shopee.normalizeChannel(req.query.channel && req.query.channel !== 'all' ? req.query.channel : null);
    const shops = await resolveShops(req.query.shop_id);
    if (!shops.length) return res.json({ data: [], source: 'empty' });

    const { data, errors } = await collectFromShops(shops, async (shop) => {
      const token = await shopee.ensureValidToken(shop);
      const { startDate, endDate } = await shopee.shopRange(shop.shop_id, token, period);
      const list = await shopee.fetchAllPages(
        (pageNo) => shopee.getProductPerformance(shop.shop_id, token, { periodType: period, startDate, endDate, channel }, pageNo),
        { pageSize: shopee.AMS_MAX_PAGE_SIZE, maxPages: 50 }
      );
      return list.map(p => ({
        item_id: p.item_id,
        item_name: p.item_name,
        sales: num(p.sales),
        items_sold: num(p.items_sold),
        orders: num(p.orders),
        clicks: num(p.clicks),
        est_commission: num(p.est_commission),
        roi: num(p.roi),
        total_buyers: num(p.total_buyers),
        new_buyers: num(p.new_buyers),
      }));
    });

    data.sort((a, b) => b.sales - a.sales);
    res.json({ data, errors, source: 'live', count: data.length });
  } catch (e) {
    res.json({ data: [], source: 'error', error: e.message });
  }
});

// ---------- Transactions (from Shopee API) ----------

/** One conversion-report order flattened for the table. Amounts are in rupiah. */
function normalizeConversion(o) {
  const items = o.items || [];
  const first = items[0]?.item_name || '-';
  return {
    order_sn: o.order_sn,
    order_status: o.order_status,
    verified_status: o.verified_status,
    buyer_status: o.buyer_status,
    place_order_time: o.place_order_time,
    affiliate_id: o.affiliate_id,
    affiliate_name: o.affiliate_name,
    affiliate_username: o.affiliate_username,
    channel: o.channel,
    item_name: items.length > 1 ? `${first} (+${items.length - 1} produk)` : first,
    qty: items.reduce((n, i) => n + num(i.qty), 0),
    purchase_value: items.reduce((n, i) => n + num(i.purchase_value), 0),
    refund_amount: items.reduce((n, i) => n + num(i.refund_amount), 0),
    commission: num(o.order_brand_commission),
  };
}

router.get('/transactions', async (req, res) => {
  try {
    if ((process.env.APP_MODE || 'mock') !== 'live') {
      return res.json({ data: [], source: 'mock' });
    }

    const period = req.query.period || 'Last30d';
    const shops = await resolveShops(req.query.shop_id);
    if (!shops.length) return res.json({ data: [], source: 'empty' });

    const { data, errors } = await collectFromShops(shops, async (shop) => {
      const token = await shopee.ensureValidToken(shop);
      const { startDate } = await shopee.shopRange(shop.shop_id, token, period);
      // Orders placed from the period start (00:00 WIB) until now.
      const iso = `${startDate.slice(0, 4)}-${startDate.slice(4, 6)}-${startDate.slice(6, 8)}`;
      const placeOrderTimeStart = Math.floor(Date.parse(`${iso}T00:00:00+07:00`) / 1000);
      const placeOrderTimeEnd = Math.floor(Date.now() / 1000);
      // page_no * page_size must stay <= 10000.
      const list = await shopee.fetchAllPages(
        (pageNo) => shopee.getConversionReport(shop.shop_id, token, { placeOrderTimeStart, placeOrderTimeEnd }, pageNo),
        { pageSize: shopee.CONVERSION_PAGE_SIZE, maxPages: 10000 / shopee.CONVERSION_PAGE_SIZE }
      );
      return list.map(normalizeConversion);
    });

    data.sort((a, b) => String(b.place_order_time).localeCompare(String(a.place_order_time), undefined, { numeric: true }));
    res.json({ data, errors, source: 'live', count: data.length });
  } catch (e) {
    res.json({ data: [], source: 'error', error: e.message });
  }
});

// ---------- Period Comparison ----------
router.get('/dashboard/compare', async (req, res) => {
  try {
    const shopId = req.query.shop_id;
    
    let results;
    if ((process.env.APP_MODE || 'mock') === 'live') {
      // Both windows from the same daily rows, ending on Shopee's latest data date.
      const { days, rows } = await daily.dailySeries(await resolveShops(shopId), 'Last30d');
      const sumDays = (list) => list.reduce((t, d) => {
        const r = rows[d] || {};
        t.gmv += r.sales || 0; t.orders += r.orders || 0;
        t.commission += r.commission || 0; t.clicks += r.clicks || 0;
        return t;
      }, { gmv: 0, orders: 0, commission: 0, clicks: 0 });
      results = { Last7d: sumDays(days.slice(-7)), Last30d: sumDays(days) };
    } else {
      results = {
        Last7d: await latestSnapshotTotals('Last7d', { shopId }),
        Last30d: await latestSnapshotTotals('Last30d', { shopId }),
      };
    }

    // Calculate changes
    const r7 = results['Last7d'] || {};
    const r30 = results['Last30d'] || {};
    
    // Extrapolate 7d to 30d for fair comparison
    const r7ext = {
      gmv: r7.gmv * (30/7),
      orders: r7.orders * (30/7),
      commission: r7.commission * (30/7),
      clicks: r7.clicks * (30/7),
    };

    const pctChange = (curr, prev) => {
      if (prev === 0) return curr > 0 ? 100 : 0;
      return ((curr - prev) / prev * 100);
    };

    res.json({
      periods: {
        'Last7d': r7,
        'Last30d': r30,
        'Last7d_extrapolated': r7ext,
      },
      comparison: {
        gmv: {
          change_pct: Number(pctChange(r7ext.gmv, r30.gmv).toFixed(1)),
          direction: r7ext.gmv > r30.gmv ? 'up' : r7ext.gmv < r30.gmv ? 'down' : 'flat'
        },
        orders: {
          change_pct: Number(pctChange(r7ext.orders, r30.orders).toFixed(1)),
          direction: r7ext.orders > r30.orders ? 'up' : r7ext.orders < r30.orders ? 'down' : 'flat'
        },
        commission: {
          change_pct: Number(pctChange(r7ext.commission, r30.commission).toFixed(1)),
          direction: r7ext.commission > r30.commission ? 'up' : r7ext.commission < r30.commission ? 'down' : 'flat'
        },
      },
      insight: generateInsight(r7ext, r30)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Generate human-readable insight from comparison */
function generateInsight(r7ext, r30) {
  const insights = [];
  const gmvChange = r30.gmv > 0 ? ((r7ext.gmv - r30.gmv) / r30.gmv * 100) : 0;
  const commChange = r30.commission > 0 ? ((r7ext.commission - r30.commission) / r30.commission * 100) : 0;
  const orderChange = r30.orders > 0 ? ((r7ext.orders - r30.orders) / r30.orders * 100) : 0;

  if (gmvChange > 10) insights.push('📈 GMV tren naik ' + Math.abs(gmvChange).toFixed(0) + '% — performa membaik');
  else if (gmvChange < -10) insights.push('📉 GMV tren turun ' + Math.abs(gmvChange).toFixed(0) + '% — perlu perhatian');
  else insights.push('➡️ GMV stabil');

  if (commChange > 15) insights.push('💰 Komisi naik lebih cepat dari GMV — efisiensi meningkat');
  else if (commChange < -15) insights.push('⚠️ Komisi turun — cek rate komisi atau produk');

  if (orderChange > 10 && gmvChange < 5) insights.push('🛒 Order naik tapi GMV flat — avg order value turun');

  return insights;
}

// ---------- Alerts (anomaly detection) ----------
router.get('/alerts', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM alerts WHERE active = true ORDER BY created_at DESC LIMIT 50`
    );
    res.json({ data: rows });
  } catch (e) {
    // If table doesn't exist, return empty
    res.json({ data: [] });
  }
});

router.post('/alerts/check', async (_req, res) => {
  try {
    // Check for anomalies: affiliates with 0 orders in last 30d but had orders before
    const { rows: dropped } = await query(`
      SELECT a.name, a.username, a.shop_id,
             COALESCE(p.gmv, 0) AS current_gmv,
             COALESCE(p.orders, 0) AS current_orders
      FROM affiliates a
      LEFT JOIN LATERAL (
        SELECT * FROM affiliate_performance ap
        WHERE ap.affiliate_id = a.affiliate_id AND ap.shop_id = a.shop_id
          AND ap.period_type = 'Last30d'
        ORDER BY ap.synced_at DESC LIMIT 1
      ) p ON true
      WHERE COALESCE(p.orders, 0) = 0 AND COALESCE(p.gmv, 0) = 0
        AND a.status = 'active'
      LIMIT 10
    `);

    // GMV/commission drop: Last7d extrapolated to 30 days vs Last30d.
    const t30 = await latestSnapshotTotals('Last30d');
    const t7 = await latestSnapshotTotals('Last7d');

    const alerts = [];

    const { rows: expiredShops } = await query(
      `SELECT shop_id, shop_name FROM shops WHERE status = 'expired' ORDER BY shop_name`
    );
    if (expiredShops.length > 0) {
      alerts.push({
        type: 'critical',
        title: 'Token Toko Expired',
        message: `${expiredShops.map(sh => sh.shop_name || sh.shop_id).join(', ')} perlu diotorisasi ulang (menu Toko → Authorize ulang)`,
        created_at: new Date().toISOString()
      });
    }

    const gmv30 = t30.gmv;
    const gmv7ext = t7.gmv * (30 / 7);
    if (gmv30 > 0 && gmv7ext > 0 && gmv7ext < gmv30 * 0.7) {
      alerts.push({
        type: 'warning',
        title: 'GMV Turun Signifikan',
        message: `Extrapolasi dari data 7 hari (${formatRupiahShort(gmv7ext)}) < 70% dari 30 hari (${formatRupiahShort(gmv30)})`,
        created_at: new Date().toISOString()
      });
    }

    if (dropped.length > 0) {
      alerts.push({
        type: 'info',
        title: 'Afiliator Tidak Aktif',
        message: `${dropped.length} afiliator tidak punya order/GMV di periode ini`,
        created_at: new Date().toISOString()
      });
    }

    // Commission drop check
    const comm30 = t30.commission;
    const comm7ext = t7.commission * (30 / 7);
    if (comm30 > 0 && comm7ext > 0 && comm7ext < comm30 * 0.7) {
      alerts.push({
        type: 'warning',
        title: 'Komisi Turun',
        message: `Extrapolasi komisi 7 hari (${formatRupiahShort(comm7ext)}) turun dari 30 hari (${formatRupiahShort(comm30)})`,
        created_at: new Date().toISOString()
      });
    }

    // Store alerts
    for (const a of alerts) {
      await query(
        `INSERT INTO alerts (type, title, message, active) VALUES ($1, $2, $3, true)`,
        [a.type, a.title, a.message]
      ).catch(() => {});
    }

    res.json({ alerts, checked_at: new Date().toISOString() });
  } catch (e) {
    // If alerts table doesn't exist, just return empty
    res.json({ alerts: [], checked_at: new Date().toISOString() });
  }
});

// ---------- Export (CSV) ----------
/** Quote a CSV cell; a leading =+-@ is neutralised so Excel won't run it as a formula. */
function csvCell(v) {
  let str = String(v ?? '');
  if (/^[=+\-@]/.test(str)) str = "'" + str;
  return `"${str.replace(/"/g, '""')}"`;
}

router.get('/export/csv', async (req, res) => {
  try {
    const shopId = req.query.shop_id;
    const period = req.query.period || 'Last30d';
    const channel = shopee.normalizeChannel(req.query.channel && req.query.channel !== 'all' ? req.query.channel : null);

    const params = [period, channel];
    let sql = `
      SELECT a.name, a.username, s.shop_name, p.channel AS aff_channel,
             p.gmv, p.orders, p.clicks, p.est_commission AS commission, p.roi,
             p.total_buyers, p.new_buyers
      FROM (${LATEST_SNAPSHOT_SQL}) p
      JOIN affiliates a ON a.affiliate_id = p.affiliate_id AND a.shop_id = p.shop_id
      LEFT JOIN shops s ON s.shop_id = p.shop_id
    `;
    if (shopId && shopId !== 'all') {
      params.push(shopId);
      sql += ` WHERE p.shop_id = $${params.length}`;
    }
    sql += ` ORDER BY p.gmv DESC NULLS LAST`;

    const { rows } = await query(sql, params);

    // Build CSV
    const header = 'Nama,Username,Toko,Channel,GMV,Orders,Clicks,Komisi,ROI,Total Buyers,New Buyers';
    const csvRows = rows.map(r =>
      [r.name, r.username, r.shop_name, r.aff_channel].map(csvCell).join(',') + ',' +
      [r.gmv, r.orders, r.clicks, r.commission, r.roi, r.total_buyers, r.new_buyers].map(num).join(',')
    );
    const csv = [header, ...csvRows].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="affiliate-report-${period}-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send('\uFEFF' + csv); // BOM for Excel
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Commission Calculator ----------
router.post('/calculator/simulate', async (req, res) => {
  try {
    const { current_gmv, target_gmv, avg_commission_rate, avg_order_value } = req.body;
    const rate = Number(avg_commission_rate) / 100 || 0.06;
    const aov = Number(avg_order_value) || 300000;
    const currentGmv = Number(current_gmv) || 0;
    const targetGmv = Number(target_gmv) || 0;

    const currentOrders = Math.round(currentGmv / aov);
    const targetOrders = Math.round(targetGmv / aov);
    const additionalOrders = targetOrders - currentOrders;
    const additionalGmv = targetGmv - currentGmv;
    const additionalCommission = additionalGmv * rate;
    const totalCommission = targetGmv * rate;
    const progressPct = targetGmv > 0 ? Math.min(100, (currentGmv / targetGmv) * 100) : 0;

    res.json({
      current: { gmv: currentGmv, orders: currentOrders, commission: currentGmv * rate },
      target: { gmv: targetGmv, orders: targetOrders, commission: totalCommission },
      gap: { gmv: additionalGmv, orders: additionalOrders, commission: additionalCommission },
      progress_pct: Number(progressPct.toFixed(1)),
      assumptions: { commission_rate: (rate * 100).toFixed(1) + '%', avg_order_value: aov },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

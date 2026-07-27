const express = require('express');
const router = express.Router();
const { query } = require('../db');
const shopee = require('../services/shopee');

const PERIOD_DAYS = { Last1d: 1, Last7d: 7, Last30d: 30 };

/**
 * Resolve a period label into concrete dates.
 * Snapshots must carry start_date/end_date: they are part of the unique key,
 * and NULLs there make ON CONFLICT never match (Postgres treats NULL as
 * distinct), which would insert a duplicate row on every sync.
 */
function periodRange(periodType) {
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const end = new Date();

  // "Month" means month-to-date, not a rolling 30-day window.
  if (periodType === 'Month') {
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    return { startDate: fmt(start), endDate: fmt(end) };
  }

  const days = PERIOD_DAYS[periodType] || 30;
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  return { startDate: fmt(start), endDate: fmt(end) };
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

    let totalSynced = 0;
    const results = [];

    for (const shop of shops) {
      try {
        const token = await shopee.ensureValidToken(shop);
        const periodType = req.body?.period || 'Last30d';
        const channel = shopee.normalizeChannel(req.body?.channel);
        const { startDate, endDate } = periodRange(periodType);

        const list = await shopee.getAllAffiliatePerformance(shop.shop_id, token, { periodType, channel, startDate, endDate });
        let count = 0;

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
                gmv, orders, clicks, est_commission, roi, total_buyers, new_buyers, synced_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
             ON CONFLICT (affiliate_id, shop_id, period_type, start_date, end_date, channel)
             DO UPDATE SET
               gmv = EXCLUDED.gmv, orders = EXCLUDED.orders, clicks = EXCLUDED.clicks,
               est_commission = EXCLUDED.est_commission, roi = EXCLUDED.roi,
               total_buyers = EXCLUDED.total_buyers, new_buyers = EXCLUDED.new_buyers,
               synced_at = NOW()`,
            [a.affiliate_id, shop.shop_id, periodType, startDate, endDate, channel,
             Number(a.sales || 0), a.orders || 0, a.clicks || 0,
             Number(a.est_commission || 0), Number(a.roi || 0),
             a.total_buyers || 0, a.new_buyers || 0]
          );
          count++;
        }

        await query(`UPDATE shops SET last_sync_at = NOW() WHERE shop_id = $1`, [shop.shop_id]);
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
router.get('/affiliates', async (req, res) => {
  try {
    const shopId = req.query.shop_id;
    const channel = req.query.channel;
    const period = req.query.period || 'Last30d';
    const search = req.query.q || '';

    // Try live performance first if mode=live and shop has token
    const mode = process.env.APP_MODE || 'mock';
    let liveError = null;

    if (mode === 'live' && shopId) {
      const { rows: shops } = await query(`SELECT * FROM shops WHERE shop_id = $1`, [shopId]);
      if (shops.length && shops[0].access_token) {
        try {
          const token = await shopee.ensureValidToken(shops[0]);
          const rows = await shopee.getAllAffiliatePerformance(shopId, token, {
            periodType: period,
            channel,
          });

          const list = rows.map((a) => ({
            affiliate_id: a.affiliate_id,
            name: a.affiliate_name,
            username: a.affiliate_username,
            gmv: Number(a.sales || 0),
            orders: a.orders || 0,
            clicks: a.clicks || 0,
            commission: Number(a.est_commission || 0),
            roi: Number(a.roi || 0),
            total_buyers: a.total_buyers || 0,
            new_buyers: a.new_buyers || 0,
            channel: shopee.normalizeChannel(channel),
            status: 'active',
          }));

          return res.json({ data: list, source: 'live' });
        } catch (apiErr) {
          // Falling back to cache keeps the dashboard usable, but the reason
          // must reach the client or a misconfigured filter looks like "no data".
          console.error('[API] Live fetch failed, fallback to cache:', apiErr.message);
          liveError = apiErr.message;
        }
      }
    }

    // Fallback: cached DB
    // Use period_type filter if data exists for it, otherwise fall back to most recent
    let sql = `
      SELECT a.affiliate_id, a.name, a.username,
             COALESCE(a.channel, p.channel) AS channel,
             a.status, a.followers, a.shop_id, a.last_active_at,
             COALESCE(p.gmv, 0) AS gmv,
             COALESCE(p.orders, 0) AS orders,
             COALESCE(p.clicks, 0) AS clicks,
             COALESCE(p.est_commission, 0) AS commission,
             COALESCE(p.roi, 0) AS roi
      FROM affiliates a
      LEFT JOIN LATERAL (
        SELECT * FROM affiliate_performance ap
        WHERE ap.affiliate_id = a.affiliate_id
          AND ap.shop_id = a.shop_id
          AND ap.period_type = $1
        ORDER BY ap.synced_at DESC LIMIT 1
      ) p ON true
      WHERE 1=1
    `;
    // $1 is the period filter above; user filters continue from $2.
    const params = [period];
    let idx = 2;

    if (shopId && shopId !== 'all') {
      sql += ` AND a.shop_id = $${idx++}`;
      params.push(shopId);
    }
    if (channel && channel !== 'all') {
      sql += ` AND (a.channel ILIKE $${idx} OR p.channel ILIKE $${idx})`;
      params.push(channel);
      idx++;
    }
    if (search) {
      sql += ` AND (a.name ILIKE $${idx} OR a.username ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }
    sql += ` ORDER BY gmv DESC NULLS LAST LIMIT 200`;

    const { rows } = await query(sql, params);

    // If empty and mock mode → return seeded mock from memory is handled by frontend
    res.json({ data: rows, source: 'cache', ...(liveError ? { live_error: liveError } : {}) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Campaigns ----------
router.get('/campaigns', async (req, res) => {
  try {
    const shopId = req.query.shop_id;
    let sql = `SELECT * FROM campaigns`;
    const params = [];
    if (shopId && shopId !== 'all') {
      sql += ` WHERE shop_id = $1`;
      params.push(shopId);
    }
    sql += ` ORDER BY updated_at DESC LIMIT 50`;
    const { rows } = await query(sql, params);
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Dashboard Trend (daily GMV/orders) ----------
router.get('/dashboard/trend', async (req, res) => {
  try {
    const shopId = req.query.shop_id;
    const period = req.query.period || 'Last30d';
    const days = { Last7d: 7, Last30d: 30, Month: 30 }[period] || 30;

    const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
    const end = new Date();
    const start = new Date(end.getTime() - (days - 1) * 86400000);

    // Aggregate GMV/orders per day using synced_at date
    let sql = `
      SELECT
        TO_CHAR(synced_at AT TIME ZONE 'Asia/Jakarta', 'DD Mon') AS label,
        TO_CHAR(synced_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS date_key,
        SUM(gmv) AS gmv,
        SUM(orders) AS orders,
        SUM(est_commission) AS commission,
        SUM(clicks) AS clicks,
        COUNT(DISTINCT affiliate_id) AS affiliates
      FROM affiliate_performance
      WHERE synced_at >= $1
        AND synced_at < ($2::date + INTERVAL '1 day')
    `;
    const params = [start, end];
    let idx = 3;

    if (shopId && shopId !== 'all') {
      sql += ` AND shop_id = $${idx++}`;
      params.push(shopId);
    }

    sql += ` GROUP BY date_key, label ORDER BY date_key`;

    const { rows } = await query(sql, params);

    // Fill in missing days with zeros
    const dataMap = {};
    for (const r of rows) {
      dataMap[r.date_key] = {
        label: r.label,
        gmv: Number(r.gmv || 0),
        orders: Number(r.orders || 0),
        commission: Number(r.commission || 0),
        clicks: Number(r.clicks || 0),
        affiliates: Number(r.affiliates || 0),
      };
    }

    const labels = [];
    const gmv = [];
    const orders = [];
    const commissions = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start.getTime() + i * 86400000);
      const key = d.toISOString().slice(0, 10);
      const shortLabel = d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
      const entry = dataMap[key];
      labels.push(shortLabel);
      gmv.push(entry ? entry.gmv / 1e6 : 0); // convert to millions
      orders.push(entry ? entry.orders : 0);
      commissions.push(entry ? entry.commission : 0);
    }

    res.json({ labels, gmv, orders, commissions });
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
    const shopId = req.query.shop_id;
    const period = req.query.period || 'Last30d';
    const channel = req.query.channel && req.query.channel !== 'all'
      ? req.query.channel
      : 'AllChannel';

    // Aggregate over the newest snapshot per affiliate only. Summing the raw
    // table would double count: it holds one row per period/channel/date range.
    const params = [period, channel];
    let filter = `WHERE period_type = $1 AND channel = $2`;
    if (shopId && shopId !== 'all') {
      params.push(shopId);
      filter += ` AND shop_id = $${params.length}`; 
    }

    const sql = `
      SELECT
        COALESCE(SUM(gmv), 0) AS total_gmv,
        COALESCE(SUM(orders), 0) AS total_orders,
        COALESCE(SUM(est_commission), 0) AS total_commission,
        COALESCE(SUM(clicks), 0) AS total_clicks,
        COUNT(*) AS affiliate_count
      FROM (
        SELECT DISTINCT ON (affiliate_id, shop_id)
               affiliate_id, shop_id, gmv, orders, est_commission, clicks
        FROM affiliate_performance
        ${filter}
        ORDER BY affiliate_id, shop_id, synced_at DESC
      ) latest
    `;

    const { rows } = await query(sql, params);
    const s = rows[0] || {};
    const roi = s.total_commission > 0 ? (Number(s.total_gmv) / Number(s.total_commission)) : 0;

    res.json({
      total_gmv: Number(s.total_gmv),
      total_orders: Number(s.total_orders),
      total_commission: Number(s.total_commission),
      total_clicks: Number(s.total_clicks),
      affiliate_count: Number(s.affiliate_count),
      avg_roi: Number(roi.toFixed(2)),
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

    const shop = rows[0];
    const token = await shopee.ensureValidToken(shop);

    const periodType = req.body?.period || 'Last30d';
    const channel = shopee.normalizeChannel(req.body?.channel);
    const { startDate, endDate } = periodRange(periodType);

    // Fetch every page — page_size is capped at 50, so one call is not enough.
    const list = await shopee.getAllAffiliatePerformance(shopId, token, {
      periodType,
      channel,
      startDate,
      endDate,
    });
    let upserted = 0;

    for (const a of list) {
      // Upsert affiliate
      await query(
        `INSERT INTO affiliates (affiliate_id, shop_id, name, username, channel, status)
         VALUES ($1, $2, $3, $4, $5, 'active')
         ON CONFLICT (affiliate_id, shop_id) DO UPDATE SET
           name = EXCLUDED.name,
           username = EXCLUDED.username,
           channel = EXCLUDED.channel,
           updated_at = NOW()`,
        [a.affiliate_id, shopId, a.affiliate_name, a.affiliate_username, channel]
      );

      // Upsert performance
      await query(
        `INSERT INTO affiliate_performance
           (affiliate_id, shop_id, period_type, start_date, end_date, channel,
            gmv, orders, clicks, est_commission, roi, total_buyers, new_buyers, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
         ON CONFLICT (affiliate_id, shop_id, period_type, start_date, end_date, channel)
         DO UPDATE SET
           gmv = EXCLUDED.gmv,
           orders = EXCLUDED.orders,
           clicks = EXCLUDED.clicks,
           est_commission = EXCLUDED.est_commission,
           roi = EXCLUDED.roi,
           total_buyers = EXCLUDED.total_buyers,
           new_buyers = EXCLUDED.new_buyers,
           synced_at = NOW()`,
        [
          a.affiliate_id,
          shopId,
          periodType,
          startDate,
          endDate,
          channel,
          Number(a.sales || 0),
          a.orders || 0,
          a.clicks || 0,
          Number(a.est_commission || 0),
          Number(a.roi || 0),
          a.total_buyers || 0,
          a.new_buyers || 0,
        ]
      );
      upserted++;
    }

    await query(`UPDATE shops SET last_sync_at = NOW() WHERE shop_id = $1`, [shopId]);
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
/**
 * Sync campaigns for a single shop from the Shopee AMS API.
 * Stores them in the campaigns table (upsert by campaign_id + shop_id).
 */
router.post('/sync/campaigns/:shopId', async (req, res) => {
  const shopId = req.params.shopId;
  const mode = process.env.APP_MODE || 'mock';
  if (mode !== 'live') {
    return res.json({ message: 'Mode mock — sync campaigns dilewati.', synced: 0 });
  }

  try {
    const { rows } = await query(`SELECT * FROM shops WHERE shop_id = $1`, [shopId]);
    if (!rows.length) return res.status(404).json({ error: 'Shop not found' });

    const shop = rows[0];
    const token = await shopee.ensureValidToken(shop);

    // Fetch all pages of campaigns
    let pageNo = 1;
    let allCampaigns = [];
    const pageSize = 50;
    while (true) {
      const res2 = await shopee.getManagedCampaignList(shopId, token, pageNo, pageSize);
      const list = res2.response?.campaign_list || res2.response?.list || [];
      allCampaigns.push(...list);
      const more = res2.response?.more ?? res2.response?.has_next_page;
      if (more === false || list.length < pageSize) break;
      pageNo++;
      if (pageNo > 50) break; // safety limit
    }

    let upserted = 0;
    for (const c of allCampaigns) {
      const campaignId = c.campaign_id || c.id;
      if (!campaignId) continue;

      await query(
        `INSERT INTO campaigns (campaign_id, shop_id, name, type, status, commission_info,
                                products_count, affiliates_count, period_start, period_end, raw_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (campaign_id, shop_id) DO UPDATE SET
           name = EXCLUDED.name,
           type = EXCLUDED.type,
           status = EXCLUDED.status,
           commission_info = EXCLUDED.commission_info,
           products_count = EXCLUDED.products_count,
           affiliates_count = EXCLUDED.affiliates_count,
           period_start = EXCLUDED.period_start,
           period_end = EXCLUDED.period_end,
           raw_data = EXCLUDED.raw_data,
           updated_at = NOW()`,
        [
          campaignId,
          shopId,
          c.name || c.campaign_name || null,
          c.type || c.campaign_type || null,
          c.status || c.campaign_status || null,
          c.commission_info || c.commission_rate || null,
          c.products_count || 0,
          c.affiliates_count || 0,
          c.period_start || c.start_time || null,
          c.period_end || c.end_time || null,
          JSON.stringify(c),
        ]
      );
      upserted++;
    }

    await query(
      `INSERT INTO sync_logs (shop_id, action, status, message) VALUES ($1, 'sync_campaigns', 'success', $2)`,
      [shopId, `Synced ${upserted} campaigns for shop ${shopId}`]
    ).catch(() => {});

    res.json({ success: true, synced: upserted, total_fetched: allCampaigns.length });
  } catch (e) {
    await query(
      `INSERT INTO sync_logs (shop_id, action, status, message) VALUES ($1, 'sync_campaigns', 'error', $2)`,
      [shopId, e.message]
    ).catch(() => {});
    res.status(500).json({ error: e.message });
  }
});

/**
 * Sync campaigns for ALL active shops.
 */
router.get('/campaigns/sync-all', async (_req, res) => {
  const mode = process.env.APP_MODE || 'mock';
  if (mode !== 'live') {
    return res.json({ message: 'Mode mock — sync campaigns dilewati.', synced: 0 });
  }

  try {
    const { rows: shops } = await query(`SELECT * FROM shops WHERE status = 'active' ORDER BY shop_name`);
    if (!shops.length) return res.json({ message: 'Tidak ada toko aktif.', synced: 0 });

    let totalSynced = 0;
    const results = [];

    for (const shop of shops) {
      try {
        const token = await shopee.ensureValidToken(shop);

        let pageNo = 1;
        let allCampaigns = [];
        const pageSize = 50;
        while (true) {
          const res2 = await shopee.getManagedCampaignList(shop.shop_id, token, pageNo, pageSize);
          const list = res2.response?.campaign_list || res2.response?.list || [];
          allCampaigns.push(...list);
          const more = res2.response?.more ?? res2.response?.has_next_page;
          if (more === false || list.length < pageSize) break;
          pageNo++;
          if (pageNo > 50) break;
        }

        let count = 0;
        for (const c of allCampaigns) {
          const campaignId = c.campaign_id || c.id;
          if (!campaignId) continue;

          await query(
            `INSERT INTO campaigns (campaign_id, shop_id, name, type, status, commission_info,
                                    products_count, affiliates_count, period_start, period_end, raw_data)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (campaign_id, shop_id) DO UPDATE SET
               name = EXCLUDED.name,
               type = EXCLUDED.type,
               status = EXCLUDED.status,
               commission_info = EXCLUDED.commission_info,
               products_count = EXCLUDED.products_count,
               affiliates_count = EXCLUDED.affiliates_count,
               period_start = EXCLUDED.period_start,
               period_end = EXCLUDED.period_end,
               raw_data = EXCLUDED.raw_data,
               updated_at = NOW()`,
            [
              campaignId,
              shop.shop_id,
              c.name || c.campaign_name || null,
              c.type || c.campaign_type || null,
              c.status || c.campaign_status || null,
              c.commission_info || c.commission_rate || null,
              c.products_count || 0,
              c.affiliates_count || 0,
              c.period_start || c.start_time || null,
              c.period_end || c.end_time || null,
              JSON.stringify(c),
            ]
          );
          count++;
        }
        totalSynced += count;
        results.push({ shop_id: shop.shop_id, name: shop.shop_name, synced: count });
      } catch (e) {
        console.error(`[CAMPAIGN-SYNC-ALL] Shop ${shop.shop_id} gagal:`, e.message);
        results.push({ shop_id: shop.shop_id, name: shop.shop_name, error: e.message });
      }
    }

    await query(
      `INSERT INTO sync_logs (shop_id, action, status, message) VALUES (0, 'sync_campaigns_all', 'success', $1)`,
      [`Synced ${totalSynced} campaigns from ${shops.length} shops`]
    ).catch(() => {});

    res.json({ success: true, total: totalSynced, shops: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


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

    // Check for total GMV drop vs previous period (compare Last30d vs Last7d extrapolated)
    const { rows: summary } = await query(`
      SELECT
        SUM(CASE WHEN period_type = 'Last30d' THEN gmv ELSE 0 END) AS gmv_30d,
        SUM(CASE WHEN period_type = 'Last7d' THEN gmv * 4 ELSE 0 END) AS gmv_7d_extrapolated,
        SUM(CASE WHEN period_type = 'Last30d' THEN orders ELSE 0 END) AS orders_30d,
        SUM(CASE WHEN period_type = 'Last7d' THEN orders * 4 ELSE 0 END) AS orders_7d_extrapolated
      FROM affiliate_performance
      WHERE period_type IN ('Last30d', 'Last7d')
    `);

    const alerts = [];
    const s = summary[0] || {};
    const gmv30 = Number(s.gmv_30d || 0);
    const gmv7ext = Number(s.gmv_7d_extrapolated || 0);
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
    const { rows: commRows } = await query(`
      SELECT
        SUM(CASE WHEN period_type = 'Last30d' THEN est_commission ELSE 0 END) AS comm_30d,
        SUM(CASE WHEN period_type = 'Last7d' THEN est_commission * 4 ELSE 0 END) AS comm_7d_ext
      FROM affiliate_performance
      WHERE period_type IN ('Last30d', 'Last7d')
    `);
    const c = commRows[0] || {};
    const comm30 = Number(c.comm_30d || 0);
    const comm7ext = Number(c.comm_7d_ext || 0);
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
router.get('/export/csv', async (req, res) => {
  try {
    const shopId = req.query.shop_id;
    const period = req.query.period || 'Last30d';
    const channel = req.query.channel && req.query.channel !== 'all' ? req.query.channel : null;

    let sql = `
      SELECT a.name, a.username, a.channel AS aff_channel,
             COALESCE(p.gmv, 0) AS gmv,
             COALESCE(p.orders, 0) AS orders,
             COALESCE(p.clicks, 0) AS clicks,
             COALESCE(p.est_commission, 0) AS commission,
             COALESCE(p.roi, 0) AS roi,
             COALESCE(p.total_buyers, 0) AS total_buyers,
             COALESCE(p.new_buyers, 0) AS new_buyers,
             p.period_type, p.start_date, p.end_date
      FROM affiliates a
      LEFT JOIN LATERAL (
        SELECT * FROM affiliate_performance ap
        WHERE ap.affiliate_id = a.affiliate_id AND ap.shop_id = a.shop_id
          AND ap.period_type = $1
        ORDER BY ap.synced_at DESC LIMIT 1
      ) p ON true
      WHERE 1=1
    `;
    const params = [period];
    let idx = 2;

    if (shopId && shopId !== 'all') {
      sql += ` AND a.shop_id = $${idx++}`;
      params.push(shopId);
    }
    if (channel) {
      sql += ` AND p.channel = $${idx++}`;
      params.push(channel);
    }
    sql += ` ORDER BY gmv DESC NULLS LAST`;

    const { rows } = await query(sql, params);

    // Build CSV
    const header = 'Nama,Username,Channel,GMV,Orders,Clicks,Komisi,ROI,Total Buyers,New Buyers';
    const csvRows = rows.map(r =>
      `"${(r.name || '').replace(/"/g, '""')}","${r.username || ''}","${r.aff_channel || ''}",${r.gmv},${r.orders},${r.clicks},${r.commission},${r.roi},${r.total_buyers},${r.new_buyers}`
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

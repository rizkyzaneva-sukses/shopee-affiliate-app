const express = require('express');
const router = express.Router();
const { query } = require('../db');
const shopee = require('../services/shopee');

// ---------- Health ----------
router.get('/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', mode: process.env.APP_MODE || 'mock', time: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
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

    if (mode === 'live' && shopId) {
      const { rows: shops } = await query(`SELECT * FROM shops WHERE shop_id = $1`, [shopId]);
      if (shops.length && shops[0].access_token) {
        try {
          const token = await shopee.ensureValidToken(shops[0]);
          const result = await shopee.getAffiliatePerformance(shopId, token, {
            periodType: period,
            channel: channel === 'all' || !channel ? 'AllChannel' : channel,
            pageSize: 100,
          });

          const list = (result.response?.list || []).map((a) => ({
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
            channel: channel || 'AllChannel',
            status: 'active',
          }));

          return res.json({ data: list, source: 'live' });
        } catch (apiErr) {
          console.error('[API] Live fetch failed, fallback to cache:', apiErr.message);
        }
      }
    }

    // Fallback: cached DB or mock
    let sql = `
      SELECT a.affiliate_id, a.name, a.username, a.channel, a.status, a.followers,
             a.shop_id, a.last_active_at,
             COALESCE(p.gmv, 0) AS gmv,
             COALESCE(p.orders, 0) AS orders,
             COALESCE(p.clicks, 0) AS clicks,
             COALESCE(p.est_commission, 0) AS commission,
             COALESCE(p.roi, 0) AS roi
      FROM affiliates a
      LEFT JOIN LATERAL (
        SELECT * FROM affiliate_performance ap
        WHERE ap.affiliate_id = a.affiliate_id AND ap.shop_id = a.shop_id
        ORDER BY ap.synced_at DESC LIMIT 1
      ) p ON true
      WHERE 1=1
    `;
    const params = [];
    let idx = 1;

    if (shopId && shopId !== 'all') {
      sql += ` AND a.shop_id = $${idx++}`;
      params.push(shopId);
    }
    if (channel && channel !== 'all') {
      sql += ` AND a.channel ILIKE $${idx++}`;
      params.push(channel);
    }
    if (search) {
      sql += ` AND (a.name ILIKE $${idx} OR a.username ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }
    sql += ` ORDER BY gmv DESC NULLS LAST LIMIT 200`;

    const { rows } = await query(sql, params);

    // If empty and mock mode → return seeded mock from memory is handled by frontend
    res.json({ data: rows, source: 'cache' });
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

// ---------- Dashboard summary ----------
router.get('/dashboard/summary', async (req, res) => {
  try {
    const shopId = req.query.shop_id;

    // Simple aggregate from performance table
    let sql = `
      SELECT
        COALESCE(SUM(gmv), 0) AS total_gmv,
        COALESCE(SUM(orders), 0) AS total_orders,
        COALESCE(SUM(est_commission), 0) AS total_commission,
        COALESCE(SUM(clicks), 0) AS total_clicks,
        COUNT(DISTINCT affiliate_id) AS affiliate_count
      FROM affiliate_performance
      WHERE 1=1
    `;
    const params = [];
    if (shopId && shopId !== 'all') {
      sql += ` AND shop_id = $1`;
      params.push(shopId);
    }

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

    // Fetch performance
    const perf = await shopee.getAffiliatePerformance(shopId, token, {
      periodType: 'Last30d',
      pageSize: 100,
    });

    const list = perf.response?.list || [];
    let upserted = 0;

    for (const a of list) {
      // Upsert affiliate
      await query(
        `INSERT INTO affiliates (affiliate_id, shop_id, name, username, status)
         VALUES ($1, $2, $3, $4, 'active')
         ON CONFLICT (affiliate_id, shop_id) DO UPDATE SET
           name = EXCLUDED.name,
           username = EXCLUDED.username,
           updated_at = NOW()`,
        [a.affiliate_id, shopId, a.affiliate_name, a.affiliate_username]
      );

      // Upsert performance
      await query(
        `INSERT INTO affiliate_performance
           (affiliate_id, shop_id, period_type, gmv, orders, clicks, est_commission, roi, total_buyers, new_buyers, synced_at)
         VALUES ($1, $2, 'Last30d', $3, $4, $5, $6, $7, $8, $9, NOW())
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

module.exports = router;

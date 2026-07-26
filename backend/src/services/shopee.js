/**
 * Shopee Open Platform AMS API Service
 * Handles signature generation + common calls
 */

const crypto = require('crypto');
const { query } = require('../db');

function getConfig() {
  return {
    partnerId: process.env.SHOPEE_PARTNER_ID || '',
    partnerKey: process.env.SHOPEE_PARTNER_KEY || '',
    baseUrl: process.env.SHOPEE_BASE_URL || 'https://partner.shopeemobile.com',
    region: process.env.SHOPEE_REGION || 'ID',
    mode: process.env.APP_MODE || 'mock',
  };
}

/**
 * Generate HMAC-SHA256 signature for Shopee v2 API
 * Base string order matters:
 * Shop API: partner_id + path + timestamp + access_token + shop_id
 * Public API: partner_id + path + timestamp
 */
function generateSign(path, timestamp, accessToken = '', shopId = '') {
  const { partnerId, partnerKey } = getConfig();
  const base = `${partnerId}${path}${timestamp}${accessToken}${shopId}`;
  return crypto.createHmac('sha256', partnerKey).update(base).digest('hex');
}

async function shopeeRequest({ method = 'GET', path, shopId, accessToken, body = null, queryParams = {} }) {
  const cfg = getConfig();
  if (cfg.mode === 'mock') {
    throw new Error('APP_MODE is mock — real API disabled');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const sign = generateSign(path, timestamp, accessToken || '', shopId || '');

  const params = new URLSearchParams({
    partner_id: cfg.partnerId,
    timestamp: String(timestamp),
    sign,
    ...(accessToken ? { access_token: accessToken } : {}),
    ...(shopId ? { shop_id: shopId } : {}),
    ...queryParams,
  });

  const url = `${cfg.baseUrl}${path}?${params.toString()}`;
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const data = await res.json();

  if (data.error) {
    const err = new Error(data.message || data.error);
    err.code = data.error;
    err.requestId = data.request_id;
    throw err;
  }
  return data;
}

// ---------- High level helpers ----------

async function getShopsByPartner() {
  return shopeeRequest({
    method: 'GET',
    path: '/api/v2/public/get_shops_by_partner',
    queryParams: { page_size: 100, page_no: 1 },
  });
}

async function getAffiliatePerformance(shopId, accessToken, opts = {}) {
  const {
    periodType = 'Last30d',
    startDate,
    endDate,
    channel = 'AllChannel',
    orderType = 'ConfirmedOrder',
    pageNo = 1,
    pageSize = 50,
    affiliateId,
  } = opts;

  const queryParams = {
    period_type: periodType,
    channel,
    order_type: orderType,
    page_no: pageNo,
    page_size: pageSize,
  };
  if (startDate) queryParams.start_date = startDate;
  if (endDate) queryParams.end_date = endDate;
  if (affiliateId) queryParams.affiliate_id = affiliateId;

  return shopeeRequest({
    method: 'GET',
    path: '/api/v2/ams/get_affiliate_performance',
    shopId,
    accessToken,
    queryParams,
  });
}

async function getManagedAffiliateList(shopId, accessToken, pageNo = 1, pageSize = 50) {
  return shopeeRequest({
    method: 'GET',
    path: '/api/v2/ams/get_managed_affiliate_list',
    shopId,
    accessToken,
    queryParams: { page_no: pageNo, page_size: pageSize },
  });
}

async function refreshAccessToken(shopId, refreshToken) {
  const cfg = getConfig();
  const path = '/api/v2/auth/access_token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = generateSign(path, timestamp);

  const url = `${cfg.baseUrl}${path}?partner_id=${cfg.partnerId}&timestamp=${timestamp}&sign=${sign}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refresh_token: refreshToken,
      partner_id: Number(cfg.partnerId),
      shop_id: Number(shopId),
    }),
  });
  return res.json();
}

/**
 * Ensure token is valid, refresh if needed
 */
async function ensureValidToken(shop) {
  if (!shop.access_token || !shop.refresh_token) {
    throw new Error(`Shop ${shop.shop_id} belum punya token. Lakukan authorization dulu.`);
  }

  const expireAt = shop.token_expire_at ? new Date(shop.token_expire_at).getTime() : 0;
  const bufferMs = 30 * 60 * 1000; // 30 menit

  if (Date.now() < expireAt - bufferMs) {
    return shop.access_token;
  }

  // Refresh
  const result = await refreshAccessToken(shop.shop_id, shop.refresh_token);
  if (result.error) {
    throw new Error(`Refresh token gagal: ${result.message || result.error}`);
  }

  const newExpire = new Date(Date.now() + (result.expire_in || 14400) * 1000);
  await query(
    `UPDATE shops SET access_token = $1, refresh_token = $2, token_expire_at = $3, updated_at = NOW()
     WHERE shop_id = $4`,
    [result.access_token, result.refresh_token || shop.refresh_token, newExpire, shop.shop_id]
  );

  return result.access_token;
}

module.exports = {
  getConfig,
  generateSign,
  shopeeRequest,
  getShopsByPartner,
  getAffiliatePerformance,
  getManagedAffiliateList,
  refreshAccessToken,
  ensureValidToken,
};

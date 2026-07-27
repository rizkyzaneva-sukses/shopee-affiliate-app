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
    redirectUri: process.env.SHOPEE_REDIRECT_URI || '',
    region: process.env.SHOPEE_REGION || 'ID',
    mode: process.env.APP_MODE || 'mock',
  };
}

/**
 * Validate that credentials needed for live calls are present.
 * Throws a message the user can act on instead of letting Shopee reply 403.
 */
function assertCredentials() {
  const { partnerId, partnerKey } = getConfig();
  const missing = [];
  if (!partnerId) missing.push('SHOPEE_PARTNER_ID');
  if (!partnerKey) missing.push('SHOPEE_PARTNER_KEY');
  if (missing.length) {
    throw new Error(
      `Kredensial Shopee belum diisi: ${missing.join(', ')}. ` +
      'Daftarkan app di https://open.shopee.com/ untuk mendapatkannya.'
    );
  }
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

// ---------- Authorization (OAuth) ----------

const AUTH_PARTNER_PATH = '/api/v2/shop/auth_partner';
const TOKEN_GET_PATH = '/api/v2/auth/token/get';
const TOKEN_REFRESH_PATH = '/api/v2/auth/access_token/get';

/**
 * Build the Shopee shop-authorization URL.
 * The seller opens this, approves, and Shopee redirects to
 * `redirect` with ?code=...&shop_id=... appended.
 * Link is only valid for 5 minutes — always build it on demand.
 */
function buildAuthUrl(redirectUri) {
  assertCredentials();
  const cfg = getConfig();
  const redirect = redirectUri || cfg.redirectUri;
  if (!redirect) {
    throw new Error('SHOPEE_REDIRECT_URI belum diisi. Contoh: https://domain-anda.com/api/auth/callback');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  // redirect is NOT part of the signed base string
  const sign = generateSign(AUTH_PARTNER_PATH, timestamp);

  const params = new URLSearchParams({
    partner_id: cfg.partnerId,
    timestamp: String(timestamp),
    sign,
    redirect,
  });

  return `${cfg.baseUrl}${AUTH_PARTNER_PATH}?${params.toString()}`;
}

/**
 * Exchange the one-time `code` from the auth callback for tokens.
 * Public API: signed with partner_id + path + timestamp only.
 */
async function getAccessToken(code, shopId) {
  assertCredentials();
  const cfg = getConfig();
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = generateSign(TOKEN_GET_PATH, timestamp);

  const url = `${cfg.baseUrl}${TOKEN_GET_PATH}?partner_id=${cfg.partnerId}&timestamp=${timestamp}&sign=${sign}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      shop_id: Number(shopId),
      partner_id: Number(cfg.partnerId),
    }),
  });

  const data = await res.json();
  if (data.error) {
    const err = new Error(data.message || data.error);
    err.code = data.error;
    err.requestId = data.request_id;
    throw err;
  }
  return data; // { access_token, refresh_token, expire_in }
}

/**
 * Fetch shop profile so we can store a real name instead of a bare ID.
 * Note: get_shop_info returns its fields flat, not nested under `response`.
 */
async function getShopInfo(shopId, accessToken) {
  return shopeeRequest({
    method: 'GET',
    path: '/api/v2/shop/get_shop_info',
    shopId,
    accessToken,
  });
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

/**
 * Shopee rejected page_size=100 with "invalid page_size", so the ceiling is
 * lower than the usual v2 limit. 50 is the documented default for AMS list
 * endpoints; override with SHOPEE_PAGE_SIZE if your app's quota differs.
 */
function getPageSize() {
  const raw = Number(process.env.SHOPEE_PAGE_SIZE || 50);
  if (!Number.isFinite(raw) || raw < 1) return 50;
  return Math.min(Math.floor(raw), 50);
}

/**
 * Channel filter values the AMS API accepts. The dashboard's <select> uses
 * short keys, which must never be forwarded raw — Shopee rejects them.
 * Anything unrecognised degrades to AllChannel rather than erroring the sync.
 */
const CHANNEL_MAP = {
  all: 'AllChannel',
  allchannel: 'AllChannel',
  social: 'SocialMedia',
  'social media': 'SocialMedia',
  socialmedia: 'SocialMedia',
  video: 'ShopeeVideo',
  'shopee video': 'ShopeeVideo',
  shopeevideo: 'ShopeeVideo',
  live: 'LiveStreaming',
  'live streaming': 'LiveStreaming',
  livestreaming: 'LiveStreaming',
};

function normalizeChannel(channel) {
  if (!channel) return 'AllChannel';
  const hit = CHANNEL_MAP[String(channel).trim().toLowerCase()];
  if (!hit) {
    console.warn(`[SHOPEE] channel "${channel}" tidak dikenal — pakai AllChannel`);
    return 'AllChannel';
  }
  return hit;
}

async function getShopsByPartner() {
  return shopeeRequest({
    method: 'GET',
    path: '/api/v2/public/get_shops_by_partner',
    queryParams: { page_size: getPageSize(), page_no: 1 },
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
    pageSize = getPageSize(),
    affiliateId,
  } = opts;

  const queryParams = {
    period_type: periodType,
    channel: normalizeChannel(channel),
    order_type: orderType,
    page_no: pageNo,
    page_size: Math.min(Number(pageSize) || getPageSize(), 50),
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

/**
 * The AMS page_size ceiling is not documented anywhere we can reach, and the
 * live API rejected both 100 and 50. Rather than guess-and-redeploy, probe
 * downwards once and remember what the API accepted for the rest of the
 * process lifetime.
 */
const PAGE_SIZE_CANDIDATES = [50, 30, 20, 10, 5, 1];
let negotiatedPageSize = null;

function isInvalidPageSizeError(err) {
  return /page_size/i.test(err?.message || '') || /page_size/i.test(err?.code || '');
}

/** Candidates to try, honouring an explicit SHOPEE_PAGE_SIZE first. */
function pageSizeCandidates() {
  const configured = process.env.SHOPEE_PAGE_SIZE ? getPageSize() : null;
  const rest = PAGE_SIZE_CANDIDATES.filter((n) => n !== configured);
  return configured ? [configured, ...rest] : [...PAGE_SIZE_CANDIDATES];
}

/**
 * Fetch one page, discovering an acceptable page_size on first use.
 * Only "invalid page_size" triggers a retry — any other error propagates,
 * so a bad token or wrong channel still fails loudly instead of looping.
 */
async function fetchPageWithNegotiation(shopId, accessToken, opts, pageNo) {
  if (negotiatedPageSize) {
    return {
      res: await getAffiliatePerformance(shopId, accessToken, {
        ...opts, pageNo, pageSize: negotiatedPageSize,
      }),
      pageSize: negotiatedPageSize,
    };
  }

  let lastErr;
  for (const size of pageSizeCandidates()) {
    try {
      const res = await getAffiliatePerformance(shopId, accessToken, {
        ...opts, pageNo, pageSize: size,
      });
      negotiatedPageSize = size;
      console.log(`[SHOPEE] page_size ${size} diterima — dipakai untuk request berikutnya`);
      return { res, pageSize: size };
    } catch (e) {
      if (!isInvalidPageSizeError(e)) throw e;
      console.warn(`[SHOPEE] page_size ${size} ditolak, coba lebih kecil`);
      lastErr = e;
    }
  }
  throw lastErr;
}

/**
 * Walk every page of affiliate performance.
 * A single page does not cover a full roster once page_size is small,
 * so callers that need the whole list must paginate.
 */
async function getAllAffiliatePerformance(shopId, accessToken, opts = {}, maxPages = 200) {
  const all = [];

  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const { res, pageSize } = await fetchPageWithNegotiation(shopId, accessToken, opts, pageNo);
    const list = res.response?.list || [];
    all.push(...list);

    // Stop on an explicit "no more pages" flag, or on a short/empty page.
    const more = res.response?.more ?? res.response?.has_next_page;
    if (more === false || list.length < pageSize) break;

    if (pageNo === maxPages) {
      console.warn(`[SHOPEE] shop ${shopId}: berhenti di ${maxPages} halaman, mungkin masih ada sisa`);
    }
  }

  return all;
}

/**
 * Diagnostic: report which page_size values the live API actually accepts.
 * Exists because the error message alone does not reveal the valid range.
 */
async function probePageSizes(shopId, accessToken, sizes = [100, 50, 30, 20, 10, 5, 1]) {
  const results = [];
  for (const size of sizes) {
    try {
      const res = await getAffiliatePerformance(shopId, accessToken, { pageNo: 1, pageSize: size });
      results.push({ page_size: size, ok: true, returned: (res.response?.list || []).length });
    } catch (e) {
      results.push({ page_size: size, ok: false, error: e.message, code: e.code });
    }
  }
  return results;
}

async function getManagedAffiliateList(shopId, accessToken, pageNo = 1, pageSize = getPageSize()) {
  return shopeeRequest({
    method: 'GET',
    path: '/api/v2/ams/get_managed_affiliate_list',
    shopId,
    accessToken,
    queryParams: { page_no: pageNo, page_size: Math.min(Number(pageSize) || 50, 50) },
  });
}

async function getManagedCampaignList(shopId, accessToken, pageNo = 1, pageSize = getPageSize()) {
  return shopeeRequest({
    method: 'GET',
    path: '/api/v2/ams/get_managed_campaign_list',
    shopId,
    accessToken,
    queryParams: { page_no: pageNo, page_size: Math.min(Number(pageSize) || 50, 50) },
  });
}

async function refreshAccessToken(shopId, refreshToken) {
  assertCredentials();
  const cfg = getConfig();
  const path = TOKEN_REFRESH_PATH;
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
  assertCredentials,
  generateSign,
  buildAuthUrl,
  getAccessToken,
  getShopInfo,
  shopeeRequest,
  getShopsByPartner,
  getPageSize,
  normalizeChannel,
  getAffiliatePerformance,
  getAllAffiliatePerformance,
  probePageSizes,
  getManagedAffiliateList,
  getManagedCampaignList,
  refreshAccessToken,
  ensureValidToken,
};

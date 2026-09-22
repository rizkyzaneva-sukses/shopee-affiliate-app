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

// ---------- Period ranges ----------

/**
 * AMS data lags behind the calendar (usually by a day), and every
 * performance endpoint requires end_date == the latest data date for
 * Last7d/Last30d/current Month — using "today" fails with
 * "invalid time range". Cached per shop, since it moves once a day.
 */
const LATEST_DATE_TTL_MS = 30 * 60 * 1000;
const latestDateCache = new Map();

async function getLatestDataDate(shopId, accessToken) {
  const key = String(shopId);
  const hit = latestDateCache.get(key);
  if (hit && Date.now() - hit.at < LATEST_DATE_TTL_MS) return hit.date;

  const data = await shopeeRequest({
    method: 'GET',
    path: '/api/v2/ams/get_performance_data_update_time',
    shopId,
    accessToken,
    queryParams: { marker_type: 'AmsMarker' },
  });
  const date = data.response?.last_report_date; // "YYYY-MM-DD"
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    throw new Error(`last_report_date tidak valid dari Shopee: ${JSON.stringify(date)}`);
  }
  latestDateCache.set(key, { at: Date.now(), date });
  return date;
}

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const addDays = (isoDate, n) => new Date(Date.parse(isoDate + 'T00:00:00Z') + n * 86400000);

/**
 * start_date/end_date (YYYYMMDD) that satisfy Shopee's alignment rules,
 * given the latest data date (YYYY-MM-DD). "Month" is the month-to-date of
 * the latest data date. "Day" takes an explicit date.
 */
function amsRange(periodType, latestDate, day) {
  const end = addDays(latestDate, 0);
  switch (periodType) {
    case 'Day': {
      const d = addDays(day || latestDate, 0);
      return { startDate: ymd(d), endDate: ymd(d) };
    }
    case 'Last7d':
      return { startDate: ymd(addDays(latestDate, -6)), endDate: ymd(end) };
    case 'Month':
      return { startDate: latestDate.slice(0, 8).replace(/-/g, '') + '01', endDate: ymd(end) };
    case 'Last30d':
    default:
      return { startDate: ymd(addDays(latestDate, -29)), endDate: ymd(end) };
  }
}

/** Resolve the range for a shop in one call. */
async function shopRange(shopId, accessToken, periodType, day) {
  const latest = await getLatestDataDate(shopId, accessToken);
  return { ...amsRange(periodType, latest, day), latestDate: latest };
}

/**
 * Walk a paginated AMS endpoint until has_more is false.
 * `fetchPage(pageNo)` returns the raw Shopee reply; `listKey` names the array.
 */
async function fetchAllPages(fetchPage, { pageSize, listKey = 'list', maxPages = 200 } = {}) {
  const all = [];
  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const res = await fetchPage(pageNo);
    const list = res.response?.[listKey] || [];
    all.push(...list);
    const total = res.response?.total_count;
    if (res.response?.has_more === false || list.length < pageSize) break;
    if (typeof total === 'number' && all.length >= total) break;
  }
  return all;
}

// ---------- High level helpers ----------

/**
 * AMS performance endpoints (affiliate/product/content) accept page_size 1–20.
 * SHOPEE_PAGE_SIZE may lower it, never raise it.
 */
const AMS_MAX_PAGE_SIZE = 20;

function getPageSize() {
  const raw = Number(process.env.SHOPEE_PAGE_SIZE || AMS_MAX_PAGE_SIZE);
  if (!Number.isFinite(raw) || raw < 1) return AMS_MAX_PAGE_SIZE;
  return Math.min(Math.floor(raw), AMS_MAX_PAGE_SIZE);
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
    page_size: Math.min(Number(pageSize) || getPageSize(), AMS_MAX_PAGE_SIZE),
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
const PAGE_SIZE_CANDIDATES = [20, 10, 5, 1];
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

    // Stop on Shopee's has_more flag, or on a short/empty page.
    if (res.response?.has_more === false || list.length < pageSize) break;

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

/** Seller-created targeted campaigns (page_size 1–100). */
async function getTargetedCampaignList(shopId, accessToken, pageNo = 1, pageSize = 100) {
  return shopeeRequest({
    method: 'GET',
    path: '/api/v2/ams/get_targeted_campaign_list',
    shopId,
    accessToken,
    queryParams: { page_no: pageNo, page_size: Math.min(Number(pageSize) || 100, 100) },
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

const TOKEN_BUFFER_MS = 30 * 60 * 1000; // 30 menit

function isExpiring(tokenExpireAt, bufferMs) {
  const expireAt = tokenExpireAt ? new Date(tokenExpireAt).getTime() : 0;
  return Date.now() >= expireAt - bufferMs;
}

// One in-flight refresh per shop. Shopee rotates the refresh_token on every
// refresh, so two parallel refreshes with the same token would make the
// loser fail — concurrent callers share a single promise instead.
const inflightRefresh = new Map();

/**
 * Ensure token is valid, refresh if needed
 */
async function ensureValidToken(shop) {
  if (!shop.access_token || !shop.refresh_token) {
    throw new Error(`Shop ${shop.shop_id} belum punya token. Lakukan authorization dulu.`);
  }

  if (!isExpiring(shop.token_expire_at, TOKEN_BUFFER_MS)) {
    return shop.access_token;
  }

  return refreshShopToken(shop.shop_id, TOKEN_BUFFER_MS);
}

/**
 * Refresh a shop's token if it expires within `bufferMs`. Safe to call
 * concurrently; also used by the background scheduler.
 */
function refreshShopToken(shopId, bufferMs = TOKEN_BUFFER_MS) {
  const key = String(shopId);
  if (!inflightRefresh.has(key)) {
    const p = doRefreshShopToken(shopId, bufferMs).finally(() => inflightRefresh.delete(key));
    inflightRefresh.set(key, p);
  }
  return inflightRefresh.get(key);
}

async function doRefreshShopToken(shopId, bufferMs) {
  // Re-read the row: the caller's copy may be stale if another request
  // already rotated the token.
  const { rows } = await query(
    `SELECT shop_id, access_token, refresh_token, token_expire_at FROM shops WHERE shop_id = $1`,
    [shopId]
  );
  const shop = rows[0];
  if (!shop || !shop.refresh_token) {
    throw new Error(`Shop ${shopId} belum punya token. Lakukan authorization dulu.`);
  }
  if (shop.access_token && !isExpiring(shop.token_expire_at, bufferMs)) {
    return shop.access_token;
  }

  // Network errors propagate without touching status — only a Shopee
  // rejection means the token itself is bad.
  const result = await refreshAccessToken(shop.shop_id, shop.refresh_token);
  if (result.error) {
    const msg = `Refresh token gagal: ${result.message || result.error}`;
    await query(
      `UPDATE shops SET status = 'expired', updated_at = NOW() WHERE shop_id = $1`,
      [shop.shop_id]
    );
    await query(
      `INSERT INTO sync_logs (shop_id, action, status, message) VALUES ($1, 'refresh_token', 'error', $2)`,
      [shop.shop_id, msg]
    ).catch(() => {});
    throw new Error(msg);
  }

  const newExpire = new Date(Date.now() + (result.expire_in || 14400) * 1000);
  await query(
    `UPDATE shops SET access_token = $1, refresh_token = $2, token_expire_at = $3,
       status = CASE WHEN status = 'expired' THEN 'active' ELSE status END, updated_at = NOW()
     WHERE shop_id = $4`,
    [result.access_token, result.refresh_token || shop.refresh_token, newExpire, shop.shop_id]
  );

  return result.access_token;
}


// ---------- Shop / Product / Conversion APIs ----------

function periodParams({ periodType, startDate, endDate, channel = 'AllChannel', orderType = 'ConfirmedOrder' }) {
  return {
    period_type: periodType,
    start_date: startDate,
    end_date: endDate,
    channel: normalizeChannel(channel),
    order_type: orderType,
  };
}

/** Shop-level totals for one period (use period_type=Day for a daily trend). */
async function getShopPerformance(shopId, accessToken, opts) {
  return shopeeRequest({
    method: 'GET',
    path: '/api/v2/ams/get_shop_performance',
    shopId,
    accessToken,
    queryParams: periodParams(opts),
  });
}

async function getProductPerformance(shopId, accessToken, opts, pageNo = 1) {
  return shopeeRequest({
    method: 'GET',
    path: '/api/v2/ams/get_product_performance',
    shopId,
    accessToken,
    queryParams: { ...periodParams(opts), page_no: pageNo, page_size: AMS_MAX_PAGE_SIZE },
  });
}

/**
 * Order-level conversions. page_size up to 500, page_no * page_size <= 10000.
 * Time filters are unix seconds (inclusive).
 */
const CONVERSION_PAGE_SIZE = 500;

async function getConversionReport(shopId, accessToken, { placeOrderTimeStart, placeOrderTimeEnd } = {}, pageNo = 1) {
  const queryParams = { page_no: pageNo, page_size: CONVERSION_PAGE_SIZE };
  if (placeOrderTimeStart) queryParams.place_order_time_start = placeOrderTimeStart;
  if (placeOrderTimeEnd) queryParams.place_order_time_end = placeOrderTimeEnd;
  return shopeeRequest({
    method: 'GET',
    path: '/api/v2/ams/get_conversion_report',
    shopId,
    accessToken,
    queryParams,
  });
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
  getTargetedCampaignList,
  getLatestDataDate,
  amsRange,
  shopRange,
  fetchAllPages,
  getShopPerformance,
  getProductPerformance,
  getConversionReport,
  CONVERSION_PAGE_SIZE,
  AMS_MAX_PAGE_SIZE,
  refreshAccessToken,
  ensureValidToken,
  refreshShopToken,
};

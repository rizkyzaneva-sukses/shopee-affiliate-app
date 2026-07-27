/**
 * Shopee Affiliate Manager - Frontend
 * Live mode only — no mock data fallback.
 */

const API = window.APP_CONFIG?.API_BASE || '';

let state = {
  shop: 'all',
  channel: 'all',
  period: 'Last30d',
  search: '',
  tab: 'dashboard',
  shops: [],
  affiliates: [],
  campaigns: [],
  goals: [],
  trend: null,
  source: 'live',
  mode: null,   // 'live' | 'mock', from /api/health
  syncing: false,
};

let gmvChart = null;

// ---------- Helpers ----------
function formatRupiah(num) {
  num = Number(num) || 0;
  if (num >= 1e9) return 'Rp ' + (num / 1e9).toFixed(1).replace('.', ',') + 'M';
  if (num >= 1e6) return 'Rp ' + (num / 1e6).toFixed(1).replace('.', ',') + 'jt';
  return 'Rp ' + num.toLocaleString('id-ID');
}
function formatNumber(n) { return Number(n || 0).toLocaleString('id-ID'); }

function getChannelBadge(ch) {
  if (ch === 'Live Streaming') return 'badge-live';
  if (ch === 'Shopee Video') return 'badge-video';
  return 'badge-social';
}
function getStatusBadge(s) {
  if (s === 'active') return { cls: 'status-active', text: 'Aktif' };
  if (s === 'warning') return { cls: 'status-warning', text: 'Perlu Perhatian' };
  return { cls: 'status-inactive', text: 'Nonaktif' };
}

// ---------- Admin session ----------
const TOKEN_KEY = 'sam_admin_token';

function getAdminToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function setAdminToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearAdminToken() { localStorage.removeItem(TOKEN_KEY); }

function authHeaders() {
  const t = getAdminToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** Shows the login overlay and resolves once a token is accepted. */
function requireLogin() {
  if (document.getElementById('loginOverlay')) return;

  const el = document.createElement('div');
  el.id = 'loginOverlay';
  el.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:rgba(2,6,23,.92);' +
    'display:flex;align-items:center;justify-content:center;padding:1rem';
  el.innerHTML = `
    <div class="card p-6" style="max-width:22rem;width:100%">
      <h2 class="text-base font-semibold text-slate-100 mb-1">Masuk</h2>
      <p class="text-xs text-slate-500 mb-4">Masukkan admin token (env <code>ADMIN_TOKEN</code>).</p>
      <input id="loginToken" type="password" autocomplete="current-password"
             class="w-full mb-3 px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-sm text-slate-100"
             placeholder="Admin token">
      <p id="loginError" class="text-xs text-red-400 mb-3 hidden"></p>
      <button id="loginBtn" class="btn btn-primary w-full justify-center">Masuk</button>
    </div>`;
  document.body.appendChild(el);

  const submit = async () => {
    const val = document.getElementById('loginToken').value.trim();
    const err = document.getElementById('loginError');
    if (!val) return;
    setAdminToken(val);
    const res = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
    });
    if (res.ok) {
      el.remove();
      refreshAll();
    } else {
      clearAdminToken();
      err.textContent = res.status === 401 ? 'Token salah.' : 'Gagal masuk (' + res.status + ').';
      err.classList.remove('hidden');
    }
  };

  document.getElementById('loginBtn').addEventListener('click', submit);
  document.getElementById('loginToken').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
}

let configErrorShown = false;

async function apiGet(path) {
  try {
    const res = await fetch(`${API}${path}`, { headers: authHeaders() });
    if (res.status === 401) {
      clearAdminToken();
      requireLogin();
      return null;
    }
    if (res.status === 503) {
      const body = await res.json().catch(() => ({}));
      if (!configErrorShown) {
        configErrorShown = true;
        showToast(body.error || 'Server belum dikonfigurasi.', 'info');
      }
      return null;
    }
    if (!res.ok) throw new Error(res.statusText);
    return await res.json();
  } catch (e) {
    console.warn('[API]', path, e.message);
    return null;
  }
}

async function apiPost(path, body = {}) {
  try {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      clearAdminToken();
      requireLogin();
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn('[API]', path, e.message);
    return null;
  }
}

async function apiPut(path, body = {}) {
  try {
    const res = await fetch(`${API}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (e) {
    console.warn('[API]', path, e.message);
    return null;
  }
}

async function apiDelete(path) {
  try {
    const res = await fetch(`${API}${path}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    return await res.json();
  } catch (e) {
    console.warn('[API]', path, e.message);
    return null;
  }
}

// ---------- Shop authorization ----------
async function connectShop() {
  showToast('Menyiapkan link otorisasi Shopee...', 'info');
  try {
    const res = await fetch(`${API}/api/auth/url`, { headers: authHeaders() });
    const data = await res.json();
    if (res.status === 401) {
      clearAdminToken();
      return requireLogin();
    }
    if (res.ok && data.url) {
      window.location.href = data.url;
    } else {
      showToast(data.error || 'Gagal membuat link otorisasi.', 'info');
    }
  } catch (e) {
    showToast('Gagal membuat link otorisasi: ' + e.message, 'info');
  }
}

function handleAuthResult() {
  const p = new URLSearchParams(window.location.search);
  const status = p.get('auth');
  if (!status) return;
  showToast(p.get('msg') || status, status === 'success' ? 'success' : 'info');
  window.history.replaceState({}, '', window.location.pathname);
}

// ---------- Data loading ----------

async function loadMode() {
  const res = await apiGet('/api/health');
  if (res?.mode) state.mode = res.mode;
}

async function loadShops() {
  const res = await apiGet('/api/shops');
  state.shops = res?.data || [];
  renderShopSelect();
  renderShopList();
}

async function loadAffiliates() {
  const params = new URLSearchParams();
  if (state.shop !== 'all') params.set('shop_id', state.shop);
  if (state.channel !== 'all') params.set('channel', state.channel);
  if (state.search) params.set('q', state.search);
  params.set('period', state.period);

  const res = await apiGet('/api/affiliates?' + params.toString());
  let data = res?.data || [];

  if (res?.live_error) showToast('Shopee API: ' + res.live_error, 'info');

  state.source = data.length ? (res?.source || 'live') : 'empty';
  state.affiliates = data.sort((a, b) => (b.gmv || 0) - (a.gmv || 0));
  updateKPI();
  updateQuickStats();
  renderTop();
  renderTable();
  updateModeBadge();
}

async function loadTrend() {
  const params = new URLSearchParams();
  if (state.shop !== 'all') params.set('shop_id', state.shop);
  params.set('period', state.period);

  const res = await apiGet('/api/dashboard/trend?' + params.toString());
  if (res && res.labels) {
    state.trend = res;
    renderChart();
  }
}

async function loadGoals() {
  const res = await apiGet('/api/goals');
  state.goals = res?.data || [];
  renderGoals();
}

async function loadCampaigns() {
  const params = state.shop !== 'all' ? `?shop_id=${state.shop}` : '';
  const res = await apiGet('/api/campaigns' + params);
  state.campaigns = res?.data || [];
  renderCampaigns();
}

// ---------- Render ----------
function updateModeBadge() {
  const el = document.getElementById('modeBadge');
  if (!el) return;
  if (state.mode === 'live' && (state.source === 'live' || state.source === 'cache')) {
    el.textContent = 'LIVE API';
    el.className = 'mode-badge mode-live';
  } else if (state.mode === 'live' && state.source === 'empty') {
    el.textContent = 'LIVE (NO DATA)';
    el.className = 'mode-badge mode-live';
  } else {
    el.textContent = 'MOCK DATA';
    el.className = 'mode-badge mode-mock';
  }
}

function updateKPI() {
  const d = state.affiliates;
  const gmv = d.reduce((s, a) => s + Number(a.gmv || 0), 0);
  const orders = d.reduce((s, a) => s + Number(a.orders || 0), 0);
  const commission = d.reduce((s, a) => s + Number(a.commission || 0), 0);
  const clicks = d.reduce((s, a) => s + Number(a.clicks || 0), 0);
  const roi = commission > 0 ? gmv / commission : 0;
  const active = d.filter(a => a.status === 'active').length;

  document.getElementById('kpiGmv').textContent = formatRupiah(gmv);
  document.getElementById('kpiOrder').textContent = formatNumber(orders);
  document.getElementById('kpiCommission').textContent = formatRupiah(commission);
  document.getElementById('kpiRoi').textContent = roi.toFixed(1) + 'x';
  document.getElementById('kpiClicks').textContent = formatNumber(clicks);
  document.getElementById('kpiActive').textContent = active + ' / ' + d.length;
}

function updateQuickStats() {
  const d = state.affiliates;
  const gmv = d.reduce((s, a) => s + Number(a.gmv || 0), 0);
  const orders = d.reduce((s, a) => s + Number(a.orders || 0), 0);
  const commission = d.reduce((s, a) => s + Number(a.commission || 0), 0);
  const clicks = d.reduce((s, a) => s + Number(a.clicks || 0), 0);
  const newBuyers = d.reduce((s, a) => s + Number(a.new_buyers || 0), 0);

  // AOV
  const aov = orders > 0 ? gmv / orders : 0;
  const el1 = document.getElementById('statAov');
  if (el1) el1.textContent = formatRupiah(aov);

  // CVR
  const cvr = clicks > 0 ? (orders / clicks * 100) : 0;
  const el2 = document.getElementById('statCvr');
  if (el2) el2.textContent = cvr.toFixed(1) + '%';

  // Commission rate
  const commRate = gmv > 0 ? (commission / gmv * 100) : 0;
  const el3 = document.getElementById('statCommRate');
  if (el3) el3.textContent = commRate.toFixed(1) + '%';

  // New buyers
  const el4 = document.getElementById('statNewBuyers');
  if (el4) el4.textContent = formatNumber(newBuyers);
}

function renderTop() {
  const el = document.getElementById('topAffiliates');
  const top = state.affiliates.slice(0, 5);
  if (!top.length) {
    el.innerHTML = `
      <div class="text-center py-8">
        <i class="fas fa-users text-3xl text-slate-700 mb-3"></i>
        <p class="text-slate-500 text-sm">Belum ada data afiliator</p>
        <p class="text-xs text-slate-600 mt-1">Hubungkan toko lalu sync untuk mulai</p>
      </div>`;
    return;
  }

  // Calculate max GMV for bar width
  const maxGmv = top[0]?.gmv || 1;

  el.innerHTML = top.map((a, i) => {
    const rank = i === 0 ? 'rank-gold' : i === 1 ? 'rank-silver' : i === 2 ? 'rank-bronze' : '';
    const pct = Math.round(((a.gmv || 0) / maxGmv) * 100);
    const commRate = a.gmv > 0 ? ((a.commission / a.gmv) * 100).toFixed(1) : '0';
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '';
    return `
      <div class="top-item ${rank}">
        <div class="rank-num">${medal || (i + 1)}</div>
        <div class="flex-1 min-w-0">
          <p class="font-medium text-sm text-slate-100 truncate">${a.name || a.username}</p>
          <div class="flex items-center gap-2 mt-1">
            <div class="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div class="h-full bg-gradient-to-r from-orange-500 to-amber-400 rounded-full" style="width:${pct}%"></div>
            </div>
            <span class="text-[10px] text-slate-500">${commRate}%</span>
          </div>
          <p class="text-[10px] text-slate-500 mt-0.5">${a.orders || 0} order · @${a.username || '-'}</p>
        </div>
        <div class="text-right flex-shrink-0">
          <p class="font-semibold text-sm text-orange-400">${formatRupiah(a.gmv)}</p>
          <p class="text-[10px] text-emerald-400">${formatRupiah(a.commission)}</p>
        </div>
      </div>`;
  }).join('');
}

function renderTable() {
  const tbody = document.getElementById('affiliateTable');
  const tbodyFull = document.getElementById('affiliateTableFull');
  const countEl = document.getElementById('affiliateCount');
  const countFull = document.getElementById('affiliateCountFull');
  if (countEl) countEl.textContent = state.affiliates.length + ' afiliator';
  if (countFull) countFull.textContent = state.affiliates.length + ' afiliator';

  function emptyRow() {
    const hasShops = state.shops.length > 0;
    return `
      <tr><td colspan="9" class="text-center py-12">
        <div class="flex flex-col items-center gap-3">
          <i class="fas ${hasShops ? 'fa-sync-alt' : 'fa-store'} text-3xl text-slate-700"></i>
          <p class="text-slate-400 text-sm font-medium">${hasShops ? 'Belum ada data performa' : 'Belum ada toko terhubung'}</p>
          <p class="text-xs text-slate-600 max-w-sm">${hasShops
            ? 'Klik "Sync" pada toko untuk menarik data dari Shopee.'
            : 'Klik "Hubungkan Toko" untuk mengotorisasi akun Shopee kamu.'}</p>
          ${hasShops ? '<button class="btn btn-primary mt-2" onclick="syncAllShops()"><i class="fas fa-sync-alt"></i> Sync Semua Toko</button>' : ''}
        </div>
      </td></tr>`;
  }

  if (!state.affiliates.length) {
    tbody.innerHTML = emptyRow();
    if (tbodyFull) tbodyFull.innerHTML = emptyRow();
    return;
  }

  function renderRows(data) {
    return data.map((a, i) => {
      const st = getStatusBadge(a.status || 'active');
      const initials = (a.name || '??').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
      const commRate = a.gmv > 0 ? ((a.commission / a.gmv) * 100).toFixed(1) : '0';
      return `
        <tr class="table-row">
          <td class="td-rank">${i + 1}</td>
          <td>
            <div class="flex items-center gap-3">
              <div class="avatar">${initials}</div>
              <div>
                <p class="font-medium text-slate-100">${a.name || '-'}</p>
                <p class="text-xs text-slate-500">@${a.username || '-'} · ${a.followers || ''}</p>
              </div>
            </div>
          </td>
          <td><span class="badge ${getChannelBadge(a.channel)}">${a.channel || '-'}</span></td>
          <td class="text-right font-medium text-slate-100">${formatRupiah(a.gmv)}</td>
          <td class="text-right text-slate-300">${formatNumber(a.orders)}</td>
          <td class="text-right text-slate-300">${formatNumber(a.clicks)}</td>
          <td class="text-right font-medium text-orange-400">${formatRupiah(a.commission)}</td>
          <td class="text-right"><span class="text-xs text-emerald-400">${commRate}%</span> <span class="font-semibold text-slate-100">${Number(a.roi || 0).toFixed(1)}x</span></td>
          <td class="text-center">
            <span class="status-badge ${st.cls}">${st.text}</span>
            <p class="text-[10px] text-slate-500 mt-0.5">${a.last_active_at || a.last_active || ''}</p>
          </td>
        </tr>`;
    }).join('');
  }

  tbody.innerHTML = renderRows(state.affiliates);

  // Also render into the Affiliates tab table
  if (tbodyFull) {
    tbodyFull.innerHTML = renderRows(state.affiliates);
  }
}

function renderShopSelect() {
  const sel = document.getElementById('shopSelect');
  const current = sel.value;
  sel.innerHTML = `<option value="all">Semua Toko (${state.shops.length})</option>`;
  state.shops.forEach(s => {
    sel.innerHTML += `<option value="${s.shop_id}">${s.shop_name || s.shop_id}</option>`;
  });
  sel.value = current || 'all';
}

function renderShopList() {
  const el = document.getElementById('shopList');
  if (!el) return;

  if (!state.shops.length) {
    el.innerHTML = `
      <div class="text-center py-10">
        <i class="fas fa-store text-3xl text-slate-700 mb-3"></i>
        <p class="text-slate-400 text-sm font-medium">Belum ada toko terhubung</p>
        <p class="text-xs text-slate-600 mt-1 mb-4">Klik tombol di bawah untuk mengotorisasi toko Shopee kamu.</p>
        <button class="btn btn-primary" onclick="connectShop()"><i class="fas fa-link text-xs"></i> Hubungkan Toko</button>
      </div>`;
    return;
  }

  const lastSync = (s) => {
    if (!s.last_sync_at) return 'Belum pernah sync';
    const d = new Date(s.last_sync_at);
    const diff = Math.floor((Date.now() - d.getTime()) / 60000);
    if (diff < 1) return 'Baru saja';
    if (diff < 60) return diff + ' menit lalu';
    if (diff < 1440) return Math.floor(diff / 60) + ' jam lalu';
    return Math.floor(diff / 1440) + ' hari lalu';
  };

  el.innerHTML = state.shops.map(s => `
    <div class="shop-item ${s.status === 'inactive' ? 'opacity-60' : ''}">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-orange-500/20 text-orange-400 flex items-center justify-content-center text-sm font-bold">
          ${(s.shop_name || 'S').charAt(0)}
        </div>
        <div>
          <p class="font-medium text-sm text-slate-100">${s.shop_name || s.shop_id}</p>
          <p class="text-xs text-slate-500">${s.region || '-'} · ${s.status || 'active'} · ${lastSync(s)}</p>
        </div>
      </div>
      <button class="btn btn-ghost text-xs" onclick="syncShop('${s.shop_id}')" id="syncBtn-${s.shop_id}">
        <i class="fas fa-sync-alt"></i> Sync
      </button>
    </div>
  `).join('');
}

function renderCampaigns() {
  const el = document.getElementById('campaignList');
  if (!el) return;

  if (!state.campaigns.length) {
    el.innerHTML = `
      <div class="sm:col-span-2 text-center py-10">
        <i class="fas fa-bullhorn text-3xl text-slate-700 mb-3"></i>
        <p class="text-slate-500 text-sm">Belum ada campaign</p>
      </div>`;
    return;
  }

  el.innerHTML = state.campaigns.map(c => {
    const st = c.status === 'Ongoing' ? 'status-active' : c.status === 'Upcoming' ? 'status-warning' : 'status-inactive';
    return `
      <div class="campaign-card">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="font-medium text-slate-100">${c.name}</p>
            <p class="text-xs text-slate-500 mt-0.5">${c.type} · ${c.products_count || 0} produk · ${c.affiliates_count || 0} afiliator</p>
          </div>
          <span class="status-badge ${st}">${c.status}</span>
        </div>
        <div class="flex items-center justify-between mt-3 text-xs text-slate-400">
          <span>Komisi: <span class="text-orange-400 font-medium">${c.commission_info || '-'}</span></span>
          <span>${c.period_end || ''}</span>
        </div>
      </div>`;
  }).join('');
}

function renderChart() {
  const canvas = document.getElementById('gmvChart');
  if (!canvas) return;
  if (gmvChart) gmvChart.destroy();

  // Use real trend data from API
  const t = state.trend;

  if (!t || !t.labels || !t.labels.length || t.gmv.every(v => v === 0)) {
    gmvChart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels: ['—'], datasets: [{ label: 'GMV', data: [0], borderColor: '#f97316', backgroundColor: 'transparent' }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { display: false },
          x: { grid: { display: false }, ticks: { color: '#64748b' } }
        }
      }
    });
    return;
  }

  // Update period label
  const periodLabel = { Last7d: '7 hari', Last30d: '30 hari', Month: 'Bulan Ini' }[state.period] || '30 hari';
  document.getElementById('trendPeriod').textContent = periodLabel;

  gmvChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: t.labels,
      datasets: [
        {
          label: 'GMV (jt)', data: t.gmv,
          borderColor: '#f97316', backgroundColor: 'rgba(249,115,22,0.08)',
          fill: true, tension: 0.4, pointRadius: 4, pointBackgroundColor: '#f97316',
          pointBorderColor: '#0f172a', pointBorderWidth: 2,
        },
        {
          label: 'Order', data: t.orders,
          borderColor: '#38bdf8', backgroundColor: 'transparent', borderDash: [5, 5],
          tension: 0.4, pointRadius: 3, pointBackgroundColor: '#38bdf8', yAxisID: 'y1',
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', align: 'end', labels: { color: '#94a3b8', boxWidth: 12, usePointStyle: true } },
        tooltip: {
          backgroundColor: '#1e293b', titleColor: '#f1f5f9', bodyColor: '#cbd5e1', borderColor: '#334155', borderWidth: 1,
          callbacks: {
            label: function(ctx) {
              if (ctx.datasetIndex === 0) return 'GMV: Rp ' + (ctx.parsed.y * 1e6).toLocaleString('id-ID');
              return 'Order: ' + ctx.parsed.y;
            }
          }
        }
      },
      scales: {
        y: { beginAtZero: true, grid: { color: 'rgba(51,65,85,0.5)' }, ticks: { color: '#64748b', callback: v => v + 'jt' } },
        y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { color: '#64748b' } },
        x: { grid: { display: false }, ticks: { color: '#64748b', maxRotation: 45, autoSkip: true, maxTicksLimit: 15 } }
      }
    }
  });
}

// ---------- Goal Tracker ----------
function renderGoals() {
  const el = document.getElementById('goalList');
  if (!el) return;

  if (!state.goals.length) {
    el.innerHTML = `
      <div class="text-center py-6">
        <i class="fas fa-bullseye text-2xl text-slate-700 mb-2"></i>
        <p class="text-slate-500 text-xs">Belum ada goal</p>
        <p class="text-slate-600 text-[10px] mt-1">Klik "Tambah Goal" untuk set target</p>
      </div>`;
    return;
  }

  // Calculate current progress from affiliates data
  const d = state.affiliates;
  const currentGmv = d.reduce((s, a) => s + Number(a.gmv || 0), 0);
  const currentOrders = d.reduce((s, a) => s + Number(a.orders || 0), 0);
  const currentCommission = d.reduce((s, a) => s + Number(a.commission || 0), 0);

  el.innerHTML = state.goals.map(g => {
    const gmvPct = Math.min(100, (currentGmv / g.target_gmv) * 100);
    const orderPct = g.target_orders > 0 ? Math.min(100, (currentOrders / g.target_orders) * 100) : 0;
    const commPct = g.target_commission > 0 ? Math.min(100, (currentCommission / g.target_commission) * 100) : 0;

    const gmvColor = gmvPct >= 80 ? 'from-emerald-500 to-green-400' : gmvPct >= 50 ? 'from-amber-500 to-yellow-400' : 'from-red-500 to-pink-400';

    return `
      <div class="bg-slate-900/50 rounded-lg p-3">
        <div class="flex items-center justify-between mb-2">
          <p class="font-medium text-sm text-slate-100">${g.name}</p>
          <div class="flex items-center gap-1">
            <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">${g.period || 'Month'}</span>
            <button class="text-slate-600 hover:text-red-400 text-xs" onclick="deleteGoal(${g.id})"><i class="fas fa-trash"></i></button>
          </div>
        </div>

        <!-- GMV Progress -->
        <div class="mb-2">
          <div class="flex items-center justify-between text-[10px] mb-1">
            <span class="text-slate-500">GMV</span>
            <span class="text-slate-400">${formatRupiah(currentGmv)} / ${formatRupiah(g.target_gmv)}</span>
          </div>
          <div class="h-2 bg-slate-800 rounded-full overflow-hidden">
            <div class="h-full bg-gradient-to-r ${gmvColor} rounded-full transition-all duration-500" style="width:${gmvPct}%"></div>
          </div>
          <p class="text-right text-[10px] text-slate-500 mt-0.5">${gmvPct.toFixed(0)}%</p>
        </div>

        ${g.target_orders > 0 ? `
        <!-- Orders Progress -->
        <div class="mb-2">
          <div class="flex items-center justify-between text-[10px] mb-1">
            <span class="text-slate-500">Order</span>
            <span class="text-slate-400">${currentOrders} / ${g.target_orders}</span>
          </div>
          <div class="h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <div class="h-full bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full transition-all duration-500" style="width:${orderPct}%"></div>
          </div>
        </div>` : ''}

        ${g.target_commission > 0 ? `
        <!-- Commission Progress -->
        <div>
          <div class="flex items-center justify-between text-[10px] mb-1">
            <span class="text-slate-500">Komisi</span>
            <span class="text-slate-400">${formatRupiah(currentCommission)} / ${formatRupiah(g.target_commission)}</span>
          </div>
          <div class="h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <div class="h-full bg-gradient-to-r from-orange-500 to-amber-400 rounded-full transition-all duration-500" style="width:${commPct}%"></div>
          </div>
        </div>` : ''}
      </div>`;
  }).join('');
}

function showGoalModal() {
  document.getElementById('goalModal').classList.remove('hidden');
}

function closeGoalModal() {
  document.getElementById('goalModal').classList.add('hidden');
  // Reset form
  document.getElementById('goalName').value = '';
  document.getElementById('goalGmv').value = '';
  document.getElementById('goalOrders').value = '';
  document.getElementById('goalCommission').value = '';
  document.getElementById('goalPeriod').value = 'Month';
}

async function saveGoal() {
  const name = document.getElementById('goalName').value.trim();
  const targetGmv = Number(document.getElementById('goalGmv').value) || 0;
  const targetOrders = Number(document.getElementById('goalOrders').value) || 0;
  const targetCommission = Number(document.getElementById('goalCommission').value) || 0;
  const period = document.getElementById('goalPeriod').value;

  if (!name || !targetGmv) {
    showToast('Nama goal dan target GMV wajib diisi', 'info');
    return;
  }

  const res = await apiPost('/api/goals', {
    name, target_gmv: targetGmv, target_orders: targetOrders,
    target_commission: targetCommission, period
  });

  if (res?.success) {
    showToast('Goal berhasil disimpan!', 'success');
    closeGoalModal();
    await loadGoals();
  } else {
    showToast('Gagal menyimpan goal', 'info');
  }
}

async function deleteGoal(id) {
  if (!confirm('Hapus goal ini?')) return;
  const res = await apiDelete(`/api/goals/${id}`);
  if (res?.success) {
    showToast('Goal dihapus', 'success');
    await loadGoals();
  }
}

// ---------- Alerts ----------
async function checkAlerts() {
  const res = await apiPost('/api/alerts/check');
  const el = document.getElementById('alertBanner');
  if (!el || !res?.alerts?.length) {
    if (el) el.classList.add('hidden');
    return;
  }

  const alerts = res.alerts;
  el.classList.remove('hidden');
  el.innerHTML = alerts.map(a => {
    const colors = {
      warning: 'bg-amber-500/10 border-amber-500/30 text-amber-300',
      critical: 'bg-red-500/10 border-red-500/30 text-red-300',
      info: 'bg-blue-500/10 border-blue-500/30 text-blue-300'
    };
    const icons = { warning: 'fa-exclamation-triangle', critical: 'fa-times-circle', info: 'fa-info-circle' };
    return `
      <div class="flex items-start gap-3 p-3 rounded-lg border ${colors[a.type] || colors.info} mb-2">
        <i class="fas ${icons[a.type] || icons.info} mt-0.5"></i>
        <div class="flex-1">
          <p class="font-medium text-sm">${a.title}</p>
          <p class="text-xs opacity-80">${a.message}</p>
        </div>
        <button class="text-xs opacity-50 hover:opacity-100" onclick="this.parentElement.remove()">
          <i class="fas fa-times"></i>
        </button>
      </div>`;
  }).join('');
}

function formatRupiahShort(num) {
  num = Number(num) || 0;
  if (num >= 1e9) return 'Rp ' + (num / 1e9).toFixed(1).replace('.', ',') + 'M';
  if (num >= 1e6) return 'Rp ' + (num / 1e6).toFixed(1).replace('.', ',') + 'jt';
  return 'Rp ' + num.toLocaleString('id-ID');
}

// ---------- Export ----------
function exportCSV() {
  const params = new URLSearchParams();
  if (state.shop !== 'all') params.set('shop_id', state.shop);
  if (state.channel !== 'all') params.set('channel', state.channel);
  params.set('period', state.period);
  window.open(`${API}/api/export/csv?${params.toString()}`, '_blank');
  showToast('Export dimulai...', 'success');
}

// ---------- Calculator ----------
function showCalculator() {
  document.getElementById('calculatorModal').classList.remove('hidden');
  // Pre-fill with current data
  const d = state.affiliates;
  const currentGmv = d.reduce((s, a) => s + Number(a.gmv || 0), 0);
  const currentComm = d.reduce((s, a) => s + Number(a.commission || 0), 0);
  document.getElementById('calcCurrentGmv').value = Math.round(currentGmv);
}

function closeCalculator() {
  document.getElementById('calculatorModal').classList.add('hidden');
}

async function runCalculator() {
  const currentGmv = Number(document.getElementById('calcCurrentGmv').value) || 0;
  const targetGmv = Number(document.getElementById('calcTargetGmv').value) || 0;
  const commRate = Number(document.getElementById('calcCommRate').value) || 6;
  const aov = Number(document.getElementById('calcAov').value) || 300000;

  if (!targetGmv) {
    showToast('Isi target GMV terlebih dahulu', 'info');
    return;
  }

  const res = await apiPost('/api/calculator/simulate', {
    current_gmv: currentGmv, target_gmv: targetGmv,
    avg_commission_rate: commRate, avg_order_value: aov
  });

  if (res?.error) {
    showToast(res.error, 'info');
    return;
  }

  document.getElementById('calcResult').classList.remove('hidden');
  document.getElementById('calcProgress').textContent = res.progress_pct + '%';
  document.getElementById('calcProgressBar').style.width = res.progress_pct + '%';
  document.getElementById('calcOrdersGap').textContent = formatNumber(res.gap.orders) + ' order';
  document.getElementById('calcGmvGap').textContent = formatRupiah(res.gap.gmv);
  document.getElementById('calcCommTarget').textContent = formatRupiah(res.target.commission);
}

// ---------- Actions ----------
function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('[data-tab]').forEach(el => el.classList.toggle('nav-active', el.dataset.tab === tab));
  document.querySelectorAll('[data-panel]').forEach(el => el.classList.toggle('hidden', el.dataset.panel !== tab));
  if (tab === 'dashboard') {
    setTimeout(renderChart, 40);
    loadGoals();
  }
}

async function refreshAll() {
  const btn = document.getElementById('btnRefresh');
  const icon = btn?.querySelector('i');
  if (icon) icon.classList.add('fa-spin');
  if (btn) btn.disabled = true;

  await loadMode();
  await Promise.all([loadShops(), loadAffiliates(), loadCampaigns(), loadTrend(), loadGoals(), checkAlerts()]);

  if (icon) icon.classList.remove('fa-spin');
  if (btn) btn.disabled = false;
  showToast('Data diperbarui', 'success');
}

async function syncShop(shopId) {
  const btn = document.getElementById(`syncBtn-${shopId}`);
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Syncing...'; }

  showToast('Sync toko ' + shopId + ' ...', 'info');
  const res = await apiPost(`/api/sync/${shopId}`, { period: state.period });

  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sync-alt"></i> Sync'; }

  if (res?.error) showToast(res.error, 'info');
  else {
    showToast(`Synced ${res?.synced || 0} afiliator`, 'success');
    await Promise.all([loadAffiliates(), loadShops(), loadTrend()]);
  }
}

async function syncAllShops() {
  if (state.syncing) return;
  state.syncing = true;

  const btn = document.getElementById('btnSyncAll');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Syncing...'; }

  showToast('Sync semua toko...', 'info');
  const res = await apiPost('/api/sync/all', { period: state.period });

  state.syncing = false;
  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sync-alt"></i> Sync Semua'; }

  if (res?.error) {
    showToast(res.error, 'info');
  } else {
    const total = res?.total || 0;
    showToast(`Synced ${total} afiliator dari ${res?.shops?.length || 0} toko`, 'success');
    await Promise.all([loadAffiliates(), loadCampaigns(), loadShops(), loadTrend()]);
  }
}

async function discoverShops() {
  showToast('Mencari toko dari Shopee...', 'info');
  const res = await apiPost('/api/shops/discover');
  if (res?.error) {
    showToast(res.error, 'info');
  } else {
    const count = res?.synced || 0;
    showToast(`Ditemukan ${count} toko dari Shopee`, 'success');
    await loadShops();
  }
}

function showToast(msg, type = 'info') {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.innerHTML = `<i class="fas ${type === 'success' ? 'fa-check-circle' : 'fa-info-circle'}"></i><span>${msg}</span>`;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2800);
}

// ---------- Init ----------
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('shopSelect')?.addEventListener('change', e => {
    state.shop = e.target.value;
    loadAffiliates();
    loadCampaigns();
    loadTrend();
  });
  document.getElementById('channelSelect')?.addEventListener('change', async (e) => {
    state.channel = e.target.value;
    // Auto-sync for the selected channel (same as period filter)
    const channelText = e.target.options[e.target.selectedIndex].text;
    showToast('Sync data untuk channel ' + channelText + '...', 'info');
    const syncRes = await apiPost('/api/sync/all', { period: state.period, channel: e.target.value });
    if (syncRes?.total > 0) {
      showToast(`Synced ${syncRes.total} afiliator`, 'success');
    } else if (e.target.value !== 'all') {
      showToast('Tidak ada data untuk channel ini di Shopee AMS', 'info');
    }
    await Promise.all([loadAffiliates(), loadTrend(), loadGoals()]);
  });
  document.getElementById('periodSelect')?.addEventListener('change', async (e) => {
    state.period = e.target.value;
    // Auto-sync all shops for the new period, then reload
    showToast('Sync data untuk periode ' + e.target.options[e.target.selectedIndex].text + '...', 'info');
    const syncRes = await apiPost('/api/sync/all', { period: state.period });
    if (syncRes?.total > 0) {
      showToast(`Synced ${syncRes.total} afiliator`, 'success');
    }
    await Promise.all([loadAffiliates(), loadTrend(), loadGoals()]);
  });
  document.getElementById('searchInput')?.addEventListener('input', e => {
    state.search = e.target.value;
    loadAffiliates();
  });
  document.getElementById('searchInputFull')?.addEventListener('input', e => {
    state.search = e.target.value;
    loadAffiliates();
  });
  document.querySelectorAll('[data-tab]').forEach(el => {
    el.addEventListener('click', ev => { ev.preventDefault(); switchTab(el.dataset.tab); });
  });

  handleAuthResult();
  refreshAll();
});

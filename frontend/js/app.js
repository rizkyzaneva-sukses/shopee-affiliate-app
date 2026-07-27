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
  renderTop();
  renderTable();
  updateModeBadge();
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
  el.innerHTML = top.map((a, i) => {
    const rank = i === 0 ? 'rank-gold' : i === 1 ? 'rank-silver' : i === 2 ? 'rank-bronze' : '';
    return `
      <div class="top-item ${rank}">
        <div class="rank-num">${i + 1}</div>
        <div class="flex-1 min-w-0">
          <p class="font-medium text-sm text-slate-100 truncate">${a.name || a.username}</p>
          <p class="text-xs text-slate-500">@${a.username || '-'}</p>
        </div>
        <div class="text-right">
          <p class="font-semibold text-sm text-orange-400">${formatRupiah(a.gmv)}</p>
          <p class="text-xs text-slate-500">${a.orders || 0} order</p>
        </div>
      </div>`;
  }).join('');
}

function renderTable() {
  const tbody = document.getElementById('affiliateTable');
  document.getElementById('affiliateCount').textContent = state.affiliates.length + ' afiliator';

  if (!state.affiliates.length) {
    const hasShops = state.shops.length > 0;
    tbody.innerHTML = `
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
    return;
  }

  tbody.innerHTML = state.affiliates.map((a, i) => {
    const st = getStatusBadge(a.status || 'active');
    const initials = (a.name || '??').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
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
        <td class="text-right font-semibold text-emerald-400">${Number(a.roi || 0).toFixed(1)}x</td>
        <td class="text-center">
          <span class="status-badge ${st.cls}">${st.text}</span>
          <p class="text-[10px] text-slate-500 mt-0.5">${a.last_active_at || a.last_active || ''}</p>
        </td>
      </tr>`;
  }).join('');
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

  const t = window.MOCK_TREND;
  // If no trend data, render empty chart
  if (!t.labels || !t.labels.length) {
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

  gmvChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: t.labels,
      datasets: [
        {
          label: 'GMV (juta)', data: t.gmv,
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
        tooltip: { backgroundColor: '#1e293b', titleColor: '#f1f5f9', bodyColor: '#cbd5e1', borderColor: '#334155', borderWidth: 1 }
      },
      scales: {
        y: { beginAtZero: true, grid: { color: 'rgba(51,65,85,0.5)' }, ticks: { color: '#64748b', callback: v => v + 'jt' } },
        y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { color: '#64748b' } },
        x: { grid: { display: false }, ticks: { color: '#64748b' } }
      }
    }
  });
}

// ---------- Actions ----------
function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('[data-tab]').forEach(el => el.classList.toggle('nav-active', el.dataset.tab === tab));
  document.querySelectorAll('[data-panel]').forEach(el => el.classList.toggle('hidden', el.dataset.panel !== tab));
  if (tab === 'dashboard') setTimeout(renderChart, 40);
}

async function refreshAll() {
  const btn = document.getElementById('btnRefresh');
  const icon = btn?.querySelector('i');
  if (icon) icon.classList.add('fa-spin');
  if (btn) btn.disabled = true;

  await loadMode();
  await Promise.all([loadShops(), loadAffiliates(), loadCampaigns()]);
  renderChart();

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
    await Promise.all([loadAffiliates(), loadShops()]);
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
    await Promise.all([loadAffiliates(), loadCampaigns(), loadShops()]);
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
  });
  document.getElementById('channelSelect')?.addEventListener('change', e => {
    state.channel = e.target.value;
    loadAffiliates();
  });
  document.getElementById('periodSelect')?.addEventListener('change', e => {
    state.period = e.target.value;
    loadAffiliates();
  });
  document.getElementById('searchInput')?.addEventListener('input', e => {
    state.search = e.target.value;
    loadAffiliates();
  });
  document.querySelectorAll('[data-tab]').forEach(el => {
    el.addEventListener('click', ev => { ev.preventDefault(); switchTab(el.dataset.tab); });
  });

  handleAuthResult();
  refreshAll();
});

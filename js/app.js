/**
   * ==========================================================================
   * Si-MAKO (Sistem Manajemen Konveksi) — Client-Side Controller (app.js)
   * Arsitektur: GAS-PRO-API (Pure Vanilla JS + Fetch HTTP ke GAS REST API)
   * Platform Frontend: Vercel • Tanpa RPC bawaan GAS • Tanpa iFrame
   * v3.1.0: login sandi + token, respons ringkas (delta), retry aman, render per menu, paginasi
   * ==========================================================================
   */

  // ============================================
  // KONFIGURASI BACKEND GAS REST API
  // ============================================
  // v3.1: URL Web App (/exec) diisi di js/config.js — file ini tidak perlu diedit per klien.
  const GAS_URL = String((window.SIMAKO_CONFIG && window.SIMAKO_CONFIG.GAS_URL) || '').trim();

  const APP_STATE = {
    data: null,
    authEmail: '',
    activeView: 'dashboard',
    effectiveRole: 'Owner', // Dapat disimulasikan oleh Owner untuk menguji tampilan Admin
    selectedInvoiceOrderId: null,
    invoiceLayout: 'A4', // 'A4' atau 'NOTA'
    reportColSortIndex: null,
    reportColSortAsc: true,
    isSubmitting: false, // Mencegah double-click pada operasi simpan/ubah
    pendingUploads: {}, // Menyimpan hasil baca/kompresi file base64 per input ID
    viewRestored: false,
    charts: {
      omzet: null,
      cashflow: null,
      status: null
    }
  };

  /**
   * ==========================================================================
   * 0. PENYIMPANAN LOKAL, TEMA, & CACHE INSTAN
   * ==========================================================================
   */
  const STORE_KEYS = {
    theme: 'simako_theme',
    view: 'simako_view',
    invoiceLayout: 'simako_invoice_layout',
    authEmail: 'simako_auth_email',
    gasUrlOverride: 'simako_gas_url_override',
    payloadCache: 'simako_payload_cache_v3'
  };

  function storeGet_(kind, key) {
    try { return window[kind].getItem(key); } catch (e) { return null; }
  }
  function storeSet_(kind, key, value) {
    try { window[kind].setItem(key, value); return true; } catch (e) { return false; }
  }
  function storeRemove_(kind, key) {
    try { window[kind].removeItem(key); } catch (e) {}
  }

  function getActiveGasUrl() {
    const customUrl = String(storeGet_('localStorage', STORE_KEYS.gasUrlOverride) || '').trim();
    if (customUrl && /^https:\/\/script\.google\.com\/macros\/s\//i.test(customUrl)) {
      return customUrl;
    }
    return String(GAS_URL || '').trim();
  }

  function isGasUrlConfigured(urlToCheck) {
    const u = String(urlToCheck !== undefined ? urlToCheck : getActiveGasUrl()).trim();
    return /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec/i.test(u) && u.indexOf('/XXXX/') === -1;
  }

  function payloadKey_() { return 'simako_data_v31:' + String(APP_STATE.authEmail || 'anon').toLowerCase(); }
  function cacheSavePayload_(payload) {
    try {
      const json = JSON.stringify(payload);
      if (json.length > 4500000) return;
      if (!storeSet_('localStorage', payloadKey_(), json)) {
        // Penyimpanan penuh: buang data akun lain di perangkat ini, lalu coba sekali lagi
        Object.keys(localStorage).filter(function(k) { return k.indexOf('simako_data_v31:') === 0 && k !== payloadKey_(); })
          .forEach(function(k) { storeRemove_('localStorage', k); });
        storeSet_('localStorage', payloadKey_(), json);
      }
    } catch (e) {}
  }
  function cacheLoadPayload_() {
    const raw = storeGet_('localStorage', payloadKey_());
    if (!raw) return null;
    try {
      const p = JSON.parse(raw);
      if (!p || p.authorized !== true) return null;
      if (APP_STATE.authEmail && p.user && String(p.user.email || '').toLowerCase() !== APP_STATE.authEmail.toLowerCase()) {
        return null;
      }
      return p;
    } catch (e) { return null; }
  }
  function cacheClearPayload_() {
    storeRemove_('localStorage', payloadKey_());
    storeRemove_('sessionStorage', STORE_KEYS.payloadCache);
  }

  function debounce_(fn, waitMs) {
    let timer = null;
    return function() {
      const ctx = this, args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function() { fn.apply(ctx, args); }, waitMs);
    };
  }

  function getTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function applyTheme(theme, persist) {
    const t = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    if (persist) storeSet_('localStorage', STORE_KEYS.theme, t);
    const btn = document.getElementById('themeToggleBtn');
    if (btn) {
      btn.setAttribute('aria-pressed', t === 'dark' ? 'true' : 'false');
      btn.setAttribute('aria-label', t === 'dark' ? 'Ganti ke tema terang' : 'Ganti ke tema gelap');
    }
    if (APP_STATE.data && APP_STATE.activeView === 'laporan' && isOwnerRole()) {
      renderAnalyticsCharts();
    }
  }

  function toggleTheme() {
    applyTheme(getTheme() === 'dark' ? 'light' : 'dark', true);
  }

  function cssVar_(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function hideBootSplash_() {
    const el = document.getElementById('bootSplash');
    if (el) el.hidden = true;
  }

  const debouncedRenderOrders = debounce_(function() { renderOrdersTable(); }, 180);
  const debouncedRenderCustomers = debounce_(function() { renderCustomersTable(); }, 180);
  const debouncedRenderMaterials = debounce_(function() { renderMaterialsView(); }, 180);
  const debouncedRenderReport = debounce_(function() { renderReportTable(); }, 180);

  /**
   * ==========================================================================
   * 1. FETCH HELPERS (STANDAR GAS-PRO-API) & KOMUNIKASI SERVER
   * ==========================================================================
   */

  function setLoading(isLoading, isMutation) {
    const bar = document.getElementById('globalLoadingBar');
    if (bar) bar.classList.toggle('active', Boolean(isLoading));
    if (isMutation !== undefined) {
      APP_STATE.isSubmitting = Boolean(isLoading);
      document.querySelectorAll('.modal-footer .btn-primary, .modal-footer .btn-danger').forEach(function(btn) {
        btn.disabled = Boolean(isLoading);
      });
    }
  }

  function generateRequestId_() {
    return 'req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
  }

  function showToast(message, type) {
    const stack = document.getElementById('toastContainer');
    if (!stack) return;
    const item = document.createElement('div');
    const toastClass = type === 'error' ? 'toast-error' : (type === 'warning' ? 'toast-warning' : (type === 'info' ? 'toast-info' : 'toast-success'));
    item.className = 'toast-item ' + toastClass;
    item.innerHTML = '<div style="flex:1;">' + escapeHtml(message) + '</div>';
    stack.appendChild(item);
    setTimeout(function() {
      if (item.parentNode) item.parentNode.removeChild(item);
    }, 4000);
  }

  // Alias kompatibilitas template GAS-PRO-API
  function showNotif(message, type) {
    showToast(message, type || 'success');
  }

  function showLoading(show) {
    setLoading(show !== false);
  }

  /**
   * ==========================================================================
   * 1b. KOMUNIKASI SERVER v3.1 (GAS-PRO-API + Instant UX PRO + Scale Turbo)
   *  - Sesi token (login email + sandi). Server tidak lagi mempercayai email dari browser.
   *  - fetch() dengan timeout & percobaan ulang: baca 3×, simpan 2× dengan reqId yang sama
   *    (server menolak penyimpanan ganda, jadi aman saat sinyal HP putus-sambung).
   *  - Respons ringkas: browser mengirim `have` (versi data lokal); server hanya mengirim yang berubah.
   *  - Pengukur: ketik  Perf.table()  atau  Perf.summary()  di Console browser.
   * ==========================================================================
   */
  const READ_ACTIONS = /^(getInitialAppData|getData|runIntegrityCheck|login)$/;
  const SESSION_KEYS = { token: 'simako_token_v31', exp: 'simako_token_exp_v31', legacy: 'simako_backend_lama' };
  const CHART_JS_URL = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';

  const Perf = {
    rows: [],
    add: function(action, total, server, partial) {
      this.rows.push({
        aksi: action, total_ms: total,
        server_ms: (server === undefined || server === null) ? null : server,
        jaringan_ms: (server === undefined || server === null) ? null : total - server,
        ringkas: Boolean(partial), waktu: new Date().toLocaleTimeString('id-ID')
      });
      if (this.rows.length > 200) this.rows.shift();
    },
    table: function() { console.table(this.rows.slice(-30)); },
    summary: function() {
      const g = {};
      this.rows.forEach(function(r) {
        const x = g[r.aksi] || (g[r.aksi] = { aksi: r.aksi, n: 0, total: 0, server: 0, ns: 0 });
        x.n++; x.total += r.total_ms;
        if (r.server_ms !== null) { x.server += r.server_ms; x.ns++; }
      });
      console.table(Object.keys(g).map(function(k) {
        const x = g[k];
        return { aksi: x.aksi, panggilan: x.n, rata_total_ms: Math.round(x.total / x.n), rata_server_ms: x.ns ? Math.round(x.server / x.ns) : null };
      }));
    }
  };
  window.Perf = Perf;

  function getToken_() {
    const t = storeGet_('localStorage', SESSION_KEYS.token);
    const exp = Number(storeGet_('localStorage', SESSION_KEYS.exp) || 0);
    if (!t || (exp && exp < Date.now())) return '';
    return t;
  }
  function setToken_(t, exp) {
    storeSet_('localStorage', SESSION_KEYS.token, t || '');
    storeSet_('localStorage', SESSION_KEYS.exp, String(exp || 0));
  }
  function clearToken_() {
    storeRemove_('localStorage', SESSION_KEYS.token);
    storeRemove_('localStorage', SESSION_KEYS.exp);
  }
  function isLegacyBackend_() { return storeGet_('localStorage', SESSION_KEYS.legacy) === '1'; }
  function hasSession_() { return Boolean(getToken_()) || isLegacyBackend_(); }

  function sleep_(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function waitOnline_(ms) {
    return new Promise(function(resolve) {
      if (navigator.onLine !== false) return resolve();
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); window.removeEventListener('online', done); resolve(); }
      window.addEventListener('online', done);
    });
  }

  /** Bangunkan server GAS lebih awal (mis. saat layar login dibuka) — maks. 1× per 4 menit, tanpa data. */
  function warmUpServer_() {
    const url = getActiveGasUrl();
    if (!isGasUrlConfigured(url)) return;
    try {
      const k = 'simako_warm_at', last = Number(storeGet_('sessionStorage', k) || 0);
      if (Date.now() - last < 240000) return;
      storeSet_('sessionStorage', k, String(Date.now()));
      fetch(url + '?w=1&t=' + Date.now(), { mode: 'no-cors', cache: 'no-store' }).catch(function() {});
    } catch (e) {}
  }

  async function apiOnce_(action, body, timeoutMs) {
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(function() { ctrl.abort(); }, timeoutMs) : null;
    const t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    try {
      const res = await fetch(getActiveGasUrl(), {
        method: 'POST', redirect: 'follow', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // wajib: hindari CORS preflight
        body: JSON.stringify(body)
      });
      const text = await res.text();
      const t1 = (window.performance && performance.now) ? performance.now() : Date.now();
      try {
        const j = JSON.parse(text);
        Perf.add(action, Math.round(t1 - t0), j.ms, j.data && j.data.partial);
        return j;
      } catch (e) {
        return { success: false, network: true, retryable: true,
          message: 'Server Google membalas tidak wajar (HTTP ' + res.status + '). Coba lagi sebentar lagi.' };
      }
    } catch (err) {
      return { success: false, network: true, retryable: true,
        message: (err && err.name === 'AbortError') ? 'Server terlalu lama merespons. Periksa sinyal lalu coba lagi.' : 'Koneksi terputus. Periksa internet Anda lalu coba lagi.' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Satu-satunya pintu ke server. Mengembalikan envelope {success, message, data, code?}. */
  async function api(action, data, opt) {
    opt = opt || {};
    if (!isGasUrlConfigured()) {
      return { success: false, message: 'URL Endpoint GAS (/exec) belum dikonfigurasi. Isi GAS_URL di js/config.js.' };
    }
    const isRead = Boolean(opt.read) || READ_ACTIONS.test(action);
    const body = { action: action, token: getToken_(), email: APP_STATE.authEmail || '', data: (data === undefined ? {} : data) };
    if (!isRead) body.reqId = opt.reqId || (data && typeof data === 'object' && data.requestId) || generateRequestId_();
    if (opt.have) body.have = opt.have;
    const tries = opt.tries || (isRead ? 3 : (isLegacyBackend_() ? 1 : 2));
    let res = null;
    for (let i = 0; i < tries; i++) {
      if (i > 0) {
        await sleep_(1200 * i);
        if (navigator.onLine === false) await waitOnline_(15000);
      }
      res = await apiOnce_(action, body, isRead ? (i ? 40000 : 25000) : 90000);
      if (res.success || !res.retryable) break;
    }
    return res;
  }

  /** Gabungkan respons ringkas server ke data lokal (harus identik dengan versi server). */
  function mergePayload_(base, p) {
    if (!p || p.authorized === false) return p;
    if (!p.partial || !base) {
      const full = Object.assign({}, p);
      delete full.patch; delete full.partial;
      return full;
    }
    const out = Object.assign({}, base);
    Object.keys(p).forEach(function(k) { if (k !== 'patch' && k !== 'partial' && k !== 'cv') out[k] = p[k]; });
    if (p.patch) {
      Object.keys(p.patch).forEach(function(coll) {
        const pt = p.patch[coll], arr = (out[coll] || []).slice(), idx = {};
        arr.forEach(function(r, i) { idx[r[pt.key]] = i; });
        (pt.upsert || []).forEach(function(r) {
          if (idx[r[pt.key]] !== undefined) arr[idx[r[pt.key]]] = r;
          else { idx[r[pt.key]] = arr.length; arr.push(r); }
        });
        const rm = {};
        (pt.remove || []).forEach(function(id) { rm[id] = 1; });
        out[coll] = arr.filter(function(r) { return !rm[r[pt.key]]; });
      });
    }
    out.cv = Object.assign({}, base.cv || {}, p.cv || {});
    return out;
  }

  function payloadChanged_(p) {
    if (!p || !p.partial) return true;
    const moved = Object.keys(p).some(function(k) { return !/^(authorized|user|partial|cv)$/.test(k); });
    const cur = APP_STATE.data && APP_STATE.data.user;
    return moved || JSON.stringify(p.user) !== JSON.stringify(cur);
  }

  /** Tangani sesi habis / wajib ganti sandi / akses dicabut. true = sudah ditangani. */
  function handleSessionError_(res, isRead) {
    const code = res && res.code;
    if (code === 'AUTH') {
      cacheClearPayload_();
      clearToken_();
      storeRemove_('localStorage', SESSION_KEYS.legacy);
      APP_STATE.data = null;
      hideBootSplash_();
      showLoginScreen(false);
      showToast(res.message || 'Sesi berakhir. Silakan masuk kembali.', 'warning');
      return true;
    }
    if (code === 'MUST_CHANGE') {
      hideBootSplash_();
      if (!APP_STATE.data) showLoginScreen(false);
      openPasswordModal(true);
      return true;
    }
    if (code === 'FORBIDDEN' && isRead) {
      applyServerPayload({ authorized: false, requireLogin: false, email: APP_STATE.authEmail, message: res.message });
      return true;
    }
    return false;
  }

  // Kompatibilitas: nama fungsi lama tetap ada (dipakai skrip kustom, bila ada)
  async function fetchData(action, queryParams) {
    const r = await api(action || 'getInitialAppData', queryParams || {}, { read: true });
    if (!r.success) throw new Error(r.message || 'Gagal memuat data dari server GAS.');
    return r.data;
  }
  async function postData(action, payload) { return api(action, payload); }

  /**
   * Wrapper lama (dipakai seluruh aplikasi). onSuccess(data, extra, meta):
   *  - data  = payload LENGKAP hasil gabung delta (handler lama tetap memanggil applyServerPayload(data))
   *  - extra = data tambahan sekali pakai (mis. sandi sementara) — tidak pernah disimpan
   *  - meta  = { changed } — false bila server tidak mengirim perubahan apa pun
   */
  async function callServer(fnName, argsArray, onSuccess, onError) {
    const isReadOnly = READ_ACTIONS.test(fnName);
    if (!isReadOnly && APP_STATE.isSubmitting) {
      showToast('Mohon tunggu, transaksi sebelumnya sedang disimpan...', 'warning');
      return;
    }

    const args = Array.isArray(argsArray) ? argsArray.slice() : [];
    let payloadData = args.length > 0 ? args[0] : {};

    // Pemetaan argumen posisional ke objek JSON terstruktur untuk endpoint REST API
    if (fnName === 'updateOrderStatus') {
      payloadData = { id_order: args[0], newStatus: args[1] };
    } else if (fnName === 'deleteOrder') {
      payloadData = { id_order: args[0], forceHardDelete: Boolean(args[1]) };
    } else if (fnName === 'deleteCustomer') {
      payloadData = { id_pelanggan: args[0] };
    } else if (fnName === 'deleteHppCalculation') {
      payloadData = { id: args[0] };
    } else if (fnName === 'deleteMaterial') {
      payloadData = { id_bahan: args[0] };
    } else if (fnName === 'deleteExpense') {
      payloadData = { id: args[0] };
    } else if (fnName === 'generateInvoicePdf') {
      payloadData = { id_order: args[0] };
    } else if (fnName === 'deleteUserAccount') {
      payloadData = { email: args[0] };
    }

    if (!isReadOnly && payloadData && typeof payloadData === 'object' && !Array.isArray(payloadData)) {
      if (!payloadData.requestId) payloadData.requestId = generateRequestId_();
    }

    const fresh = Boolean(isReadOnly && payloadData && payloadData.fresh);
    const have = (!fresh && APP_STATE.data && APP_STATE.data.cv) ? APP_STATE.data.cv : null;

    setLoading(true, !isReadOnly);
    let res;
    try {
      res = await api(fnName, payloadData, { have: have });
    } finally {
      setLoading(false, !isReadOnly);
    }

    if (!res || !res.success) {
      if (handleSessionError_(res || {}, isReadOnly)) return;
      const msg = (res && res.message) ? res.message : 'Terjadi kesalahan pada server GAS.';
      if (onError) onError(msg); else showToast(msg, 'error');
      return;
    }

    let out = res.data, changed = true;
    if (out && typeof out.authorized === 'boolean') {
      changed = payloadChanged_(out);
      out = mergePayload_(APP_STATE.data, out);
      APP_STATE.lastSyncAt = Date.now();
    }
    if (res.duplicate) showToast('Data ini sudah tersimpan sebelumnya — tidak dibuat ganda.', 'info');
    if (onSuccess) onSuccess(out, res.extra || null, { changed: changed });
  }

  /**
   * ==========================================================================
   * 1c. RENDER MALAS & PAGINASI
   *  - Setelah data berubah, hanya menu yang sedang dibuka yang digambar ulang.
   *  - Menu lain digambar saat browser senggang atau saat dibuka.
   *  - Tabel panjang tampil 50 baris + tombol "Tampilkan lagi".
   * ==========================================================================
   */
  const ALL_VIEWS_ = ['dashboard', 'order', 'pelanggan', 'hpp', 'stok', 'keuangan', 'laporan', 'pengaturan'];

  function renderViewIfDirty_(v) {
    if (!APP_STATE.dirtyViews || !APP_STATE.dirtyViews[v]) return;
    delete APP_STATE.dirtyViews[v];
    if (v === 'dashboard') { renderDashboardView(); return; }
    if (v === 'order') { renderOrdersTable(); return; }
    if (v === 'pelanggan') { renderCustomersTable(); return; }
    if (!isOwnerRole()) return;
    if (v === 'hpp') renderHppView();
    else if (v === 'stok') renderMaterialsView();
    else if (v === 'keuangan') renderFinanceView();
    else if (v === 'pengaturan') renderSettingsAndUsersView();
    else if (v === 'laporan') {
      renderReportTable();
      if (APP_STATE.activeView === 'laporan') setTimeout(renderAnalyticsCharts, 60);
    }
  }

  function scheduleIdleRender_() {
    if (APP_STATE.idleRenderPending) return;
    APP_STATE.idleRenderPending = true;
    const ric = window.requestIdleCallback || function(fn) { return setTimeout(fn, 150); };
    ric(function() {
      APP_STATE.idleRenderPending = false;
      const next = Object.keys(APP_STATE.dirtyViews || {})[0];
      if (!next) return;
      renderViewIfDirty_(next);
      scheduleIdleRender_();
    });
  }

  const PAGE_SIZE_ = 50;
  const PAGER_ = {};
  const PAGER_RENDER_ = {
    orders: function() { renderOrdersTable(); },
    customers: function() { renderCustomersTable(); },
    mutations: function() { renderMaterialsView(); },
    income: function() { renderFinanceView(); },
    expenses: function() { renderFinanceView(); },
    report: function() { renderReportTable(); }
  };

  /** Ambil potongan baris untuk ditampilkan; tombol "Tampilkan lagi" disisipkan otomatis. */
  function pageRows_(key, list, tbody, colspan, newestFirst) {
    const st = PAGER_[key] || (PAGER_[key] = { limit: PAGE_SIZE_, n: -1, seq: 0 });
    if (st.n !== list.length) { st.limit = PAGE_SIZE_; st.n = list.length; }
    const src = newestFirst ? list.slice().reverse() : list;
    const shown = src.slice(0, st.limit);
    const seq = ++st.seq;
    if (tbody) {
      Promise.resolve().then(function() {
        if (st.seq !== seq) return;
        const old = tbody.querySelector('tr.pager-row');
        if (old) old.parentNode.removeChild(old);
        if (src.length <= shown.length) return;
        const more = Math.min(PAGE_SIZE_, src.length - shown.length);
        tbody.insertAdjacentHTML('beforeend',
          '<tr class="pager-row"><td colspan="' + colspan + '">' +
            '<button type="button" class="btn btn-secondary btn-sm" onclick="showMoreRows_(\'' + key + '\')">Tampilkan ' + more + ' lagi</button>' +
            '<span class="pager-info">' + shown.length.toLocaleString('id-ID') + ' dari ' + src.length.toLocaleString('id-ID') + ' baris</span>' +
          '</td></tr>');
      });
    }
    return shown;
  }

  function showMoreRows_(key) {
    const st = PAGER_[key];
    if (!st) return;
    st.limit += PAGE_SIZE_;
    if (PAGER_RENDER_[key]) PAGER_RENDER_[key]();
  }

  /** Chart.js (±200 KB) dimuat hanya saat menu Laporan dibuka. */
  let chartJsPromise_ = null;
  function ensureChartJs_() {
    if (typeof Chart !== 'undefined') return Promise.resolve();
    if (chartJsPromise_) return chartJsPromise_;
    chartJsPromise_ = new Promise(function(resolve, reject) {
      const s = document.createElement('script');
      s.src = CHART_JS_URL;
      s.async = true;
      s.onload = function() { resolve(); };
      s.onerror = function() { chartJsPromise_ = null; reject(new Error('Gagal memuat Chart.js')); };
      document.head.appendChild(s);
    });
    return chartJsPromise_;
  }

  /**
   * ==========================================================================
   * 1d. SANDI: ganti sandi (wajib untuk sandi sementara) & sandi sementara pengguna
   * ==========================================================================
   */
  function openPasswordModal(forced) {
    APP_STATE.pwForced = Boolean(forced);
    const el = document.getElementById('passwordModal');
    if (!el) return;
    el.dataset.locked = forced ? '1' : '';
    document.getElementById('passwordModalTitle').textContent = forced ? 'Buat Sandi Baru' : 'Ganti Sandi';
    document.getElementById('passwordForcedNote').hidden = !forced;
    document.getElementById('passwordModalCloseBtn').hidden = Boolean(forced);
    document.getElementById('passwordModalCancelBtn').textContent = forced ? 'Keluar' : 'Batal';
    document.getElementById('pwOldGroup').hidden = Boolean(forced && APP_STATE.tempPassword);
    ['pwOldInput', 'pwNewInput', 'pwNew2Input'].forEach(function(id) { document.getElementById(id).value = ''; });
    openModal('passwordModal');
  }

  function cancelPasswordModal() {
    if (APP_STATE.pwForced) {
      const el = document.getElementById('passwordModal');
      el.dataset.locked = '';
      closeModal('passwordModal');
      APP_STATE.tempPassword = null;
      logoutUser();
      return;
    }
    closeModal('passwordModal');
  }

  async function submitPasswordChange() {
    const forced = APP_STATE.pwForced;
    const oldPw = (forced && APP_STATE.tempPassword) ? APP_STATE.tempPassword : document.getElementById('pwOldInput').value;
    const n1 = document.getElementById('pwNewInput').value;
    const n2 = document.getElementById('pwNew2Input').value;
    if (!oldPw) { showToast(forced ? 'Isi sandi sementara Anda.' : 'Isi sandi lama Anda.', 'error'); return; }
    if (n1.length < 8) { showToast('Sandi baru minimal 8 karakter.', 'error'); return; }
    if (n1 !== n2) { showToast('Ulangi sandi baru — kedua isian belum sama.', 'error'); return; }

    const btn = document.getElementById('passwordSubmitBtn');
    btn.disabled = true;
    btn.textContent = 'Menyimpan...';
    const base = APP_STATE.data || cacheLoadPayload_();
    const res = await api('changePassword', { oldPassword: oldPw, newPassword: n1 }, { read: true, tries: 1, have: base && base.cv });
    btn.disabled = false;
    btn.textContent = 'Simpan Sandi Baru';

    if (!res.success) {
      if (res.code === 'AUTH') { document.getElementById('passwordModal').dataset.locked = ''; closeModal('passwordModal'); handleSessionError_(res, true); return; }
      showToast(res.message || 'Gagal mengganti sandi.', 'error');
      return;
    }
    setToken_(res.data.token, res.data.exp);
    APP_STATE.tempPassword = null;
    APP_STATE.pwForced = false;
    document.getElementById('passwordModal').dataset.locked = '';
    closeModal('passwordModal');
    applyServerPayload(mergePayload_(base, res.data.boot));
    showToast('Sandi berhasil diganti. Perangkat lain yang memakai akun ini otomatis keluar.', 'success');
  }

  function createTempPasswordForUser(email) {
    openConfirmModal('Buat Sandi Sementara',
      'Buat sandi sementara baru untuk ' + email + '? Sandi lamanya (jika ada) langsung tidak berlaku dan akun ini keluar dari semua perangkat.',
      function() {
        callServer('setUserPassword', [{ email: email }], function(payload, extra) {
          applyServerPayload(payload);
          if (extra && extra.tempPassword) showTempPasswordModal(extra.email || email, extra.tempPassword);
        });
      });
  }

  function showTempPasswordModal(email, pw) {
    document.getElementById('tempPwEmail').textContent = email;
    document.getElementById('tempPwValue').textContent = pw;
    const text = 'Akun Si-MAKO Anda sudah siap.\nAlamat: ' + location.origin + location.pathname +
      '\nEmail: ' + email + '\nSandi sementara: ' + pw + '\n(Wajib diganti saat masuk pertama kali)';
    document.getElementById('tempPwWaLink').href = 'https://wa.me/?text=' + encodeURIComponent(text);
    openModal('tempPasswordModal');
  }

  function copyTempPassword() {
    const v = document.getElementById('tempPwValue').textContent;
    const done = function() { showToast('Sandi sementara disalin.', 'success'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(done, function() {});
  }

  function togglePasswordVisibility(inputId, btn) {
    const el = document.getElementById(inputId);
    if (!el) return;
    const show = el.type === 'password';
    el.type = show ? 'text' : 'password';
    if (btn) { btn.textContent = show ? 'Sembunyikan' : 'Lihat'; btn.setAttribute('aria-pressed', show ? 'true' : 'false'); }
  }

  function showBootError_(msg) {
    const el = document.getElementById('bootSplash');
    if (!el) { showToast(msg, 'error'); return; }
    el.hidden = false;
    el.innerHTML = '<div class="boot-error">' +
      '<div style="font-size:15px; color:var(--text-primary);">Data belum bisa dimuat</div>' +
      '<div class="body-sm" style="max-width:320px; text-align:center;">' + escapeHtml(msg) + '</div>' +
      '<div class="flex-row" style="gap:8px; justify-content:center;">' +
        '<button type="button" class="btn btn-primary btn-sm" onclick="retryBoot_()">Coba lagi</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" onclick="logoutUser()">Keluar</button>' +
      '</div></div>';
  }
  function retryBoot_() {
    const el = document.getElementById('bootSplash');
    if (el) el.innerHTML = '<div class="boot-spinner" aria-hidden="true"></div><div>Memuat Si-MAKO&hellip;</div>';
    refreshAppData(false);
  }

  /** Dipanggil sekali saat halaman dibuka. */
  function initV31_() {
    storeRemove_('sessionStorage', 'simako_payload_cache_v3');   // cache versi lama
    const setupMode = /[?&]setup=1\b/.test(location.search) || !isGasUrlConfigured();
    if (setupMode) document.querySelectorAll('[data-setup-only]').forEach(function(el) { el.hidden = false; });
    warmUpServer_();
    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState !== 'visible') return;
      if (!APP_STATE.data || !hasSession_() || APP_STATE.isSubmitting) return;
      if (document.querySelector('.modal-backdrop.open')) return;
      if (Date.now() - (APP_STATE.lastSyncAt || 0) > 120000) refreshAppData(false);
    });
  }

    function formatRupiah(num) {
    const n = Math.round(Number(num) || 0);
    return 'Rp ' + n.toLocaleString('id-ID');
  }

  function escapeHtml(str) {
    return String(str === null || str === undefined ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeDriveUrl(url) {
    const clean = String(url || '').trim();
    if (/^https:\/\/(drive|docs)\.google\.com\//i.test(clean)) {
      return escapeHtml(clean);
    }
    return '';
  }

  function safeHttpsUrl(url) {
    const clean = String(url || '').trim();
    if (/^https:\/\//i.test(clean)) {
      return escapeHtml(clean);
    }
    return '';
  }

  function getTodayYMD() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd;
  }

  function isOwnerRole() {
    return APP_STATE.effectiveRole === 'Owner';
  }

  function openConfirmModal(title, message, onConfirmCallback) {
    document.getElementById('confirmModalTitle').textContent = title || 'Konfirmasi';
    document.getElementById('confirmModalMessage').textContent = message || 'Lanjutkan tindakan ini?';
    const btn = document.getElementById('confirmModalActionBtn');
    btn.onclick = function() {
      closeModal('confirmModal');
      if (onConfirmCallback) onConfirmCallback();
    };
    openModal('confirmModal');
  }

  let _lastFocusedElement = null;

  function openModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    _lastFocusedElement = document.activeElement;
    el.classList.add('open');
    setTimeout(function() {
      const firstInput = el.querySelector('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button.btn-primary, button.modal-close');
      if (firstInput && typeof firstInput.focus === 'function') {
        firstInput.focus();
      }
    }, 30);
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.dataset && el.dataset.locked === '1') return;
    el.classList.remove('open');
    if (id === 'tempPasswordModal') { const v = document.getElementById('tempPwValue'); if (v) v.textContent = ''; }
    if (_lastFocusedElement && typeof _lastFocusedElement.focus === 'function') {
      try { _lastFocusedElement.focus(); } catch (e) {}
    }
  }

  // Tutup modal aktif saat menekan tombol Escape atau klik area backdrop luar
  window.addEventListener('keydown', function(evt) {
    const openModals = document.querySelectorAll('.modal-backdrop.open');
    if (openModals.length === 0) return;
    const topModal = openModals[openModals.length - 1];
    if (evt.key === 'Escape') {
      closeModal(topModal.id);
      return;
    }
    // Jebakan fokus: Tab / Shift+Tab berputar di dalam modal teratas (aksesibilitas keyboard)
    if (evt.key === 'Tab') {
      const focusables = Array.prototype.filter.call(
        topModal.querySelectorAll('a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'),
        function(el) { return el.offsetParent !== null; }
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (evt.shiftKey && (document.activeElement === first || !topModal.contains(document.activeElement))) {
        evt.preventDefault(); last.focus();
      } else if (!evt.shiftKey && (document.activeElement === last || !topModal.contains(document.activeElement))) {
        evt.preventDefault(); first.focus();
      }
    }
  });

  window.addEventListener('click', function(evt) {
    if (evt.target && evt.target.classList && evt.target.classList.contains('modal-backdrop') && evt.target.classList.contains('open')) {
      closeModal(evt.target.id);
    }
  });

  function toggleMobileSidebar(forceState) {
    const sb = document.getElementById('appSidebar');
    const bd = document.getElementById('sidebarBackdrop');
    if (!sb) return;
    const isOpen = forceState !== undefined ? Boolean(forceState) : !sb.classList.contains('mobile-open');
    sb.classList.toggle('mobile-open', isOpen);
    if (bd) bd.classList.toggle('active', isOpen);
  }

  /**
   * ==========================================================================
   * 2. INISIALISASI APLIKASI & MANAJEMEN PERAN (RBAC)
   * ==========================================================================
   */

  window.addEventListener('DOMContentLoaded', function() {
    applyTheme(getTheme(), false);
    initV31_();
    const savedLayout = storeGet_('localStorage', STORE_KEYS.invoiceLayout);
    if (savedLayout === 'A4' || savedLayout === 'NOTA') APP_STATE.invoiceLayout = savedLayout;

    const savedEmail = String(storeGet_('localStorage', STORE_KEYS.authEmail) || '').toLowerCase().trim();
    APP_STATE.authEmail = savedEmail;

    const emailInput = document.getElementById('loginEmailInput');
    if (emailInput && savedEmail) emailInput.value = savedEmail;

    const gasUrlInput = document.getElementById('loginGasUrlInput');
    if (gasUrlInput) {
      const currentUrl = getActiveGasUrl();
      if (currentUrl && currentUrl.indexOf('/XXXX/') === -1) {
        gasUrlInput.value = currentUrl;
      }
    }

    // Jika URL GAS belum diisi atau pengguna belum masuk dengan email, tampilkan Layar Masuk Email
    if (!isGasUrlConfigured() || !APP_STATE.authEmail || !hasSession_()) {
      hideBootSplash_();
      showLoginScreen(!isGasUrlConfigured());
      return;
    }

    // Stale-while-revalidate: tampilkan data terakhir SEKETIKA, lalu segarkan dari server
    const cached = cacheLoadPayload_();
    if (cached) applyServerPayload(cached, true);
    refreshAppData(false);
  });

  function showLoginScreen(forceShowApiBox) {
    document.getElementById('appShell').style.display = 'none';
    document.getElementById('accessDeniedScreen').style.display = 'none';
    const loginEl = document.getElementById('loginScreen');
    if (loginEl) loginEl.style.display = 'flex';

    const apiBox = document.getElementById('loginApiConfigBox');
    if (apiBox && (forceShowApiBox || !isGasUrlConfigured())) {
      apiBox.style.display = 'block';
    }
  }

  function toggleLoginApiConfig() {
    const apiBox = document.getElementById('loginApiConfigBox');
    if (!apiBox) return;
    const isHidden = apiBox.style.display === 'none';
    apiBox.style.display = isHidden ? 'block' : 'none';
    if (isHidden) {
      const inp = document.getElementById('loginGasUrlInput');
      if (inp) {
        const active = getActiveGasUrl();
        if (active && active.indexOf('/XXXX/') === -1) inp.value = active;
        inp.focus();
      }
    }
  }

  function openApiConfigModal() {
    logoutUser(true);
  }

  async function handleLoginSubmit(evt) {
    if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
    const emailInput = document.getElementById('loginEmailInput');
    const pwInput = document.getElementById('loginPasswordInput');
    const urlInput = document.getElementById('loginGasUrlInput');
    const submitBtn = document.getElementById('loginSubmitBtn');

    const email = String(emailInput ? emailInput.value : '').toLowerCase().trim();
    const password = pwInput ? pwInput.value : '';
    if (!email || email.indexOf('@') === -1) {
      showToast('Masukkan alamat email yang valid.', 'error');
      return;
    }

    if (urlInput && urlInput.value.trim()) {
      const candidateUrl = urlInput.value.trim();
      if (!isGasUrlConfigured(candidateUrl)) {
        showToast('Format URL Endpoint GAS tidak valid. Pastikan diakhiri dengan /exec', 'error');
        return;
      }
      storeSet_('localStorage', STORE_KEYS.gasUrlOverride, candidateUrl);
    }

    if (!isGasUrlConfigured()) {
      const apiBox = document.getElementById('loginApiConfigBox');
      if (apiBox) apiBox.style.display = 'block';
      showToast('Masukkan URL Web App GAS (/exec) Anda terlebih dahulu atau isi GAS_URL di js/config.js.', 'warning');
      return;
    }
    if (!password) {
      showToast('Masukkan sandi Anda.', 'error');
      if (pwInput) pwInput.focus();
      return;
    }

    function setBtn(busy) {
      if (!submitBtn) return;
      submitBtn.disabled = busy;
      submitBtn.innerHTML = busy ? '<span>Memverifikasi Akses...</span>' : '<span>Masuk ke Dashboard</span>';
    }

    APP_STATE.authEmail = email;
    storeSet_('localStorage', STORE_KEYS.authEmail, email);
    setBtn(true);
    const cached = cacheLoadPayload_();
    const res = await api('login', { email: email, password: password }, { have: cached && cached.cv });

    if (!res.success && /tidak dikenal/i.test(res.message || '')) {
      // Backend masih v3.0 (Kode.gs belum diperbarui): masuk dengan cara lama untuk sementara.
      storeSet_('localStorage', SESSION_KEYS.legacy, '1');
      await callServer('getInitialAppData', [{ fresh: true }], function(payload) {
        setBtn(false);
        applyServerPayload(payload);
        showToast('Backend masih versi lama: login belum memakai sandi. Segera perbarui Kode.gs ke v3.1.', 'warning');
      }, function(msg) {
        setBtn(false);
        showToast(msg, 'error');
      });
      return;
    }
    setBtn(false);
    if (!res.success) {
      showToast(res.message || 'Gagal masuk. Coba lagi.', 'error');
      if (pwInput && res.code === 'BAD_LOGIN') { pwInput.value = ''; pwInput.focus(); }
      return;
    }

    storeRemove_('localStorage', SESSION_KEYS.legacy);
    setToken_(res.data.token, res.data.exp);
    if (pwInput) pwInput.value = '';
    if (res.data.mustChange) {
      APP_STATE.tempPassword = password;     // hanya di memori, untuk langkah ganti sandi
      hideBootSplash_();
      openPasswordModal(true);
      return;
    }
    APP_STATE.lastSyncAt = Date.now();
    applyServerPayload(mergePayload_(cached, res.data.boot));
  }

  function logoutUser(openApiBox) {
    cacheClearPayload_();
    APP_STATE.data = null;
    clearToken_();
    storeRemove_('localStorage', SESSION_KEYS.legacy);
    const pwIn = document.getElementById('loginPasswordInput');
    if (pwIn) pwIn.value = '';
    if (!openApiBox) {
      APP_STATE.authEmail = '';
      storeRemove_('localStorage', STORE_KEYS.authEmail);
    }
    showLoginScreen(Boolean(openApiBox));
    showToast(openApiBox ? 'Silakan perbarui URL Endpoint GAS Anda.' : 'Anda telah keluar. Data di perangkat ini sudah dibersihkan.', 'info');
  }

  function refreshAppData(forceFresh) {
    if (!isGasUrlConfigured() || !APP_STATE.authEmail || !hasSession_()) {
      hideBootSplash_();
      showLoginScreen(!isGasUrlConfigured());
      return;
    }
    callServer('getInitialAppData', [{ fresh: Boolean(forceFresh) }], function(payload, extra, meta) {
      if (forceFresh || !APP_STATE.data || !meta || meta.changed) applyServerPayload(payload);
      else hideBootSplash_();
      if (forceFresh) showToast('Data terbaru dari Google Sheets sudah dimuat.', 'info');
    }, function(msg) {
      if (!APP_STATE.data) { showBootError_(msg); return; }
      hideBootSplash_();
      showToast(msg, 'error');
    });
  }

  function handleRecalculateOrderFinancials() {
    openConfirmModal(
      'Sinkronkan Ulang Tagihan & Pembayaran',
      'Sistem akan menghitung ulang Total Harga (dari rincian item) dan Total Dibayar / Sisa Tagihan (dari riwayat pembayaran) untuk seluruh order. Lanjutkan?',
      function() {
        callServer('recalculateAllOrderFinancials', [{}], function(payload) {
          applyServerPayload(payload);
          showToast('Seluruh tagihan & status bayar order berhasil disinkronkan!', 'success');
        });
      }
    );
  }

  function handleSeedDatabase() {
    openConfirmModal(
      'Inisialisasi 11 Sheet & Muat Data Contoh',
      'Sistem akan memastikan seluruh Sheet database tersedia di Google Sheets, membuat folder Google Drive Si-MAKO, dan mengisi data contoh jika tabel masih kosong. Lanjutkan?',
      function() {
        callServer('setupAppEnvironment', [{ seedSampleData: true, returnAppData: true }], function(payload) {
          applyServerPayload(payload);
          showToast('Database & data contoh konveksi berhasil disiapkan!', 'success');
        });
      }
    );
  }

  function applyServerPayload(payload, fromCache) {
    hideBootSplash_();
    const loginEl = document.getElementById('loginScreen');

    if (!payload || payload.authorized === false) {
      cacheClearPayload_();
      document.getElementById('appShell').style.display = 'none';
      if (payload && payload.requireLogin) {
        showLoginScreen(false);
        return;
      }
      if (loginEl) loginEl.style.display = 'none';
      const denied = document.getElementById('accessDeniedScreen');
      denied.style.display = 'flex';
      document.getElementById('deniedUserEmail').textContent = (payload && payload.email) || APP_STATE.authEmail || 'Tidak Terdeteksi';
      document.getElementById('accessDeniedMessage').textContent = (payload && payload.message) || 'Akses ditolak.';
      return;
    }

    if (loginEl) loginEl.style.display = 'none';
    document.getElementById('accessDeniedScreen').style.display = 'none';
    document.getElementById('appShell').style.display = 'flex';

    APP_STATE.data = payload;
    const actualRole = (payload.user && payload.user.peran) ? payload.user.peran : 'Admin';
    const simContainer = document.getElementById('roleSimContainer');

    if (actualRole === 'Owner') {
      if (simContainer) simContainer.style.display = 'flex';
      const sel = document.getElementById('roleSimulatorSelect');
      APP_STATE.effectiveRole = (sel && sel.value) ? sel.value : 'Owner';
    } else {
      if (simContainer) simContainer.style.display = 'none';
      APP_STATE.effectiveRole = 'Admin';
    }

    if (!fromCache) cacheSavePayload_(payload);

    updateUserAndRoleUI();
    renderAllViews();

    if (!APP_STATE.viewRestored) {
      APP_STATE.viewRestored = true;
      const lastView = storeGet_('localStorage', STORE_KEYS.view);
      const ownerOnly = ['hpp', 'stok', 'keuangan', 'laporan', 'pengaturan'];
      const allViews = ['dashboard', 'order', 'pelanggan'].concat(ownerOnly);
      if (lastView && lastView !== APP_STATE.activeView && allViews.indexOf(lastView) !== -1 &&
          (isOwnerRole() || ownerOnly.indexOf(lastView) === -1)) {
        switchView(lastView);
      }
    }
  }

  function handleRoleSimulationChange(newRole) {
    APP_STATE.effectiveRole = newRole;
    updateUserAndRoleUI();
    // Jika sedang di halaman khusus Owner lalu pindah ke Admin, arahkan kembali ke Dashboard
    const ownerOnlyViews = ['hpp', 'stok', 'keuangan', 'laporan', 'pengaturan'];
    if (newRole !== 'Owner' && ownerOnlyViews.indexOf(APP_STATE.activeView) !== -1) {
      switchView('dashboard');
    } else {
      renderAllViews();
    }
    showToast('Tampilan beralih ke mode peran: ' + newRole, 'info');
  }

  function updateUserAndRoleUI() {
    const d = APP_STATE.data;
    if (!d) return;

    const u = d.user || {};
    const s = d.settings || {};
    document.getElementById('sidebarBizName').textContent = s.nama_usaha || 'Manajemen Konveksi';
    document.getElementById('sidebarUserName').textContent = u.nama || 'Pengguna Si-MAKO';
    document.getElementById('sidebarUserEmail').textContent = u.email || '-';

    const initials = String(u.nama || 'SM').split(' ').map(function(w) { return w[0]; }).join('').substring(0, 2).toUpperCase();
    document.getElementById('sidebarUserAvatar').textContent = initials;

    const roleBadge = document.getElementById('sidebarUserRoleBadge');
    roleBadge.textContent = APP_STATE.effectiveRole;
    roleBadge.className = 'badge ' + (isOwnerRole() ? 'badge-owner' : 'badge-info');

    // Sembunyikan atau tampilkan menu Owner & banner pratinjau Admin
    const ownerNav = document.getElementById('ownerNavSection');
    ownerNav.style.display = isOwnerRole() ? 'block' : 'none';
    const previewBanner = document.getElementById('adminPreviewBanner');
    if (previewBanner) {
      const actualRole = (d.user && d.user.peran) || 'Admin';
      previewBanner.style.display = (actualRole === 'Owner' && !isOwnerRole()) ? 'flex' : 'none';
    }
    const simSelect = document.getElementById('roleSimulatorSelect');
    if (simSelect) simSelect.value = APP_STATE.effectiveRole;

    // Update badge jumlah order aktif & stok menipis di sidebar
    const activeOrdersCount = (d.orders || []).filter(function(o) {
      return o.status_order === 'Baru' || o.status_order === 'Diproses';
    }).length;
    document.getElementById('navBadgeActiveOrders').textContent = activeOrdersCount;

    const lowStockCount = (d.materials || []).filter(function(m) {
      return Number(m.stok_saat_ini) <= Number(m.stok_minimum);
    }).length;
    const lowBadge = document.getElementById('navBadgeLowStock');
    if (isOwnerRole() && lowStockCount > 0) {
      lowBadge.style.display = 'inline-flex';
      lowBadge.textContent = lowStockCount;
    } else {
      lowBadge.style.display = 'none';
    }
  }

  function switchView(viewName) {
    const ownerOnlyViews = ['hpp', 'stok', 'keuangan', 'laporan', 'pengaturan'];
    if (!isOwnerRole() && ownerOnlyViews.indexOf(viewName) !== -1) {
      showToast('Akses ditolak: Halaman ini khusus untuk Owner.', 'error');
      return;
    }

    APP_STATE.activeView = viewName;
    storeSet_('localStorage', STORE_KEYS.view, viewName);
    document.querySelectorAll('.app-view').forEach(function(sec) {
      sec.style.display = 'none';
    });
    const targetSec = document.getElementById('view-' + viewName);
    if (targetSec) targetSec.style.display = 'block';
    renderViewIfDirty_(viewName);

    document.querySelectorAll('.sidebar-nav .nav-item').forEach(function(btn) {
      btn.classList.remove('active');
    });
    const activeNav = document.getElementById('nav-' + viewName);
    if (activeNav) activeNav.classList.add('active');
    syncBottomNav_(viewName);

    const titles = {
      dashboard: 'Beranda',
      order: 'Pesanan',
      pelanggan: 'Pelanggan',
      hpp: 'Hitung Modal',
      stok: 'Stok Bahan',
      keuangan: 'Keuangan',
      laporan: 'Laporan',
      pengaturan: 'Pengaturan'
    };
    document.getElementById('headerPageTitle').textContent = titles[viewName] || 'Si-MAKO';

    toggleMobileSidebar(false);

    if (viewName === 'laporan' && isOwnerRole()) {
      setTimeout(renderAnalyticsCharts, 60);
    }
  }

  function renderAllViews() {
    // v3.1: tandai semua menu "kotor", gambar menu yang sedang dibuka sekarang, sisanya saat browser senggang
    APP_STATE.dirtyViews = {};
    ALL_VIEWS_.forEach(function(v) { APP_STATE.dirtyViews[v] = true; });
    renderViewIfDirty_(APP_STATE.activeView);
    scheduleIdleRender_();
  }

  /**
   * ==========================================================================
   * 3. VIEW 1: DASHBOARD (F9)
   * ==========================================================================
   */

  function getDeadlineUrgencyInfo(deadlineStr, statusOrder) {
    if (!deadlineStr) return { label: '-', badgeClass: 'badge-neutral', daysDiff: 999 };
    if (statusOrder === 'Batal') {
      return { label: 'Dibatalkan', badgeClass: 'badge-danger', daysDiff: 999 };
    }
    if (statusOrder === 'Selesai' || statusOrder === 'Diambil') {
      return { label: 'Selesai Tepat', badgeClass: 'badge-success', daysDiff: 999 };
    }
    const today = new Date(getTodayYMD() + 'T00:00:00');
    const dl = new Date(deadlineStr + 'T00:00:00');
    const diffDays = Math.ceil((dl.getTime() - today.getTime()) / (1000 * 3600 * 24));

    if (diffDays < 0) {
      return { label: 'Telat ' + Math.abs(diffDays) + ' hari', badgeClass: 'badge-danger', daysDiff: diffDays };
    }
    if (diffDays <= 3) {
      return { label: diffDays === 0 ? 'Hari ini' : (diffDays === 1 ? 'Besok' : diffDays + ' hari lagi'), badgeClass: 'badge-warning', daysDiff: diffDays };
    }
    return { label: diffDays + ' hari lagi', badgeClass: 'badge-info', daysDiff: diffDays };
  }

  function getOrderStatusBadge(status) {
    const map = {
      'Baru': 'badge-info',
      'Diproses': 'badge-warning',
      'Selesai': 'badge-success',
      'Diambil': 'badge-neutral',
      'Batal': 'badge-danger'
    };
    return '<span class="badge ' + (map[status] || 'badge-neutral') + '">' + escapeHtml(statusLabel_(status)) + '</span>';
  }

  function getPaymentStatusBadge(status) {
    const map = {
      'Lunas': 'badge-success',
      'DP': 'badge-warning',
      'Belum Bayar': 'badge-danger',
      'Batal': 'badge-neutral'
    };
    return '<span class="badge ' + (map[status] || 'badge-danger') + '">' + escapeHtml(PAY_LABEL_[status || 'Belum Bayar'] || status) + '</span>';
  }

  /**
   * ==========================================================================
   * v3.2 — BERANDA BERORIENTASI TUGAS + NAVIGASI BAWAH (HP)
   * ==========================================================================
   */
  const STATUS_LABEL_ = { 'Baru': 'Diterima', 'Diproses': 'Dijahit', 'Selesai': 'Selesai', 'Diambil': 'Diambil', 'Batal': 'Batal' };
  const PAY_LABEL_ = { 'Lunas': 'Lunas', 'DP': 'Uang muka', 'Belum Bayar': 'Belum bayar', 'Batal': 'Batal' };
  function statusLabel_(s) { return STATUS_LABEL_[s] || s || '-'; }

  function renderHomePanel_() {
    const el = document.getElementById('homeTaskPanel');
    const d = APP_STATE.data;
    if (!el || !d) return;
    const orders = d.orders || [];
    const user = d.user || {};
    const firstName = String(user.nama || '').split(' ')[0] || 'Selamat datang';
    const todayTxt = new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long' });

    const unpaid = orders.filter(function(o) { return o.status_order !== 'Batal' && (Number(o.sisa_tagihan) || 0) > 0; });
    const unpaidTotal = unpaid.reduce(function(a, o) { return a + (Number(o.sisa_tagihan) || 0); }, 0);

    const todo = orders.filter(function(o) {
      return o.status_order === 'Baru' || o.status_order === 'Diproses' || o.status_order === 'Selesai';
    }).map(function(o) {
      const u = getDeadlineUrgencyInfo(o.deadline, o.status_order);
      const ready = o.status_order === 'Selesai';
      return { o: o, u: u, ready: ready, sortKey: ready ? 9000 : u.daysDiff };
    }).sort(function(a, b) { return a.sortKey - b.sortKey; }).slice(0, 6);

    const lowStock = (d.materials || []).filter(function(m) {
      return (Number(m.stok_saat_ini) || 0) <= (Number(m.stok_minimum) || 0);
    });

    const items = todo.length === 0
      ? '<div class="home-empty">Belum ada pesanan yang sedang dikerjakan. Tekan <strong>Catat Pesanan</strong> untuk mulai.</div>'
      : todo.map(function(t) {
          const o = t.o;
          const qty = (o.items || []).reduce(function(a, it) { return a + (Number(it.qty) || 0); }, 0);
          const tone = t.ready ? 'ok' : (t.u.daysDiff <= 1 ? 'hot' : (t.u.daysDiff <= 3 ? 'warm' : 'calm'));
          const chip = t.ready ? 'Siap diambil' : t.u.label;
          return '<button type="button" class="home-task tone-' + tone + '" data-id="' + escapeHtml(o.id_order) + '" onclick="openOrderDetailModal(this.dataset.id)">' +
            '<span class="home-task-bar" aria-hidden="true"></span>' +
            '<span class="home-task-main">' +
              '<span class="home-task-title">' + escapeHtml(o.nama_pelanggan) + '</span>' +
              '<span class="home-task-sub">' + (qty ? qty.toLocaleString('id-ID') + ' pcs · ' : '') + escapeHtml(statusLabel_(o.status_order).toLowerCase()) + '</span>' +
            '</span>' +
            '<span class="home-chip">' + escapeHtml(chip) + '</span>' +
          '</button>';
        }).join('');

    el.innerHTML =
      '<div class="home-hello"><div class="home-date">' + escapeHtml(todayTxt) + '</div>' +
        '<div class="home-name">Halo, ' + escapeHtml(firstName) + '</div></div>' +
      '<div class="home-actions">' +
        '<button type="button" class="home-action primary" onclick="openOrderModal()">' +
          '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>' +
          '<span>Catat Pesanan</span></button>' +
        '<button type="button" class="home-action" onclick="startPaymentFromHome_()">' +
          '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#1F8A55" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/></svg>' +
          '<span>Terima Bayaran</span></button>' +
      '</div>' +
      '<button type="button" class="home-unpaid" onclick="switchView(\'order\')">' +
        '<span class="home-unpaid-label">Belum dibayar pelanggan</span>' +
        '<span class="home-unpaid-row"><span class="home-unpaid-amount">' + formatRupiah(unpaidTotal) + '</span>' +
        '<span class="home-link">Lihat ' + unpaid.length + ' tagihan</span></span>' +
      '</button>' +
      '<div class="home-section"><span>Yang perlu dikerjakan</span><span class="home-count">' + todo.length + ' pesanan</span></div>' +
      '<div class="home-tasks">' + items + '</div>' +
      (lowStock.length && isOwnerRole()
        ? '<button type="button" class="home-alert" onclick="switchView(\'stok\')">' + lowStock.length + ' bahan hampir habis: ' +
            escapeHtml(lowStock.slice(0, 2).map(function(m) { return m.nama_bahan; }).join(', ')) + (lowStock.length > 2 ? ', …' : '') + '</button>'
        : '') +
      '<div class="home-section home-more"><span>Ringkasan</span></div>';
  }

  /** Terima bayaran dari beranda: pilih pesanan yang masih punya tagihan. */
  function startPaymentFromHome_() {
    const d = APP_STATE.data;
    const list = (d && d.orders || []).filter(function(o) { return o.status_order !== 'Batal' && (Number(o.sisa_tagihan) || 0) > 0; });
    if (!list.length) { showToast('Semua pesanan sudah lunas.', 'success'); return; }
    if (list.length === 1) { openPaymentModal(list[0].id_order); return; }
    document.getElementById('recordDetailModalTitle').textContent = 'Pilih pesanan yang dibayar';
    document.getElementById('recordDetailModalBody').innerHTML = '<div class="home-tasks">' + list.map(function(o) {
      return '<button type="button" class="home-task tone-calm" data-id="' + escapeHtml(o.id_order) + '" onclick="closeModal(\'recordDetailModal\'); openPaymentModal(this.dataset.id)">' +
        '<span class="home-task-bar" aria-hidden="true"></span><span class="home-task-main">' +
        '<span class="home-task-title">' + escapeHtml(o.nama_pelanggan) + '</span>' +
        '<span class="home-task-sub">' + escapeHtml(o.no_invoice) + '</span></span>' +
        '<span class="home-chip">' + formatRupiah(o.sisa_tagihan) + '</span></button>';
    }).join('') + '</div>';
    document.getElementById('recordDetailModalFooter').innerHTML = '<button type="button" class="btn btn-secondary" onclick="closeModal(\'recordDetailModal\')">Batal</button>';
    openModal('recordDetailModal');
  }

  function syncBottomNav_(viewName) {
    document.querySelectorAll('.bottom-nav [data-view]').forEach(function(b) {
      const on = b.dataset.view === viewName;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }

  function renderDashboardView() {
    const d = APP_STATE.data;
    if (!d) return;
    renderHomePanel_();

    const orders = d.orders || [];
    const activeOrders = orders.filter(function(o) {
      return o.status_order === 'Baru' || o.status_order === 'Diproses';
    });

    const urgentOrders = activeOrders.filter(function(o) {
      const urg = getDeadlineUrgencyInfo(o.deadline, o.status_order);
      return urg.daysDiff <= 3;
    });

    const validOrders = orders.filter(function(o) { return o.status_order !== 'Batal'; });
    const currentMonthPrefix = getTodayYMD().substring(0, 7); // YYYY-MM
    const monthlyOrders = validOrders.filter(function(o) {
      return String(o.tanggal_order || '').indexOf(currentMonthPrefix) === 0;
    });
    const monthlyOmzet = monthlyOrders.reduce(function(acc, o) { return acc + (Number(o.total_harga) || 0); }, 0);
    const totalPiutang = validOrders.reduce(function(acc, o) { return acc + (Number(o.sisa_tagihan) || 0); }, 0);
    const lowStockItems = (d.materials || []).filter(function(m) {
      return Number(m.stok_saat_ini) <= Number(m.stok_minimum);
    });

    // Render KPI Cards (Admin hanya melihat Order Aktif & Deadline Terdekat sesuai PRD)
    let kpiHtml = '' +
      '<div class="kpi-card">' +
        '<div class="kpi-top">' +
          '<span class="label-sm">Sedang dikerjakan</span>' +
          '<div class="kpi-icon" style="background:var(--primary-soft); color:var(--primary);">' +
            '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>' +
          '</div>' +
        '</div>' +
        '<div class="kpi-value tnum">' + activeOrders.length + ' Order</div>' +
        '<div class="kpi-foot">Pesanan diterima & sedang dijahit</div>' +
      '</div>' +

      '<div class="kpi-card">' +
        '<div class="kpi-top">' +
          '<span class="label-sm">Tenggat dekat / telat</span>' +
          '<div class="kpi-icon" style="background:var(--warning-soft); color:var(--warning-text);">' +
            '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' +
          '</div>' +
        '</div>' +
        '<div class="kpi-value tnum" style="color:' + (urgentOrders.length > 0 ? 'var(--danger-text)' : 'var(--text-primary)') + ';">' + urgentOrders.length + ' Order</div>' +
        '<div class="kpi-foot">Kerjakan lebih dulu</div>' +
      '</div>';

    if (isOwnerRole()) {
      kpiHtml += '' +
        '<div class="kpi-card">' +
          '<div class="kpi-top">' +
            '<span class="label-sm">Penjualan bulan ini</span>' +
            '<span class="badge-owner-mini">Owner</span>' +
          '</div>' +
          '<div class="kpi-value tnum" style="color:var(--primary);">' + formatRupiah(monthlyOmzet) + '</div>' +
          '<div class="kpi-foot">' + monthlyOrders.length + ' pesanan masuk bulan ini</div>' +
        '</div>' +

        '<div class="kpi-card">' +
          '<div class="kpi-top">' +
            '<span class="label-sm">Belum dibayar</span>' +
            '<span class="badge-owner-mini">Owner</span>' +
          '</div>' +
          '<div class="kpi-value tnum" style="color:var(--danger-text);">' + formatRupiah(totalPiutang) + '</div>' +
          '<div class="kpi-foot">Total sisa tagihan semua pesanan</div>' +
        '</div>';
    }

    document.getElementById('dashboardKpiGrid').innerHTML = kpiHtml;

    // Tabel Deadline Terdekat
    const sortedActive = activeOrders.slice().sort(function(a, b) {
      return String(a.deadline || '9999').localeCompare(String(b.deadline || '9999'));
    });

    const dlBody = document.getElementById('dashboardDeadlineTableBody');
    if (sortedActive.length === 0) {
      dlBody.innerHTML = '<tr><td colspan="5" class="empty-state">Tidak ada antrean order aktif saat ini.</td></tr>';
    } else {
      dlBody.innerHTML = sortedActive.map(function(o) {
        const urg = getDeadlineUrgencyInfo(o.deadline, o.status_order);
        return '<tr>' +
          '<td>' +
            '<div class="code-cell">' + escapeHtml(o.no_invoice) + '</div>' +
            '<div class="mobile-sub">' + escapeHtml(o.nama_pelanggan) + ' • ' + escapeHtml(o.deadline) + '</div>' +
          '</td>' +
          '<td class="col-desktop-only"><div class="cell-truncate" style="font-weight:600;">' + escapeHtml(o.nama_pelanggan) + '</div></td>' +
          '<td class="col-desktop-only">' +
            '<div class="flex-row" style="gap:6px; flex-wrap:nowrap;">' +
              '<span class="tnum" style="font-weight:600;">' + escapeHtml(o.deadline) + '</span>' +
              '<span class="badge ' + urg.badgeClass + '">' + urg.label + '</span>' +
            '</div>' +
          '</td>' +
          '<td>' + getOrderStatusBadge(o.status_order) + '</td>' +
          '<td class="num-col">' +
            '<button type="button" class="btn btn-secondary btn-xs" data-id="' + escapeHtml(o.id_order) + '" onclick="openOrderDetailModal(this.dataset.id)">Detail</button>' +
          '</td>' +
        '</tr>';
      }).join('');
    }

    // Panel Stok Menipis (Khusus Owner)
    const ownerStockCard = document.getElementById('dashboardOwnerStockCard');
    if (isOwnerRole()) {
      ownerStockCard.style.display = 'block';
      const stockContainer = document.getElementById('dashboardLowStockList');
      if (lowStockItems.length === 0) {
        stockContainer.innerHTML = '<div class="badge badge-success">Seluruh stok bahan baku berada di atas batas minimum</div>';
      } else {
        stockContainer.innerHTML = lowStockItems.map(function(m) {
          return '<div class="flex-between" style="padding:10px 0; border-bottom:1px solid var(--border-subtle);">' +
            '<div>' +
              '<div style="font-weight:600; font-size:13px;">' + escapeHtml(m.nama_bahan) + '</div>' +
              '<div class="body-sm" style="color:var(--text-muted);">Min: ' + m.stok_minimum + ' ' + escapeHtml(m.satuan) + '</div>' +
            '</div>' +
            '<div style="text-align:right;">' +
              '<span class="badge badge-danger tnum">Sisa ' + m.stok_saat_ini + ' ' + escapeHtml(m.satuan) + '</span>' +
            '</div>' +
          '</div>';
        }).join('');
      }
    } else {
      ownerStockCard.style.display = 'none';
    }

    // Ringkasan Pipeline Status Order
    const statuses = ['Baru', 'Diproses', 'Selesai', 'Diambil'];
    const statusBox = document.getElementById('dashboardStatusSummary');
    statusBox.innerHTML = statuses.map(function(st) {
      const count = orders.filter(function(o) { return o.status_order === st; }).length;
      const pct = orders.length > 0 ? Math.round((count / orders.length) * 100) : 0;
      return '<div style="margin-bottom:12px;">' +
        '<div class="flex-between" style="margin-bottom:4px; font-size:13px;">' +
          '<span>' + getOrderStatusBadge(st) + '</span>' +
          '<strong class="tnum">' + count + ' Order (' + pct + '%)</strong>' +
        '</div>' +
        '<div style="height:6px; background:var(--bg-subtle); border-radius:99px; overflow:hidden;">' +
          '<div style="height:100%; width:' + pct + '%; background:var(--primary); border-radius:99px;"></div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  /**
   * ==========================================================================
   * 4. VIEW 2: MANAJEMEN ORDER & PEMBAYARAN (F3, F4, F8)
   * ==========================================================================
   */

  function resetOrderFilters() {
    document.getElementById('searchOrderInput').value = '';
    document.getElementById('filterOrderStatus').value = 'ALL';
    document.getElementById('filterPaymentStatus').value = 'ALL';
    document.getElementById('filterDeadlineStart').value = '';
    document.getElementById('filterDeadlineEnd').value = '';
    renderOrdersTable();
  }

  function renderOrdersTable() {
    const d = APP_STATE.data;
    if (!d) return;

    const q = (document.getElementById('searchOrderInput').value || '').toLowerCase().trim();
    const fStatus = document.getElementById('filterOrderStatus').value;
    const fPay = document.getElementById('filterPaymentStatus').value;
    const fStart = document.getElementById('filterDeadlineStart').value;
    const fEnd = document.getElementById('filterDeadlineEnd').value;

    const filtered = (d.orders || []).filter(function(o) {
      if (fStatus !== 'ALL' && o.status_order !== fStatus) return false;
      if (fPay !== 'ALL' && o.status_bayar !== fPay) return false;
      if (fStart && String(o.deadline) < fStart) return false;
      if (fEnd && String(o.deadline) > fEnd) return false;
      if (q) {
        const itemText = (o.items || []).map(function(i) { return i.jenis_produk; }).join(' ').toLowerCase();
        const hay = (o.no_invoice + ' ' + o.id_order + ' ' + o.nama_pelanggan + ' ' + itemText).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });

    const tbody = document.getElementById('ordersTableBody');
    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Tidak ada data order yang cocok dengan filter pencarian.</td></tr>';
      return;
    }

    tbody.innerHTML = pageRows_('orders', filtered, tbody, 6, true).map(function(o) {
      const urg = getDeadlineUrgencyInfo(o.deadline, o.status_order);
      return '<tr>' +
        '<td>' +
          '<div class="code-cell">' + escapeHtml(o.no_invoice) + '</div>' +
          '<div class="mobile-sub">' + escapeHtml(o.nama_pelanggan) + ' • ' + escapeHtml(o.status_order) + '</div>' +
        '</td>' +
        '<td class="col-desktop-only"><div class="cell-truncate" style="font-weight:600;">' + escapeHtml(o.nama_pelanggan) + '</div></td>' +
        '<td class="col-desktop-only">' +
          '<div class="flex-row" style="gap:6px; flex-wrap:nowrap;">' +
            '<span class="tnum" style="font-weight:600;">' + escapeHtml(o.deadline) + '</span>' +
            '<span class="badge ' + urg.badgeClass + '">' + urg.label + '</span>' +
          '</div>' +
        '</td>' +
        '<td class="col-desktop-only">' + getOrderStatusBadge(o.status_order) + '</td>' +
        '<td class="num-col">' +
          '<div class="flex-row bill-status-cell" style="justify-content:flex-end; gap:8px; flex-wrap:nowrap;">' +
            '<span class="numeric-md tnum">' + formatRupiah(o.total_harga) + '</span>' +
            getPaymentStatusBadge(o.status_bayar) +
          '</div>' +
        '</td>' +
        '<td class="num-col">' +
          '<button type="button" class="btn btn-secondary btn-xs" data-id="' + escapeHtml(o.id_order) + '" onclick="openOrderDetailModal(this.dataset.id)">Detail</button>' +
        '</td>' +
      '</tr>';
    }).join('');
  }

  function quickChangeOrderStatus(idOrder, newStatus) {
    callServer('updateOrderStatus', [idOrder, newStatus], function(payload) {
      applyServerPayload(payload);
      showToast('Status order ' + idOrder + ' diperbarui menjadi: ' + newStatus, 'success');
    });
  }

  function confirmDeleteOrder(idOrder) {
    const d = APP_STATE.data;
    const target = d && (d.orders || []).find(function(o) { return o.id_order === idOrder; });
    const hasPayment = target && Number(target.total_dibayar) > 0;
    const title = hasPayment ? 'Batalkan Order (Void)' : 'Batalkan / Hapus Order';
    const msg = hasPayment
      ? ('Order ' + idOrder + ' sudah memiliki pembayaran masuk. Demi integritas nomor invoice & audit kas, order akan diubah menjadi status "Batal" (Void) dan tagihan dinolkan. Lanjutkan?')
      : ('Ubah status order ' + idOrder + ' menjadi "Batal" (Void) agar histori nomor invoice tetap terjaga?');

    openConfirmModal(title, msg, function() {
      callServer('deleteOrder', [idOrder, false], function(payload) {
        applyServerPayload(payload);
        showToast('Order ' + idOrder + ' telah dibatalkan (Void).', 'success');
      });
    });
  }

  function openOrderModal(editOrderId) {
    const d = APP_STATE.data;
    if (!d) return;

    // Reset kotak cari pelanggan & isi dropdown pelanggan
    const custSearch = document.getElementById('orderCustomerSearchInput');
    if (custSearch) custSearch.value = '';
    filterOrderCustomerDropdown('');

    // Populate acuan harga katalog dari Kalkulasi HPP
    const refSelect = document.getElementById('orderHppRefSelect');
    refSelect.innerHTML = '<option value="">+ Isi dari Acuan Harga Katalog...</option>' +
      (d.productPriceRefs || []).map(function(r) {
        return '<option value="' + r.id + '">' + escapeHtml(r.nama_produk) + ' — ' + formatRupiah(r.harga_jual_per_pcs) + '/pcs</option>';
      }).join('');

    const itemsContainer = document.getElementById('orderItemsContainer');
    itemsContainer.innerHTML = '';
    delete APP_STATE.pendingUploads['orderBuktiFileInput'];
    document.getElementById('orderBuktiFileInput').value = '';
    document.getElementById('orderBuktiInfo').textContent = '';

    if (editOrderId) {
      const target = (d.orders || []).find(function(o) { return o.id_order === editOrderId; });
      if (!target) return;
      document.getElementById('orderModalTitle').textContent = 'Ubah Order ' + target.no_invoice;
      document.getElementById('orderIdInput').value = target.id_order;
      filterOrderCustomerDropdown('', target.id_pelanggan);
      document.getElementById('orderTanggalInput').value = target.tanggal_order || getTodayYMD();
      document.getElementById('orderDeadlineInput').value = target.deadline || '';
      document.getElementById('orderCatatanInput').value = target.catatan || '';
      document.getElementById('orderInitialDpSection').style.display = 'none';
      document.getElementById('orderDpInput').value = target.total_dibayar || 0;

      (target.items || []).forEach(function(it) {
        addOrderItemRow(it.jenis_produk, it.ukuran, it.qty, it.harga_satuan);
      });
    } else {
      document.getElementById('orderModalTitle').textContent = 'Buat Order Konveksi Baru';
      document.getElementById('orderIdInput').value = '';
      document.getElementById('orderTanggalInput').value = getTodayYMD();
      // Default deadline +10 hari
      const dl = new Date();
      dl.setDate(dl.getDate() + 10);
      document.getElementById('orderDeadlineInput').value = dl.toISOString().substring(0, 10);
      document.getElementById('orderCatatanInput').value = '';
      document.getElementById('orderInitialDpSection').style.display = 'block';
      document.getElementById('orderDpInput').value = 0;
      addOrderItemRow('', 'S, M, L, XL', 24, 75000);
    }

    recalculateOrderModalSummary();
    openModal('orderModal');
  }

  function addOrderItemRow(jenis, ukuran, qty, harga) {
    const container = document.getElementById('orderItemsContainer');
    const row = document.createElement('div');
    row.className = 'order-item-row';
    // Grid layout diatur rapi oleh class .order-item-row di Stylesheet.html
    row.innerHTML = '' +
      '<input type="text" class="form-control item-jenis" placeholder="Jenis Produk (mis. Kaos Combed 30s)" value="' + escapeHtml(jenis || '') + '">' +
      '<input type="text" class="form-control item-ukuran" placeholder="Rincian Ukuran (M:10, L:14)" value="' + escapeHtml(ukuran || 'All Size') + '">' +
      '<input type="number" class="form-control tnum item-qty" placeholder="Qty" min="1" value="' + (qty !== undefined ? qty : 12) + '" oninput="recalculateOrderModalSummary()">' +
      '<div class="input-rupiah-group">' +
        '<span class="input-rupiah-prefix">Rp</span>' +
        '<input type="number" class="item-harga" min="0" step="500" value="' + (harga !== undefined ? harga : 75000) + '" oninput="recalculateOrderModalSummary()">' +
      '</div>' +
      '<div class="num-col numeric-md tnum item-subtotal" style="padding:0 6px; text-align:right;">Rp 0</div>' +
      '<button type="button" class="btn btn-danger-soft btn-xs" onclick="removeOrderItemRow(this)" title="Hapus baris" aria-label="Hapus baris item">✕</button>';
    container.appendChild(row);
    recalculateOrderModalSummary();
  }

  function removeOrderItemRow(btn) {
    const container = document.getElementById('orderItemsContainer');
    if (container.querySelectorAll('.order-item-row').length <= 1) {
      showToast('Order wajib memiliki minimal 1 baris item produk.', 'warning');
      return;
    }
    btn.closest('.order-item-row').remove();
    recalculateOrderModalSummary();
  }

  function filterOrderCustomerDropdown(query, keepSelectedId) {
    const d = APP_STATE.data;
    if (!d) return;
    const custSelect = document.getElementById('orderPelangganSelect');
    const currentVal = keepSelectedId !== undefined ? keepSelectedId : custSelect.value;
    const q = String(query || '').toLowerCase().trim();
    const list = (d.customers || []).filter(function(c) {
      if (!q) return true;
      return (String(c.nama) + ' ' + String(c.kontak) + ' ' + String(c.id_pelanggan)).toLowerCase().indexOf(q) !== -1;
    });

    custSelect.innerHTML = '<option value="">-- Pilih Pelanggan (' + list.length + ') --</option>' +
      list.map(function(c) {
        return '<option value="' + c.id_pelanggan + '">' + escapeHtml(c.nama) + ' (' + escapeHtml(c.kontak) + ')</option>';
      }).join('');

    if (currentVal && list.some(function(c) { return c.id_pelanggan === currentVal; })) {
      custSelect.value = currentVal;
    } else if (q && list.length === 1) {
      custSelect.value = list[0].id_pelanggan;
    }
  }

  function useHppInNewOrder(hppId) {
    const d = APP_STATE.data;
    if (!d) return;
    const ref = (d.productPriceRefs || []).find(function(r) { return r.id === hppId; }) ||
                (d.hppCalculations || []).find(function(h) { return h.id === hppId; });
    openOrderModal();
    if (ref) {
      const container = document.getElementById('orderItemsContainer');
      container.innerHTML = '';
      addOrderItemRow(ref.nama_produk, 'S, M, L, XL', 24, Number(ref.harga_jual_per_pcs) || 75000);
      showToast('Acuan harga "' + ref.nama_produk + '" diterapkan ke form Order Baru.', 'info');
    }
  }

  function applyHppReferenceToNewItem(hppId) {
    if (!hppId || !APP_STATE.data) return;
    const ref = (APP_STATE.data.productPriceRefs || []).find(function(r) { return r.id === hppId; });
    if (ref) {
      addOrderItemRow(ref.nama_produk, 'M, L, XL', 24, ref.harga_jual_per_pcs);
    }
    document.getElementById('orderHppRefSelect').value = '';
  }

  function recalculateOrderModalSummary() {
    const rows = document.querySelectorAll('#orderItemsContainer .order-item-row');
    let totalHarga = 0;
    rows.forEach(function(r) {
      const qty = Number(r.querySelector('.item-qty').value) || 0;
      const harga = Number(r.querySelector('.item-harga').value) || 0;
      const sub = Math.round(qty * harga);
      totalHarga += sub;
      r.querySelector('.item-subtotal').textContent = formatRupiah(sub);
    });

    const dp = Math.max(0, Number(document.getElementById('orderDpInput').value) || 0);
    const remaining = Math.max(0, totalHarga - dp);
    let statusBayar = 'Belum Bayar';
    let badgeClass = 'badge-danger';
    if (dp > 0 && dp < totalHarga) {
      statusBayar = 'DP';
      badgeClass = 'badge-warning';
    } else if (dp >= totalHarga && totalHarga > 0) {
      statusBayar = 'Lunas';
      badgeClass = 'badge-success';
    }

    document.getElementById('orderSummaryTotal').textContent = formatRupiah(totalHarga);
    document.getElementById('orderSummaryPaid').textContent = formatRupiah(dp);
    document.getElementById('orderSummaryRemaining').textContent = formatRupiah(remaining);
    const badge = document.getElementById('orderSummaryStatusBayar');
    badge.textContent = statusBayar;
    badge.className = 'badge ' + badgeClass;
  }

  function submitOrderForm() {
    const idOrder = document.getElementById('orderIdInput').value;
    const idPelanggan = document.getElementById('orderPelangganSelect').value;
    const tanggalOrder = document.getElementById('orderTanggalInput').value;
    const deadline = document.getElementById('orderDeadlineInput').value;
    const catatan = document.getElementById('orderCatatanInput').value;
    const dpAwal = Number(document.getElementById('orderDpInput').value) || 0;
    const metodeBayar = document.getElementById('orderMetodeBayarInput').value;

    if (!idPelanggan) {
      showToast('Pilih pelanggan terlebih dahulu.', 'error');
      return;
    }
    if (!deadline) {
      showToast('Tanggal deadline produksi wajib diisi.', 'error');
      return;
    }

    const items = [];
    const rows = document.querySelectorAll('#orderItemsContainer .order-item-row');
    for (let i = 0; i < rows.length; i++) {
      const jenis = rows[i].querySelector('.item-jenis').value.trim();
      const ukuran = rows[i].querySelector('.item-ukuran').value.trim();
      const qty = Number(rows[i].querySelector('.item-qty').value) || 0;
      const harga = Number(rows[i].querySelector('.item-harga').value) || 0;
      if (!jenis || qty <= 0) {
        showToast('Pastikan setiap baris item memiliki nama produk dan Qty > 0.', 'error');
        return;
      }
      items.push({ jenis_produk: jenis, ukuran: ukuran, qty: qty, harga_satuan: harga });
    }

    const uploadObj = APP_STATE.pendingUploads['orderBuktiFileInput'] || {};
    const payload = {
      id_order: idOrder || '',
      id_pelanggan: idPelanggan,
      tanggal_order: tanggalOrder,
      deadline: deadline,
      catatan: catatan,
      dp_awal: dpAwal,
      metode_bayar: metodeBayar,
      items: items,
      bukti_base64: uploadObj.base64 || '',
      bukti_filename: uploadObj.fileName || '',
      bukti_mimetype: uploadObj.mimeType || ''
    };

    callServer('saveOrder', [payload], function(res) {
      closeModal('orderModal');
      applyServerPayload(res);
      showToast(idOrder ? 'Data order berhasil diperbarui!' : 'Order baru berhasil disimpan!', 'success');
    });
  }

  function openOrderDetailModal(idOrder) {
    const d = APP_STATE.data;
    if (!d) return;
    const o = (d.orders || []).find(function(x) { return x.id_order === idOrder; });
    if (!o) return;

    document.getElementById('orderDetailModalTitle').textContent = 'Detail Order — ' + o.no_invoice;

    const itemsRows = (o.items || []).map(function(it, idx) {
      return '<tr>' +
        '<td>' + (idx + 1) + '</td>' +
        '<td><strong>' + escapeHtml(it.jenis_produk) + '</strong></td>' +
        '<td>' + escapeHtml(it.ukuran) + '</td>' +
        '<td class="num-col">' + Number(it.qty).toLocaleString('id-ID') + ' pcs</td>' +
        '<td class="num-col">' + formatRupiah(it.harga_satuan) + '</td>' +
        '<td class="num-col numeric-md">' + formatRupiah(it.subtotal) + '</td>' +
      '</tr>';
    }).join('');

    const paymentRows = (o.payments || []).length === 0
      ? '<tr><td colspan="6" class="empty-state" style="padding:16px;">Belum ada pembayaran tercatat untuk order ini.</td></tr>'
      : (o.payments || []).map(function(p) {
          const safeUrl = safeDriveUrl(p.link_bukti);
          const buktiLink = safeUrl
            ? '<a href="' + safeUrl + '" target="_blank" rel="noopener noreferrer" class="badge badge-info">Lihat Bukti</a>'
            : '<span class="body-sm" style="color:var(--text-muted);">-</span>';
          return '<tr>' +
            '<td class="code-cell">' + escapeHtml(p.id_bayar) + '</td>' +
            '<td class="tnum">' + escapeHtml(p.tanggal) + '</td>' +
            '<td><span class="badge badge-neutral">' + escapeHtml(p.jenis) + '</span></td>' +
            '<td>' + escapeHtml(p.metode) + '</td>' +
            '<td class="num-col numeric-md" style="color:var(--success-text);">' + formatRupiah(p.jumlah) + '</td>' +
            '<td>' + buktiLink + '</td>' +
          '</tr>';
        }).join('');

    const statusBtns = ['Baru', 'Diproses', 'Selesai', 'Diambil', 'Batal'].map(function(st) {
      const activeClass = o.status_order === st ? 'btn-primary' : 'btn-secondary';
      return '<button type="button" class="btn ' + activeClass + ' btn-sm" data-id=\"' + escapeHtml(o.id_order) + '\" data-status=\"' + escapeHtml(st) + '\" onclick=\"quickChangeOrderStatus(this.dataset.id, this.dataset.status); closeModal(\'orderDetailModal\');\">' + st + '</button>';
    }).join('');

    document.getElementById('orderDetailModalBody').innerHTML = '' +
      '<div class="flex-between" style="background:var(--bg-subtle); padding:14px 16px; border-radius:12px; border:1px solid var(--border-color); margin-bottom:16px;">' +
        '<div>' +
          '<div class="label-sm"> Tahapan Produksi Saat Ini</div>' +
          '<div style="margin-top:4px;">' + getOrderStatusBadge(o.status_order) + ' ' + getPaymentStatusBadge(o.status_bayar) + '</div>' +
        '</div>' +
        '<div class="flex-row">' + statusBtns + '</div>' +
      '</div>' +

      '<div class="grid-12" style="gap:16px; margin-bottom:16px;">' +
        '<div class="col-span-6" style="background:#FFF; border:1px solid var(--border-color); border-radius:12px; padding:14px;">' +
          '<div class="label-sm" style="margin-bottom:6px;">Informasi Pelanggan</div>' +
          '<div style="font-weight:700; font-size:15px;">' + escapeHtml(o.nama_pelanggan) + '</div>' +
          '<div class="body-sm tnum" style="color:var(--text-secondary); margin-top:2px;">WA/Telp: ' + escapeHtml(o.kontak_pelanggan) + '</div>' +
          '<div class="body-sm" style="color:var(--text-muted); margin-top:2px;">' + escapeHtml(o.alamat_pelanggan) + '</div>' +
        '</div>' +
        '<div class="col-span-6" style="background:#FFF; border:1px solid var(--border-color); border-radius:12px; padding:14px;">' +
          '<div class="label-sm" style="margin-bottom:6px;">Ringkasan Tagihan & Jadwal</div>' +
          '<div class="flex-between body-sm"><span>Tanggal Order:</span><strong class="tnum">' + escapeHtml(o.tanggal_order) + '</strong></div>' +
          '<div class="flex-between body-sm"><span>Deadline Selesai:</span><strong class="tnum">' + escapeHtml(o.deadline) + '</strong></div>' +
          '<div class="flex-between body-sm"><span>Total Harga:</span><strong class="tnum">' + formatRupiah(o.total_harga) + '</strong></div>' +
          '<div class="flex-between body-sm"><span>Total Dibayar:</span><strong class="tnum" style="color:var(--success-text);">' + formatRupiah(o.total_dibayar) + '</strong></div>' +
          '<div class="flex-between body-md" style="margin-top:4px; padding-top:4px; border-top:1px dashed var(--border-color);"><span>Sisa Tagihan:</span><strong class="tnum" style="color:var(--danger-text);">' + formatRupiah(o.sisa_tagihan) + '</strong></div>' +
        '</div>' +
      '</div>' +

      (o.catatan ? '<div style="margin-bottom:16px; padding:10px 14px; background:var(--warning-soft); color:var(--warning-text); border-radius:10px; font-size:13px;"><strong>Catatan Produksi:</strong> ' + escapeHtml(o.catatan) + '</div>' : '') +

      '<div class="label-md" style="margin-bottom:8px;">Rincian Item Produk</div>' +
      '<div class="table-responsive" style="border:1px solid var(--border-color); border-radius:12px; margin-bottom:20px;">' +
        '<table class="data-table"><thead><tr><th>No</th><th>Jenis Produk</th><th>Ukuran</th><th class="num-col">Qty</th><th class="num-col">Harga Satuan</th><th class="num-col">Subtotal</th></tr></thead><tbody>' + itemsRows + '</tbody></table>' +
      '</div>' +

      '<div class="flex-between" style="margin-bottom:8px;">' +
        '<span class="label-md">Riwayat Pembayaran (DP / Cicilan / Pelunasan)</span>' +
        (o.sisa_tagihan > 0 ? '<button type="button" class="btn btn-primary btn-xs" data-id="' + escapeHtml(o.id_order) + '" onclick="closeModal(\'orderDetailModal\'); openPaymentModal(this.dataset.id);">+ Tambah Pembayaran</button>' : '<span class="badge badge-success">Order Sudah Lunas</span>') +
      '</div>' +
      '<div class="table-responsive" style="border:1px solid var(--border-color); border-radius:12px;">' +
        '<table class="data-table"><thead><tr><th>ID Bayar</th><th>Tanggal</th><th>Jenis</th><th>Metode</th><th class="num-col">Jumlah</th><th>Bukti Transfer</th></tr></thead><tbody>' + paymentRows + '</tbody></table>' +
      '</div>';

    const voidBtnHtml = (isOwnerRole() && o.status_order !== 'Batal')
      ? '<button type="button" class="btn btn-danger-soft" data-id="' + escapeHtml(o.id_order) + '" onclick="closeModal(\'orderDetailModal\'); confirmDeleteOrder(this.dataset.id);">Batalkan Order</button>'
      : '';
    const editBtnHtml = (o.status_order !== 'Batal')
      ? '<button type="button" class="btn btn-secondary" data-id="' + escapeHtml(o.id_order) + '" onclick="closeModal(\'orderDetailModal\'); openOrderModal(this.dataset.id);">Ubah Order</button>'
      : '';
    const payBtnHtml = (o.sisa_tagihan > 0 && o.status_order !== 'Batal')
      ? '<button type="button" class="btn btn-primary" data-id="' + escapeHtml(o.id_order) + '" onclick="closeModal(\'orderDetailModal\'); openPaymentModal(this.dataset.id);">+ Catat Pembayaran</button>'
      : '';

    document.getElementById('orderDetailModalFooter').innerHTML = '' +
      '<button type="button" class="btn btn-secondary" onclick="closeModal(\'orderDetailModal\')">Tutup</button>' +
      voidBtnHtml +
      editBtnHtml +
      '<button type="button" class="btn btn-secondary" data-id="' + escapeHtml(o.id_order) + '" onclick="closeModal(\'orderDetailModal\'); openInvoicePreviewModal(this.dataset.id);">Cetak Invoice / Nota</button>' +
      payBtnHtml;

    openModal('orderDetailModal');
  }

  function openPaymentModal(idOrder) {
    const d = APP_STATE.data;
    if (!d) return;
    const o = (d.orders || []).find(function(x) { return x.id_order === idOrder; });
    if (!o) return;

    document.getElementById('payOrderIdInput').value = o.id_order;
    document.getElementById('payModalInvoiceNo').textContent = o.no_invoice;
    document.getElementById('payModalCustomerName').textContent = o.nama_pelanggan;
    document.getElementById('payModalMaxRemaining').textContent = formatRupiah(o.sisa_tagihan);
    document.getElementById('payModalMaxRemaining').dataset.max = o.sisa_tagihan;
    document.getElementById('payTanggalInput').value = getTodayYMD();
    document.getElementById('payJumlahInput').value = o.sisa_tagihan;
    document.getElementById('payJenisInput').value = o.total_dibayar === 0 ? 'DP' : 'Pelunasan';

    delete APP_STATE.pendingUploads['payBuktiFileInput'];
    document.getElementById('payBuktiFileInput').value = '';
    document.getElementById('payBuktiInfo').textContent = '';

    openModal('paymentModal');
  }

  function fillFullRemainingPayment() {
    const maxVal = Number(document.getElementById('payModalMaxRemaining').dataset.max) || 0;
    document.getElementById('payJumlahInput').value = maxVal;
    document.getElementById('payJenisInput').value = 'Pelunasan';
  }

  function submitPaymentForm() {
    const idOrder = document.getElementById('payOrderIdInput').value;
    const maxRemaining = Number(document.getElementById('payModalMaxRemaining').dataset.max) || 0;
    const jumlah = Math.round(Number(document.getElementById('payJumlahInput').value) || 0);
    const tanggal = document.getElementById('payTanggalInput').value;
    const jenis = document.getElementById('payJenisInput').value;
    const metode = document.getElementById('payMetodeInput').value;

    if (jumlah <= 0) {
      showToast('Jumlah pembayaran harus lebih besar dari Rp 0.', 'error');
      return;
    }
    if (jumlah > maxRemaining) {
      showToast('Jumlah pembayaran tidak boleh melebihi sisa tagihan (' + formatRupiah(maxRemaining) + ').', 'error');
      return;
    }

    const uploadObj = APP_STATE.pendingUploads['payBuktiFileInput'] || {};
    const payload = {
      id_order: idOrder,
      tanggal: tanggal,
      jenis: jenis,
      jumlah: jumlah,
      metode: metode,
      bukti_base64: uploadObj.base64 || '',
      bukti_filename: uploadObj.fileName || '',
      bukti_mimetype: uploadObj.mimeType || ''
    };

    callServer('addPayment', [payload], function(res) {
      closeModal('paymentModal');
      applyServerPayload(res);
      showToast('Pembayaran sebesar ' + formatRupiah(jumlah) + ' berhasil dicatat!', 'success');
    });
  }

  /**
   * ==========================================================================
   * 5. KOMPRESI GAMBAR KLIEN & VALIDASI < 5 MB (Non-Fungsional #4)
   * ==========================================================================
   */

  function handleFileInputPreview(inputEl, infoElementId) {
    const infoEl = document.getElementById(infoElementId);
    const file = inputEl.files && inputEl.files[0];
    if (!file) {
      delete APP_STATE.pendingUploads[inputEl.id];
      if (infoEl) infoEl.textContent = '';
      return;
    }

    const maxBytes = 5 * 1024 * 1024; // 5 MB
    if (file.size > maxBytes) {
      inputEl.value = '';
      delete APP_STATE.pendingUploads[inputEl.id];
      if (infoEl) infoEl.textContent = 'File ditolak: Ukuran melebihi batas 5 MB.';
      showToast('Ukuran file melebihi batas maksimal 5 MB. Pilih file yang lebih kecil.', 'error');
      return;
    }

    if (file.type.indexOf('image/') === 0) {
      if (infoEl) infoEl.textContent = 'Mengompresi gambar agar hemat kuota GAS...';
      compressImageFile_(file, function(base64DataUrl) {
        APP_STATE.pendingUploads[inputEl.id] = {
          base64: base64DataUrl,
          fileName: file.name,
          mimeType: 'image/jpeg'
        };
        const kb = Math.round((base64DataUrl.length * 0.75) / 1024);
        if (infoEl) infoEl.textContent = 'Siap diunggah (' + file.name + ' • ~' + kb + ' KB setelah kompresi)';
      });
    } else if (file.type === 'application/pdf') {
      const reader = new FileReader();
      reader.onload = function(evt) {
        APP_STATE.pendingUploads[inputEl.id] = {
          base64: evt.target.result,
          fileName: file.name,
          mimeType: 'application/pdf'
        };
        const kb = Math.round(file.size / 1024);
        if (infoEl) infoEl.textContent = 'PDF siap diunggah (' + file.name + ' • ' + kb + ' KB)';
      };
      reader.readAsDataURL(file);
    } else {
      inputEl.value = '';
      showToast('Format file harus berupa JPG, PNG, atau PDF.', 'error');
    }
  }

  function compressImageFile_(file, callback) {
    const reader = new FileReader();
    reader.onload = function(event) {
      const img = new Image();
      img.onload = function() {
        const maxWidth = 1280;
        let w = img.width;
        let h = img.height;
        if (w > maxWidth) {
          h = Math.round((h * maxWidth) / w);
          w = maxWidth;
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.78);
        callback(compressedDataUrl);
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  }

  /**
   * ==========================================================================
   * 6. VIEW 3: DATA PELANGGAN (F2)
   * ==========================================================================
   */

  function renderCustomersTable() {
    const d = APP_STATE.data;
    if (!d) return;

    const q = (document.getElementById('searchPelangganInput').value || '').toLowerCase().trim();
    const customers = d.customers || [];
    const orders = d.orders || [];

    const filtered = customers.filter(function(c) {
      if (!q) return true;
      return (String(c.nama) + ' ' + String(c.kontak) + ' ' + String(c.id_pelanggan) + ' ' + String(c.alamat)).toLowerCase().indexOf(q) !== -1;
    });

    const tbody = document.getElementById('customersTableBody');
    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Data pelanggan tidak ditemukan.</td></tr>';
      return;
    }

    tbody.innerHTML = pageRows_('customers', filtered, tbody, 5, true).map(function(c) {
      const custOrders = orders.filter(function(o) { return o.id_pelanggan === c.id_pelanggan && o.status_order !== 'Batal'; });
      const totalSpend = custOrders.reduce(function(acc, o) { return acc + (Number(o.total_harga) || 0); }, 0);

      return '<tr>' +
        '<td>' +
          '<div class="cell-truncate" style="font-weight:600;">' + escapeHtml(c.nama) + '</div>' +
          '<div class="mobile-sub tnum">' + escapeHtml(c.kontak) + ' • ' + custOrders.length + ' order</div>' +
        '</td>' +
        '<td class="tnum col-desktop-only" style="font-weight:500;">' + escapeHtml(c.kontak) + '</td>' +
        '<td class="num-col tnum col-desktop-only">' + custOrders.length + ' order</td>' +
        '<td class="num-col numeric-md">' + formatRupiah(totalSpend) + '</td>' +
        '<td class="num-col">' +
          '<button type="button" class="btn btn-secondary btn-xs" data-id="' + escapeHtml(c.id_pelanggan) + '" onclick="openCustomerDetailModal(this.dataset.id)">Detail</button>' +
        '</td>' +
      '</tr>';
    }).join('');
  }

  function openCustomerModal(editId) {
    const d = APP_STATE.data;
    document.getElementById('duplicatePhoneWarning').style.display = 'none';
    document.getElementById('custConfirmDuplicateCheck').checked = false;

    if (editId && d) {
      const c = (d.customers || []).find(function(x) { return x.id_pelanggan === editId; });
      if (!c) return;
      document.getElementById('customerModalTitle').textContent = 'Ubah Pelanggan ' + c.id_pelanggan;
      document.getElementById('custIdInput').value = c.id_pelanggan;
      document.getElementById('custNamaInput').value = c.nama || '';
      document.getElementById('custKontakInput').value = c.kontak || '';
      document.getElementById('custAlamatInput').value = c.alamat || '';
      document.getElementById('custCatatanInput').value = c.catatan || '';
    } else {
      document.getElementById('customerModalTitle').textContent = 'Tambah Pelanggan Baru';
      document.getElementById('custIdInput').value = '';
      document.getElementById('custNamaInput').value = '';
      document.getElementById('custKontakInput').value = '';
      document.getElementById('custAlamatInput').value = '';
      document.getElementById('custCatatanInput').value = '';
    }
    openModal('customerModal');
  }

  function checkCustomerPhoneDuplicate() {
    const d = APP_STATE.data;
    if (!d) return;
    const idPelanggan = document.getElementById('custIdInput').value;
    const rawPhone = document.getElementById('custKontakInput').value.replace(/[^0-9]/g, '');
    const warnBox = document.getElementById('duplicatePhoneWarning');
    if (rawPhone.length < 6) {
      warnBox.style.display = 'none';
      return;
    }
    const dup = (d.customers || []).find(function(c) {
      const p = String(c.kontak || '').replace(/[^0-9]/g, '');
      return p === rawPhone && c.id_pelanggan !== idPelanggan;
    });
    if (dup) {
      warnBox.style.display = 'block';
      document.getElementById('duplicatePhoneText').textContent =
        'Peringatan Duplikat: Nomor kontak ini sudah terdaftar atas nama "' + dup.nama + '" (' + dup.id_pelanggan + ').';
    } else {
      warnBox.style.display = 'none';
    }
  }

  function submitCustomerForm() {
    const idPelanggan = document.getElementById('custIdInput').value;
    const nama = document.getElementById('custNamaInput').value.trim();
    const kontak = document.getElementById('custKontakInput').value.trim();
    const alamat = document.getElementById('custAlamatInput').value.trim();
    const catatan = document.getElementById('custCatatanInput').value.trim();
    const ignoreDup = document.getElementById('custConfirmDuplicateCheck').checked;

    if (!nama || !kontak) {
      showToast('Nama pelanggan dan nomor kontak wajib diisi.', 'error');
      return;
    }

    callServer('saveCustomer', [{
      id_pelanggan: idPelanggan,
      nama: nama,
      kontak: kontak,
      alamat: alamat,
      catatan: catatan,
      ignoreDuplicateWarning: ignoreDup
    }], function(res) {
      closeModal('customerModal');
      applyServerPayload(res);
      showToast('Data pelanggan berhasil disimpan.', 'success');
    }, function(errMsg) {
      if (errMsg.indexOf('DUPLIKAT_KONTAK') !== -1) {
        document.getElementById('duplicatePhoneWarning').style.display = 'block';
        document.getElementById('duplicatePhoneText').textContent = errMsg;
      }
      showToast(errMsg, 'warning');
    });
  }

  function openCustomerDetailModal(idPelanggan) {
    const d = APP_STATE.data;
    if (!d) return;
    const c = (d.customers || []).find(function(x) { return x.id_pelanggan === idPelanggan; });
    if (!c) return;

    const custOrders = (d.orders || []).filter(function(o) { return o.id_pelanggan === idPelanggan; });
    const totalSpend = custOrders.reduce(function(acc, o) { return acc + (Number(o.total_harga) || 0); }, 0);
    const totalSisa = custOrders.reduce(function(acc, o) { return acc + (Number(o.sisa_tagihan) || 0); }, 0);

    document.getElementById('custDetailTitle').textContent = 'Riwayat Pelanggan — ' + c.nama;

    const rowsHtml = custOrders.length === 0
      ? '<tr><td colspan="5" class="empty-state">Pelanggan ini belum memiliki riwayat order.</td></tr>'
      : custOrders.map(function(o) {
          return '<tr>' +
            '<td class="code-cell">' + escapeHtml(o.no_invoice) + '</td>' +
            '<td class="tnum">' + escapeHtml(o.tanggal_order) + '</td>' +
            '<td>' + getOrderStatusBadge(o.status_order) + '</td>' +
            '<td class="num-col numeric-md">' + formatRupiah(o.total_harga) + '</td>' +
            '<td class="num-col"><button type="button" class="btn btn-secondary btn-xs" data-id="' + escapeHtml(o.id_order) + '" onclick="closeModal(\'customerDetailModal\'); openOrderDetailModal(this.dataset.id);">Detail</button></td>' +
          '</tr>';
        }).join('');

    document.getElementById('custDetailBody').innerHTML = '' +
      '<div class="grid-12" style="gap:16px; margin-bottom:20px;">' +
        '<div class="col-span-6" style="background:var(--bg-subtle); padding:16px; border-radius:12px; border:1px solid var(--border-color);">' +
          '<div class="label-sm">Profil Pelanggan</div>' +
          '<div style="font-size:16px; font-weight:700; margin-top:4px;">' + escapeHtml(c.nama) + ' <span class="badge badge-neutral tnum">' + escapeHtml(c.id_pelanggan) + '</span></div>' +
          '<div class="body-sm tnum" style="margin-top:6px;">Kontak WA: <strong>' + escapeHtml(c.kontak) + '</strong></div>' +
          '<div class="body-sm" style="margin-top:4px;">Alamat: ' + escapeHtml(c.alamat || '-') + '</div>' +
          '<div class="body-sm" style="margin-top:4px; color:var(--text-muted);">Catatan: ' + escapeHtml(c.catatan || '-') + '</div>' +
        '</div>' +
        '<div class="col-span-6" style="background:var(--primary-soft); padding:16px; border-radius:12px; border:1px solid var(--primary-border);">' +
          '<div class="label-sm" style="color:var(--primary);">Ringkasan Transaksi</div>' +
          '<div class="flex-between" style="margin-top:8px;"><span>Frekuensi Order:</span><strong class="tnum">' + custOrders.length + ' Kali Order</strong></div>' +
          '<div class="flex-between" style="margin-top:6px;"><span>Total Nilai Belanja:</span><strong class="numeric-md tnum" style="color:var(--primary);">' + formatRupiah(totalSpend) + '</strong></div>' +
          '<div class="flex-between" style="margin-top:6px;"><span>Sisa Tagihan Aktif:</span><strong class="tnum" style="color:var(--danger-text);">' + formatRupiah(totalSisa) + '</strong></div>' +
        '</div>' +
      '</div>' +
      '<div class="label-md" style="margin-bottom:8px;">Daftar Riwayat Order</div>' +
      '<div class="table-responsive" style="border:1px solid var(--border-color); border-radius:12px;">' +
        '<table class="data-table"><thead><tr><th>No. Invoice</th><th>Tanggal</th><th>Status</th><th class="num-col">Total Harga</th><th class="num-col">Aksi</th></tr></thead><tbody>' + rowsHtml + '</tbody></table>' +
      '</div>';

    const delBtnHtml = isOwnerRole()
      ? '<button type="button" class="btn btn-danger-soft" data-id="' + escapeHtml(c.id_pelanggan) + '" onclick="closeModal(\'customerDetailModal\'); confirmDeleteCustomer(this.dataset.id);">Hapus Pelanggan</button>'
      : '';
    const footerEl = document.getElementById('custDetailFooter');
    if (footerEl) {
      footerEl.innerHTML = '' +
        '<button type="button" class="btn btn-secondary" onclick="closeModal(\'customerDetailModal\')">Tutup</button>' +
        delBtnHtml +
        '<button type="button" class="btn btn-secondary" data-id="' + escapeHtml(c.id_pelanggan) + '" onclick="closeModal(\'customerDetailModal\'); openCustomerModal(this.dataset.id);">Ubah Pelanggan</button>' +
        '<button type="button" class="btn btn-primary" data-id="' + escapeHtml(c.id_pelanggan) + '" onclick="closeModal(\'customerDetailModal\'); openOrderModal(); filterOrderCustomerDropdown(\'\', this.dataset.id);">+ Buat Order</button>';
    }

    openModal('customerDetailModal');
  }

  function confirmDeleteCustomer(idPelanggan) {
    openConfirmModal(
      'Hapus Data Pelanggan',
      'Hapus pelanggan ' + idPelanggan + '? Pelanggan yang masih memiliki riwayat order akan otomatis diblokir oleh sistem demi integritas data.',
      function() {
        callServer('deleteCustomer', [idPelanggan], function(res) {
          applyServerPayload(res);
          showToast('Pelanggan berhasil dihapus.', 'success');
        });
      }
    );
  }

  /**
   * ==========================================================================
   * 7. VIEW 4: KALKULATOR HARGA & HPP (F5 — KHUSUS OWNER)
   * ==========================================================================
   */

  function renderHppView() {
    const d = APP_STATE.data;
    if (!d || !isOwnerRole()) return;

    const container = document.getElementById('hppMaterialRowsContainer');
    if (container && container.children.length === 0) {
      resetHppCalculator();
    } else {
      recalculateHppPreview();
    }

    const tbody = document.getElementById('hppHistoryTableBody');
    const list = d.hppCalculations || [];
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Belum ada riwayat kalkulasi HPP tersimpan.</td></tr>';
      return;
    }

    tbody.innerHTML = list.map(function(h) {
      const hppVal = Number(h.hpp_per_pcs) || 0;
      const jualVal = Number(h.harga_jual_per_pcs) || 0;
      const labaVal = jualVal - hppVal;
      return '<tr>' +
        '<td>' +
          '<div class="cell-truncate" style="font-weight:600;">' + escapeHtml(h.nama_produk) + '</div>' +
          '<div class="mobile-sub tnum">HPP: ' + formatRupiah(hppVal) + ' • Laba: +' + formatRupiah(labaVal) + '</div>' +
        '</td>' +
        '<td class="num-col tnum col-desktop-only">' + formatRupiah(hppVal) + '</td>' +
        '<td class="num-col numeric-md" style="color:var(--primary);">' + formatRupiah(jualVal) + '</td>' +
        '<td class="num-col tnum col-desktop-only" style="color:var(--success-text); font-weight:600;">+' + formatRupiah(labaVal) + '</td>' +
        '<td class="num-col">' +
          '<button type="button" class="btn btn-secondary btn-xs" data-id="' + escapeHtml(h.id) + '" onclick="openHppDetailModal(this.dataset.id)">Detail</button>' +
        '</td>' +
      '</tr>';
    }).join('');
  }

  function resetHppCalculator() {
    document.getElementById('hppIdInput').value = '';
    const badge = document.getElementById('hppEditingBadge');
    if (badge) badge.style.display = 'none';
    document.getElementById('hppNamaProduk').value = '';
    document.getElementById('hppOngkosJahit').value = 10000;
    document.getElementById('hppOngkosSablon').value = 8000;
    document.getElementById('hppBiayaLain').value = 2500;
    document.getElementById('hppMarginPersen').value = 35;

    const container = document.getElementById('hppMaterialRowsContainer');
    container.innerHTML = '';
    const mats = (APP_STATE.data && APP_STATE.data.materials) || [];
    const firstId = mats[0] ? mats[0].id_bahan : '';
    addHppMaterialRow(firstId, 0.22);
    recalculateHppPreview();
  }

  function addHppMaterialRow(selectedBahanId, defaultQty) {
    const mats = (APP_STATE.data && APP_STATE.data.materials) || [];
    const container = document.getElementById('hppMaterialRowsContainer');
    const row = document.createElement('div');
    row.className = 'hpp-mat-row';
    row.style.cssText = 'display:grid; grid-template-columns: 2.2fr 1fr 1.2fr auto; gap:8px; align-items:center; background:var(--bg-subtle); padding:8px; border-radius:10px; border:1px solid var(--border-color);';

    const optionsHtml = '<option value="">-- Pilih Bahan dari Stok --</option>' +
      mats.map(function(m) {
        const sel = (m.id_bahan === selectedBahanId) ? 'selected' : '';
        return '<option value="' + m.id_bahan + '" data-price="' + m.harga_per_satuan + '" data-unit="' + escapeHtml(m.satuan) + '" ' + sel + '>' +
          escapeHtml(m.nama_bahan) + ' (' + formatRupiah(m.harga_per_satuan) + '/' + escapeHtml(m.satuan) + ')' +
        '</option>';
      }).join('');

    row.innerHTML = '' +
      '<select class="form-select hpp-mat-select" onchange="recalculateHppPreview()">' + optionsHtml + '</select>' +
      '<input type="number" class="form-control tnum hpp-mat-qty" min="0.01" step="0.01" value="' + (defaultQty !== undefined ? defaultQty : 0.25) + '" placeholder="Kebutuhan/pcs" oninput="recalculateHppPreview()">' +
      '<div class="num-col numeric-md tnum hpp-mat-subtotal" style="text-align:right; padding:0 6px;">Rp 0</div>' +
      '<button type="button" class="btn btn-danger-soft btn-xs" onclick="this.closest(\'.hpp-mat-row\').remove(); recalculateHppPreview();" aria-label="Hapus bahan">✕</button>';

    container.appendChild(row);
    recalculateHppPreview();
  }

  function recalculateHppPreview() {
    const mats = (APP_STATE.data && APP_STATE.data.materials) || [];
    const matMap = {};
    mats.forEach(function(m) { matMap[m.id_bahan] = m; });

    let totalBahan = 0;
    document.querySelectorAll('#hppMaterialRowsContainer .hpp-mat-row').forEach(function(row) {
      const idBahan = row.querySelector('.hpp-mat-select').value;
      const qty = Number(row.querySelector('.hpp-mat-qty').value) || 0;
      const mat = matMap[idBahan];
      const price = mat ? (Number(mat.harga_per_satuan) || 0) : 0;
      const sub = Math.round(qty * price);
      totalBahan += sub;
      row.querySelector('.hpp-mat-subtotal').textContent = formatRupiah(sub);
    });

    const jahit = Number(document.getElementById('hppOngkosJahit').value) || 0;
    const sablon = Number(document.getElementById('hppOngkosSablon').value) || 0;
    const lain = Number(document.getElementById('hppBiayaLain').value) || 0;
    const margin = Number(document.getElementById('hppMarginPersen').value) || 0;

    const totalHpp = Math.round(totalBahan + jahit + sablon + lain);
    const sellingPrice = Math.round(totalHpp * (1 + margin / 100));
    const profit = sellingPrice - totalHpp;
    const realMarginPct = sellingPrice > 0 ? ((profit / sellingPrice) * 100).toFixed(1) : '0.0';

    document.getElementById('hppPreviewBahanCost').textContent = formatRupiah(totalBahan);
    document.getElementById('hppPreviewTotalHpp').textContent = formatRupiah(totalHpp);
    document.getElementById('hppPreviewSellingPrice').textContent = formatRupiah(sellingPrice);
    document.getElementById('hppPreviewProfitPerPcs').textContent = formatRupiah(profit);
    const realMarginEl = document.getElementById('hppPreviewRealMargin');
    if (realMarginEl) realMarginEl.textContent = realMarginPct + '% dari harga jual';
  }

  function submitHppCalculation() {
    const namaProduk = document.getElementById('hppNamaProduk').value.trim();
    if (!namaProduk) {
      showToast('Masukkan nama produk terlebih dahulu.', 'error');
      return;
    }

    const mats = (APP_STATE.data && APP_STATE.data.materials) || [];
    const matMap = {};
    mats.forEach(function(m) { matMap[m.id_bahan] = m; });

    const rincian = [];
    document.querySelectorAll('#hppMaterialRowsContainer .hpp-mat-row').forEach(function(row) {
      const idBahan = row.querySelector('.hpp-mat-select').value;
      const qty = Number(row.querySelector('.hpp-mat-qty').value) || 0;
      if (idBahan && matMap[idBahan] && qty > 0) {
        const m = matMap[idBahan];
        rincian.push({
          id_bahan: idBahan,
          nama_bahan: m.nama_bahan,
          satuan: m.satuan,
          qty_per_pcs: qty,
          harga_satuan: Number(m.harga_per_satuan) || 0,
          subtotal: Math.round(qty * (Number(m.harga_per_satuan) || 0))
        });
      }
    });

    const payload = {
      id: document.getElementById('hppIdInput').value || '',
      nama_produk: namaProduk,
      rincian_bahan: rincian,
      ongkos_jahit: Number(document.getElementById('hppOngkosJahit').value) || 0,
      ongkos_sablon_bordir: Number(document.getElementById('hppOngkosSablon').value) || 0,
      biaya_lain: Number(document.getElementById('hppBiayaLain').value) || 0,
      margin_persen: Number(document.getElementById('hppMarginPersen').value) || 0
    };

    callServer('saveHppCalculation', [payload], function(res) {
      applyServerPayload(res);
      showToast('Kalkulasi HPP "' + namaProduk + '" berhasil disimpan ke katalog!', 'success');
    });
  }

  function loadHppIntoCalculator(idHpp) {
    const d = APP_STATE.data;
    if (!d) return;
    const target = (d.hppCalculations || []).find(function(h) { return h.id === idHpp; });
    if (!target) return;

    document.getElementById('hppIdInput').value = target.id || '';
    const badge = document.getElementById('hppEditingBadge');
    if (badge) {
      badge.style.display = 'inline-flex';
      badge.textContent = 'Mengubah ' + target.id;
    }
    document.getElementById('hppNamaProduk').value = target.nama_produk || '';
    document.getElementById('hppOngkosJahit').value = target.ongkos_jahit || 0;
    document.getElementById('hppOngkosSablon').value = target.ongkos_sablon_bordir || 0;
    document.getElementById('hppBiayaLain').value = target.biaya_lain || 0;
    document.getElementById('hppMarginPersen').value = target.margin_persen || 30;

    const container = document.getElementById('hppMaterialRowsContainer');
    container.innerHTML = '';
    let parsedMats = [];
    try {
      parsedMats = typeof target.rincian_bahan === 'string' ? JSON.parse(target.rincian_bahan) : (target.rincian_bahan || []);
    } catch (e) {}

    if (parsedMats.length === 0) {
      addHppMaterialRow('', 0.25);
    } else {
      parsedMats.forEach(function(m) {
        addHppMaterialRow(m.id_bahan, m.qty_per_pcs);
      });
    }
    recalculateHppPreview();
    showToast('Rincian HPP "' + target.nama_produk + '" dimuat ke kalkulator.', 'info');
  }

  function confirmDeleteHpp(idHpp) {
    openConfirmModal('Hapus Riwayat HPP', 'Hapus kalkulasi ' + idHpp + ' dari riwayat?', function() {
      callServer('deleteHppCalculation', [idHpp], function(res) {
        applyServerPayload(res);
        showToast('Riwayat HPP dihapus.', 'success');
      });
    });
  }

  /**
   * ==========================================================================
   * 8. VIEW 5: STOK BAHAN & MUTASI (F6 — KHUSUS OWNER)
   * ==========================================================================
   */

  function renderMaterialsView() {
    const d = APP_STATE.data;
    if (!d || !isOwnerRole()) return;

    const q = (document.getElementById('searchStokInput').value || '').toLowerCase().trim();
    const fStatus = document.getElementById('filterStokStatus').value;
    const materials = d.materials || [];
    const matMap = {};
    materials.forEach(function(m) { matMap[m.id_bahan] = m; });

    const filtered = materials.filter(function(m) {
      const isLow = Number(m.stok_saat_ini) <= Number(m.stok_minimum);
      if (fStatus === 'LOW' && !isLow) return false;
      if (fStatus === 'SAFE' && isLow) return false;
      if (q && (m.id_bahan + ' ' + m.nama_bahan + ' ' + m.satuan).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });

    const tbody = document.getElementById('materialsTableBody');
    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Tidak ada bahan baku yang sesuai filter.</td></tr>';
    } else {
      tbody.innerHTML = filtered.map(function(m) {
        const isLow = Number(m.stok_saat_ini) <= Number(m.stok_minimum);
        const statusBadge = isLow
          ? '<span class="badge badge-warning">Stok Menipis</span>'
          : '<span class="badge badge-success">Stok Aman</span>';
        return '<tr>' +
          '<td>' +
            '<div class="cell-truncate" style="font-weight:600;">' + escapeHtml(m.nama_bahan) + '</div>' +
            '<div class="mobile-sub tnum">' + formatRupiah(m.harga_per_satuan) + '/' + escapeHtml(m.satuan) + '</div>' +
          '</td>' +
          '<td class="num-col numeric-md" style="color:' + (isLow ? 'var(--danger-text)' : 'var(--text-primary)') + ';">' + Number(m.stok_saat_ini).toLocaleString('id-ID') + ' ' + escapeHtml(m.satuan) + '</td>' +
          '<td class="num-col numeric-md col-desktop-only">' + formatRupiah(m.harga_per_satuan) + '</td>' +
          '<td class="col-desktop-only">' + statusBadge + '</td>' +
          '<td class="num-col">' +
            '<button type="button" class="btn btn-secondary btn-xs" data-id="' + escapeHtml(m.id_bahan) + '" onclick="openMaterialDetailModal(this.dataset.id)">Detail</button>' +
          '</td>' +
        '</tr>';
      }).join('');
    }

    // Render tabel mutasi stok (5 kolom + Detail)
    const mutBody = document.getElementById('mutationsTableBody');
    const mutations = (d.mutations || []).slice().reverse();
    if (mutations.length === 0) {
      mutBody.innerHTML = '<tr><td colspan="5" class="empty-state">Belum ada riwayat mutasi stok.</td></tr>';
    } else {
      mutBody.innerHTML = pageRows_('mutations', mutations, mutBody, 5).map(function(mut) {
        const mat = matMap[mut.id_bahan] || {};
        const j = mut.jenis;
        const numQty = Number(mut.jumlah) || 0;
        let badge = '<span class="badge badge-info">Koreksi Opname</span>';
        let qtyPrefix = numQty >= 0 ? '+' : '';
        if (j === 'Masuk') {
          badge = '<span class="badge badge-success">Stok Masuk (+)</span>';
          qtyPrefix = '+';
        } else if (j === 'Keluar') {
          badge = '<span class="badge badge-danger">Stok Keluar (-)</span>';
          qtyPrefix = '-';
        }
        return '<tr>' +
          '<td class="tnum col-desktop-only">' + escapeHtml(mut.tanggal) + '</td>' +
          '<td>' +
            '<div class="cell-truncate" style="font-weight:600;">' + escapeHtml(mat.nama_bahan || mut.id_bahan) + '</div>' +
            '<div class="mobile-sub tnum">' + escapeHtml(mut.tanggal) + ' • ' + escapeHtml(mut.jenis) + '</div>' +
          '</td>' +
          '<td class="col-desktop-only">' + badge + '</td>' +
          '<td class="num-col numeric-md">' + qtyPrefix + numQty.toLocaleString('id-ID') + ' ' + escapeHtml(mat.satuan || '') + '</td>' +
          '<td class="num-col">' +
            '<button type="button" class="btn btn-secondary btn-xs" data-id="' + escapeHtml(mut.id) + '" onclick="openMutationDetailModal(this.dataset.id)">Detail</button>' +
          '</td>' +
        '</tr>';
      }).join('');
    }
  }

  function openMaterialModal(editBahanId) {
    const d = APP_STATE.data;
    const stokInput = document.getElementById('matStokSaatIniInput');
    const stokLabel = document.getElementById('matStokInitialLabel');
    const stokNote = document.getElementById('matStokLockNote');
    if (editBahanId && d) {
      const m = (d.materials || []).find(function(x) { return x.id_bahan === editBahanId; });
      if (!m) return;
      document.getElementById('materialModalTitle').textContent = 'Ubah Bahan ' + m.id_bahan;
      document.getElementById('matIdInput').value = m.id_bahan;
      document.getElementById('matNamaInput').value = m.nama_bahan;
      document.getElementById('matSatuanInput').value = m.satuan;
      document.getElementById('matStokMinInput').value = m.stok_minimum;
      stokInput.value = m.stok_saat_ini;
      stokInput.disabled = true;
      if (stokLabel) stokLabel.textContent = 'Stok Saat Ini (Terkunci)';
      if (stokNote) stokNote.style.display = 'block';
      document.getElementById('matHargaInput').value = m.harga_per_satuan;
    } else {
      document.getElementById('materialModalTitle').textContent = 'Tambah Bahan Baku Baru';
      document.getElementById('matIdInput').value = '';
      document.getElementById('matNamaInput').value = '';
      document.getElementById('matSatuanInput').value = 'Kg';
      document.getElementById('matStokMinInput').value = 15;
      stokInput.value = 0;
      stokInput.disabled = false;
      if (stokLabel) stokLabel.textContent = 'Stok Awal';
      if (stokNote) stokNote.style.display = 'none';
      document.getElementById('matHargaInput').value = 100000;
    }
    openModal('materialModal');
  }

  function submitMaterialForm() {
    const idBahan = document.getElementById('matIdInput').value;
    const nama = document.getElementById('matNamaInput').value.trim();
    const satuan = document.getElementById('matSatuanInput').value;
    const stokMin = Number(document.getElementById('matStokMinInput').value) || 0;
    const stokSaatIni = Number(document.getElementById('matStokSaatIniInput').value) || 0;
    const harga = Number(document.getElementById('matHargaInput').value) || 0;

    if (!nama) {
      showToast('Nama bahan baku wajib diisi.', 'error');
      return;
    }

    callServer('saveMaterial', [{
      id_bahan: idBahan,
      nama_bahan: nama,
      satuan: satuan,
      stok_minimum: stokMin,
      stok_saat_ini: stokSaatIni,
      harga_per_satuan: harga
    }], function(res) {
      closeModal('materialModal');
      applyServerPayload(res);
      showToast('Data bahan baku berhasil disimpan.', 'success');
    });
  }

  function openMutationModal(preselectedBahanId) {
    const mats = (APP_STATE.data && APP_STATE.data.materials) || [];
    const sel = document.getElementById('mutBahanSelect');
    sel.innerHTML = mats.map(function(m) {
      return '<option value="' + m.id_bahan + '">' + escapeHtml(m.nama_bahan) + ' (Stok: ' + m.stok_saat_ini + ' ' + escapeHtml(m.satuan) + ')</option>';
    }).join('');

    if (preselectedBahanId) sel.value = preselectedBahanId;
    document.getElementById('mutTanggalInput').value = getTodayYMD();
    document.getElementById('mutJenisSelect').value = 'Masuk';
    document.getElementById('mutJumlahInput').value = 10;
    document.getElementById('mutKeteranganInput').value = '';
    handleMutationMaterialChange(sel.value);
    toggleMutationPriceField();
    openModal('mutationModal');
  }

  function handleMutationMaterialChange(idBahan) {
    const mats = (APP_STATE.data && APP_STATE.data.materials) || [];
    const m = mats.find(function(x) { return x.id_bahan === idBahan; });
    if (m) {
      document.getElementById('mutSatuanLabel').textContent = m.satuan;
      document.getElementById('mutHargaBeliInput').value = m.harga_per_satuan || 0;
    }
  }

  function toggleMutationPriceField() {
    const jenis = document.getElementById('mutJenisSelect').value;
    document.getElementById('mutHargaBeliGroup').style.opacity = jenis === 'Masuk' ? '1' : '0.5';
    const titleLabel = document.getElementById('mutJumlahTitleLabel');
    if (titleLabel) {
      titleLabel.textContent = jenis === 'Koreksi' ? 'Stok Fisik Aktual' : 'Jumlah';
    }
  }

  function submitMutationForm() {
    const idBahan = document.getElementById('mutBahanSelect').value;
    const jenis = document.getElementById('mutJenisSelect').value;
    const tanggal = document.getElementById('mutTanggalInput').value;
    const jumlah = Number(document.getElementById('mutJumlahInput').value);
    const hargaBeli = Number(document.getElementById('mutHargaBeliInput').value) || 0;
    const keterangan = document.getElementById('mutKeteranganInput').value.trim();

    if (!idBahan || isNaN(jumlah) || (jenis !== 'Koreksi' && jumlah <= 0) || (jenis === 'Koreksi' && jumlah < 0)) {
      showToast(jenis === 'Koreksi' ? 'Masukkan jumlah stok fisik aktual (>= 0).' : 'Pilih bahan dan masukkan jumlah mutasi > 0.', 'error');
      return;
    }

    callServer('recordStockMutation', [{
      id_bahan: idBahan,
      jenis: jenis,
      tanggal: tanggal,
      jumlah: jumlah,
      harga_beli: hargaBeli,
      keterangan: keterangan
    }], function(res) {
      closeModal('mutationModal');
      applyServerPayload(res);
      showToast('Mutasi stok ' + jenis + ' berhasil dicatat!', 'success');
    });
  }

  function confirmDeleteMaterial(idBahan) {
    openConfirmModal('Hapus Bahan Baku', 'Hapus bahan ' + idBahan + ' dari daftar stok?', function() {
      callServer('deleteMaterial', [idBahan], function(res) {
        applyServerPayload(res);
        showToast('Bahan baku berhasil dihapus.', 'success');
      });
    });
  }

  /**
   * ==========================================================================
   * 9. VIEW 6: KEUANGAN DASAR & PIUTANG (F7 — KHUSUS OWNER)
   * ==========================================================================
   */

  function switchFinanceTab(tabName) {
    ['piutang', 'pemasukan', 'pengeluaran'].forEach(function(t) {
      const cap = t.charAt(0).toUpperCase() + t.slice(1);
      document.getElementById('tabBtn' + cap).classList.toggle('active', t === tabName);
      document.getElementById('financeSub' + cap).style.display = (t === tabName) ? 'block' : 'none';
    });
  }

  function renderFinanceView() {
    const d = APP_STATE.data;
    if (!d || !isOwnerRole()) return;

    const selMonth = document.getElementById('financeMonthSelect').value;
    const selYear = document.getElementById('financeYearSelect').value;
    const periodPrefix = selMonth === 'ALL' ? selYear : (selYear + '-' + selMonth);

    const orders = d.orders || [];
    const payments = d.payments || [];
    const expenses = d.expenses || [];

    const orderMap = {};
    orders.forEach(function(o) { orderMap[o.id_order] = o; });

    const filteredPays = payments.filter(function(p) {
      return String(p.tanggal || '').indexOf(periodPrefix) === 0;
    });
    const filteredExps = expenses.filter(function(e) {
      return String(e.tanggal || '').indexOf(periodPrefix) === 0;
    });

    const totalIn = filteredPays.reduce(function(acc, p) { return acc + (Number(p.jumlah) || 0); }, 0);
    const totalOut = filteredExps.reduce(function(acc, e) { return acc + (Number(e.jumlah) || 0); }, 0);
    const netCash = totalIn - totalOut;
    const endOfPeriod = selMonth === 'ALL' ? (selYear + '-12-31') : (selYear + '-' + selMonth + '-31');
    const unpaidOrders = orders.filter(function(o) {
      return Number(o.sisa_tagihan) > 0 && String(o.tanggal_order || '') <= endOfPeriod;
    });
    const totalReceivables = unpaidOrders.reduce(function(acc, o) { return acc + (Number(o.sisa_tagihan) || 0); }, 0);

    document.getElementById('financeKpiGrid').innerHTML = '' +
      '<div class="kpi-card">' +
        '<div class="kpi-top"><span class="label-sm">Pemasukan Kas (DP & Pelunasan)</span><span class="badge badge-success">Masuk</span></div>' +
        '<div class="kpi-value tnum" style="color:var(--success-text);">' + formatRupiah(totalIn) + '</div>' +
        '<div class="kpi-foot">' + filteredPays.length + ' transaksi pembayaran masuk</div>' +
      '</div>' +
      '<div class="kpi-card">' +
        '<div class="kpi-top"><span class="label-sm">Pengeluaran Operasional</span><span class="badge badge-danger">Keluar</span></div>' +
        '<div class="kpi-value tnum" style="color:var(--danger-text);">' + formatRupiah(totalOut) + '</div>' +
        '<div class="kpi-foot">' + filteredExps.length + ' catatan pengeluaran kas</div>' +
      '</div>' +
      '<div class="kpi-card">' +
        '<div class="kpi-top"><span class="label-sm">Selisih Arus Kas Bersih</span><span class="badge badge-info">Netto</span></div>' +
        '<div class="kpi-value tnum" style="color:' + (netCash >= 0 ? 'var(--primary)' : 'var(--danger-text)') + ';">' + formatRupiah(netCash) + '</div>' +
        '<div class="kpi-foot">Pemasukan dikurangi Pengeluaran periode ini</div>' +
      '</div>' +
      '<div class="kpi-card">' +
        '<div class="kpi-top"><span class="label-sm">Total Piutang Akhir</span><span class="badge badge-warning">Piutang</span></div>' +
        '<div class="kpi-value tnum" style="color:var(--warning-text);">' + formatRupiah(totalReceivables) + '</div>' +
        '<div class="kpi-foot">Dari ' + unpaidOrders.length + ' order yang belum lunas</div>' +
      '</div>';

    // 1. Tabel Piutang (5 kolom + Detail)
    const todayMs = new Date(getTodayYMD() + 'T00:00:00').getTime();
    const recBody = document.getElementById('receivablesTableBody');
    if (unpaidOrders.length === 0) {
      recBody.innerHTML = '<tr><td colspan="5" class="empty-state">Tidak ada piutang tertunggak. Seluruh order telah lunas!</td></tr>';
    } else {
      recBody.innerHTML = unpaidOrders.map(function(o) {
        const orderDateMs = new Date((o.tanggal_order || getTodayYMD()) + 'T00:00:00').getTime();
        const ageDays = Math.max(0, Math.floor((todayMs - orderDateMs) / (1000 * 3600 * 24)));
        const ageBadge = ageDays > 14 ? 'badge-danger' : (ageDays > 7 ? 'badge-warning' : 'badge-info');
        return '<tr>' +
          '<td>' +
            '<div class="code-cell">' + escapeHtml(o.no_invoice) + '</div>' +
            '<div class="mobile-sub">' + escapeHtml(o.nama_pelanggan) + ' • ' + ageDays + ' hr</div>' +
          '</td>' +
          '<td class="col-desktop-only"><div class="cell-truncate" style="font-weight:600;">' + escapeHtml(o.nama_pelanggan) + '</div></td>' +
          '<td class="num-col col-desktop-only"><span class="badge ' + ageBadge + ' tnum">' + ageDays + ' hari</span></td>' +
          '<td class="num-col numeric-md" style="color:var(--danger-text);">' + formatRupiah(o.sisa_tagihan) + '</td>' +
          '<td class="num-col"><button type="button" class="btn btn-secondary btn-xs" data-id="' + escapeHtml(o.id_order) + '" onclick="openOrderDetailModal(this.dataset.id)">Detail</button></td>' +
        '</tr>';
      }).join('');
    }

    // 2. Tabel Pemasukan (5 kolom + Detail)
    const incBody = document.getElementById('incomeTableBody');
    if (filteredPays.length === 0) {
      incBody.innerHTML = '<tr><td colspan="5" class="empty-state">Belum ada pemasukan pada periode ini.</td></tr>';
    } else {
      incBody.innerHTML = pageRows_('income', filteredPays.slice().reverse(), incBody, 5).map(function(p) {
        const ord = orderMap[p.id_order] || {};
        return '<tr>' +
          '<td class="tnum col-desktop-only">' + escapeHtml(p.tanggal) + '</td>' +
          '<td>' +
            '<div class="cell-truncate"><strong>' + escapeHtml(ord.no_invoice || p.id_order) + '</strong> — ' + escapeHtml(ord.nama_pelanggan || '') + '</div>' +
            '<div class="mobile-sub tnum">' + escapeHtml(p.tanggal) + ' • ' + escapeHtml(p.jenis) + '</div>' +
          '</td>' +
          '<td class="col-desktop-only"><span class="badge badge-neutral">' + escapeHtml(p.jenis) + '</span> <span class="body-sm" style="color:var(--text-muted);">' + escapeHtml(p.metode) + '</span></td>' +
          '<td class="num-col numeric-md" style="color:var(--success-text);">+' + formatRupiah(p.jumlah) + '</td>' +
          '<td class="num-col"><button type="button" class="btn btn-secondary btn-xs" data-id="' + escapeHtml(p.id_bayar) + '" onclick="openPaymentDetailModal(this.dataset.id)">Detail</button></td>' +
        '</tr>';
      }).join('');
    }

    // 3. Tabel Pengeluaran (5 kolom + Detail)
    const expBody = document.getElementById('expensesTableBody');
    if (filteredExps.length === 0) {
      expBody.innerHTML = '<tr><td colspan="5" class="empty-state">Belum ada pengeluaran pada periode ini.</td></tr>';
    } else {
      expBody.innerHTML = pageRows_('expenses', filteredExps.slice().reverse(), expBody, 5).map(function(e) {
        return '<tr>' +
          '<td class="tnum col-desktop-only">' + escapeHtml(e.tanggal) + '</td>' +
          '<td>' +
            '<span class="badge badge-neutral">' + escapeHtml(e.kategori) + '</span>' +
            '<div class="mobile-sub">' + escapeHtml(e.tanggal) + ' • ' + escapeHtml(e.keterangan) + '</div>' +
          '</td>' +
          '<td class="col-desktop-only"><div class="cell-truncate">' + escapeHtml(e.keterangan) + '</div></td>' +
          '<td class="num-col numeric-md" style="color:var(--danger-text);">-' + formatRupiah(e.jumlah) + '</td>' +
          '<td class="num-col"><button type="button" class="btn btn-secondary btn-xs" data-id="' + escapeHtml(e.id) + '" onclick="openExpenseDetailModal(this.dataset.id)">Detail</button></td>' +
        '</tr>';
      }).join('');
    }
  }

  function openExpenseModal(editExpId) {
    const d = APP_STATE.data;
    delete APP_STATE.pendingUploads['expBuktiFileInput'];
    document.getElementById('expBuktiFileInput').value = '';
    document.getElementById('expBuktiInfo').textContent = '';

    if (editExpId && d) {
      const target = (d.expenses || []).find(function(e) { return e.id === editExpId; });
      if (!target) return;
      document.getElementById('expenseModalTitle').textContent = 'Ubah Pengeluaran ' + target.id;
      document.getElementById('expIdInput').value = target.id;
      document.getElementById('expTanggalInput').value = target.tanggal || getTodayYMD();
      document.getElementById('expKategoriSelect').value = target.kategori || 'Bahan Baku';
      document.getElementById('expKeteranganInput').value = target.keterangan || '';
      document.getElementById('expJumlahInput').value = target.jumlah || 0;
    } else {
      document.getElementById('expenseModalTitle').textContent = 'Catat Pengeluaran Kas';
      document.getElementById('expIdInput').value = '';
      document.getElementById('expTanggalInput').value = getTodayYMD();
      document.getElementById('expKategoriSelect').value = 'Bahan Baku';
      document.getElementById('expKeteranganInput').value = '';
      document.getElementById('expJumlahInput').value = '';
    }
    openModal('expenseModal');
  }

  function submitExpenseForm() {
    const idExp = document.getElementById('expIdInput').value || '';
    const tanggal = document.getElementById('expTanggalInput').value;
    const kategori = document.getElementById('expKategoriSelect').value;
    const keterangan = document.getElementById('expKeteranganInput').value.trim();
    const jumlah = Math.round(Number(document.getElementById('expJumlahInput').value) || 0);

    if (!keterangan || jumlah <= 0) {
      showToast('Keterangan dan jumlah pengeluaran (> Rp 0) wajib diisi.', 'error');
      return;
    }

    const uploadObj = APP_STATE.pendingUploads['expBuktiFileInput'] || {};
    callServer('saveExpense', [{
      id: idExp,
      tanggal: tanggal,
      kategori: kategori,
      keterangan: keterangan,
      jumlah: jumlah,
      bukti_base64: uploadObj.base64 || '',
      bukti_filename: uploadObj.fileName || '',
      bukti_mimetype: uploadObj.mimeType || ''
    }], function(res) {
      closeModal('expenseModal');
      applyServerPayload(res);
      showToast('Pengeluaran sebesar ' + formatRupiah(jumlah) + ' berhasil dicatat.', 'success');
    });
  }

  function confirmDeleteExpense(idExp) {
    openConfirmModal('Hapus Catatan Pengeluaran', 'Hapus pengeluaran ' + idExp + '?', function() {
      callServer('deleteExpense', [idExp], function(res) {
        applyServerPayload(res);
        showToast('Catatan pengeluaran dihapus.', 'success');
      });
    });
  }

  /**
   * ==========================================================================
   * 10. INVOICE A4 & NOTA RINGKAS + CETAK PDF (F8)
   * ==========================================================================
   */

  function openInvoicePreviewModal(idOrder) {
    APP_STATE.selectedInvoiceOrderId = idOrder;
    APP_STATE.invoiceLayout = 'A4';
    document.getElementById('btnInvLayoutA4').classList.add('active');
    document.getElementById('btnInvLayoutNota').classList.remove('active');
    renderInvoicePreviewContent();
    openModal('invoiceModal');
  }

  function switchInvoiceLayout(layoutMode) {
    storeSet_('localStorage', STORE_KEYS.invoiceLayout, layoutMode === 'NOTA' ? 'NOTA' : 'A4');
    APP_STATE.invoiceLayout = layoutMode;
    document.getElementById('btnInvLayoutA4').classList.toggle('active', layoutMode === 'A4');
    document.getElementById('btnInvLayoutNota').classList.toggle('active', layoutMode === 'NOTA');
    renderInvoicePreviewContent();
  }

  function renderInvoicePreviewContent() {
    const d = APP_STATE.data;
    if (!d || !APP_STATE.selectedInvoiceOrderId) return;
    const o = (d.orders || []).find(function(x) { return x.id_order === APP_STATE.selectedInvoiceOrderId; });
    if (!o) return;
    const s = d.settings || {};
    const container = document.getElementById('printableInvoiceArea');

    if (APP_STATE.invoiceLayout === 'NOTA') {
      container.className = 'invoice-paper nota-thermal';
      const itemsNota = (o.items || []).map(function(it) {
        return '<div style="margin-bottom:6px; border-bottom:1px dashed #CBD5E1; padding-bottom:6px;">' +
          '<div style="font-weight:700;">' + escapeHtml(it.jenis_produk) + '</div>' +
          '<div class="flex-between tnum"><span>' + it.qty + ' pcs x ' + formatRupiah(it.harga_satuan) + '</span><strong>' + formatRupiah(it.subtotal) + '</strong></div>' +
        '</div>';
      }).join('');

      container.innerHTML = '' +
        '<div style="text-align:center; border-bottom:2px dashed #0F172A; padding-bottom:10px; margin-bottom:10px;">' +
          (safeHttpsUrl(s.logo) ? '<img src="' + safeHttpsUrl(s.logo) + '" alt="Logo" style="max-height:36px; max-width:120px; object-fit:contain; margin:0 auto 4px; display:block;">' : '') +
          '<div style="font-weight:700; font-size:15px;">' + escapeHtml(s.nama_usaha || 'Si-MAKO Konveksi') + '</div>' +
          '<div style="font-size:11px; color:var(--text-muted);">' + escapeHtml(s.alamat || '') + '</div>' +
          '<div style="font-size:11px; color:var(--text-muted);">WA: ' + escapeHtml(s.kontak || '') + '</div>' +
        '</div>' +
        '<div style="margin-bottom:10px; font-size:11px;">' +
          '<div class="flex-between"><span>No. Nota:</span><strong class="tnum">' + escapeHtml(o.no_invoice) + '</strong></div>' +
          '<div class="flex-between"><span>Tanggal:</span><span class="tnum">' + escapeHtml(o.tanggal_order) + '</span></div>' +
          '<div class="flex-between"><span>Pelanggan:</span><strong>' + escapeHtml(o.nama_pelanggan) + '</strong></div>' +
          '<div class="flex-between"><span>Deadline:</span><span class="tnum">' + escapeHtml(o.deadline) + '</span></div>' +
        '</div>' +
        '<div style="border-top:1px solid #0F172A; padding-top:8px; margin-bottom:10px;">' + itemsNota + '</div>' +
        '<div style="font-size:12px;">' +
          '<div class="flex-between"><span>Total:</span><strong class="tnum">' + formatRupiah(o.total_harga) + '</strong></div>' +
          '<div class="flex-between"><span>Dibayar:</span><strong class="tnum">' + formatRupiah(o.total_dibayar) + '</strong></div>' +
          '<div class="flex-between" style="font-size:14px; margin-top:4px; padding-top:4px; border-top:1px solid #0F172A;"><span>Sisa:</span><strong class="tnum">' + formatRupiah(o.sisa_tagihan) + '</strong></div>' +
          '<div style="text-align:center; margin-top:10px;">' + getPaymentStatusBadge(o.status_bayar) + '</div>' +
        '</div>' +
        '<div style="margin-top:14px; text-align:center; font-size:10px; color:var(--text-muted);">' +
          escapeHtml(s.rekening_pembayaran || '') + '<br>Terima kasih atas kepercayaan Anda!' +
        '</div>';
    } else {
      container.className = 'invoice-paper';
      const rowsA4 = (o.items || []).map(function(it, idx) {
        return '<tr>' +
          '<td>' + (idx + 1) + '</td>' +
          '<td><strong>' + escapeHtml(it.jenis_produk) + '</strong></td>' +
          '<td>' + escapeHtml(it.ukuran) + '</td>' +
          '<td class="num-col">' + Number(it.qty).toLocaleString('id-ID') + ' pcs</td>' +
          '<td class="num-col">' + formatRupiah(it.harga_satuan) + '</td>' +
          '<td class="num-col numeric-md">' + formatRupiah(it.subtotal) + '</td>' +
        '</tr>';
      }).join('');

      container.innerHTML = '' +
        '<div class="flex-between" style="border-bottom:2px solid var(--primary); padding-bottom:16px; margin-bottom:20px;">' +
          '<div>' +
            (s.logo ? '<img src="' + escapeHtml(s.logo) + '" alt="Logo Usaha" style="max-height:48px; max-width:150px; object-fit:contain; margin-bottom:6px; display:block;">' : '') +
            '<div style="font-size:22px; font-weight:700; color:var(--primary);">' + escapeHtml(s.nama_usaha || 'Si-MAKO Konveksi') + '</div>' +
            '<div class="body-sm" style="color:var(--text-muted); margin-top:4px;">' + escapeHtml(s.alamat || '') + '</div>' +
            '<div class="body-sm tnum" style="color:var(--text-muted);">Kontak WhatsApp: ' + escapeHtml(s.kontak || '') + '</div>' +
          '</div>' +
          '<div style="text-align:right;">' +
            '<div class="label-sm">INVOICE RESMI</div>' +
            '<div class="numeric-lg tnum" style="color:var(--text-primary); margin:4px 0;">' + escapeHtml(o.no_invoice) + '</div>' +
            getPaymentStatusBadge(o.status_bayar) +
          '</div>' +
        '</div>' +

        '<div class="flex-between" style="margin-bottom:20px; align-items:flex-start;">' +
          '<div>' +
            '<div class="label-sm">Ditagihkan Kepada:</div>' +
            '<div style="font-weight:700; font-size:15px; margin-top:4px;">' + escapeHtml(o.nama_pelanggan) + '</div>' +
            '<div class="body-sm tnum">' + escapeHtml(o.kontak_pelanggan) + '</div>' +
            '<div class="body-sm" style="color:var(--text-muted); max-width:300px;">' + escapeHtml(o.alamat_pelanggan) + '</div>' +
          '</div>' +
          '<div style="text-align:right;">' +
            '<div class="body-sm">ID Order: <strong class="tnum">' + escapeHtml(o.id_order) + '</strong></div>' +
            '<div class="body-sm">Tanggal Order: <strong class="tnum">' + escapeHtml(o.tanggal_order) + '</strong></div>' +
            '<div class="body-sm">Deadline Selesai: <strong class="tnum">' + escapeHtml(o.deadline) + '</strong></div>' +
            '<div class="body-sm">Status Produksi: <strong>' + escapeHtml(o.status_order) + '</strong></div>' +
          '</div>' +
        '</div>' +

        '<table class="data-table" style="border:1px solid var(--border-color); margin-bottom:20px;">' +
          '<thead><tr><th>No</th><th>Jenis Produk</th><th>Rincian Ukuran</th><th class="num-col">Qty</th><th class="num-col">Harga Satuan</th><th class="num-col">Subtotal</th></tr></thead>' +
          '<tbody>' + rowsA4 + '</tbody>' +
        '</table>' +

        '<div class="flex-between" style="align-items:flex-start;">' +
          '<div style="max-width:52%; background:var(--bg-subtle); padding:14px; border-radius:10px; border:1px solid var(--border-color);">' +
            '<div class="label-sm" style="margin-bottom:4px;">Rekening Pembayaran Resmi</div>' +
            '<div class="body-sm" style="font-weight:600;">' + escapeHtml(s.rekening_pembayaran || '-') + '</div>' +
            (o.catatan ? '<div class="body-sm" style="margin-top:8px; color:var(--text-muted);">Catatan: ' + escapeHtml(o.catatan) + '</div>' : '') +
          '</div>' +
          '<div style="width:280px;">' +
            '<div class="flex-between" style="padding:6px 0;"><span class="body-sm">Total Harga:</span><strong class="tnum">' + formatRupiah(o.total_harga) + '</strong></div>' +
            '<div class="flex-between" style="padding:6px 0;"><span class="body-sm">Total Dibayar (DP/Termin):</span><strong class="tnum" style="color:var(--success-text);">' + formatRupiah(o.total_dibayar) + '</strong></div>' +
            '<div class="flex-between" style="padding:10px 0; border-top:2px solid var(--text-primary); font-size:16px;"><strong>Sisa Tagihan:</strong><strong class="tnum" style="color:var(--danger-text);">' + formatRupiah(o.sisa_tagihan) + '</strong></div>' +
          '</div>' +
        '</div>';
    }
  }

  function downloadInvoicePdfFromServer() {
    if (!APP_STATE.selectedInvoiceOrderId) return;
    callServer('generateInvoicePdf', [APP_STATE.selectedInvoiceOrderId], function(res) {
      if (res && res.base64) {
        const link = document.createElement('a');
        link.href = 'data:application/pdf;base64,' + res.base64;
        link.download = res.fileName || 'Invoice_Si-MAKO.pdf';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showToast('Invoice PDF berhasil dibuat dan diunduh!', 'success');
      } else {
        window.print();
      }
    });
  }

  /**
   * ==========================================================================
   * 11. VIEW 7: LAPORAN, GRAFIK CHART.JS, & EKSPOR CSV (F10 — KHUSUS OWNER)
   * ==========================================================================
   */

  function renderAnalyticsCharts() {
    const d = APP_STATE.data;
    if (!d || !isOwnerRole()) return;
    if (typeof Chart === 'undefined') {
      ensureChartJs_().then(function() { if (APP_STATE.activeView === 'laporan') renderAnalyticsCharts(); })
        .catch(function() { showToast('Grafik gagal dimuat (periksa koneksi internet).', 'warning'); });
      return;
    }

    const orders = d.orders || [];
    const payments = d.payments || [];
    const expenses = d.expenses || [];

    // 6 bulan terakhir (bergulir mengikuti tanggal hari ini; tidak ada bulan yang ditulis permanen)
    const months = [];
    const nowD = new Date();
    for (let k = 5; k >= 0; k--) {
      const d = new Date(nowD.getFullYear(), nowD.getMonth() - k, 1);
      months.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
    }
    const palette = {
      text: cssVar_('--text-muted', '#475569'),
      grid: cssVar_('--border-color', '#E5E9F2'),
      primary: cssVar_('--primary', '#2F5BEA'),
      success: cssVar_('--success', '#10B981'),
      danger: cssVar_('--danger', '#EF4444'),
      info: cssVar_('--info', '#0EA5E9'),
      warning: cssVar_('--warning', '#F59E0B'),
      neutral: cssVar_('--text-placeholder', '#64748B'),
      surface: cssVar_('--bg-surface', '#FFFFFF')
    };
    const compactRupiah = function(v) {
      const n = Number(v) || 0;
      if (Math.abs(n) >= 1000000) return 'Rp ' + (n / 1000000).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + ' jt';
      if (Math.abs(n) >= 1000) return 'Rp ' + Math.round(n / 1000).toLocaleString('id-ID') + ' rb';
      return 'Rp ' + n;
    };
    const barOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: palette.text } },
        tooltip: { callbacks: { label: function(c) { return ' ' + (c.dataset.label || '') + ': ' + formatRupiah(c.parsed.y); } } }
      },
      scales: {
        x: { ticks: { color: palette.text }, grid: { color: palette.grid } },
        y: { beginAtZero: true, ticks: { color: palette.text, callback: compactRupiah }, grid: { color: palette.grid } }
      }
    };
    const omzetSeries = months.map(function(m) {
      return orders.filter(function(o) { return String(o.tanggal_order || '').indexOf(m) === 0; })
        .reduce(function(acc, o) { return acc + (Number(o.total_harga) || 0); }, 0);
    });
    const incomeSeries = months.map(function(m) {
      return payments.filter(function(p) { return String(p.tanggal || '').indexOf(m) === 0; })
        .reduce(function(acc, p) { return acc + (Number(p.jumlah) || 0); }, 0);
    });
    const expenseSeries = months.map(function(m) {
      return expenses.filter(function(e) { return String(e.tanggal || '').indexOf(m) === 0; })
        .reduce(function(acc, e) { return acc + (Number(e.jumlah) || 0); }, 0);
    });

    // 1. Chart Omzet
    const ctxOmzet = document.getElementById('chartOmzetCanvas');
    if (ctxOmzet) {
      if (APP_STATE.charts.omzet) APP_STATE.charts.omzet.destroy();
      APP_STATE.charts.omzet = new Chart(ctxOmzet, {
        type: 'bar',
        data: {
          labels: months,
          datasets: [{
            label: 'Omzet Order (Rp)',
            data: omzetSeries,
            backgroundColor: palette.primary,
            borderRadius: 6
          }]
        },
        options: barOptions
      });
    }

    // 2. Chart Pemasukan vs Pengeluaran
    const ctxCash = document.getElementById('chartCashflowCanvas');
    if (ctxCash) {
      if (APP_STATE.charts.cashflow) APP_STATE.charts.cashflow.destroy();
      APP_STATE.charts.cashflow = new Chart(ctxCash, {
        type: 'bar',
        data: {
          labels: months,
          datasets: [
            { label: 'Pemasukan', data: incomeSeries, backgroundColor: palette.success, borderRadius: 6 },
            { label: 'Pengeluaran', data: expenseSeries, backgroundColor: palette.danger, borderRadius: 6 }
          ]
        },
        options: barOptions
      });
    }

    // 3. Chart Status Order
    const ctxStatus = document.getElementById('chartOrderStatusCanvas');
    if (ctxStatus) {
      if (APP_STATE.charts.status) APP_STATE.charts.status.destroy();
      const statusLabels = ['Baru', 'Diproses', 'Selesai', 'Diambil'];
      const statusCounts = statusLabels.map(function(st) {
        return orders.filter(function(o) { return o.status_order === st; }).length;
      });
      APP_STATE.charts.status = new Chart(ctxStatus, {
        type: 'doughnut',
        data: {
          labels: statusLabels,
          datasets: [{
            data: statusCounts,
            backgroundColor: [palette.info, palette.warning, palette.success, palette.neutral],
            borderColor: palette.surface
          }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: palette.text } } } }
      });
    }
  }

  function handleReportDatasetChange() {
    APP_STATE.reportColSortIndex = null;
    populateReportFilterDropdowns_();
    renderReportTable();
  }

  function populateReportFilterDropdowns_() {
    const d = APP_STATE.data;
    if (!d) return;
    const dataset = document.getElementById('reportDatasetSelect').value;
    const custSelect = document.getElementById('reportCustomerFilter');
    const statusSelect = document.getElementById('reportStatusFilter');

    if (custSelect) {
      const prevCust = custSelect.value;
      custSelect.style.display = (dataset === 'expenses') ? 'none' : 'inline-block';
      custSelect.innerHTML = '<option value="ALL">Semua Pelanggan</option>' +
        (d.customers || []).map(function(c) {
          return '<option value="' + c.id_pelanggan + '">' + escapeHtml(c.nama) + '</option>';
        }).join('');
      if (prevCust && Array.from(custSelect.options).some(function(o) { return o.value === prevCust; })) {
        custSelect.value = prevCust;
      }
    }

    if (statusSelect) {
      let opts = '<option value="ALL">Semua Status</option>';
      if (dataset === 'orders') {
        opts += '<optgroup label="Status Produksi"><option value="ORD:Baru">Produksi: Baru</option><option value="ORD:Diproses">Produksi: Diproses</option><option value="ORD:Selesai">Produksi: Selesai</option><option value="ORD:Diambil">Produksi: Diambil</option></optgroup>' +
                '<optgroup label="Status Bayar"><option value="PAY:Belum Bayar">Bayar: Belum Bayar</option><option value="PAY:DP">Bayar: DP</option><option value="PAY:Lunas">Bayar: Lunas</option></optgroup>';
      } else if (dataset === 'payments') {
        opts = '<option value="ALL">Semua Jenis Bayar</option><option value="DP">DP</option><option value="Cicilan">Cicilan</option><option value="Pelunasan">Pelunasan</option>';
      } else {
        opts = '<option value="ALL">Semua Kategori</option><option value="Bahan Baku">Bahan Baku</option><option value="Upah Produksi">Upah Produksi</option><option value="Sablon & Bordir">Sablon & Bordir</option><option value="Operasional">Operasional</option><option value="Pengiriman">Pengiriman</option><option value="Lain-lain">Lain-lain</option>';
      }
      statusSelect.innerHTML = opts;
    }
  }

  function sortReportByColumn(colIdx) {
    if (APP_STATE.reportColSortIndex === colIdx) {
      APP_STATE.reportColSortAsc = !APP_STATE.reportColSortAsc;
    } else {
      APP_STATE.reportColSortIndex = colIdx;
      APP_STATE.reportColSortAsc = true;
    }
    renderReportTable();
  }

  function getFilteredReportRows_() {
    const d = APP_STATE.data;
    if (!d) return { headers: [], rows: [] };

    const dataset = document.getElementById('reportDatasetSelect').value;
    const q = (document.getElementById('reportSearchInput').value || '').toLowerCase().trim();
    const custFilter = document.getElementById('reportCustomerFilter') ? document.getElementById('reportCustomerFilter').value : 'ALL';
    const statusFilter = document.getElementById('reportStatusFilter') ? document.getElementById('reportStatusFilter').value : 'ALL';
    const dStart = document.getElementById('reportDateStart').value;
    const dEnd = document.getElementById('reportDateEnd').value;
    const sortBy = document.getElementById('reportSortBy').value;

    const orderMap = {};
    (d.orders || []).forEach(function(o) { orderMap[o.id_order] = o; });

    let items = [];
    let headers = [];

    let csvHeaders = [];
    if (dataset === 'orders') {
      headers = ['No. Invoice', 'Tanggal', 'Pelanggan', 'Status', 'Total Harga'];
      csvHeaders = ['No. Invoice', 'Tanggal Order', 'Pelanggan', 'Deadline', 'Status Produksi', 'Status Bayar', 'Total Harga', 'Sisa Tagihan'];
      items = (d.orders || []).map(function(o) {
        return {
          id: o.id_order,
          type: 'orders',
          date: o.tanggal_order,
          amount: Number(o.total_harga) || 0,
          id_pelanggan: o.id_pelanggan,
          status_order: o.status_order,
          status_bayar: o.status_bayar,
          searchStr: (o.no_invoice + ' ' + o.nama_pelanggan + ' ' + o.status_order + ' ' + o.status_bayar).toLowerCase(),
          cells: [o.no_invoice, o.tanggal_order, o.nama_pelanggan, o.status_order + ' (' + o.status_bayar + ')', formatRupiah(o.total_harga)],
          sortVals: [o.no_invoice, o.tanggal_order, o.nama_pelanggan, o.status_order, Number(o.total_harga) || 0],
          rawCsv: [o.no_invoice, o.tanggal_order, o.nama_pelanggan, o.deadline, o.status_order, o.status_bayar, o.total_harga, o.sisa_tagihan]
        };
      });
    } else if (dataset === 'payments') {
      headers = ['Tanggal', 'No. Invoice', 'Pelanggan', 'Jenis & Metode', 'Jumlah Masuk'];
      csvHeaders = ['ID Bayar', 'Tanggal', 'No. Invoice / Order', 'Pelanggan', 'Jenis', 'Metode', 'Jumlah Pembayaran'];
      items = (d.payments || []).map(function(p) {
        const ord = orderMap[p.id_order] || {};
        return {
          id: p.id_bayar,
          type: 'payments',
          date: p.tanggal,
          amount: Number(p.jumlah) || 0,
          id_pelanggan: ord.id_pelanggan || '',
          jenis: p.jenis,
          searchStr: (p.id_bayar + ' ' + (ord.no_invoice || p.id_order) + ' ' + (ord.nama_pelanggan || '') + ' ' + p.jenis + ' ' + p.metode).toLowerCase(),
          cells: [p.tanggal, ord.no_invoice || p.id_order, ord.nama_pelanggan || '-', p.jenis + ' (' + p.metode + ')', formatRupiah(p.jumlah)],
          sortVals: [p.tanggal, ord.no_invoice || p.id_order, ord.nama_pelanggan || '-', p.jenis, Number(p.jumlah) || 0],
          rawCsv: [p.id_bayar, p.tanggal, ord.no_invoice || p.id_order, ord.nama_pelanggan || '-', p.jenis, p.metode, p.jumlah]
        };
      });
    } else {
      headers = ['Tanggal', 'Kategori', 'Keterangan', 'Jumlah Keluar'];
      csvHeaders = ['ID Pengeluaran', 'Tanggal', 'Kategori', 'Keterangan', 'Jumlah Keluar', 'Dicatat Oleh'];
      items = (d.expenses || []).map(function(e) {
        return {
          id: e.id,
          type: 'expenses',
          date: e.tanggal,
          amount: Number(e.jumlah) || 0,
          kategori: e.kategori,
          searchStr: (e.id + ' ' + e.kategori + ' ' + e.keterangan).toLowerCase(),
          cells: [e.tanggal, e.kategori, e.keterangan, formatRupiah(e.jumlah)],
          sortVals: [e.tanggal, e.kategori, e.keterangan, Number(e.jumlah) || 0],
          rawCsv: [e.id, e.tanggal, e.kategori, e.keterangan, e.jumlah, e.dicatat_oleh || '-']
        };
      });
    }

    const filtered = items.filter(function(it) {
      if (dStart && String(it.date) < dStart) return false;
      if (dEnd && String(it.date) > dEnd) return false;
      if (dataset !== 'expenses' && custFilter !== 'ALL' && it.id_pelanggan !== custFilter) return false;
      if (statusFilter !== 'ALL') {
        if (dataset === 'orders') {
          if (statusFilter.indexOf('ORD:') === 0 && it.status_order !== statusFilter.replace('ORD:', '')) return false;
          if (statusFilter.indexOf('PAY:') === 0 && it.status_bayar !== statusFilter.replace('PAY:', '')) return false;
        } else if (dataset === 'payments' && it.jenis !== statusFilter) {
          return false;
        } else if (dataset === 'expenses' && it.kategori !== statusFilter) {
          return false;
        }
      }
      if (q && it.searchStr.indexOf(q) === -1) return false;
      return true;
    });

    if (APP_STATE.reportColSortIndex !== null) {
      const cIdx = APP_STATE.reportColSortIndex;
      const dir = APP_STATE.reportColSortAsc ? 1 : -1;
      filtered.sort(function(a, b) {
        const vA = a.sortVals ? a.sortVals[cIdx] : a.rawCsv[cIdx];
        const vB = b.sortVals ? b.sortVals[cIdx] : b.rawCsv[cIdx];
        if (typeof vA === 'number' && typeof vB === 'number') return (vA - vB) * dir;
        return String(vA || '').localeCompare(String(vB || '')) * dir;
      });
    } else {
      filtered.sort(function(a, b) {
        if (sortBy === 'date_asc') return String(a.date).localeCompare(String(b.date));
        if (sortBy === 'amount_desc') return b.amount - a.amount;
        if (sortBy === 'amount_asc') return a.amount - b.amount;
        return String(b.date).localeCompare(String(a.date));
      });
    }

    return { headers: headers, csvHeaders: csvHeaders, rows: filtered };
  }

  function renderReportTable() {
    if (!isOwnerRole()) return;
    const custSelect = document.getElementById('reportCustomerFilter');
    if (custSelect && custSelect.options.length <= 1) {
      populateReportFilterDropdowns_();
    }
    const data = getFilteredReportRows_();
    const thead = document.getElementById('reportMasterTableHead');
    const tbody = document.getElementById('reportMasterTableBody');

    thead.innerHTML = '<tr>' + data.headers.map(function(h, idx) {
      const arrow = APP_STATE.reportColSortIndex === idx ? (APP_STATE.reportColSortAsc ? ' ▲' : ' ▼') : '';
      const isFirstOrLast = (idx === 0 || idx === data.headers.length - 1);
      const extraClass = (idx === data.headers.length - 1 ? ' num-col' : '') + (isFirstOrLast ? '' : ' col-desktop-only');
      return '<th class="sortable' + extraClass + '" title="Klik untuk mengurutkan kolom ini" onclick="sortReportByColumn(' + idx + ')">' + escapeHtml(h) + arrow + '</th>';
    }).join('') + '<th class="num-col">Aksi</th></tr>';

    if (data.rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="' + (data.headers.length + 1) + '" class="empty-state">Tidak ada data laporan pada filter ini.</td></tr>';
      return;
    }

    tbody.innerHTML = pageRows_('report', data.rows, tbody, data.headers.length + 1).map(function(r) {
      const detailFn = r.type === 'orders'
        ? ('openOrderDetailModal(\'' + r.id + '\')')
        : (r.type === 'payments' ? ('openPaymentDetailModal(\'' + r.id + '\')') : ('openExpenseDetailModal(\'' + r.id + '\')'));
      const subSummary = r.cells.slice(1, r.cells.length - 1).join(' • ');
      return '<tr>' + r.cells.map(function(c, i) {
        const isFirst = i === 0;
        const isLast = i === r.cells.length - 1;
        const deskOnly = (!isFirst && !isLast) ? ' col-desktop-only' : '';
        const subHtml = isFirst ? ('<div class="mobile-sub">' + escapeHtml(subSummary) + '</div>') : '';
        return '<td class="tnum' + (isLast ? ' num-col numeric-md' : '') + deskOnly + '"><div class="' + (isLast ? '' : 'cell-truncate') + '" style="' + (isFirst ? 'font-weight:600;' : '') + '">' + escapeHtml(c) + '</div>' + subHtml + '</td>';
      }).join('') +
      '<td class="num-col"><button type="button" class="btn btn-secondary btn-xs" onclick="' + detailFn + '">Detail</button></td></tr>';
    }).join('');
  }

  function exportCurrentReportCsv() {
    const data = getFilteredReportRows_();
    if (!data.rows.length) {
      showToast('Tidak ada data untuk diekspor.', 'warning');
      return;
    }
    const csvLines = [(data.csvHeaders || data.headers).join(',')];
    data.rows.forEach(function(r) {
      const line = r.rawCsv.map(function(val) {
        return '"' + String(val === null || val === undefined ? '' : val).replace(/"/g, '""') + '"';
      }).join(',');
      csvLines.push(line);
    });
    const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Laporan_Si-MAKO_' + document.getElementById('reportDatasetSelect').value + '_' + getTodayYMD() + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('File CSV berhasil diunduh.', 'success');
  }

  /**
   * ==========================================================================
   * 12. VIEW 8: PENGATURAN & MANAJEMEN PENGGUNA (F1 — KHUSUS OWNER)
   * ==========================================================================
   */

  function renderSettingsAndUsersView() {
    const d = APP_STATE.data;
    if (!d || !isOwnerRole()) return;

    const s = d.settings || {};
    document.getElementById('setNamaUsaha').value = s.nama_usaha || '';
    document.getElementById('setAlamat').value = s.alamat || '';
    document.getElementById('setKontak').value = s.kontak || '';
    document.getElementById('setFormatInvoice').value = s.format_nomor_invoice || 'INV/{YYYY}/{MM}/{NNN}';
    document.getElementById('setLogo').value = s.logo || '';
    document.getElementById('setRekening').value = s.rekening_pembayaran || '';

    const usersBody = document.getElementById('usersTableBody');
    const users = d.users || [];
    usersBody.innerHTML = users.map(function(u) {
      const roleBadge = u.peran === 'Owner' ? '<span class="badge badge-owner">Owner</span>' : '<span class="badge badge-info">Admin</span>';
      const activeBadge = String(u.aktif).toLowerCase() === 'ya' ? '<span class="badge badge-success">Aktif</span>' : '<span class="badge badge-danger">Nonaktif</span>';
      const pwBadge = u.punya_sandi === false ? ' <span class="badge badge-warning">Belum ada sandi</span>' : (u.sandi_sementara ? ' <span class="badge badge-neutral">Sandi sementara</span>' : '');
      return '<tr>' +
        '<td>' +
          '<div class="cell-truncate" style="font-weight:600;">' + escapeHtml(u.nama) + '</div>' +
          '<div class="body-sm cell-truncate" style="color:var(--text-muted);">' + escapeHtml(u.email) + '</div>' +
        '</td>' +
        '<td>' + roleBadge + pwBadge + '</td>' +
        '<td class="col-desktop-only">' + activeBadge + '</td>' +
        '<td class="num-col">' +
          '<button type="button" class="btn btn-secondary btn-xs" data-email="' + escapeHtml(u.email) + '" onclick="openUserDetailModal(this.dataset.email)">Detail</button>' +
        '</td>' +
      '</tr>';
    }).join('');

    const logsBody = document.getElementById('activityLogsTableBody');
    const logs = d.logs || [];
    logsBody.innerHTML = logs.length === 0
      ? '<tr><td colspan="4" class="empty-state">Belum ada log aktivitas.</td></tr>'
      : logs.map(function(l) {
          return '<tr>' +
            '<td class="tnum body-sm">' + escapeHtml(l.waktu) + '</td>' +
            '<td class="body-sm">' + escapeHtml(l.email) + '</td>' +
            '<td><span class="badge badge-neutral">' + escapeHtml(l.aksi) + '</span></td>' +
            '<td class="code-cell body-sm">' + escapeHtml(l.id_terkait) + '</td>' +
          '</tr>';
        }).join('');
  }

  function submitSettings() {
    const payload = {
      nama_usaha: document.getElementById('setNamaUsaha').value.trim(),
      alamat: document.getElementById('setAlamat').value.trim(),
      kontak: document.getElementById('setKontak').value.trim(),
      format_nomor_invoice: document.getElementById('setFormatInvoice').value.trim(),
      logo: document.getElementById('setLogo').value.trim(),
      rekening_pembayaran: document.getElementById('setRekening').value.trim()
    };
    callServer('saveSettings', [payload], function(res) {
      applyServerPayload(res);
      showToast('Pengaturan identitas usaha & invoice berhasil disimpan!', 'success');
    });
  }

  function openUserModal(editEmail) {
    const d = APP_STATE.data;
    if (editEmail && d) {
      const u = (d.users || []).find(function(x) { return String(x.email).toLowerCase() === String(editEmail).toLowerCase(); });
      if (!u) return;
      document.getElementById('userModalTitle').textContent = 'Ubah Hak Akses Pengguna';
      document.getElementById('userEmailInput').value = u.email;
      document.getElementById('userNamaInput').value = u.nama;
      document.getElementById('userPeranSelect').value = u.peran;
      document.getElementById('userAktifSelect').value = u.aktif;
    } else {
      document.getElementById('userModalTitle').textContent = 'Tambah Pengguna Baru';
      document.getElementById('userEmailInput').value = '';
      document.getElementById('userNamaInput').value = '';
      document.getElementById('userPeranSelect').value = 'Admin';
      document.getElementById('userAktifSelect').value = 'Ya';
    }
    openModal('userModal');
  }

  function submitUserForm() {
    const email = document.getElementById('userEmailInput').value.trim();
    const nama = document.getElementById('userNamaInput').value.trim();
    const peran = document.getElementById('userPeranSelect').value;
    const aktif = document.getElementById('userAktifSelect').value;

    if (!email || !nama) {
      showToast('Email Google dan nama pengguna wajib diisi.', 'error');
      return;
    }

    callServer('saveUserAccount', [{ email: email, nama: nama, peran: peran, aktif: aktif }], function(res) {
      closeModal('userModal');
      applyServerPayload(res);
      showToast('Data pengguna ' + email + ' berhasil disimpan.', 'success');
      const nu = (res.users || []).find(function(x) { return String(x.email).toLowerCase() === email.toLowerCase(); });
      if (nu && nu.punya_sandi === false && aktif === 'Ya') setTimeout(function() { createTempPasswordForUser(nu.email); }, 250);
    });
  }

  function confirmDeleteUser(email) {
    openConfirmModal('Hapus Akun Pengguna', 'Cabut akses dan hapus ' + email + ' dari daftar Pengguna?', function() {
      callServer('deleteUserAccount', [email], function(res) {
        applyServerPayload(res);
        showToast('Pengguna dihapus.', 'success');
      });
    });
  }


  /**
   * ==========================================================================
   * 13. MODAL DETAIL UNIVERSAL (HPP, STOK BAHAN, MUTASI, KAS, & PENGGUNA)
   * ==========================================================================
   */

  function openHppDetailModal(idHpp) {
    const d = APP_STATE.data;
    if (!d) return;
    const h = (d.hppCalculations || []).find(function(x) { return x.id === idHpp; });
    if (!h) return;

    const hppVal = Number(h.hpp_per_pcs) || 0;
    const jualVal = Number(h.harga_jual_per_pcs) || 0;
    const labaVal = jualVal - hppVal;
    const markupPct = Number(h.margin_persen) || 0;
    const realMarginPct = jualVal > 0 ? ((labaVal / jualVal) * 100).toFixed(1) : '0.0';

    let parsedMats = [];
    try {
      parsedMats = typeof h.rincian_bahan === 'string' ? JSON.parse(h.rincian_bahan) : (h.rincian_bahan || []);
    } catch (e) {}

    const totalBahan = parsedMats.reduce(function(acc, m) { return acc + (Number(m.subtotal) || 0); }, 0);
    const matRows = parsedMats.length === 0
      ? '<tr><td colspan="4" class="empty-state" style="padding:14px;">Tidak ada rincian komponen bahan.</td></tr>'
      : parsedMats.map(function(m) {
          return '<tr>' +
            '<td><strong>' + escapeHtml(m.nama_bahan || m.id_bahan) + '</strong></td>' +
            '<td class="num-col tnum">' + Number(m.qty_per_pcs) + ' ' + escapeHtml(m.satuan || '') + '</td>' +
            '<td class="num-col tnum">' + formatRupiah(m.harga_satuan) + '</td>' +
            '<td class="num-col numeric-md">' + formatRupiah(m.subtotal) + '</td>' +
          '</tr>';
        }).join('');

    document.getElementById('recordDetailModalTitle').textContent = 'Detail Kalkulasi HPP — ' + h.id;
    document.getElementById('recordDetailModalBody').innerHTML = '' +
      '<div class="detail-kv-grid">' +
        '<div class="detail-kv-card">' +
          '<div class="label-sm" style="margin-bottom:8px;">Identitas Katalog Produk</div>' +
          '<div class="detail-kv-row"><span class="detail-kv-label">ID Kalkulasi</span><span class="detail-kv-val code-cell">' + escapeHtml(h.id) + '</span></div>' +
          '<div class="detail-kv-row"><span class="detail-kv-label">Nama Produk</span><span class="detail-kv-val">' + escapeHtml(h.nama_produk) + '</span></div>' +
          '<div class="detail-kv-row"><span class="detail-kv-label">Tanggal Hitung</span><span class="detail-kv-val tnum">' + escapeHtml(h.tanggal) + '</span></div>' +
          '<div class="detail-kv-row"><span class="detail-kv-label">Markup / Margin Riil</span><span class="detail-kv-val"><span class="badge badge-info">Markup ' + markupPct + '%</span> <span class="badge badge-neutral">Margin ' + realMarginPct + '%</span></span></div>' +
        '</div>' +
        '<div class="detail-kv-card" style="background:var(--primary-soft); border-color:var(--primary-border);">' +
          '<div class="label-sm" style="color:var(--primary); margin-bottom:8px;">Struktur Biaya & Harga Jual / Pcs</div>' +
          '<div class="detail-kv-row"><span class="detail-kv-label">Biaya Bahan Baku</span><span class="detail-kv-val tnum">' + formatRupiah(totalBahan) + '</span></div>' +
          '<div class="detail-kv-row"><span class="detail-kv-label">Jahit + Sablon + Lain</span><span class="detail-kv-val tnum">' + formatRupiah((Number(h.ongkos_jahit) || 0) + (Number(h.ongkos_sablon_bordir) || 0) + (Number(h.biaya_lain) || 0)) + '</span></div>' +
          '<div class="detail-kv-row"><span class="detail-kv-label">Total HPP / Pcs</span><span class="detail-kv-val tnum">' + formatRupiah(hppVal) + '</span></div>' +
          '<div class="detail-kv-row"><span class="detail-kv-label">Harga Jual (Laba)</span><span class="detail-kv-val tnum" style="color:var(--primary);">' + formatRupiah(jualVal) + ' <span style="color:var(--success-text);">(+' + formatRupiah(labaVal) + ')</span></span></div>' +
        '</div>' +
      '</div>' +
      '<div class="label-md" style="margin-bottom:8px;">Rincian Komponen Bahan Baku per Pcs</div>' +
      '<div class="table-responsive" style="border:1px solid var(--border-color); border-radius:12px;">' +
        '<table class="data-table"><thead><tr><th>Bahan Baku</th><th class="num-col">Kebutuhan/Pcs</th><th class="num-col">Harga Satuan</th><th class="num-col">Subtotal</th></tr></thead><tbody>' + matRows + '</tbody></table>' +
      '</div>';

    document.getElementById('recordDetailModalFooter').innerHTML = '' +
      '<button type="button" class="btn btn-secondary" onclick="closeModal(\'recordDetailModal\')">Tutup</button>' +
      '<button type="button" class="btn btn-danger-soft" data-id="' + escapeHtml(h.id) + '" onclick="closeModal(\'recordDetailModal\'); confirmDeleteHpp(this.dataset.id);">Hapus</button>' +
      '<button type="button" class="btn btn-secondary" data-id="' + escapeHtml(h.id) + '" onclick="closeModal(\'recordDetailModal\'); loadHppIntoCalculator(this.dataset.id);">Ubah di Kalkulator</button>' +
      '<button type="button" class="btn btn-primary" data-id="' + escapeHtml(h.id) + '" onclick="closeModal(\'recordDetailModal\'); useHppInNewOrder(this.dataset.id);">Pakai di Order Baru</button>';

    openModal('recordDetailModal');
  }

  function openMaterialDetailModal(idBahan) {
    const d = APP_STATE.data;
    if (!d) return;
    const m = (d.materials || []).find(function(x) { return x.id_bahan === idBahan; });
    if (!m) return;

    const isLow = Number(m.stok_saat_ini) <= Number(m.stok_minimum);
    const statusBadge = isLow
      ? '<span class="badge badge-warning">Stok Menipis</span>'
      : '<span class="badge badge-success">Stok Aman</span>';
    const inventoryVal = Math.round((Number(m.stok_saat_ini) || 0) * (Number(m.harga_per_satuan) || 0));

    const recentMuts = (d.mutations || []).filter(function(x) { return x.id_bahan === idBahan; }).slice(-5).reverse();
    const mutRows = recentMuts.length === 0
      ? '<tr><td colspan="4" class="empty-state" style="padding:14px;">Belum ada riwayat mutasi untuk bahan ini.</td></tr>'
      : recentMuts.map(function(mut) {
          const prefix = mut.jenis === 'Masuk' ? '+' : (mut.jenis === 'Keluar' ? '-' : '');
          return '<tr>' +
            '<td class="tnum">' + escapeHtml(mut.tanggal) + '</td>' +
            '<td><span class="badge badge-neutral">' + escapeHtml(mut.jenis) + '</span></td>' +
            '<td class="num-col numeric-md tnum">' + prefix + Number(mut.jumlah).toLocaleString('id-ID') + ' ' + escapeHtml(m.satuan) + '</td>' +
            '<td><div class="cell-truncate">' + escapeHtml(mut.keterangan || '-') + '</div></td>' +
          '</tr>';
        }).join('');

    document.getElementById('recordDetailModalTitle').textContent = 'Detail Bahan Baku — ' + m.id_bahan;
    document.getElementById('recordDetailModalBody').innerHTML = '' +
      '<div class="detail-kv-grid">' +
        '<div class="detail-kv-card">' +
          '<div class="label-sm" style="margin-bottom:8px;">Informasi Master Bahan</div>' +
          '<div class="detail-kv-row"><span class="detail-kv-label">ID Bahan</span><span class="detail-kv-val code-cell">' + escapeHtml(m.id_bahan) + '</span></div>' +
          '<div class="detail-kv-row"><span class="detail-kv-label">Nama Bahan</span><span class="detail-kv-val">' + escapeHtml(m.nama_bahan) + '</span></div>' +
          '<div class="detail-kv-row"><span class="detail-kv-label">Satuan Ukur</span><span class="detail-kv-val">' + escapeHtml(m.satuan) + '</span></div>' +
          '<div class="detail-kv-row"><span class="detail-kv-label">Status Persediaan</span><span class="detail-kv-val">' + statusBadge + '</span></div>' +
        '</div>' +
        '<div class="detail-kv-card">' +
          '<div class="label-sm" style="margin-bottom:8px;">Kuantitas & Valuasi Stok</div>' +
          '<div class="detail-kv-row"><span class="detail-kv-label">Stok Saat Ini</span><span class="detail-kv-val tnum" style="color:' + (isLow ? 'var(--danger-text)' : 'var(--text-primary)') + ';">' + Number(m.stok_saat_ini).toLocaleString('id-ID') + ' ' + escapeHtml(m.satuan) + '</span></div>' +
          '<div class="detail-kv-row"><span class="detail-kv-label">Batas Minimum</span><span class="detail-kv-val tnum">' + Number(m.stok_minimum).toLocaleString('id-ID') + ' ' + escapeHtml(m.satuan) + '</span></div>' +
          '<div class="detail-kv-row"><span class="detail-kv-label">Harga Beli / Satuan</span><span class="detail-kv-val tnum">' + formatRupiah(m.harga_per_satuan) + '</span></div>' +
          '<div class="detail-kv-row"><span class="detail-kv-label">Nilai Persediaan</span><span class="detail-kv-val tnum" style="color:var(--primary);">' + formatRupiah(inventoryVal) + '</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="label-md" style="margin-bottom:8px;">5 Mutasi Terakhir Bahan Ini</div>' +
      '<div class="table-responsive" style="border:1px solid var(--border-color); border-radius:12px;">' +
        '<table class="data-table"><thead><tr><th>Tanggal</th><th>Jenis</th><th class="num-col">Jumlah</th><th>Keterangan</th></tr></thead><tbody>' + mutRows + '</tbody></table>' +
      '</div>';

    document.getElementById('recordDetailModalFooter').innerHTML = '' +
      '<button type="button" class="btn btn-secondary" onclick="closeModal(\'recordDetailModal\')">Tutup</button>' +
      '<button type="button" class="btn btn-danger-soft" data-id="' + escapeHtml(m.id_bahan) + '" onclick="closeModal(\'recordDetailModal\'); confirmDeleteMaterial(this.dataset.id);">Hapus Bahan</button>' +
      '<button type="button" class="btn btn-secondary" data-id="' + escapeHtml(m.id_bahan) + '" onclick="closeModal(\'recordDetailModal\'); openMaterialModal(this.dataset.id);">Ubah Master</button>' +
      '<button type="button" class="btn btn-primary" data-id="' + escapeHtml(m.id_bahan) + '" onclick="closeModal(\'recordDetailModal\'); openMutationModal(this.dataset.id);">+ Catat Mutasi Stok</button>';

    openModal('recordDetailModal');
  }

  function openMutationDetailModal(idMutasi) {
    const d = APP_STATE.data;
    if (!d) return;
    const mut = (d.mutations || []).find(function(x) { return x.id === idMutasi; });
    if (!mut) return;
    const mat = (d.materials || []).find(function(x) { return x.id_bahan === mut.id_bahan; }) || {};

    const numQty = Number(mut.jumlah) || 0;
    const prefix = mut.jenis === 'Masuk' ? '+' : (mut.jenis === 'Keluar' ? '-' : '');
    const badgeClass = mut.jenis === 'Masuk' ? 'badge-success' : (mut.jenis === 'Keluar' ? 'badge-danger' : 'badge-info');

    document.getElementById('recordDetailModalTitle').textContent = 'Detail Mutasi Stok — ' + mut.id;
    document.getElementById('recordDetailModalBody').innerHTML = '' +
      '<div class="detail-kv-card">' +
        '<div class="detail-kv-row"><span class="detail-kv-label">ID Mutasi</span><span class="detail-kv-val code-cell">' + escapeHtml(mut.id) + '</span></div>' +
        '<div class="detail-kv-row"><span class="detail-kv-label">Tanggal Transaksi</span><span class="detail-kv-val tnum">' + escapeHtml(mut.tanggal) + '</span></div>' +
        '<div class="detail-kv-row"><span class="detail-kv-label">Bahan Baku</span><span class="detail-kv-val">' + escapeHtml(mat.nama_bahan || mut.id_bahan) + ' (' + escapeHtml(mut.id_bahan) + ')</span></div>' +
        '<div class="detail-kv-row"><span class="detail-kv-label">Jenis Mutasi</span><span class="detail-kv-val"><span class="badge ' + badgeClass + '">' + escapeHtml(mut.jenis) + '</span></span></div>' +
        '<div class="detail-kv-row"><span class="detail-kv-label">Jumlah Mutasi</span><span class="detail-kv-val tnum">' + prefix + numQty.toLocaleString('id-ID') + ' ' + escapeHtml(mat.satuan || '') + '</span></div>' +
        '<div class="detail-kv-row"><span class="detail-kv-label">Harga Beli / Satuan</span><span class="detail-kv-val tnum">' + formatRupiah(mut.harga_beli) + '</span></div>' +
        '<div class="detail-kv-row"><span class="detail-kv-label">Keterangan / Referensi</span><span class="detail-kv-val">' + escapeHtml(mut.keterangan || '-') + '</span></div>' +
      '</div>';

    document.getElementById('recordDetailModalFooter').innerHTML = '' +
      '<button type="button" class="btn btn-secondary" onclick="closeModal(\'recordDetailModal\')">Tutup</button>' +
      (mat.id_bahan ? '<button type="button" class="btn btn-primary" data-id="' + escapeHtml(mat.id_bahan) + '" onclick="closeModal(\'recordDetailModal\'); openMaterialDetailModal(this.dataset.id);">Lihat Bahan Baku</button>' : '');

    openModal('recordDetailModal');
  }

  function openPaymentDetailModal(idBayar) {
    const d = APP_STATE.data;
    if (!d) return;
    const p = (d.payments || []).find(function(x) { return x.id_bayar === idBayar; });
    if (!p) return;
    const ord = (d.orders || []).find(function(x) { return x.id_order === p.id_order; }) || {};
    const safeUrl = safeDriveUrl(p.link_bukti);
    const buktiHtml = safeUrl
      ? '<a href="' + safeUrl + '" target="_blank" rel="noopener noreferrer" class="badge badge-info">Buka Bukti Transfer di Google Drive</a>'
      : '<span class="body-sm" style="color:var(--text-muted);">Tidak ada lampiran bukti</span>';

    document.getElementById('recordDetailModalTitle').textContent = 'Detail Pemasukan Kas — ' + p.id_bayar;
    document.getElementById('recordDetailModalBody').innerHTML = '' +
      '<div class="detail-kv-card">' +
        '<div class="detail-kv-row"><span class="detail-kv-label">ID Pembayaran</span><span class="detail-kv-val code-cell">' + escapeHtml(p.id_bayar) + '</span></div>' +
        '<div class="detail-kv-row"><span class="detail-kv-label">Tanggal Pembayaran</span><span class="detail-kv-val tnum">' + escapeHtml(p.tanggal) + '</span></div>' +
        '<div class="detail-kv-row"><span class="detail-kv-label">No. Invoice / Order</span><span class="detail-kv-val code-cell">' + escapeHtml(ord.no_invoice || p.id_order) + '</span></div>' +
        '<div class="detail-kv-row"><span class="detail-kv-label">Nama Pelanggan</span><span class="detail-kv-val">' + escapeHtml(ord.nama_pelanggan || '-') + '</span></div>' +
        '<div class="detail-kv-row"><span class="detail-kv-label">Jenis & Metode</span><span class="detail-kv-val"><span class="badge badge-neutral">' + escapeHtml(p.jenis) + '</span> ' + escapeHtml(p.metode) + '</span></div>' +
        '<div class="detail-kv-row"><span class="detail-kv-label">Nominal Masuk</span><span class="detail-kv-val tnum" style="color:var(--success-text); font-size:15px;">+' + formatRupiah(p.jumlah) + '</span></div>' +
        '<div class="detail-kv-row"><span class="detail-kv-label">Bukti Transfer</span><span class="detail-kv-val">' + buktiHtml + '</span></div>' +
      '</div>';

    document.getElementById('recordDetailModalFooter').innerHTML = '' +
      '<button type="button" class="btn btn-secondary" onclick="closeModal(\'recordDetailModal\')">Tutup</button>' +
      (ord.id_order ? '<button type="button" class="btn btn-primary" data-id="' + escapeHtml(ord.id_order) + '" onclick="closeModal(\'recordDetailModal\'); openOrderDetailModal(this.dataset.id);">Lihat Detail Order</button>' : '');

    openModal('recordDetailModal');
  }

  function openExpenseDetailModal(idExp) {
    const d = APP_STATE.data;
    if (!d) return;
    const e = (d.expenses || []).find(function(x) { return x.id === idExp; });
    if (!e) return;
    const safeUrl = safeDriveUrl(e.link_bukti);
    const buktiHtml = safeUrl
      ? '<a href="' + safeUrl + '" target="_blank" rel="noopener noreferrer" class="badge badge-info">Buka Nota/Kwitansi di Google Drive</a>'
      : '<span class="body-sm" style="color:var(--text-muted);">Tidak ada lampiran nota</span>';

    document.getElementById('recordDetailModalTitle').textContent = 'Detail Pengeluaran Kas — ' + e.id;
    document.getElementById('recordDetailModalBody').innerHTML = '' +
      '<div class="detail-kv-card">' +
        '<div class="detail-kv-row"><span class="detail-kv-label">ID Pengeluaran</span><span class="detail-kv-val code-cell">' + escapeHtml(e.id) + '</span></div>' +
        '<div class="detail-kv-row"><span class="detail-kv-label">Tanggal</span><span class="detail-kv-val tnum">' + escapeHtml(e.tanggal) + '</span></div>' +
        '<div class="detail-kv-row"><span class="detail-kv-label">Kategori</span><span class="detail-kv-val"><span class="badge badge-neutral">' + escapeHtml(e.kategori) + '</span></span></div>' +
        '<div class="detail-kv-row"><span class="detail-kv-label">Keterangan Lengkap</span><span class="detail-kv-val">' + escapeHtml(e.keterangan) + '</span></div>' +
        '<div class="detail-kv-row"><span class="detail-kv-label">Nominal Keluar</span><span class="detail-kv-val tnum" style="color:var(--danger-text); font-size:15px;">-' + formatRupiah(e.jumlah) + '</span></div>' +
        '<div class="detail-kv-row"><span class="detail-kv-label">Dicatat Oleh</span><span class="detail-kv-val">' + escapeHtml(e.dicatat_oleh || '-') + '</span></div>' +
        '<div class="detail-kv-row"><span class="detail-kv-label">Lampiran Nota</span><span class="detail-kv-val">' + buktiHtml + '</span></div>' +
      '</div>';

    document.getElementById('recordDetailModalFooter').innerHTML = '' +
      '<button type="button" class="btn btn-secondary" onclick="closeModal(\'recordDetailModal\')">Tutup</button>' +
      '<button type="button" class="btn btn-danger-soft" data-id="' + escapeHtml(e.id) + '" onclick="closeModal(\'recordDetailModal\'); confirmDeleteExpense(this.dataset.id);">Hapus</button>' +
      '<button type="button" class="btn btn-primary" data-id="' + escapeHtml(e.id) + '" onclick="closeModal(\'recordDetailModal\'); openExpenseModal(this.dataset.id);">Ubah Pengeluaran</button>';

    openModal('recordDetailModal');
  }

  function openUserDetailModal(email) {
    const d = APP_STATE.data;
    if (!d) return;
    const u = (d.users || []).find(function(x) { return String(x.email).toLowerCase() === String(email).toLowerCase(); });
    if (!u) return;

    const roleBadge = u.peran === 'Owner' ? '<span class="badge badge-owner">Owner</span>' : '<span class="badge badge-info">Admin</span>';
    const activeBadge = String(u.aktif).toLowerCase() === 'ya' ? '<span class="badge badge-success">Aktif (Ya)</span>' : '<span class="badge badge-danger">Nonaktif (Tidak)</span>';

    document.getElementById('recordDetailModalTitle').textContent = 'Detail Hak Akses Pengguna';
    document.getElementById('recordDetailModalBody').innerHTML = '' +
      '<div class="detail-kv-card">' +
        '<div class="detail-kv-row"><span class="detail-kv-label">Nama Lengkap</span><span class="detail-kv-val">' + escapeHtml(u.nama) + '</span></div>' +
        '<div class="detail-kv-row"><span class="detail-kv-label">Email Akun Google</span><span class="detail-kv-val">' + escapeHtml(u.email) + '</span></div>' +
        '<div class="detail-kv-row"><span class="detail-kv-label">Peran (RBAC)</span><span class="detail-kv-val">' + roleBadge + '</span></div>' +
        '<div class="detail-kv-row"><span class="detail-kv-label">Status Akses</span><span class="detail-kv-val">' + activeBadge + '</span></div>' +
        '<div class="detail-kv-row"><span class="detail-kv-label">Sandi Login</span><span class="detail-kv-val">' + (u.punya_sandi === false ? '<span class="badge badge-warning">Belum dibuat</span>' : (u.sandi_sementara ? '<span class="badge badge-neutral">Sementara (belum diganti)</span>' : '<span class="badge badge-success">Sudah diatur</span>')) + '</span></div>' +
      '</div>';

    document.getElementById('recordDetailModalFooter').innerHTML = '' +
      '<button type="button" class="btn btn-secondary" onclick="closeModal(\'recordDetailModal\')">Tutup</button>' +
      (String(u.email).toLowerCase() !== String((d.user || {}).email || '').toLowerCase()
        ? '<button type="button" class="btn btn-secondary" data-email="' + escapeHtml(u.email) + '" onclick="closeModal(\'recordDetailModal\'); createTempPasswordForUser(this.dataset.email)">Buat Sandi Sementara</button>'
        : '') +
      '<button type="button" class="btn btn-danger-soft" data-email="' + escapeHtml(u.email) + '" onclick="closeModal(\'recordDetailModal\'); confirmDeleteUser(this.dataset.email)">Hapus Pengguna</button>' +
      '<button type="button" class="btn btn-primary" data-email="' + escapeHtml(u.email) + '" onclick="closeModal(\'recordDetailModal\'); openUserModal(this.dataset.email)">Ubah Hak Akses</button>';

    openModal('recordDetailModal');
  }
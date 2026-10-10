// Saku: dashboard lokal. Semua angka datang dari API; tidak ada data contoh.
import { api, ApiFailure } from './api.js';
import {
  rupiah, signedRupiah, typedAmount, typeLabel, esc, previewAmount, todayJakarta, nowLocalInput,
  rangeLabel, monthRange, isFullMonth, shiftMonth, addDays, daysIn, monthName, fmtDateTime,
} from './format.js';
import { drawCashflow } from './charts.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  route: 'ringkasan',
  period: monthRange(todayJakarta().slice(0, 7)),
  filters: { q: '', type: '', category_id: '', source: '', sort: 'date_desc', page: 1, all: false },
  categories: [],
  chart: null,
};
let renderToken = 0;
const txCache = new Map();
const knownIds = new Set();

const ROUTES = {
  ringkasan: { title: 'Ringkasan keuangan', period: true, view: viewSummary },
  transaksi: { title: 'Transaksi', period: true, view: viewLedger },
  anggaran: { title: 'Anggaran', period: true, view: viewBudgets },
  kategori: { title: 'Kategori', period: false, view: viewCategories },
  pengaturan: { title: 'Pengaturan', period: false, view: viewSettings },
};

const PAGE_SIZE = 20;
// Hanya dua nada: pemimpin gelap, sisanya sedang. Keduanya >= 3:1 terhadap lintasan batang.
const FILL_LEAD = '#2c5c4f';
const FILL_REST = '#547d70';
const pct = (n) => String(n).replace('.', ',') + '%';
const sourceLabel = (s) => (s === 'telegram' ? 'Telegram' : 'Dashboard');

// ---------- bantuan umum ----------
function toast(message, { action, error = false } = {}) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  el.innerHTML = `<span>${esc(message)}</span>`;
  const remove = () => el.remove();
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.addEventListener('click', async () => {
      remove();
      try { await action.run(); } catch (e) { toast(e.message, { error: true }); }
    });
    el.append(b);
  }
  box.append(el);
  setTimeout(remove, action ? 8000 : 4500);
}

function skeleton() {
  return '<div class="skeleton" role="status"><span class="sr-only">Memuat data</span></div>';
}

function showError(el, e, retry, what = 'Data') {
  el.className = 'state-box error';
  el.removeAttribute('aria-busy');
  const unreachable = e instanceof ApiFailure && e.code === 'UNREACHABLE';
  el.innerHTML =
    `<strong>${what} tidak bisa dimuat</strong><p>${esc(e.message || 'Terjadi kesalahan.')}${unreachable ? ' Angka tidak ditampilkan agar tidak terbaca sebagai nol.' : ''}</p>` +
    '<button type="button" class="btn small">Coba lagi</button>';
  $('button', el).addEventListener('click', retry);
}

// Setiap bagian dimuat sendiri: kegagalan satu grafik tidak menghapus bagian lain.
function runSection(token, el, cls, fetcher, renderer, { quiet = false, what = 'Data' } = {}) {
  const go = async (q) => {
    if (!q) {
      el.className = '';
      el.setAttribute('aria-busy', 'true');
      el.innerHTML = skeleton();
    }
    try {
      const data = await fetcher();
      if (token !== renderToken) return;
      el.className = cls;
      el.removeAttribute('aria-busy');
      renderer(el, data);
    } catch (e) {
      if (token !== renderToken) return;
      showError(el, e, () => go(false), what);
    }
  };
  return go(quiet);
}

function emptyBox(text, actionLabel, action) {
  return `<div class="state-box"><strong>${esc(text)}</strong>${actionLabel ? `<button type="button" class="btn small primary" data-action="${action}">${esc(actionLabel)}</button>` : ''}</div>`;
}

function remember(items) {
  for (const t of items) txCache.set(t.id, t);
}
function markFresh(root, items) {
  const first = knownIds.size === 0;
  for (const t of items) {
    // Sorot hanya transaksi yang benar-benar baru dibuat, bukan baris lama yang baru pertama kali dimuat.
    const justCreated = Date.now() - Date.parse(t.created_at) < 10000;
    if (!first && justCreated && !knownIds.has(t.id)) {
      const el = root.querySelector(`[data-id="${t.id}"]`);
      if (el) el.classList.add('fresh');
    }
    knownIds.add(t.id);
  }
}

const activeCats = (type) => state.categories.filter((c) => c.type === type && !c.is_archived);

async function loadCategories() {
  try {
    state.categories = (await api('/api/v1/categories')).items;
    return true;
  } catch {
    return false;
  }
}

// ---------- rute dan periode ----------
const currentRoute = () => {
  const r = location.hash.replace(/^#\/?/, '') || 'ringkasan';
  return ROUTES[r] ? r : 'ringkasan';
};

function updatePeriodUI() {
  const route = ROUTES[state.route];
  $('#period').hidden = !route.period;
  $('#periodBtn').textContent = rangeLabel(state.period.from, state.period.to);
  if (!route.period) closePeriodPop();
}

function render({ quiet = false } = {}) {
  const id = currentRoute();
  state.route = id;
  const route = ROUTES[id];
  document.title = `${route.title} · Saku`;
  $$('.nav-list a').forEach((a) => {
    if (a.dataset.route === id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  updatePeriodUI();
  route.view($('#main'), ++renderToken, { quiet });
}

function setPeriod(p) {
  state.period = p;
  state.filters.page = 1;
  render();
}

function shiftPeriod(dir) {
  const p = state.period;
  if (isFullMonth(p)) {
    setPeriod(monthRange(shiftMonth(p.from.slice(0, 7), dir)));
  } else {
    const n = daysIn(p);
    setPeriod(dir < 0 ? { from: addDays(p.from, -n), to: addDays(p.from, -1) } : { from: addDays(p.to, 1), to: addDays(p.to, n) });
  }
}

// popover periode (lapisan kaca)
let popOpen = false;
function closePeriodPop(restore = false) {
  const pop = $('#periodPop');
  if (pop.hidden) return;
  pop.hidden = true;
  popOpen = false;
  $('#periodBtn').setAttribute('aria-expanded', 'false');
  if (restore) $('#periodBtn').focus();
}
function openPeriodPop() {
  const pop = $('#periodPop');
  const p = state.period;
  pop.innerHTML = `
    <h2>Periode</h2>
    <div class="field"><label for="ppMonth">Bulan</label><input id="ppMonth" type="month" value="${p.from.slice(0, 7)}"></div>
    <hr class="sep">
    <p class="sub">Atau rentang khusus</p>
    <div class="row">
      <div class="field"><label for="ppFrom">Dari</label><input id="ppFrom" type="date" value="${p.from}"></div>
      <div class="field"><label for="ppTo">Sampai</label><input id="ppTo" type="date" value="${p.to}"></div>
    </div>
    <p class="hint err" id="ppErr" role="alert"></p>
    <div class="actions">
      <button type="button" class="btn small" id="ppNow">Bulan ini</button>
      <button type="button" class="btn small primary" id="ppApply">Terapkan rentang</button>
    </div>`;
  pop.hidden = false;
  popOpen = true;
  $('#periodBtn').setAttribute('aria-expanded', 'true');
  $('#ppMonth').addEventListener('change', (e) => {
    if (/^\d{4}-\d{2}$/.test(e.target.value)) { setPeriod(monthRange(e.target.value)); closePeriodPop(true); }
  });
  $('#ppNow').addEventListener('click', () => { setPeriod(monthRange(todayJakarta().slice(0, 7))); closePeriodPop(true); });
  $('#ppApply').addEventListener('click', () => {
    const from = $('#ppFrom').value;
    const to = $('#ppTo').value;
    const err = $('#ppErr');
    if (!from || !to) { err.textContent = 'Isi tanggal awal dan akhir.'; return; }
    if (from > to) { err.textContent = 'Tanggal awal tidak boleh setelah tanggal akhir.'; return; }
    if (daysIn({ from, to }) > 800) { err.textContent = 'Rentang maksimal sekitar 800 hari.'; return; }
    setPeriod({ from, to });
    closePeriodPop(true);
  });
  $('#ppMonth').focus();
}

// ---------- Ringkasan ----------
function viewSummary(root, token, { quiet }) {
  const keep = quiet && root.dataset.view === 'ringkasan';
  if (!keep) {
    root.dataset.view = 'ringkasan';
    root.innerHTML = `
      <header class="page-head"><div><h1>Ringkasan keuangan</h1><p class="range" id="rangeText"></p></div></header>
      <div class="summary-grid">
        <div class="col-main">
          <section id="secFlow" aria-label="Arus kas bersih"></section>
          <section id="secChart" aria-label="Grafik arus kas"></section>
        </div>
        <aside class="col-side" aria-label="Rincian">
          <section id="secCats" aria-label="Pengeluaran per kategori"></section>
          <section id="secRecent" aria-label="Transaksi terbaru"></section>
        </aside>
      </div>`;
  }
  const p = state.period;
  $('#rangeText').textContent = rangeLabel(p.from, p.to);
  const params = { from: p.from, to: p.to };
  const opt = (what) => ({ quiet: keep, what });
  runSection(token, $('#secFlow'), 'flow-panel', () => api('/api/v1/dashboard/summary', { params }), renderFlow, opt('Ringkasan'));
  runSection(token, $('#secChart'), 'block', () => api('/api/v1/dashboard/cashflow', { params }), (el, d) => renderChart(el, d, !keep), opt('Grafik'));
  runSection(token, $('#secCats'), 'block plain', () => api('/api/v1/dashboard/categories', { params }), renderCats, opt('Rincian kategori'));
  runSection(token, $('#secRecent'), 'block', () => api('/api/v1/transactions', { params: { ...params, page_size: 6 } }), renderRecent, opt('Transaksi terbaru'));
}

function renderFlow(el, s) {
  let note;
  if (s.count === 0) {
    note = '<p class="flow-note">Belum ada transaksi pada periode ini.</p><button type="button" class="btn" data-action="add-tx">Tambah transaksi</button>';
  } else if (s.previous) {
    const diff = s.net - s.previous.net;
    const label = rangeLabel(s.previous.from, s.previous.to);
    note = `<p class="flow-note">${s.count} transaksi. Dibanding ${esc(label)}, arus kas bersih ${diff === 0 ? 'sama' : `${diff > 0 ? 'lebih tinggi' : 'lebih rendah'} ${rupiah(diff)}`}.</p>`;
  } else {
    note = `<p class="flow-note">${s.count} transaksi pada periode ini.</p>`;
  }
  el.innerHTML = `
    <p class="label">Arus kas bersih</p>
    <p class="big">${signedRupiah(s.net)}</p>
    <div class="flow-split">
      <div><p class="label">Pemasukan</p><p class="v">+${rupiah(s.income)}</p></div>
      <div><p class="label">Pengeluaran</p><p class="v">−${rupiah(s.expense)}</p></div>
    </div>${note}`;
}

function renderChart(el, d, animate) {
  const total = d.buckets.reduce((s, b) => s + b.income + b.expense, 0);
  const unit = { day: 'per hari', week: 'per minggu', month: 'per bulan' }[d.granularity];
  const head = `
    <div class="block-head"><div><h2 class="section">Arus kas</h2>
    <p class="sub">Bagaimana pemasukan dan pengeluaran berubah selama periode ini?</p></div></div>`;
  if (total === 0) {
    el.innerHTML = head + `<div style="margin-top:16px">${emptyBox('Belum ada transaksi pada periode ini.', 'Tambah transaksi', 'add-tx')}</div>`;
    state.chart = null;
    return;
  }
  const rows = d.buckets
    .map((b) => `<tr><td>${esc(rangeLabel(b.from, b.to))}</td><td class="r">+${rupiah(b.income)}</td><td class="r">−${rupiah(b.expense)}</td></tr>`)
    .join('');
  el.innerHTML = `${head}
    <div class="legend"><span><i style="background:var(--income)"></i>Pemasukan</span><span><i style="background:var(--expense)"></i>Pengeluaran</span><span>${unit}, dalam rupiah</span></div>
    <div class="chart-wrap" id="chartHost"></div>
    <details class="data-table"><summary>Lihat data sebagai tabel</summary>
      <div class="scroll"><table><caption class="sr-only">Pemasukan dan pengeluaran ${unit}</caption>
      <thead><tr><th scope="col">Periode</th><th scope="col" class="r">Pemasukan</th><th scope="col" class="r">Pengeluaran</th></tr></thead><tbody>${rows}</tbody></table></div>
    </details>`;
  const host = $('#chartHost', el);
  state.chart = { host, data: d };
  drawCashflow(host, d, { animate });
}

function renderCats(el, d) {
  const p = state.period;
  const head = `<h2 class="section">Pengeluaran per kategori</h2>
    <p class="sub">Kategori mana yang paling banyak menyerap pengeluaran, ${esc(rangeLabel(p.from, p.to))}</p>`;
  if (d.items.length === 0) {
    el.innerHTML = head + `<div style="margin-top:16px"><div class="state-box"><strong>Belum ada pengeluaran pada periode ini.</strong></div></div>`;
    return;
  }
  let items = d.items;
  if (items.length > 7) {
    const rest = items.slice(6);
    const amount = rest.reduce((s, i) => s + i.amount, 0);
    items = [...items.slice(0, 6), { name: `${rest.length} kategori lain`, amount, share: Math.round((amount * 1000) / d.total) / 10 }];
  }
  el.innerHTML = `${head}
    <p class="sub num" style="margin-top:10px">Total pengeluaran <strong style="color:var(--ink)">−${rupiah(d.total)}</strong></p>
    <ol class="cat-list">${items.map((i, n) => `
      <li class="cat-row"><div class="top"><span class="name">${esc(i.name)}</span><span class="val">−${rupiah(i.amount)}<small>${pct(i.share)}</small></span></div>
      <div class="meter" role="img" aria-label="${pct(i.share)} dari total pengeluaran"><span style="--w:${i.share}%;--fill:${n === 0 ? FILL_LEAD : FILL_REST}"></span></div></li>`).join('')}
    </ol>`;
}

function txTitle(t) {
  return t.description || t.category_name || typeLabel(t.type);
}

function renderRecent(el, d) {
  remember(d.items);
  const head = `<div class="block-head"><h2 class="section">Transaksi terbaru</h2><a class="btn link" href="#/transaksi">Lihat semua</a></div>`;
  if (d.items.length === 0) {
    el.innerHTML = head + `<div style="margin-top:12px">${emptyBox('Belum ada transaksi pada periode ini.', 'Tambah transaksi', 'add-tx')}</div>`;
    return;
  }
  el.innerHTML = `${head}<ul class="recent">${d.items.map((t) => `
    <li data-id="${t.id}"><button type="button" class="row-btn" data-action="edit-tx" data-id="${t.id}">
      <span class="t">${esc(txTitle(t))}</span>
      <span class="m">${esc(t.category_name || 'Tanpa kategori')} · ${fmtDateTime(t.occurred_at)}</span>
      <span class="amount ${t.type}"><span class="sr-only">${typeLabel(t.type)} </span>${typedAmount(t.type, t.amount)}</span>
    </button></li>`).join('')}</ul>`;
  markFresh(el, d.items);
}

// ---------- Transaksi ----------
const filtersActive = () => {
  const f = state.filters;
  return Boolean(f.q || f.type || f.category_id || f.source || f.all || f.sort !== 'date_desc');
};

function fillFilterCategories() {
  const sel = $('#fCategory');
  if (!sel) return;
  const opt = (c) => `<option value="${c.id}">${esc(c.name)}${c.is_archived ? ' (arsip)' : ''}</option>`;
  const group = (label, type) => `<optgroup label="${label}">${state.categories.filter((c) => c.type === type).map(opt).join('')}</optgroup>`;
  sel.innerHTML = `<option value="">Semua kategori</option>${group('Pengeluaran', 'expense')}${group('Pemasukan', 'income')}`;
  sel.value = state.categories.some((c) => c.id === state.filters.category_id) ? state.filters.category_id : '';
}

function viewLedger(root, token, { quiet }) {
  const keep = quiet && root.dataset.view === 'transaksi';
  if (!keep) {
    root.dataset.view = 'transaksi';
    root.innerHTML = `
      <header class="page-head"><div><h1>Transaksi</h1><p class="range" id="rangeText"></p></div></header>
      <form class="toolbar" id="filters" role="search" aria-label="Cari dan saring transaksi">
        <div class="field"><label for="fQ">Cari</label><input id="fQ" type="search" autocomplete="off" placeholder="Catatan, kategori, atau jumlah"></div>
        <div class="field"><label for="fType">Jenis</label><select id="fType"><option value="">Semua jenis</option><option value="expense">Pengeluaran</option><option value="income">Pemasukan</option></select></div>
        <div class="field"><label for="fCategory">Kategori</label><select id="fCategory"></select></div>
        <div class="field"><label for="fSource">Sumber</label><select id="fSource"><option value="">Semua sumber</option><option value="telegram">Telegram</option><option value="dashboard">Dashboard</option></select></div>
        <div class="field"><label for="fSort">Urutan</label><select id="fSort"><option value="date_desc">Terbaru</option><option value="date_asc">Terlama</option><option value="amount_desc">Jumlah terbesar</option><option value="amount_asc">Jumlah terkecil</option></select></div>
        <div class="field"><label for="fScope">Rentang</label><select id="fScope"><option value="period">Periode terpilih</option><option value="all">Semua waktu</option></select></div>
      </form>
      <div id="ledgerMeta" class="toolbar-meta" aria-live="polite"></div>
      <section id="ledgerBody" aria-label="Daftar transaksi"></section>`;
    const f = state.filters;
    $('#fQ').value = f.q;
    $('#fType').value = f.type;
    $('#fSource').value = f.source;
    $('#fSort').value = f.sort;
    $('#fScope').value = f.all ? 'all' : 'period';
    let timer;
    $('#filters').addEventListener('submit', (e) => e.preventDefault());
    $('#fQ').addEventListener('input', (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => { f.q = e.target.value.trim(); f.page = 1; loadLedger(renderToken, false); }, 250);
    });
    const bind = (id, key, map = (v) => v) =>
      $(id).addEventListener('change', (e) => { f[key] = map(e.target.value); f.page = 1; render({ quiet: true }); });
    bind('#fType', 'type');
    bind('#fCategory', 'category_id');
    bind('#fSource', 'source');
    bind('#fSort', 'sort');
    bind('#fScope', 'all', (v) => v === 'all');
  }
  fillFilterCategories();
  const p = state.period;
  $('#rangeText').textContent = state.filters.all ? 'Semua waktu' : rangeLabel(p.from, p.to);
  loadLedger(token, keep);
}

function loadLedger(token, quiet) {
  const f = state.filters;
  const params = { q: f.q, type: f.type, category_id: f.category_id, source: f.source, sort: f.sort, page: f.page, page_size: PAGE_SIZE };
  if (!f.all) { params.from = state.period.from; params.to = state.period.to; }
  return runSection(token, $('#ledgerBody'), '', () => api('/api/v1/transactions', { params }), renderLedger, { quiet, what: 'Daftar transaksi' });
}

function renderLedger(el, d) {
  const f = state.filters;
  const pages = Math.max(1, Math.ceil(d.total / PAGE_SIZE));
  if (d.items.length === 0 && d.total > 0 && f.page > pages) { f.page = pages; loadLedger(renderToken, true); return; }
  remember(d.items);
  const meta = $('#ledgerMeta');
  meta.innerHTML = `<span>${d.total} transaksi${filtersActive() ? ' sesuai saringan' : ''}</span>${filtersActive() ? '<button type="button" class="btn small" data-action="reset-filters">Reset filter</button>' : ''}`;
  if (d.total === 0) {
    el.innerHTML = filtersActive()
      ? `<div class="state-box"><strong>Tidak ada transaksi yang cocok.</strong><button type="button" class="btn small primary" data-action="reset-filters">Reset filter</button></div>`
      : emptyBox('Belum ada transaksi pada periode ini.', 'Tambah transaksi', 'add-tx');
    return;
  }
  const rows = d.items.map((t) => `
    <tr data-id="${t.id}">
      <td class="when">${fmtDateTime(t.occurred_at)}<small>${sourceLabel(t.source)}</small></td>
      <td class="d"><span class="desc">${esc(t.description || '(tanpa catatan)')}</span><small class="m-only">${esc(t.category_name || 'Tanpa kategori')}</small></td>
      <td class="cat">${esc(t.category_name || 'Tanpa kategori')}${t.category_archived ? ' <small>(arsip)</small>' : ''}</td>
      <td class="typ">${typeLabel(t.type)}</td>
      <td class="amt ${t.type}"><span class="sr-only">${typeLabel(t.type)} </span>${typedAmount(t.type, t.amount)}</td>
      <td class="act"><div class="row-actions">
        <button type="button" class="btn small ghost" data-action="edit-tx" data-id="${t.id}" aria-label="Ubah transaksi ${esc(txTitle(t))}">Ubah</button>
        <button type="button" class="btn small ghost" data-action="delete-tx" data-id="${t.id}" aria-label="Hapus transaksi ${esc(txTitle(t))}">Hapus</button>
      </div></td>
    </tr>`).join('');
  el.innerHTML = `
    <div class="ledger"><table>
      <caption class="sr-only">Daftar transaksi, halaman ${f.page} dari ${pages}</caption>
      <thead><tr><th scope="col">Tanggal</th><th scope="col">Deskripsi</th><th scope="col">Kategori</th><th scope="col">Jenis</th><th scope="col" class="r">Jumlah</th><th scope="col"><span class="sr-only">Aksi</span></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div class="pager"><span>Halaman ${f.page} dari ${pages}</span><div class="btns">
      <button type="button" class="btn small" data-action="page" data-dir="-1" ${f.page <= 1 ? 'disabled' : ''}>Sebelumnya</button>
      <button type="button" class="btn small" data-action="page" data-dir="1" ${f.page >= pages ? 'disabled' : ''}>Berikutnya</button></div></div>`;
  markFresh(el, d.items);
}

// ---------- Anggaran ----------
function viewBudgets(root, token, { quiet }) {
  const month = state.period.from.slice(0, 7);
  const keep = quiet && root.dataset.view === 'anggaran';
  if (!keep) {
    root.dataset.view = 'anggaran';
    root.innerHTML = `
      <header class="page-head"><div><h1>Anggaran</h1><p class="range" id="rangeText"></p></div>
        <button type="button" class="btn primary" data-action="add-budget">Buat anggaran</button></header>
      <p class="sub" style="max-width:640px;margin-bottom:24px">Anggaran dihitung dari seluruh pengeluaran pada bulan yang dipilih. Pengembalian dana dicatat sebagai pemasukan dan tidak mengurangi pengeluaran.</p>
      <section id="budgetBody" aria-label="Daftar anggaran"></section>`;
  }
  $('#rangeText').textContent = monthName(month) + (isFullMonth(state.period) ? '' : ' (dari awal periode)');
  runSection(token, $('#budgetBody'), '', () => api('/api/v1/budgets', { params: { month } }), (el, d) => renderBudgets(el, d, month), { quiet: keep, what: 'Anggaran' });
}

function budgetStatus(b) {
  if (b.paused) return { cls: 'paused', label: 'Dijeda' };
  if (b.percent > 100) return { cls: 'over', label: 'Melebihi target' };
  if (b.percent >= 80) return { cls: 'warn', label: 'Hampir habis' };
  return { cls: 'ok', label: 'Dalam batas' };
}

function budgetInner(b, lead) {
  const st = budgetStatus(b);
  const name = b.category_name || 'Semua pengeluaran';
  const left = b.remaining >= 0 ? `Sisa ${rupiah(b.remaining)}` : `Lebih ${rupiah(-b.remaining)}`;
  return `
    <div class="budget-top"><span class="name">${esc(name)}</span><span class="tag ${st.cls}">${st.label}</span></div>
    ${lead ? `<p class="big num">${rupiah(b.spent)} <span class="sub" style="font-size:16px;font-weight:400">dari ${rupiah(b.limit_amount)}</span></p>` : ''}
    <div class="meter ${st.cls === 'ok' ? '' : st.cls}" role="progressbar" aria-label="Pemakaian anggaran ${esc(name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(b.percent, 100)}" style="margin-top:${lead ? 0 : 10}px"><span style="--w:${Math.min(b.percent, 100)}%"></span></div>
    <div class="budget-meta"><span>${lead ? '' : `${rupiah(b.spent)} dari ${rupiah(b.limit_amount)} · `}${b.percent}% terpakai</span><span>${left}</span></div>
    <div class="budget-actions">
      <button type="button" class="btn small ghost" data-action="edit-budget" data-id="${b.id}" aria-label="Ubah target anggaran ${esc(name)}">Ubah target</button>
      <button type="button" class="btn small ghost" data-action="toggle-budget" data-id="${b.id}" data-paused="${b.paused}" aria-label="${b.paused ? 'Lanjutkan' : 'Jeda'} anggaran ${esc(name)}">${b.paused ? 'Lanjutkan' : 'Jeda'}</button>
      <button type="button" class="btn small ghost" data-action="delete-budget" data-id="${b.id}" aria-label="Hapus anggaran ${esc(name)}">Hapus</button>
    </div>`;
}

const budgetCache = new Map();
function renderBudgets(el, d, month) {
  budgetCache.clear();
  d.items.forEach((b) => budgetCache.set(b.id, b));
  if (d.items.length === 0) {
    el.innerHTML = emptyBox('Belum ada anggaran untuk bulan ini.', 'Buat anggaran', 'add-budget');
    return;
  }
  const overall = d.items.find((b) => !b.category_id);
  const rest = d.items.filter((b) => b.category_id).sort((a, b) => b.percent - a.percent);
  el.innerHTML =
    (overall ? `<div class="budget-lead" data-id="${overall.id}">${budgetInner(overall, true)}</div>` : '') +
    (rest.length ? `<ul class="ruled" aria-label="Anggaran per kategori">${rest.map((b) => `<li data-id="${b.id}">${budgetInner(b, false)}</li>`).join('')}</ul>` : '');
}

// ---------- Kategori ----------
function viewCategories(root, token, { quiet }) {
  const keep = quiet && root.dataset.view === 'kategori';
  if (!keep) {
    root.dataset.view = 'kategori';
    root.innerHTML = `
      <header class="page-head"><div><h1>Kategori</h1><p class="sub">Kategori yang diarsipkan tetap terbaca pada transaksi lama.</p></div></header>
      <section id="catBody" aria-label="Daftar kategori"></section>`;
  }
  runSection(token, $('#catBody'), '', async () => { const d = await api('/api/v1/categories'); state.categories = d.items; return d; }, renderCategories, { quiet: keep, what: 'Kategori' });
}

function renderCategories(el, d) {
  const group = (type, title) => {
    const all = d.items.filter((c) => c.type === type);
    const live = all.filter((c) => !c.is_archived);
    const arch = all.filter((c) => c.is_archived);
    const item = (c) => `
      <li><div class="cat-item"><div><span class="name">${esc(c.name)}</span><span class="meta"> · ${c.transaction_count} transaksi</span></div>
        <div class="row-actions">
          <button type="button" class="btn small ghost" data-action="rename-category" data-id="${c.id}" aria-label="Ubah nama kategori ${esc(c.name)}">Ubah nama</button>
          <button type="button" class="btn small ghost" data-action="toggle-category" data-id="${c.id}" data-archived="${c.is_archived}" aria-label="${c.is_archived ? 'Aktifkan lagi' : 'Arsipkan'} kategori ${esc(c.name)}">${c.is_archived ? 'Aktifkan lagi' : 'Arsipkan'}</button>
        </div></div></li>`;
    return `<section aria-label="Kategori ${title.toLowerCase()}">
      <div class="block-head" style="margin-bottom:12px"><h2 class="section">${title}</h2>
        <button type="button" class="btn small" data-action="add-category" data-type="${type}">Tambah kategori</button></div>
      ${live.length ? `<ul class="ruled">${live.map(item).join('')}</ul>` : emptyBox('Kategori khusus belum dibuat.', 'Tambah kategori', 'add-category" data-type="' + type)}
      ${arch.length ? `<details class="data-table"><summary>Diarsipkan (${arch.length})</summary><ul class="ruled" style="margin-top:8px">${arch.map(item).join('')}</ul></details>` : ''}
    </section>`;
  };
  el.innerHTML = `<div class="two-col">${group('expense', 'Pengeluaran')}${group('income', 'Pemasukan')}</div>`;
}

// ---------- Pengaturan ----------
function viewSettings(root, token, { quiet }) {
  const keep = quiet && root.dataset.view === 'pengaturan';
  if (!keep) {
    root.dataset.view = 'pengaturan';
    root.innerHTML = `<header class="page-head"><div><h1>Pengaturan</h1><p class="sub">Status koneksi dan data lokal.</p></div></header><section id="setBody" aria-label="Pengaturan"></section>`;
  }
  runSection(token, $('#setBody'), '', () => api('/api/v1/settings'), renderSettings, { quiet: keep, what: 'Pengaturan' });
}

function kb(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1).replace('.', ',')} KB`;
}

function renderSettings(el, s) {
  const t = s.telegram;
  const cls = t.state === 'Terhubung' ? 'ok' : t.state === 'Perlu tindakan' ? 'bad' : 'wait';
  const base = location.origin;
  const curl = `curl -X POST ${base}/api/v1/transactions \\
  -H "Content-Type: application/json" \\
  -H "X-Saku-Key: $SAKU_BOT_KEY" \\
  -d '{"type":"expense","amount":"28000","category_name":"Makanan & Minuman","description":"Kopi sore","telegram_update_id":123456,"telegram_user_id":123456789}'`;
  const beat = `curl -X POST ${base}/api/v1/bot/heartbeat \\
  -H "Content-Type: application/json" -H "X-Saku-Key: $SAKU_BOT_KEY" \\
  -d '{"ok":true}'`;
  el.innerHTML = `<div class="settings-grid">
    <section aria-labelledby="hTg">
      <h2 class="section" id="hTg">Telegram</h2>
      <p class="state-word ${cls}" style="margin-top:10px">${esc(t.state)}</p>
      ${t.detail ? `<p class="sub">${esc(t.detail)}</p>` : ''}
      <dl class="kv">
        <dt>Sinyal terakhir</dt><dd>${t.last_ok_at ? fmtDateTime(t.last_ok_at) : 'Belum ada'}</dd>
        <dt>Kesalahan terakhir</dt><dd>${t.last_error_at ? fmtDateTime(t.last_error_at) : 'Tidak ada'}</dd>
        <dt>ID Telegram diizinkan</dt><dd>${t.allowed_user_ids.length ? esc(t.allowed_user_ids.join(', ')) : 'Belum diatur di file .env'}</dd>
        <dt>Kunci bot</dt><dd>${t.key_configured ? 'Sudah diatur' : 'Belum diatur di file .env'}</dd>
      </dl>
      <p class="note">Database dan dashboard berjalan di komputer ini, tetapi pesan Telegram tetap melewati server Telegram.</p>
      <details class="data-table"><summary>Cara menghubungkan bot</summary>
        <p class="sub" style="margin-top:8px">Bot memanggil API lokal ini dengan header kunci. Server menentukan sumber transaksi dan menolak ID Telegram di luar daftar.</p>
        <pre><code>${esc(curl)}</code></pre>
        <p class="sub" style="margin-top:12px">Kirim sinyal berkala agar status di atas mencerminkan keadaan nyata:</p>
        <pre><code>${esc(beat)}</code></pre>
      </details>
    </section>
    <section aria-labelledby="hSt">
      <h2 class="section" id="hSt">Penyimpanan</h2>
      <dl class="kv">
        <dt>Berkas data</dt><dd>${esc(s.storage.file)}</dd>
        <dt>Ukuran</dt><dd>${kb(s.storage.size_bytes)}</dd>
        <dt>Transaksi tersimpan</dt><dd>${s.storage.transactions}</dd>
      </dl>
      <p class="note">Cadangan: salin berkas data di atas. Untuk memulihkan, hentikan Saku, ganti berkasnya, lalu jalankan lagi.</p>
    </section>
    <section aria-labelledby="hEx">
      <h2 class="section" id="hEx">Ekspor</h2>
      <p class="sub" style="margin-top:6px">Unduh seluruh transaksi sebagai CSV. Berkas ini tidak terenkripsi dan berisi data keuangan pribadi, jadi simpan di tempat yang aman.</p>
      <a class="btn" style="margin-top:12px" href="/api/v1/export/transactions.csv" download>Unduh CSV</a>
    </section>
    <section aria-labelledby="hAb">
      <h2 class="section" id="hAb">Tentang</h2>
      <dl class="kv"><dt>Versi</dt><dd>${esc(s.app.version)}</dd><dt>Zona waktu</dt><dd>${esc(s.app.timezone)}</dd><dt>Mata uang</dt><dd>${esc(s.app.currency)}</dd><dt>Alamat layanan</dt><dd>${esc(location.host)}</dd></dl>
    </section></div>`;
}

async function refreshRailStatus() {
  const el = $('#railStatus');
  try {
    const s = await api('/api/v1/settings');
    el.textContent = `Telegram: ${s.telegram.state.toLowerCase()}`;
  } catch {
    el.textContent = 'Layanan lokal: tidak merespons';
  }
}

// ---------- form transaksi ----------
let lastFocus = null;
let saving = false;

function fillTxCategories(selected) {
  const type = $('#txForm').elements.type.value;
  const sel = $('#txCategory');
  const list = activeCats(type);
  const extra = selected && !list.some((c) => c.id === selected) ? state.categories.find((c) => c.id === selected && c.type === type) : null;
  sel.innerHTML = '<option value="">Pilih kategori</option>' +
    [...list, ...(extra ? [extra] : [])].map((c) => `<option value="${c.id}">${esc(c.name)}${c.is_archived ? ' (arsip)' : ''}</option>`).join('');
  sel.value = selected && [...sel.options].some((o) => o.value === selected) ? selected : '';
  $('#txCategoryMsg').textContent = list.length ? '' : 'Belum ada kategori untuk jenis ini. Tambahkan dulu di halaman Kategori.';
}

function clearTxErrors() {
  for (const id of ['Amount', 'Category', 'When', 'Desc']) {
    $(`#tx${id}Msg`).textContent = '';
    $(`#tx${id}Msg`).classList.remove('err');
  }
  $$('#txForm input, #txForm select').forEach((i) => i.removeAttribute('aria-invalid'));
  $('#txError').textContent = '';
}

function setFieldError(msgEl, input, text) {
  msgEl.textContent = text;
  msgEl.classList.add('err');
  input.setAttribute('aria-invalid', 'true');
}

async function openTxDialog(tx = null) {
  lastFocus = document.activeElement;
  if (!state.categories.length) await loadCategories();
  const form = $('#txForm');
  clearTxErrors();
  form.dataset.id = tx ? tx.id : '';
  form.dataset.key = tx ? '' : crypto.randomUUID();
  $('#txTitle').textContent = tx ? 'Ubah transaksi' : 'Tambah transaksi';
  $('#txSubmit').textContent = 'Simpan transaksi';
  form.elements.type.value = tx ? tx.type : 'expense';
  $('#txAmount').value = tx ? String(tx.amount) : '';
  $('#txWhen').value = tx ? tx.occurred_at.slice(0, 16) : nowLocalInput();
  $('#txDesc').value = tx ? tx.description || '' : '';
  fillTxCategories(tx ? tx.category_id : '');
  updateAmountHint();
  $('#txDialog').showModal();
  $('#txAmount').focus();
}

function updateAmountHint() {
  const msg = $('#txAmountMsg');
  const input = $('#txAmount');
  const r = previewAmount(input.value);
  msg.classList.remove('err');
  input.removeAttribute('aria-invalid');
  if (r.empty) msg.textContent = '';
  else if (r.error) setFieldError(msg, input, r.error);
  else msg.textContent = `Akan disimpan sebagai ${rupiah(r.value)}`;
}

async function submitTx(e) {
  e.preventDefault();
  if (saving) return;
  const form = $('#txForm');
  clearTxErrors();
  const body = {
    type: form.elements.type.value,
    amount: $('#txAmount').value,
    category_id: $('#txCategory').value,
    occurred_at: $('#txWhen').value,
    description: $('#txDesc').value,
  };
  if (!body.category_id) { setFieldError($('#txCategoryMsg'), $('#txCategory'), 'Pilih kategori untuk melanjutkan.'); $('#txCategory').focus(); return; }
  if (!body.occurred_at) { setFieldError($('#txWhenMsg'), $('#txWhen'), 'Isi tanggal dan waktu.'); return; }
  const btn = $('#txSubmit');
  saving = true;
  btn.disabled = true;
  btn.textContent = 'Menyimpan...';
  try {
    const id = form.dataset.id;
    const res = id
      ? await api(`/api/v1/transactions/${id}`, { method: 'PATCH', body })
      : await api('/api/v1/transactions', { method: 'POST', body: { ...body, idempotency_key: form.dataset.key } });
    $('#txDialog').close();
    toast(id ? 'Perubahan tersimpan.' : 'Transaksi tersimpan.');
    remember([res.transaction]);
    render({ quiet: true });
  } catch (err) {
    const map = { amount: ['Amount', '#txAmount'], category_id: ['Category', '#txCategory'], occurred_at: ['When', '#txWhen'], description: ['Desc', '#txDesc'] };
    const hit = map[err.field];
    if (hit) setFieldError($(`#tx${hit[0]}Msg`), $(hit[1]), err.message);
    else $('#txError').textContent = err.code === 'UNREACHABLE' ? `${err.message} Transaksi belum tersimpan, isian Anda tetap ada.` : err.message;
  } finally {
    saving = false;
    btn.disabled = false;
    btn.textContent = 'Simpan transaksi';
  }
}

// ---------- dialog generik, konfirmasi ----------
function openFormDialog({ title, submitLabel, fields, onSubmit }) {
  lastFocus = document.activeElement;
  const dlg = $('#formDialog');
  const form = $('#genericForm');
  const fieldHtml = fields.map((f) => {
    const id = `gf-${f.name}`;
    const control = f.type === 'select'
      ? `<select id="${id}" name="${f.name}" ${f.disabled ? 'disabled' : ''} aria-describedby="${id}-msg">${f.options.map((o) => `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
      : `<input id="${id}" name="${f.name}" value="${esc(f.value || '')}" ${f.inputmode ? `inputmode="${f.inputmode}"` : ''} ${f.maxlength ? `maxlength="${f.maxlength}"` : ''} autocomplete="off" placeholder="${esc(f.placeholder || '')}" aria-describedby="${id}-msg">`;
    return `<div class="field"><label for="${id}">${esc(f.label)}</label>${control}<p class="hint" id="${id}-msg" aria-live="polite">${esc(f.hint || '')}</p></div>`;
  }).join('');
  form.innerHTML = `<header class="dlg-head"><h2 id="formTitle">${esc(title)}</h2><button type="button" class="btn ghost" data-close>Tutup</button></header>
    ${fieldHtml}<p class="form-error" role="alert"></p>
    <footer class="dlg-foot"><button type="button" class="btn" data-close>Batal</button><button type="submit" class="btn primary">${esc(submitLabel)}</button></footer>`;
  let busy = false;
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    $$('.hint', form).forEach((h, i) => { h.classList.remove('err'); h.textContent = fields[i].hint || ''; });
    $$('input,select', form).forEach((i) => i.removeAttribute('aria-invalid'));
    $('.form-error', form).textContent = '';
    const values = Object.fromEntries(fields.map((f) => [f.name, f.disabled ? f.value : form.elements[f.name].value]));
    const submit = $('button[type="submit"]', form);
    busy = true;
    submit.disabled = true;
    try {
      await onSubmit(values);
      dlg.close();
    } catch (err) {
      const input = err.field && form.elements[err.field];
      if (input) setFieldError($(`#gf-${err.field}-msg`), input, err.message);
      else $('.form-error', form).textContent = err.message;
    } finally {
      busy = false;
      submit.disabled = false;
    }
  };
  dlg.showModal();
  const first = $$('input,select', form).find((i) => !i.disabled);
  if (first) first.focus();
}

function confirmAsk({ title, message, confirmLabel }) {
  return new Promise((resolve) => {
    lastFocus = document.activeElement;
    const dlg = $('#confirmDialog');
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = message;
    $('#confirmOk').textContent = confirmLabel;
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
  });
}

// ---------- palet pencarian (lapisan kaca) ----------
function paletteActions() {
  return [
    { label: 'Tambah transaksi', run: () => openTxDialog() },
    { label: 'Buka Ringkasan', run: () => go('ringkasan') },
    { label: 'Buka Transaksi', run: () => go('transaksi') },
    { label: 'Buka Anggaran', run: () => go('anggaran') },
    { label: 'Buka Kategori', run: () => go('kategori') },
    { label: 'Buka Pengaturan', run: () => go('pengaturan') },
  ];
}
const go = (r) => { location.hash = `#/${r}`; };

let paletteTimer;
let paletteSeq = 0;
function openPalette() {
  lastFocus = document.activeElement;
  const dlg = $('#paletteDialog');
  $('#paletteInput').value = '';
  renderPalette('', []);
  dlg.showModal();
  $('#paletteInput').focus();
}

function renderPalette(q, results, error) {
  const list = $('#paletteList');
  const acts = paletteActions().filter((a) => !q || a.label.toLowerCase().includes(q.toLowerCase()));
  let html = '';
  if (q) {
    html += '<div class="palette-group">Transaksi</div>';
    if (error) html += `<p class="palette-empty">${esc(error)}</p>`;
    else if (!results.length) html += '<p class="palette-empty">Tidak ada transaksi yang cocok.</p>';
    else html += results.map((t) => `<button type="button" class="palette-item" role="option" data-pal-tx="${t.id}"><span>${esc(txTitle(t))}<small>${esc(t.category_name || 'Tanpa kategori')} · ${fmtDateTime(t.occurred_at)}</small></span><span class="amount ${t.type}">${typedAmount(t.type, t.amount)}</span></button>`).join('');
  }
  if (acts.length) html += '<div class="palette-group">Perintah</div>' + acts.map((a, i) => `<button type="button" class="palette-item" role="option" data-pal-act="${paletteActions().indexOf(a)}"><span>${esc(a.label)}</span></button>`).join('');
  list.innerHTML = html;
}

function onPaletteInput(e) {
  const q = e.target.value.trim();
  clearTimeout(paletteTimer);
  if (!q) { renderPalette('', []); return; }
  renderPalette(q, [], null);
  const seq = ++paletteSeq;
  paletteTimer = setTimeout(async () => {
    try {
      const d = await api('/api/v1/transactions', { params: { q, page_size: 6 } });
      if (seq !== paletteSeq) return;
      remember(d.items);
      renderPalette(q, d.items);
    } catch (err) {
      if (seq === paletteSeq) renderPalette(q, [], err.message);
    }
  }, 200);
}

function onPaletteKey(e) {
  const items = $$('.palette-item', $('#paletteList'));
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const i = items.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
    if (next < 0) $('#paletteInput').focus();
    else if (items[next]) items[next].focus();
  } else if (e.key === 'Enter' && e.target.id === 'paletteInput' && items[0]) {
    e.preventDefault();
    items[0].click();
  }
}

// ---------- aksi (delegasi klik) ----------
async function deleteTx(id) {
  const t = txCache.get(id);
  const ok = await confirmAsk({
    title: 'Hapus transaksi ini?',
    message: t ? `${txTitle(t)} · ${typedAmount(t.type, t.amount)}. Total akan dihitung ulang.` : 'Total akan dihitung ulang.',
    confirmLabel: 'Hapus transaksi',
  });
  if (!ok) return;
  try {
    await api(`/api/v1/transactions/${id}`, { method: 'DELETE' });
    toast('Transaksi dihapus.', { action: { label: 'Urungkan', run: async () => { await api(`/api/v1/transactions/${id}/restore`, { method: 'POST' }); toast('Transaksi dipulihkan.'); render({ quiet: true }); } } });
    render({ quiet: true });
  } catch (e) {
    toast(e.message, { error: true });
  }
}

function budgetDialog(existing) {
  const month = state.period.from.slice(0, 7);
  const used = new Set([...budgetCache.values()].map((b) => b.category_id));
  const options = [];
  if (!used.has(null) || existing) options.push({ value: '', label: 'Semua pengeluaran' });
  for (const c of activeCats('expense')) if (!used.has(c.id) || (existing && existing.category_id === c.id)) options.push({ value: c.id, label: c.name });
  if (!options.length) { toast('Semua kategori sudah punya anggaran bulan ini.'); return; }
  openFormDialog({
    title: existing ? 'Ubah target anggaran' : `Buat anggaran ${monthName(month)}`,
    submitLabel: 'Simpan anggaran',
    fields: [
      { name: 'category_id', label: 'Kategori', type: 'select', options, value: existing ? existing.category_id || '' : options[0].value, disabled: Boolean(existing) },
      { name: 'limit_amount', label: 'Target (Rp)', inputmode: 'numeric', value: existing ? String(existing.limit_amount) : '', placeholder: 'Contoh: 1500000', hint: 'Batas pengeluaran untuk bulan ini.' },
    ],
    onSubmit: async (v) => {
      if (existing) await api(`/api/v1/budgets/${existing.id}`, { method: 'PATCH', body: { limit_amount: v.limit_amount } });
      else await api('/api/v1/budgets', { method: 'POST', body: { month, category_id: v.category_id || null, limit_amount: v.limit_amount } });
      toast('Anggaran tersimpan.');
      render({ quiet: true });
    },
  });
}

function categoryDialog({ id, type, name }) {
  openFormDialog({
    title: id ? 'Ubah nama kategori' : `Tambah kategori ${type === 'income' ? 'pemasukan' : 'pengeluaran'}`,
    submitLabel: 'Simpan kategori',
    fields: [{ name: 'name', label: 'Nama kategori', value: name || '', maxlength: 40, placeholder: 'Contoh: Pendidikan' }],
    onSubmit: async (v) => {
      if (id) await api(`/api/v1/categories/${id}`, { method: 'PATCH', body: { name: v.name } });
      else await api('/api/v1/categories', { method: 'POST', body: { name: v.name, type } });
      await loadCategories();
      toast('Kategori tersimpan.');
      render({ quiet: true });
    },
  });
}

document.addEventListener('click', async (e) => {
  const close = e.target.closest('[data-close]');
  if (close) { close.closest('dialog').close(); return; }
  if (e.target === $('#paletteDialog')) { $('#paletteDialog').close(); return; }
  const palTx = e.target.closest('[data-pal-tx]');
  if (palTx) { const t = txCache.get(palTx.dataset.palTx); $('#paletteDialog').close(); if (t) openTxDialog(t); return; }
  const palAct = e.target.closest('[data-pal-act]');
  if (palAct) { $('#paletteDialog').close(); paletteActions()[Number(palAct.dataset.palAct)].run(); return; }
  if (popOpen && !e.target.closest('#periodPop') && !e.target.closest('#periodBtn')) closePeriodPop();
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const d = el.dataset;
  switch (d.action) {
    case 'add-tx': openTxDialog(); break;
    case 'edit-tx': { const t = txCache.get(d.id); if (t) openTxDialog(t); break; }
    case 'delete-tx': deleteTx(d.id); break;
    case 'open-search': openPalette(); break;
    case 'reset-filters':
      state.filters = { q: '', type: '', category_id: '', source: '', sort: 'date_desc', page: 1, all: false };
      render();
      break;
    case 'page': state.filters.page = Math.max(1, state.filters.page + Number(d.dir)); render({ quiet: true }); break;
    case 'add-budget': budgetDialog(null); break;
    case 'edit-budget': budgetDialog(budgetCache.get(d.id)); break;
    case 'toggle-budget':
      try { await api(`/api/v1/budgets/${d.id}`, { method: 'PATCH', body: { paused: d.paused !== 'true' } }); render({ quiet: true }); } catch (err) { toast(err.message, { error: true }); }
      break;
    case 'delete-budget': {
      const b = budgetCache.get(d.id);
      if (await confirmAsk({ title: 'Hapus anggaran ini?', message: `${b && b.category_name ? b.category_name : 'Semua pengeluaran'}. Transaksi tidak ikut terhapus.`, confirmLabel: 'Hapus anggaran' })) {
        try { await api(`/api/v1/budgets/${d.id}`, { method: 'DELETE' }); toast('Anggaran dihapus.'); render({ quiet: true }); } catch (err) { toast(err.message, { error: true }); }
      }
      break;
    }
    case 'add-category': categoryDialog({ type: d.type }); break;
    case 'rename-category': { const c = state.categories.find((x) => x.id === d.id); if (c) categoryDialog({ id: c.id, type: c.type, name: c.name }); break; }
    case 'toggle-category':
      try {
        const archive = d.archived !== 'true';
        await api(`/api/v1/categories/${d.id}`, { method: 'PATCH', body: { is_archived: archive } });
        await loadCategories();
        toast(archive ? 'Kategori diarsipkan. Transaksi lama tetap terbaca.' : 'Kategori aktif lagi.');
        render({ quiet: true });
      } catch (err) { toast(err.message, { error: true }); }
      break;
    default: break;
  }
});

// ---------- inisialisasi ----------
$('#periodPrev').addEventListener('click', () => shiftPeriod(-1));
$('#periodNext').addEventListener('click', () => shiftPeriod(1));
$('#periodBtn').addEventListener('click', () => (popOpen ? closePeriodPop(true) : openPeriodPop()));
$('#txForm').addEventListener('submit', submitTx);
$('#txAmount').addEventListener('input', updateAmountHint);
$$('#txForm input[name="type"]').forEach((r) => r.addEventListener('change', () => fillTxCategories('')));
$('#paletteInput').addEventListener('input', onPaletteInput);
$('#paletteDialog').addEventListener('keydown', onPaletteKey);
$$('dialog').forEach((dlg) => dlg.addEventListener('close', () => {
  if (!$('dialog[open]') && lastFocus && document.contains(lastFocus)) lastFocus.focus();
}));

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (!$('dialog[open]')) openPalette();
  } else if (e.key === 'Escape' && popOpen) {
    closePeriodPop(true);
  }
});

window.addEventListener('hashchange', () => { render(); $('#main').focus({ preventScroll: true }); });
// href="#main" akan dibaca sebagai rute dan memicu hashchange, jadi tautan lewati ditangani langsung.
$('.skip').addEventListener('click', (e) => { e.preventDefault(); $('#main').focus(); });

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.chart && state.chart.host.isConnected) drawCashflow(state.chart.host, state.chart.data);
  }, 150);
});

// Pembaruan langsung: SSE, dengan polling ringan bila SSE terputus.
let sseOpen = false;
let eventTimer;
function connectEvents() {
  if (typeof EventSource === 'undefined') return;
  const es = new EventSource('/api/v1/events');
  es.onopen = () => { sseOpen = true; };
  es.onerror = () => { sseOpen = false; };
  es.onmessage = (m) => {
    clearTimeout(eventTimer);
    eventTimer = setTimeout(async () => {
      let ev = {};
      try { ev = JSON.parse(m.data); } catch { /* abaikan */ }
      if (String(ev.type || '').startsWith('category')) await loadCategories();
      if (ev.type === 'bot.status') refreshRailStatus();
      render({ quiet: true });
    }, 250);
  };
}
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  refreshRailStatus();
  if (!sseOpen && !$('dialog[open]')) render({ quiet: true });
}, 30000);

(async function init() {
  await loadCategories();
  render();
  refreshRailStatus();
  connectEvents();
})();

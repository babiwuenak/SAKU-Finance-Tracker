// Saku: API lokal + penyaji dashboard. Tanpa dependensi, hanya Node 20+.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ApiError, parseAmount, normalizeOccurredAt, validateRange, summarize, cashflow,
  categoryBreakdown, budgetProgress, previousRange, isActive, inRange, nowJakartaIso,
} from './lib.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv(path.join(ROOT, '.env'));

const HOST = process.env.APP_HOST || '127.0.0.1';
const PORT = Number(process.env.APP_PORT || 8000);
const DATA_FILE = path.resolve(ROOT, process.env.DATA_FILE || './data/saku.json');
const BOT_KEY = process.env.SAKU_BOT_KEY || '';
const ALLOWED_IDS = (process.env.TELEGRAM_ALLOWED_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PUBLIC_DIR = path.join(ROOT, 'public');

// ---------- penyimpanan ----------
const uid = () => crypto.randomUUID();
const stamp = () => nowJakartaIso();

function seed() {
  const t = stamp();
  const mk = (name, type) => ({ id: uid(), name, type, is_archived: false, created_at: t, updated_at: t });
  return {
    version: 1,
    categories: [
      ...['Makanan & Minuman', 'Transportasi', 'Belanja', 'Tagihan', 'Kesehatan', 'Hiburan', 'Lainnya'].map((n) => mk(n, 'expense')),
      ...['Gaji', 'Usaha', 'Lainnya'].map((n) => mk(n, 'income')),
    ],
    transactions: [],
    budgets: [],
    bot: { last_ok_at: null, last_error_at: null, last_error: null },
  };
}

let db;
if (fs.existsSync(DATA_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    console.error('File data tidak bisa dibaca. Server berhenti agar data tidak tertimpa. Periksa atau pulihkan dari cadangan.');
    process.exit(1);
  }
} else {
  db = seed();
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  persist();
}

function persist() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------- event langsung (SSE) ----------
const clients = new Set();
function emit(type, payload = {}) {
  const msg = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

// ---------- util ----------
const clean = (s, max, field, required = false) => {
  if (s == null || s === '') {
    if (required) throw new ApiError(400, 'VALIDATION_ERROR', 'Kolom ini wajib diisi.', field);
    return null;
  }
  if (typeof s !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', 'Teks tidak valid.', field);
  const v = s.trim().replace(/[\u0000-\u001f\u007f]/g, ' ');
  if (!v && required) throw new ApiError(400, 'VALIDATION_ERROR', 'Kolom ini wajib diisi.', field);
  if (v.length > max) throw new ApiError(400, 'VALIDATION_ERROR', `Maksimal ${max} karakter.`, field);
  return v || null;
};
const catById = (id) => db.categories.find((c) => c.id === id);
const nameKey = (s) => s.trim().toLowerCase();

function txView(t) {
  const c = t.category_id ? catById(t.category_id) : null;
  const { idempotency_key, ...rest } = t;
  return { ...rest, category_name: c ? c.name : null, category_archived: c ? c.is_archived : false };
}

function resolveCategory(body, type) {
  let cat = null;
  if (body.category_id) cat = catById(body.category_id);
  else if (body.category_name) cat = db.categories.find((c) => c.type === type && nameKey(c.name) === nameKey(String(body.category_name)));
  else throw new ApiError(400, 'CATEGORY_REQUIRED', 'Pilih kategori untuk transaksi ini.', 'category_id');
  if (!cat) throw new ApiError(400, 'VALIDATION_ERROR', 'Kategori tidak ditemukan.', 'category_id');
  if (cat.type !== type) throw new ApiError(400, 'VALIDATION_ERROR', 'Jenis kategori tidak sesuai dengan jenis transaksi.', 'category_id');
  return cat;
}

function parseType(v) {
  if (v !== 'income' && v !== 'expense') throw new ApiError(400, 'VALIDATION_ERROR', 'Jenis transaksi harus pemasukan atau pengeluaran.', 'type');
  return v;
}

function readRange(q) {
  return validateRange(q.get('from') || '', q.get('to') || '');
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// ---------- rute ----------
const routes = [];
const route = (method, pattern, handler) =>
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:id/g, '([^/]+)') + '$'), handler });

route('GET', '/api/v1/health', () => ({
  status: 'ok',
  database: fs.existsSync(DATA_FILE) ? 'ok' : 'missing',
}));

route('GET', '/api/v1/dashboard/summary', ({ q }) => {
  const r = readRange(q);
  const current = summarize(db.transactions, r.from, r.to);
  const pr = previousRange(r.from, r.to);
  const prev = summarize(db.transactions, pr.from, pr.to);
  return { ...r, ...current, previous: prev.count > 0 ? { ...pr, ...prev } : null };
});

route('GET', '/api/v1/dashboard/cashflow', ({ q }) => {
  const r = readRange(q);
  return { ...r, ...cashflow(db.transactions, r.from, r.to) };
});

route('GET', '/api/v1/dashboard/categories', ({ q }) => {
  const r = readRange(q);
  return { ...r, ...categoryBreakdown(db.transactions, db.categories, r.from, r.to) };
});

route('GET', '/api/v1/transactions', ({ q }) => {
  let list = db.transactions.filter(isActive);
  if (q.get('from') || q.get('to')) {
    const r = readRange(q);
    list = list.filter((t) => inRange(t, r.from, r.to));
  }
  const type = q.get('type');
  if (type) list = list.filter((t) => t.type === type);
  const cat = q.get('category_id');
  if (cat) list = list.filter((t) => t.category_id === cat);
  const source = q.get('source');
  if (source) list = list.filter((t) => t.source === source);
  const text = (q.get('q') || '').trim().toLowerCase().slice(0, 80);
  if (text) {
    const digits = text.replace(/[^\d]/g, '');
    list = list.filter((t) => {
      const c = t.category_id ? catById(t.category_id) : null;
      return (
        (t.description || '').toLowerCase().includes(text) ||
        (c && c.name.toLowerCase().includes(text)) ||
        (digits.length > 0 && String(t.amount).includes(digits))
      );
    });
  }
  const sort = q.get('sort') || 'date_desc';
  const cmp = {
    date_desc: (a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0),
    date_asc: (a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0),
    amount_desc: (a, b) => b.amount - a.amount,
    amount_asc: (a, b) => a.amount - b.amount,
  }[sort];
  if (!cmp) throw new ApiError(400, 'VALIDATION_ERROR', 'Urutan tidak dikenali.', 'sort');
  list.sort(cmp);
  const pageSize = Math.min(100, Math.max(1, parseInt(q.get('page_size') || '20', 10) || 20));
  const page = Math.max(1, parseInt(q.get('page') || '1', 10) || 1);
  return {
    items: list.slice((page - 1) * pageSize, page * pageSize).map(txView),
    total: list.length,
    page,
    page_size: pageSize,
  };
});

route('POST', '/api/v1/transactions', ({ body, isBot }) => {
  const type = parseType(body.type);
  const amount = parseAmount(body.amount);
  const cat = resolveCategory(body, type);
  if (cat.is_archived) throw new ApiError(400, 'VALIDATION_ERROR', 'Kategori ini sudah diarsipkan. Pilih kategori lain.', 'category_id');
  const occurred_at = normalizeOccurredAt(body.occurred_at);
  const description = clean(body.description, 200, 'description');
  let key = clean(body.idempotency_key, 100, 'idempotency_key');
  if (isBot) {
    if (ALLOWED_IDS.length && !ALLOWED_IDS.includes(String(body.telegram_user_id ?? ''))) {
      throw new ApiError(403, 'FORBIDDEN', 'Pengguna Telegram ini tidak diizinkan.');
    }
    if (!key && body.telegram_update_id != null) key = `tg:${String(body.telegram_update_id).slice(0, 40)}`;
  }
  if (key) {
    const existing = db.transactions.find((t) => t.idempotency_key === key);
    if (existing) return { status: 200, json: { transaction: txView(existing), duplicate: true } };
  }
  const t = stamp();
  const tx = {
    id: uid(), type, amount, currency: 'IDR', category_id: cat.id, description, occurred_at,
    source: isBot ? 'telegram' : 'dashboard', idempotency_key: key, created_at: t, updated_at: t, deleted_at: null,
  };
  db.transactions.push(tx);
  persist();
  emit('transaction.created', { id: tx.id });
  return { status: 201, json: { transaction: txView(tx), duplicate: false } };
});

const findTx = (id) => {
  const t = db.transactions.find((x) => x.id === id);
  if (!t) throw new ApiError(404, 'NOT_FOUND', 'Transaksi tidak ditemukan.');
  return t;
};

route('GET', '/api/v1/transactions/:id', ({ params }) => {
  const t = findTx(params[0]);
  if (t.deleted_at) throw new ApiError(404, 'NOT_FOUND', 'Transaksi tidak ditemukan.');
  return { transaction: txView(t) };
});

route('PATCH', '/api/v1/transactions/:id', ({ params, body }) => {
  const t = findTx(params[0]);
  if (t.deleted_at) throw new ApiError(404, 'NOT_FOUND', 'Transaksi tidak ditemukan.');
  const type = body.type !== undefined ? parseType(body.type) : t.type;
  const next = { ...t, type };
  if (body.amount !== undefined) next.amount = parseAmount(body.amount);
  if (body.occurred_at !== undefined) next.occurred_at = normalizeOccurredAt(body.occurred_at);
  if (body.description !== undefined) next.description = clean(body.description, 200, 'description');
  if (body.category_id !== undefined || body.category_name !== undefined || type !== t.type) {
    const unchanged = body.category_id === t.category_id && type === t.type;
    if (!unchanged) {
      const cat = resolveCategory({ category_id: body.category_id || undefined, category_name: body.category_name }, type);
      if (cat.is_archived) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Kategori ini sudah diarsipkan. Pilih kategori lain.', 'category_id');
      }
      next.category_id = cat.id;
    }
  }
  next.updated_at = stamp();
  Object.assign(t, next);
  persist();
  emit('transaction.updated', { id: t.id });
  return { transaction: txView(t) };
});

route('DELETE', '/api/v1/transactions/:id', ({ params }) => {
  const t = findTx(params[0]);
  if (!t.deleted_at) {
    t.deleted_at = stamp();
    persist();
    emit('transaction.deleted', { id: t.id });
  }
  return { status: 200, json: { id: t.id, deleted: true } };
});

route('POST', '/api/v1/transactions/:id/restore', ({ params }) => {
  const t = findTx(params[0]);
  t.deleted_at = null;
  t.updated_at = stamp();
  persist();
  emit('transaction.created', { id: t.id });
  return { transaction: txView(t) };
});

route('GET', '/api/v1/categories', () => {
  const counts = new Map();
  for (const t of db.transactions) if (isActive(t) && t.category_id) counts.set(t.category_id, (counts.get(t.category_id) || 0) + 1);
  return { items: db.categories.map((c) => ({ ...c, transaction_count: counts.get(c.id) || 0 })) };
});

route('POST', '/api/v1/categories', ({ body }) => {
  const name = clean(body.name, 40, 'name', true);
  const type = parseType(body.type);
  if (db.categories.some((c) => c.type === type && nameKey(c.name) === nameKey(name))) {
    throw new ApiError(409, 'DUPLICATE', 'Kategori dengan nama ini sudah ada.', 'name');
  }
  const t = stamp();
  const c = { id: uid(), name, type, is_archived: false, created_at: t, updated_at: t };
  db.categories.push(c);
  persist();
  emit('category.changed');
  return { status: 201, json: { category: c } };
});

route('PATCH', '/api/v1/categories/:id', ({ params, body }) => {
  const c = catById(params[0]);
  if (!c) throw new ApiError(404, 'NOT_FOUND', 'Kategori tidak ditemukan.');
  if (body.name !== undefined) {
    const name = clean(body.name, 40, 'name', true);
    if (db.categories.some((x) => x.id !== c.id && x.type === c.type && nameKey(x.name) === nameKey(name))) {
      throw new ApiError(409, 'DUPLICATE', 'Kategori dengan nama ini sudah ada.', 'name');
    }
    c.name = name;
  }
  if (body.is_archived !== undefined) c.is_archived = Boolean(body.is_archived);
  c.updated_at = stamp();
  persist();
  emit('category.changed');
  return { category: c };
});

const budgetView = (b) => {
  const c = b.category_id ? catById(b.category_id) : null;
  return { ...b, category_name: c ? c.name : null, ...budgetProgress(db.transactions, b) };
};

route('GET', '/api/v1/budgets', ({ q }) => {
  const month = q.get('month') || '';
  if (!MONTH_RE.test(month)) throw new ApiError(400, 'VALIDATION_ERROR', 'Bulan tidak valid.', 'month');
  return { month, items: db.budgets.filter((b) => b.month === month).map(budgetView) };
});

function budgetInput(body, existing) {
  const limit_amount = body.limit_amount !== undefined ? parseAmount(body.limit_amount) : existing.limit_amount;
  if (limit_amount === undefined) throw new ApiError(400, 'VALIDATION_ERROR', 'Target anggaran wajib diisi.', 'limit_amount');
  return limit_amount;
}

route('POST', '/api/v1/budgets', ({ body }) => {
  if (!MONTH_RE.test(body.month || '')) throw new ApiError(400, 'VALIDATION_ERROR', 'Bulan tidak valid.', 'month');
  const category_id = body.category_id || null;
  if (category_id) {
    const c = catById(category_id);
    if (!c || c.type !== 'expense') throw new ApiError(400, 'VALIDATION_ERROR', 'Pilih kategori pengeluaran.', 'category_id');
  }
  if (db.budgets.some((b) => b.month === body.month && b.category_id === category_id)) {
    throw new ApiError(409, 'DUPLICATE', 'Anggaran untuk kategori ini sudah ada di bulan tersebut.', 'category_id');
  }
  const t = stamp();
  const b = { id: uid(), category_id, month: body.month, limit_amount: budgetInput(body, {}), paused: false, created_at: t, updated_at: t };
  db.budgets.push(b);
  persist();
  emit('budget.changed');
  return { status: 201, json: { budget: budgetView(b) } };
});

const findBudget = (id) => {
  const b = db.budgets.find((x) => x.id === id);
  if (!b) throw new ApiError(404, 'NOT_FOUND', 'Anggaran tidak ditemukan.');
  return b;
};

route('PATCH', '/api/v1/budgets/:id', ({ params, body }) => {
  const b = findBudget(params[0]);
  if (body.limit_amount !== undefined) b.limit_amount = parseAmount(body.limit_amount);
  if (body.paused !== undefined) b.paused = Boolean(body.paused);
  b.updated_at = stamp();
  persist();
  emit('budget.changed');
  return { budget: budgetView(b) };
});

route('DELETE', '/api/v1/budgets/:id', ({ params }) => {
  const b = findBudget(params[0]);
  db.budgets = db.budgets.filter((x) => x.id !== b.id);
  persist();
  emit('budget.changed');
  return { id: b.id, deleted: true };
});

// Sinyal dari proses bot: dipakai halaman Pengaturan untuk status koneksi yang sebenarnya.
route('POST', '/api/v1/bot/heartbeat', ({ body, isBot }) => {
  if (!isBot) throw new ApiError(401, 'UNAUTHORIZED', 'Kunci bot tidak valid.');
  const now = stamp();
  const ms = Date.now();
  if (body.ok === false) {
    db.bot.last_error_at = now;
    db.bot.error_ms = ms;
    db.bot.last_error = clean(body.error, 200, 'error') || 'Kesalahan tidak dirinci.';
  } else {
    db.bot.last_ok_at = now;
    db.bot.ok_ms = ms;
  }
  persist();
  emit('bot.status');
  return { ok: true };
});

function telegramState() {
  const b = db.bot;
  if (!b.last_ok_at && !b.last_error_at) {
    return { state: 'Belum terhubung', detail: 'Bot belum pernah mengirim sinyal ke layanan lokal.' };
  }
  const okMs = b.ok_ms ?? (b.last_ok_at ? Date.parse(b.last_ok_at) : 0);
  const errMs = b.error_ms ?? (b.last_error_at ? Date.parse(b.last_error_at) : 0);
  if (errMs > okMs) return { state: 'Perlu tindakan', detail: b.last_error };
  if (Date.now() - okMs > 120000) return { state: 'Terputus', detail: 'Sinyal terakhir dari bot sudah lebih dari 2 menit lalu.' };
  return { state: 'Terhubung', detail: null };
}

const maskId = (id) => (id.length <= 3 ? '•••' : '•'.repeat(id.length - 3) + id.slice(-3));

route('GET', '/api/v1/settings', () => {
  const size = fs.existsSync(DATA_FILE) ? fs.statSync(DATA_FILE).size : 0;
  return {
    telegram: {
      ...telegramState(),
      last_ok_at: db.bot.last_ok_at,
      last_error_at: db.bot.last_error_at,
      allowed_user_ids: ALLOWED_IDS.map(maskId),
      key_configured: Boolean(BOT_KEY),
    },
    storage: {
      file: path.relative(ROOT, DATA_FILE) || path.basename(DATA_FILE),
      size_bytes: size,
      transactions: db.transactions.filter(isActive).length,
    },
    app: { version: VERSION, timezone: 'Asia/Jakarta', currency: 'IDR', host: HOST },
  };
});

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function sendCsv(res) {
  const rows = [['id', 'waktu', 'jenis', 'jumlah_idr', 'kategori', 'deskripsi', 'sumber']];
  for (const t of db.transactions.filter(isActive).sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1))) {
    const c = t.category_id ? catById(t.category_id) : null;
    rows.push([t.id, t.occurred_at, t.type === 'income' ? 'pemasukan' : 'pengeluaran', t.amount, c ? c.name : '', t.description || '', t.source]);
  }
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': 'attachment; filename="saku-transaksi.csv"',
    'cache-control': 'no-store',
  });
  res.end('﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
};

const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 16384) { reject(new ApiError(413, 'TOO_LARGE', 'Permintaan terlalu besar.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('x');
        resolve(v);
      } catch {
        reject(new ApiError(400, 'INVALID_JSON', 'Isi permintaan bukan JSON yang valid.'));
      }
    });
    req.on('error', reject);
  });
}

const hostOk = (host) => {
  const name = (host || '').replace(/:\d+$/, '').toLowerCase();
  return ['localhost', '127.0.0.1', '[::1]', HOST.toLowerCase()].includes(name);
};

function botKeyOk(req) {
  const given = req.headers['x-saku-key'];
  if (!BOT_KEY || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(BOT_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function serveStatic(req, res, pathname) {
  // '/' menyajikan landing page; dashboard ada di '/dashboard'.
  const rel = pathname === '/' ? '/index.html' : pathname === '/dashboard' || pathname === '/dashboard/' ? '/dashboard.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY });
    return res.end('Tidak ditemukan');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', ...SECURITY });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostOk(req.headers.host)) throw new ApiError(403, 'FORBIDDEN', 'Host tidak diizinkan.');
    const url = new URL(req.url, 'http://local');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Metode tidak didukung.');
      return serveStatic(req, res, decodeURIComponent(url.pathname));
    }
    const isBot = botKeyOk(req);
    if (req.method !== 'GET' && !isBot) {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw new ApiError(403, 'FORBIDDEN', 'Asal permintaan tidak diizinkan.');
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', ...SECURITY });
      res.write(': terhubung\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/export/transactions.csv') return sendCsv(res);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const body = req.method === 'GET' ? {} : await readBody(req);
      const out = await r.handler({ req, q: url.searchParams, params: m.slice(1), body, isBot });
      if (out && out.status && out.json) return sendJson(res, out.status, out.json);
      return sendJson(res, 200, out);
    }
    throw new ApiError(404, 'NOT_FOUND', 'Endpoint tidak ditemukan.');
  } catch (e) {
    if (e instanceof ApiError) {
      return sendJson(res, e.status, { error: { code: e.code, message: e.message, ...(e.field ? { field: e.field } : {}) } });
    }
    console.error('Kesalahan internal:', e && e.code ? e.code : 'UNKNOWN');
    return sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Terjadi kesalahan di layanan lokal.' } });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Saku berjalan di http://${HOST}:${PORT} (dashboard di /dashboard)`);
  if (!BOT_KEY) console.log('SAKU_BOT_KEY belum diisi: bot belum bisa menulis transaksi.');
});

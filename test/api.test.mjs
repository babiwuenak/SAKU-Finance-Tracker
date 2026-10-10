import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8300 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const KEY = 'kunci-uji';
let proc;
let dir;
let cats;

const call = async (p, { method = 'GET', body, bot } = {}) => {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(bot ? { 'x-saku-key': KEY } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
};
const catId = (name, type) => cats.find((c) => c.name === name && c.type === type).id;
const MONTH = { from: '2026-10-01', to: '2026-10-31' };
const summary = async () => (await call(`/dashboard/summary?from=${MONTH.from}&to=${MONTH.to}`)).json;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'saku-'));
  proc = spawn('node', ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, APP_PORT: String(PORT), DATA_FILE: path.join(dir, 'uji.json'), SAKU_BOT_KEY: KEY, TELEGRAM_ALLOWED_USER_IDS: '111' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i += 1) {
    try { await fetch(BASE + '/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  cats = (await call('/categories')).json.items;
});

after(() => {
  proc.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('transaksi dari bot idempoten: update_id yang sama tidak membuat baris kedua', async () => {
  const body = { type: 'expense', amount: 28000, category_name: 'makanan & minuman', occurred_at: '2026-10-09T10:42', telegram_update_id: 7, telegram_user_id: 111 };
  const a = await call('/transactions', { method: 'POST', body, bot: true });
  const b = await call('/transactions', { method: 'POST', body, bot: true });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.json.duplicate, true);
  assert.equal(a.json.transaction.id, b.json.transaction.id);
  assert.equal(a.json.transaction.source, 'telegram');
  assert.equal((await summary()).expense, 28000);
});

test('sumber ditentukan server dan ID Telegram di luar daftar ditolak', async () => {
  const body = { type: 'expense', amount: 1000, category_name: 'Lainnya', source: 'telegram', telegram_update_id: 8, telegram_user_id: 999 };
  assert.equal((await call('/transactions', { method: 'POST', body, bot: true })).status, 403);
  const fromBrowser = await call('/transactions', { method: 'POST', body: { type: 'expense', amount: 1000, category_id: catId('Lainnya', 'expense'), source: 'telegram', occurred_at: '2026-10-09T08:00' } });
  assert.equal(fromBrowser.json.transaction.source, 'dashboard');
});

test('kunci idempotensi dari browser mencegah kirim ganda', async () => {
  const body = { type: 'income', amount: '2.500.000', category_id: catId('Gaji', 'income'), occurred_at: '2026-10-01T08:00', idempotency_key: 'k-1' };
  const a = await call('/transactions', { method: 'POST', body });
  const b = await call('/transactions', { method: 'POST', body });
  assert.equal(a.json.transaction.id, b.json.transaction.id);
  assert.equal(a.json.transaction.amount, 2500000);
  assert.equal((await summary()).income, 2500000);
});

test('validasi: jumlah nol, kategori kosong, jenis kategori tidak cocok', async () => {
  const cat = catId('Transportasi', 'expense');
  assert.equal((await call('/transactions', { method: 'POST', body: { type: 'expense', amount: 0, category_id: cat } })).json.error.field, 'amount');
  assert.equal((await call('/transactions', { method: 'POST', body: { type: 'expense', amount: 5000 } })).json.error.code, 'CATEGORY_REQUIRED');
  assert.equal((await call('/transactions', { method: 'POST', body: { type: 'income', amount: 5000, category_id: cat } })).json.error.field, 'category_id');
  assert.equal((await call('/transactions', { method: 'POST', body: { type: 'expense', amount: '12.5', category_id: cat } })).status, 400);
});

test('CRUD: ubah record yang sama, hapus, pulihkan, dan total ikut dihitung ulang', async () => {
  const created = await call('/transactions', { method: 'POST', body: { type: 'expense', amount: 10000, category_id: catId('Hiburan', 'expense'), occurred_at: '2026-10-15T20:00', description: 'Bioskop' } });
  const id = created.json.transaction.id;
  const before = (await summary()).expense;
  const patched = await call(`/transactions/${id}`, { method: 'PATCH', body: { amount: 35000 } });
  assert.equal(patched.json.transaction.id, id);
  assert.equal((await summary()).expense, before + 25000);
  assert.equal((await call(`/transactions/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await summary()).expense, before - 10000);
  assert.equal((await call(`/transactions/${id}`)).status, 404);
  await call(`/transactions/${id}/restore`, { method: 'POST' });
  assert.equal((await summary()).expense, before + 25000);
});

test('filter dan pencarian mengembalikan hitungan yang cocok dengan data', async () => {
  const q = await call('/transactions?q=bioskop');
  assert.equal(q.json.total, 1);
  const byType = await call('/transactions?type=income&from=2026-10-01&to=2026-10-31');
  assert.equal(byType.json.total, 1);
  const byAmount = await call('/transactions?q=2500000');
  assert.equal(byAmount.json.total, 1);
  assert.equal((await call('/transactions?from=2026-10-31&to=2026-10-01')).status, 400);
});

test('kategori: nama ganda ditolak dan arsip tidak menghapus transaksi lama', async () => {
  assert.equal((await call('/categories', { method: 'POST', body: { name: 'hiburan', type: 'expense' } })).status, 409);
  const id = catId('Hiburan', 'expense');
  await call(`/categories/${id}`, { method: 'PATCH', body: { is_archived: true } });
  const list = await call('/transactions?q=bioskop');
  assert.equal(list.json.items[0].category_name, 'Hiburan');
  assert.equal(list.json.items[0].category_archived, true);
  const blocked = await call('/transactions', { method: 'POST', body: { type: 'expense', amount: 1000, category_id: id, occurred_at: '2026-10-16T10:00' } });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.json.error.field, 'category_id');
});

test('anggaran dihitung dari transaksi periode itu', async () => {
  const c = catId('Makanan & Minuman', 'expense');
  const b = await call('/budgets', { method: 'POST', body: { month: '2026-10', category_id: c, limit_amount: 56000 } });
  assert.equal(b.json.budget.spent, 28000);
  assert.equal(b.json.budget.percent, 50);
  assert.equal((await call('/budgets', { method: 'POST', body: { month: '2026-10', category_id: c, limit_amount: 1000 } })).status, 409);
});

test('host asing, origin asing, dan kunci bot salah ditolak', async () => {
  const bad = await fetch(BASE + '/transactions', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' });
  assert.equal(bad.status, 403);
  const hb = await call('/bot/heartbeat', { method: 'POST', body: { ok: true } });
  assert.equal(hb.status, 401);
});

test('status Telegram: kesalahan setelah sinyal ok dalam detik yang sama tetap menang', async () => {
  await call('/bot/heartbeat', { method: 'POST', body: { ok: true }, bot: true });
  await call('/bot/heartbeat', { method: 'POST', body: { ok: false, error: 'Conflict' }, bot: true });
  const s = (await call('/settings')).json.telegram;
  assert.equal(s.state, 'Perlu tindakan');
  assert.equal(JSON.stringify(s).includes(KEY), false);
});

test('GET / menyajikan landing page dan /dashboard menyajikan dashboard', async () => {
  const root = `http://127.0.0.1:${PORT}`;
  const land = await fetch(root + '/');
  const landHtml = await land.text();
  assert.equal(land.status, 200);
  assert.match(landHtml, /Keuangan lebih tertata/);
  for (const p of ['/dashboard', '/dashboard/']) {
    const r = await fetch(root + p);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /app\.js/);
  }
  assert.equal((await fetch(root + '/landing.css')).status, 200);
  assert.equal((await fetch(root + '/landing.js')).status, 200);
});

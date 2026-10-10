import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAmount, normalizeOccurredAt, summarize, cashflow, categoryBreakdown,
  previousRange, budgetProgress, validateRange, ApiError,
} from '../lib.mjs';

const tx = (over) => ({
  id: Math.random().toString(36).slice(2), type: 'expense', amount: 1000, category_id: 'a',
  occurred_at: '2026-10-09T10:00:00+07:00', deleted_at: null, ...over,
});

test('parseAmount menormalkan format Indonesia dan menolak yang ambigu', () => {
  assert.equal(parseAmount('25000'), 25000);
  assert.equal(parseAmount('25.000'), 25000);
  assert.equal(parseAmount('25,000'), 25000);
  assert.equal(parseAmount('Rp 2.500.000'), 2500000);
  assert.equal(parseAmount(28000), 28000);
  for (const v of ['0', 0, -5, '-5', '12.5', '1.5e3', 'abc', '', NaN, Infinity, 1.5, null, undefined, 1e15]) {
    assert.throws(() => parseAmount(v), ApiError, `harus ditolak: ${String(v)}`);
  }
});

test('normalizeOccurredAt memakai Asia/Jakarta dan tidak menggeser hari di dekat tengah malam', () => {
  assert.equal(normalizeOccurredAt('2026-10-09T23:59'), '2026-10-09T23:59:00+07:00');
  assert.equal(normalizeOccurredAt('2026-10-09T17:30:00Z'), '2026-10-10T00:30:00+07:00');
  assert.throws(() => normalizeOccurredAt('kemarin'), ApiError);
  assert.throws(() => normalizeOccurredAt('1999-01-01T00:00'), ApiError);
});

test('summarize memisahkan pemasukan dan pengeluaran, mengabaikan yang dihapus dan di luar periode', () => {
  const list = [
    tx({ type: 'income', amount: 2500000 }),
    tx({ amount: 28000 }),
    tx({ amount: 5000, deleted_at: '2026-10-09T11:00:00+07:00' }),
    tx({ amount: 9999, occurred_at: '2026-09-30T23:59:00+07:00' }),
  ];
  assert.deepEqual(summarize(list, '2026-10-01', '2026-10-31'), { income: 2500000, expense: 28000, net: 2472000, count: 2 });
});

test('cashflow menghasilkan bucket harian lengkap dan mingguan untuk rentang panjang', () => {
  const list = [tx({ amount: 100 }), tx({ type: 'income', amount: 300, occurred_at: '2026-10-10T08:00:00+07:00' })];
  const c = cashflow(list, '2026-10-01', '2026-10-31');
  assert.equal(c.granularity, 'day');
  assert.equal(c.buckets.length, 31);
  assert.equal(c.buckets.find((b) => b.key === '2026-10-09').expense, 100);
  assert.equal(c.buckets.find((b) => b.key === '2026-10-10').income, 300);
  const w = cashflow(list, '2026-08-01', '2026-10-31');
  assert.equal(w.granularity, 'week');
  assert.equal(w.buckets.reduce((s, b) => s + b.expense, 0), 100);
  const m = cashflow(list, '2026-01-01', '2026-10-31');
  assert.equal(m.granularity, 'month');
  assert.equal(m.buckets.length, 10);
});

test('categoryBreakdown mengurutkan dari yang terbesar dan menghitung porsi', () => {
  const cats = [{ id: 'a', name: 'Makan' }, { id: 'b', name: 'Transport' }];
  const r = categoryBreakdown([tx({ amount: 300 }), tx({ category_id: 'b', amount: 100 }), tx({ type: 'income', amount: 9999 })], cats, '2026-10-01', '2026-10-31');
  assert.equal(r.total, 400);
  assert.deepEqual(r.items.map((i) => [i.name, i.amount, i.share]), [['Makan', 300, 75], ['Transport', 100, 25]]);
});

test('previousRange: bulan kalender penuh mundur ke bulan sebelumnya', () => {
  assert.deepEqual(previousRange('2026-10-01', '2026-10-31'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(previousRange('2026-03-01', '2026-03-31'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(previousRange('2026-10-10', '2026-10-16'), { from: '2026-10-03', to: '2026-10-09' });
});

test('budgetProgress menghitung dari pengeluaran nyata pada bulan anggaran', () => {
  const list = [tx({ amount: 400 }), tx({ category_id: 'b', amount: 200 }), tx({ amount: 50, occurred_at: '2026-09-30T10:00:00+07:00' })];
  assert.deepEqual(budgetProgress(list, { month: '2026-10', category_id: 'a', limit_amount: 500 }), { spent: 400, remaining: 100, percent: 80 });
  assert.deepEqual(budgetProgress(list, { month: '2026-10', category_id: null, limit_amount: 500 }), { spent: 600, remaining: -100, percent: 120 });
});

test('validateRange menolak rentang tidak valid', () => {
  assert.throws(() => validateRange('2026-10-31', '2026-10-01'), ApiError);
  assert.throws(() => validateRange('2026-02-30', '2026-03-01'), ApiError);
  assert.throws(() => validateRange('2020-01-01', '2026-10-01'), ApiError);
});

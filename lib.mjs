// Logika uang dan tanggal yang dipakai bersama oleh API, ekspor, dan ringkasan bot.
// Semua tanggal dinormalisasi ke Asia/Jakarta (UTC+7, tanpa DST), sehingga
// tanggal hari = 10 karakter pertama dari occurred_at.

export const TZ_OFFSET_MS = 7 * 3600 * 1000;
const DAY_MS = 86400000;

export class ApiError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

const bad = (message, field, code = 'VALIDATION_ERROR') => new ApiError(400, code, message, field);

// Jumlah selalu bilangan bulat rupiah. "25.000" dan "25,000" dibaca sebagai 25000.
export function parseAmount(v) {
  let n;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || !Number.isInteger(v)) throw bad('Jumlah harus berupa rupiah bulat, tanpa desimal.', 'amount');
    n = v;
  } else if (typeof v === 'string') {
    const s = v.trim().replace(/^rp\.?\s*/i, '').replace(/\s+/g, '');
    if (/^\d+$/.test(s)) n = Number(s);
    else if (/^\d{1,3}([.,]\d{3})+$/.test(s)) n = Number(s.replace(/[.,]/g, ''));
    else throw bad('Format jumlah tidak dikenali. Contoh: 25000 atau 25.000.', 'amount');
  } else {
    throw bad('Jumlah wajib diisi.', 'amount');
  }
  if (!Number.isSafeInteger(n) || n <= 0) throw bad('Jumlah transaksi harus lebih dari nol.', 'amount');
  if (n > 999_999_999_999) throw bad('Jumlah terlalu besar.', 'amount');
  return n;
}

export function toJakartaIso(ms) {
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 19) + '+07:00';
}

export function nowJakartaIso() {
  return toJakartaIso(Date.now());
}

// Waktu tanpa offset dianggap waktu lokal Jakarta.
export function normalizeOccurredAt(v) {
  if (v == null || v === '') return nowJakartaIso();
  if (typeof v !== 'string') throw bad('Tanggal tidak valid.', 'occurred_at');
  let s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) s += ':00+07:00';
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) s += '+07:00';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s)) {
    throw bad('Tanggal tidak valid.', 'occurred_at');
  }
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw bad('Tanggal tidak valid.', 'occurred_at');
  const year = new Date(ms + TZ_OFFSET_MS).getUTCFullYear();
  if (year < 2000 || year > 2100) throw bad('Tanggal di luar rentang yang didukung.', 'occurred_at');
  return toJakartaIso(ms);
}

export function isDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS) + 1;
}

export function validateRange(from, to) {
  if (!isDateStr(from)) throw bad('Tanggal awal tidak valid.', 'from');
  if (!isDateStr(to)) throw bad('Tanggal akhir tidak valid.', 'to');
  if (from > to) throw bad('Tanggal awal tidak boleh setelah tanggal akhir.', 'from');
  const days = daysBetween(from, to);
  if (days > 800) throw bad('Rentang maksimal sekitar 800 hari.', 'to');
  return { from, to, days };
}

export function lastDayOfMonth(dateStr) {
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(5, 7));
  return `${dateStr.slice(0, 8)}${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

export function previousRange(from, to) {
  const prevTo = addDays(from, -1);
  if (from.slice(8) === '01' && to === lastDayOfMonth(from)) {
    return { from: prevTo.slice(0, 8) + '01', to: prevTo };
  }
  const days = daysBetween(from, to);
  return { from: addDays(prevTo, -(days - 1)), to: prevTo };
}

export const isActive = (t) => !t.deleted_at;
export const dayOf = (t) => t.occurred_at.slice(0, 10);
export const inRange = (t, from, to) => {
  const d = dayOf(t);
  return d >= from && d <= to;
};

// Satu-satunya tempat total dihitung: dashboard, bot, anggaran, dan ekspor memakainya.
export function summarize(txs, from, to) {
  let income = 0;
  let expense = 0;
  let count = 0;
  for (const t of txs) {
    if (!isActive(t) || !inRange(t, from, to)) continue;
    count += 1;
    if (t.type === 'income') income += t.amount;
    else if (t.type === 'expense') expense += t.amount;
  }
  return { income, expense, net: income - expense, count };
}

function weekStart(day) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function granularityFor(days) {
  if (days <= 31) return 'day';
  if (days <= 140) return 'week';
  return 'month';
}

export function cashflow(txs, from, to) {
  const { days } = validateRange(from, to);
  const granularity = granularityFor(days);
  const keyOf = (day) =>
    granularity === 'day' ? day : granularity === 'week' ? weekStart(day) : day.slice(0, 7);
  const buckets = new Map();
  for (let i = 0; i < days; i += 1) {
    const day = addDays(from, i);
    const key = keyOf(day);
    const b = buckets.get(key);
    if (b) b.to = day;
    else buckets.set(key, { key, from: day, to: day, income: 0, expense: 0 });
  }
  for (const t of txs) {
    if (!isActive(t) || !inRange(t, from, to)) continue;
    const b = buckets.get(keyOf(dayOf(t)));
    if (!b) continue;
    if (t.type === 'income') b.income += t.amount;
    else if (t.type === 'expense') b.expense += t.amount;
  }
  return { granularity, buckets: [...buckets.values()] };
}

export function categoryBreakdown(txs, categories, from, to) {
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const sums = new Map();
  let total = 0;
  for (const t of txs) {
    if (!isActive(t) || t.type !== 'expense' || !inRange(t, from, to)) continue;
    const id = t.category_id || null;
    sums.set(id, (sums.get(id) || 0) + t.amount);
    total += t.amount;
  }
  const items = [...sums.entries()]
    .map(([id, amount]) => ({
      category_id: id,
      name: id ? names.get(id) || 'Kategori dihapus' : 'Tanpa kategori',
      amount,
      share: total ? Math.round((amount * 1000) / total) / 10 : 0,
    }))
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'id'));
  return { total, items };
}

export function budgetProgress(txs, budget) {
  const { from, to } = { from: budget.month + '-01', to: lastDayOfMonth(budget.month + '-01') };
  let spent = 0;
  for (const t of txs) {
    if (!isActive(t) || t.type !== 'expense' || !inRange(t, from, to)) continue;
    if (budget.category_id && t.category_id !== budget.category_id) continue;
    spent += t.amount;
  }
  return {
    spent,
    remaining: budget.limit_amount - spent,
    percent: Math.round((spent * 100) / budget.limit_amount),
  };
}

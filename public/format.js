// Format tampilan: rupiah, tanggal Asia/Jakarta, label periode. Perhitungan uang ada di server.

const nf = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
export const rupiah = (n) => 'Rp' + nf.format(Math.abs(n));
export const signedRupiah = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + rupiah(n);
export const typedAmount = (type, n) => (type === 'income' ? '+' : '−') + rupiah(n);
export const typeLabel = (type) => (type === 'income' ? 'Pemasukan' : 'Pengeluaran');

export function compactRupiah(n) {
  const v = Math.abs(n);
  const f = (x) => String(Math.round(x * 10) / 10).replace('.', ',');
  if (v >= 1e9) return f(v / 1e9) + ' M';
  if (v >= 1e6) return f(v / 1e6) + ' jt';
  if (v >= 1e3) return f(v / 1e3) + ' rb';
  return String(v);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Cermin dari parseAmount di server, hanya untuk pratinjau sebelum menyimpan.
export function previewAmount(raw) {
  const s = String(raw ?? '').trim().replace(/^rp\.?\s*/i, '').replace(/\s+/g, '');
  if (!s) return { empty: true };
  let n = null;
  if (/^\d+$/.test(s)) n = Number(s);
  else if (/^\d{1,3}([.,]\d{3})+$/.test(s)) n = Number(s.replace(/[.,]/g, ''));
  if (n === null) return { error: 'Format belum dikenali. Contoh: 25000 atau 25.000.' };
  if (n <= 0) return { error: 'Jumlah harus lebih dari nol.' };
  if (n > 999999999999) return { error: 'Jumlah terlalu besar.' };
  return { value: n };
}

const jakartaNow = () => new Date(Date.now() + 7 * 3600 * 1000);
export const todayJakarta = () => jakartaNow().toISOString().slice(0, 10);
export const nowLocalInput = () => jakartaNow().toISOString().slice(0, 16);

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const DAYS_SHORT = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const parts = (d) => ({ y: Number(d.slice(0, 4)), m: Number(d.slice(5, 7)) - 1, d: Number(d.slice(8, 10)) });

export const monthName = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

export function rangeLabel(from, to) {
  const a = parts(from);
  const b = parts(to);
  if (from === to) return `${a.d} ${MONTHS[a.m]} ${a.y}`;
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${MONTHS[a.m]} ${a.y}`;
  if (a.y === b.y) return `${a.d} ${MONTHS_SHORT[a.m]} – ${b.d} ${MONTHS_SHORT[b.m]} ${a.y}`;
  return `${a.d} ${MONTHS_SHORT[a.m]} ${a.y} – ${b.d} ${MONTHS_SHORT[b.m]} ${b.y}`;
}

export function monthRange(ym) {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}

export const isFullMonth = (p) => {
  const r = monthRange(p.from.slice(0, 7));
  return r.from === p.from && r.to === p.to;
};

export function shiftMonth(ym, delta) {
  const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const daysIn = (p) => Math.round((Date.parse(p.to + 'T00:00:00Z') - Date.parse(p.from + 'T00:00:00Z')) / 86400000) + 1;

// occurred_at sudah dinormalisasi server ke +07:00, jadi bagian teksnya langsung waktu Jakarta.
export function fmtDateTime(iso) {
  const p = parts(iso.slice(0, 10));
  return `${p.d} ${MONTHS_SHORT[p.m]} ${p.y}, ${iso.slice(11, 16).replace(':', '.')}`;
}
export function fmtDateShort(iso) {
  const p = parts(iso.slice(0, 10));
  return `${p.d} ${MONTHS_SHORT[p.m]}`;
}
export function fmtTime(iso) {
  return iso.slice(11, 16).replace(':', '.');
}

export function bucketLabel(gran, b) {
  const a = parts(b.from);
  if (gran === 'day') return String(a.d);
  if (gran === 'week') return `${a.d} ${MONTHS_SHORT[a.m]}`;
  return `${MONTHS_SHORT[a.m]} ${String(a.y).slice(2)}`;
}

export function bucketTitle(gran, b) {
  const a = parts(b.from);
  if (gran === 'day') {
    const dow = DAYS_SHORT[new Date(b.from + 'T12:00:00Z').getUTCDay()];
    return `${dow}, ${a.d} ${MONTHS_SHORT[a.m]} ${a.y}`;
  }
  if (gran === 'week') return rangeLabel(b.from, b.to);
  return monthName(b.from.slice(0, 7));
}

// Grafik arus kas: batang berkelompok (pemasukan dan pengeluaran) per hari, minggu, atau bulan.
// Dibuat sebagai SVG biasa agar warna, label, dan keadaan kosong tetap konsisten dengan sistem desain.
import { compactRupiah, rupiah, bucketLabel, bucketTitle } from './format.js';

function niceMax(v) {
  const raw = v / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((n) => n * mag).find((s) => s >= raw);
  return step * 4;
}

export function drawCashflow(el, data, { animate = false } = {}) {
  const { buckets, granularity } = data;
  const w = Math.max(el.clientWidth || 640, 280);
  const h = w < 520 ? 220 : 264;
  const m = { t: 12, r: 8, b: 30, l: w < 520 ? 46 : 58 };
  const iw = w - m.l - m.r;
  const ih = h - m.t - m.b;
  const peak = Math.max(1, ...buckets.flatMap((b) => [b.income, b.expense]));
  const max = niceMax(peak);
  const gw = iw / buckets.length;
  const bw = Math.max(2, Math.min(18, gw * 0.4));
  const gap = Math.min(3, bw * 0.25);
  const y = (v) => m.t + ih - (v / max) * ih;

  const maxLabels = Math.max(2, Math.floor(iw / (granularity === 'day' ? 26 : 62)));
  const every = Math.ceil(buckets.length / maxLabels);

  let svg = `<svg class="chart${animate ? ' reveal' : ''}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Grafik batang pemasukan dan pengeluaran. Rincian ada di tabel di bawahnya.">`;
  for (let i = 0; i <= 4; i += 1) {
    const v = (max * i) / 4;
    svg += `<line class="grid${i === 0 ? ' base' : ''}" x1="${m.l}" x2="${w - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    svg += `<text class="tick" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${compactRupiah(v)}</text>`;
  }
  buckets.forEach((b, i) => {
    const cx = m.l + gw * i + gw / 2;
    const bar = (v, cls, x) => {
      if (!v) return '';
      const bh = Math.max(1.5, (v / max) * ih);
      return `<rect class="${cls}" x="${x}" y="${m.t + ih - bh}" width="${bw}" height="${bh}" rx="2"/>`;
    };
    svg += `<g>${bar(b.income, 'bar-income', cx - bw - gap / 2)}${bar(b.expense, 'bar-expense', cx + gap / 2)}</g>`;
    if (i % every === 0) svg += `<text class="tick" x="${cx}" y="${h - 8}" text-anchor="middle">${bucketLabel(granularity, b)}</text>`;
    svg += `<rect class="hit" data-i="${i}" x="${m.l + gw * i}" y="${m.t}" width="${gw}" height="${ih}"/>`;
  });
  svg += '</svg>';

  el.innerHTML = `${svg}<div class="chart-tip" role="presentation" hidden></div>`;
  const tip = el.querySelector('.chart-tip');
  const show = (i) => {
    const b = buckets[i];
    tip.innerHTML =
      `<strong>${bucketTitle(granularity, b)}</strong>` +
      `<span>Pemasukan +${rupiah(b.income)}</span><span>Pengeluaran −${rupiah(b.expense)}</span>`;
    tip.hidden = false;
    const cx = m.l + gw * i + gw / 2;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(cx - tw / 2, 0), w - tw)}px`;
  };
  el.querySelectorAll('.hit').forEach((r) => {
    r.addEventListener('pointerenter', () => show(Number(r.dataset.i)));
    r.addEventListener('pointerleave', () => { tip.hidden = true; });
  });
}

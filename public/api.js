// Klien API tipis. Membedakan "layanan tidak merespons" dari kesalahan validasi.

export class ApiFailure extends Error {
  constructor(code, message, field, status) {
    super(message);
    this.code = code;
    this.field = field;
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body, params } = {}) {
  let url = path;
  if (params) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) q.set(k, String(v));
    const s = q.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiFailure('UNREACHABLE', 'Layanan lokal tidak merespons. Pastikan Saku sedang berjalan di komputer ini.');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* badan kosong atau bukan JSON */
  }
  if (!res.ok) {
    const e = data && data.error;
    throw new ApiFailure(e ? e.code : 'HTTP_' + res.status, e ? e.message : 'Permintaan gagal.', e && e.field, res.status);
  }
  return data;
}

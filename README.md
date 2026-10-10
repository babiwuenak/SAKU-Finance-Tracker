# Saku

Pencatatan keuangan pribadi. Catat lewat bot Telegram, lihat ringkasannya di dashboard lokal.
Dashboard dan database berjalan di komputer ini. Pesan Telegram tetap melewati server Telegram.

## Menjalankan

Butuh Node 20 atau lebih baru. Tidak ada dependensi yang perlu dipasang.

1. Salin `.env.example` menjadi `.env`, lalu isi `SAKU_BOT_KEY` (kunci acak panjang buatan sendiri) dan `TELEGRAM_ALLOWED_USER_IDS` (ID numerik Telegram Anda).
2. Jalankan `npm start`.
3. Buka `http://127.0.0.1:8000` untuk halaman pengantar (landing). Dashboard ada di `http://127.0.0.1:8000/dashboard`.
4. Di halaman Pengaturan, periksa status Telegram dan penyimpanan.

Data tersimpan di `data/saku.json` (dibuat otomatis, berisi kategori awal tanpa transaksi). Server hanya mendengarkan `127.0.0.1`.
Tes logika uang dan total: `npm test`.

## Menghubungkan bot Telegram

Saku tidak menjalankan bot. Bot yang sudah ada memanggil API lokal ini, sehingga aturan validasi dan perhitungan hanya ada di satu tempat. Tetap pakai long polling di bot Anda (tidak perlu webhook publik), dan pastikan hanya satu proses yang memegang token bot.

Mencatat transaksi. Header `X-Saku-Key` membuat server menandai sumbernya `telegram` dan memeriksa `telegram_user_id` terhadap daftar yang diizinkan:

```bash
curl -X POST http://127.0.0.1:8000/api/v1/transactions \
  -H "Content-Type: application/json" \
  -H "X-Saku-Key: $SAKU_BOT_KEY" \
  -d '{"type":"expense","amount":"28000","category_name":"Makanan & Minuman","description":"Kopi sore","telegram_update_id":123456,"telegram_user_id":123456789}'
```

- `amount` boleh `28000`, `28.000`, atau `28,000`. Server menormalkan dan menolak yang ambigu.
- `telegram_update_id` menjadi kunci idempotensi. Kiriman ulang dari Telegram mengembalikan transaksi yang sama dengan `"duplicate": true`, bukan baris baru.
- Jika kategori tidak jelas, API membalas `CATEGORY_REQUIRED`. Tanyakan pilihan kategori ke pengguna lewat tombol inline, jangan menebak.
- Bot sebaiknya baru membalas "tersimpan" setelah menerima respons 201 atau 200.
- Daftar kategori: `GET /api/v1/categories`. Ringkasan bulan ini untuk `/ringkasan`: `GET /api/v1/dashboard/summary?from=2026-10-01&to=2026-10-31`. Transaksi terakhir untuk `/terakhir`: `GET /api/v1/transactions?page_size=5`.

Sinyal status, dikirim berkala (misalnya tiap 30 detik) agar halaman Pengaturan menampilkan keadaan nyata:

```bash
curl -X POST http://127.0.0.1:8000/api/v1/bot/heartbeat \
  -H "Content-Type: application/json" -H "X-Saku-Key: $SAKU_BOT_KEY" \
  -d '{"ok":true}'
```

Kirim `{"ok":false,"error":"..."}` saat polling gagal. Status `Terhubung`, `Terputus`, `Perlu tindakan`, atau `Belum terhubung` dihitung dari sinyal ini, bukan ditebak.

Dashboard memperbarui diri lewat Server-Sent Events setelah transaksi tersimpan (biasanya kurang dari 2 detik), dan jatuh ke polling 30 detik bila koneksi SSE terputus.

## Kontrak API

Semua di bawah `/api/v1`: `health`, `dashboard/summary`, `dashboard/cashflow`, `dashboard/categories`, `transactions` (GET, POST), `transactions/{id}` (GET, PATCH, DELETE), `transactions/{id}/restore`, `categories` (GET, POST), `categories/{id}` (PATCH), `budgets` (GET dengan `month`, POST), `budgets/{id}` (PATCH, DELETE), `bot/heartbeat`, `settings`, `events`, `export/transactions.csv`.

Kesalahan berbentuk `{"error":{"code","message","field"}}`. Penghapusan transaksi bersifat soft delete sehingga bisa diurungkan.

## Catatan penyimpanan

Versi awal memakai satu berkas JSON dengan penulisan atomik, cukup untuk satu pengguna. Semua akses data lewat `server.mjs` dan perhitungan lewat `lib.mjs`, jadi berpindah ke SQLite nanti cukup mengganti lapisan penyimpanan di `server.mjs`.

## Keamanan

- API hanya di `127.0.0.1`, menolak header Host dan Origin asing, dan tidak memakai CORS terbuka.
- Token bot Telegram tidak pernah dibaca atau ditampilkan oleh Saku. Kunci `SAKU_BOT_KEY` hanya di `.env`.
- `.env`, `data/`, dan berkas CSV ada di `.gitignore`. CSV hasil ekspor tidak terenkripsi.
- Aplikasi tidak punya login. Siapa pun yang bisa membuka `127.0.0.1:8000` di komputer ini bisa melihat datanya.


---

<p align="center"><sub>Crafted entirely with Claude Sonnet 5.5.</sub></p>

# Query Dune — sumber kebenaran

Ke-12 query yang menopang setiap angka di `docs/`. Disimpan di sini supaya analisisnya
bisa dibangun ulang di akun Dune mana pun, dan supaya angkanya bisa diaudit tanpa
akses ke akun siapa pun.

**Status: migrasi selesai** (2 Agustus 2026). Versi lama di tim `passchick`
(`team_id 65014`) sudah diarsipkan seluruhnya — 1 dashboard + 12 query, terverifikasi
tidak lagi muncul di pencarian. Ke-12 query hidup di `team_id 84849`,
semuanya `is_temp: false` sejak dibuat, bervisualisasi, dan terkumpul di
[dashboard Nokturn](https://dune.com/wngstnrs7119/nocturne-robinhood-chain-equity-settlement-research).

⚠️ **Handle akun masih `wngstnrs7119`, belum `nokturn`.** Kalau handle diubah di
Settings Dune, URL dashboard ikut berubah dan **enam link** di `docs/` harus
disesuaikan (`README.md` ×2, `ide-utama.md` ×3, `parameter.md` ×1). ID query tidak
terpengaruh — URL query tidak memuat handle.

## Peta file

| File | Query lama | Visualisasi |
|---|---|---|
| `01-dex-volume-mix-by-token.sql` | 8194489 | column |
| `02-stock-volume-by-utc-hour.sql` | 8194490 | column (stacked) |
| `03-execution-quality-by-hour.sql` | 8194494 | column |
| `04-stock-token-holder-base.sql` | 8194496 | column (dual axis) |
| `05-usdg-contracts-sanity-check.sql` | 8194507 | table |
| `06-canonical-usdg-holder-base.sql` | 8194509 | column (dual axis) |
| `07-netting-ratio-backtest.sql` | 8194513 | column (group by session) |
| `08-netting-vs-market-share.sql` | 8194516 | line (dual axis) ⭐ |
| `09-netting-quality-self-roundtrips.sql` | 8194523 | counter |
| `10-stock-token-universe.sql` | 8194525 | table |
| `11-stylus-activity-crosscheck.sql` | 8194528 | table |
| `12-stylus-program-addresses.sql` | 8194531 | table |

Detail konfigurasi tiap chart ada di komentar kepala masing-masing file `.sql`.

## Urutan dashboard

Lima bagian bernarasi, bukan grid chart:

1. **Netting backtest** — counter (09) + line (08) berdampingan, lalu column (07) selebar halaman
2. **Sesi & kualitas eksekusi** — 03 dan 02 berdampingan
3. **Ukuran pasar** — 01 selebar halaman, lalu 04 dan 06 berdampingan
4. **Identitas token** — 05 lalu 10, keduanya selebar halaman
5. **Stylus** — 11 lalu 12, keduanya selebar halaman

Teks pembuka menyajikan batasan **lebih dulu**, bukan belakangan. Ini posisi sadar,
bukan kelemahan yang perlu disembunyikan.

## Yang tidak boleh hilang saat membangun ulang

- **Jangan pakai 47,6% di pitch.** Itu mengasumsikan Nokturn memonopoli arus. Pangsa
  awal realistis 10–20% memberi **21–29%**. Kurvanya yang jadi argumen, bukan titiknya.
- **41,3%, bukan 47,6%,** adalah netting dari lawan transaksi yang benar-benar berbeda.
  Counter di dashboard menampilkan angka yang sudah dipotong, bukan yang memuji diri.
- **Kualitas eksekusi adalah proksi** — pergerakan harga log absolut antar-trade
  berurutan. Bukan spread terkuotasi dan tidak boleh disajikan begitu.
- **Perbandingan vs router agregator `0x65050A9B…` bukan trustless.** Tidak bisa
  dikuotasi onchain; itu metrik publikasi offchain dengan metodologi terbuka.
- **Query 04 dan 06 tidak difilter tanggal** — kumulatif, akan naik terus. Bukan
  snapshot Juli 2026.

## Hasil verifikasi 2 Agustus 2026

Dijalankan ulang saat publikasi. Reproduksi persis: netting 47,59% · 41,33% bersih ·
5,33 pedagang/batch · kurva 18,51 → 47,59% · gas aktivasi Stylus 7,73–8,18jt ·
GME penyamar $29,6jt · 0 kontrak `0xEF` vs 3 program Stylus nyata.

Satu drift: **p90 jam terburuk 237,9 → 230,5 bps** (terbaik 69,9 → 69,0), rasio ekor
3,4× → 3,3×. Query-nya ter-scope Juli 2026, jadi kemungkinan besar backfill decoder
`dex.trades`, bukan perubahan pasar. `CLAUDE.md` §6 masih memuat angka lama.

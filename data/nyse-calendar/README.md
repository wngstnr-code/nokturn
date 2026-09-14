# Fixture Kalender NYSE + Batas DST · 2020–2035

> Artefak **data**, dibuat pra-Buildathon. Bukan kode protokol.
> Memenuhi [`docs/rencana-uji.md`](../../docs/rencana-uji.md) §8 (pengujian habis
> di setiap batas kalender) dan [`docs/desain-session-engine.md`](../../docs/desain-session-engine.md)
> §5–6 (tabel DST eksplisit + tabel hari libur & early close).
>
> Dibuat 1 Agustus 2026.

---

## Kenapa ini ada

`desain-session-engine.md` §5 memutuskan: **tabel eksplisit, bukan aturan DST yang
dihitung onchain.** Alasannya — seorang reviewer bisa membandingkan 32 angka dengan
kalender publik dalam lima menit; tidak ada yang bisa memverifikasi implementasi
aturan DST secepat itu.

Dan §1 mencatat enam kesulitan, lima di antaranya bisa membuat protokol salah
bertindak di momen paling mahal. Empat di antaranya diselesaikan file-file ini:
DST, hari libur, early close, dan batas transisi.

`rencana-uji.md` §8 menuntut lebih dari sekadar sampel: **setiap batas kalender
selama 15 tahun** harus diuji, dibandingkan dengan kalender referensi yang
di-commit sebagai fixture. Itu file ini.

---

## Isi

| File | Isi |
|---|---|
| `nyse-sessions.csv` | 5.844 baris — satu per hari kalender 2020–2035. Jenis sesi, offset ET, dan **epoch UTC buka/tutup** |
| `dst-boundaries.csv` | 32 baris — dua per tahun. **Ini yang masuk onchain** sebagai tabel DST |
| `calendar-entries.json` | 188 entri (155 libur + 33 early close) dalam bentuk `CalendarEntry` siap pakai |
| `gen_calendar.py` | Generator, stdlib murni, deterministik, tanpa jaringan. Validasi ikut di dalamnya |

### Ringkasan

| | |
|---|---|
| Rentang | 2020–2035 (16 tahun) |
| Hari dagang | 4.019 |
| Hari libur | 155 |
| **Early close** | **33** |
| Batas DST | 32 |

---

## Validasi

Generator memvalidasi dirinya terhadap **kalender NYSE 2020–2026 yang diketahui
independen** — hari libur **dan** early close — dan menolak jalan kalau ada satu
saja yang meleset. Jalankan ulang kapan pun:

```bash
OUT_DIR=. python3 gen_calendar.py
```

Edge case yang sudah diperiksa manual dan benar:

| Kasus | Hasil |
|---|---|
| Natal 25 Des 2027 = **Sabtu** | Libur digeser ke Jumat 24 Des — dan **bukan** early close |
| Tahun Baru 1 Jan 2028 = **Sabtu** | **Tidak diobservasi sama sekali**; 31 Des 2027 tetap hari dagang |
| Juneteenth 19 Jun 2027 = **Sabtu** | Digeser ke Jumat 18 Jun |
| 4 Juli 2032 = **Minggu** | Digeser ke Senin 5 Jul; Jumat 2 Jul hari dagang penuh |
| Jam buka lintas batas DST 2026 | 6 Mar = **14:30 UTC** → 9 Mar = **13:30 UTC** |

Baris terakhir itu adalah mode kegagalan yang diperingatkan `desain-session-engine.md`
§1 sebagai kesulitan #1: tanpa tabel ini, protokol salah satu jam penuh, dua kali
setahun.

---

## ⚠️ Tiga batasan — baca sebelum memuat apa pun onchain

### 1. Tanggal setelah 2028 diturunkan dari aturan, bukan diumumkan NYSE

NYSE hanya menerbitkan kalender resmi sekitar **tiga tahun ke depan**. Per Agustus
2026, itu berarti resmi sampai ~2028.

Entri 2029–2035 **benar menurut aturan yang berlaku sekarang**, tapi belum
dikonfirmasi bursa. **Pakai untuk fixture uji saja. Jangan muat onchain.**
Konsisten dengan `desain-session-engine.md` §6: isi tabel onchain 2 tahun ke depan,
perbarui lewat time-lock 48 jam.

### 2. Penutupan tak terjadwal tidak bisa diturunkan dari aturan apa pun

Tidak ada rumus yang menghasilkan ini:

| Tanggal | Sebab |
|---|---|
| 9 Jan 2025 | Hari berkabung nasional — pemakaman Jimmy Carter |
| 5 Des 2018 | Hari berkabung nasional — pemakaman George H. W. Bush |
| 29–30 Okt 2012 | Badai Sandy |

Terdaftar di `calendar-entries.json` pada `unscheduled_closures_not_derivable`.
Semuanya **wajib dimasukkan manual lewat time-lock** saat diumumkan.

Konsekuensi desain yang harus diakui: kalender onchain bisa **salah** pada hari
seperti ini sampai owner memperbaruinya. Di situlah `PROTECTIVE` bekerja — kalender
bilang `OPEN` tapi feed diam sepanjang hari adalah **bukti yang bertentangan**,
dan aturan fail-safe `desain-session-engine.md` §2.2 berlaku. Fixture ini memperkuat
lapisan kalender; ia tidak menggantikan lapisan bukti.

### 3. Aturan DST bisa berubah lewat undang-undang

Tabel ini memakai Energy Policy Act 2005 (mulai Minggu ke-2 Maret, berakhir Minggu
ke-1 November). Sunshine Protection Act pernah beberapa kali diajukan di Kongres AS
untuk membuat DST permanen. **Kalau itu lolos, tabelnya harus diganti** — dan
karena ini tabel, penggantiannya satu transaksi time-lock, bukan deploy ulang.

Ini justru alasan tabel mengalahkan logika pintar: perubahan undang-undang jadi
perubahan data.

---

## Cara dipakai saat implementasi

1. `dst-boundaries.csv` → tabel DST onchain, dicari dengan binary search
   (`desain-session-engine.md` §5)
2. `calendar-entries.json`, difilter **≤ 2028**, → `CalendarEntry[]` onchain
   (`kind`: 1 = libur, 2 = early close; `close_time_et_seconds` = 46800 untuk 13:00 ET)
3. `nyse-sessions.csv` → fixture referensi untuk uji habis `sessionAt(t)`:
   setiap batas, plus ±`GUARD_BAND` (60 detik) di sekitarnya

Kolom `open_utc` / `close_utc` sudah epoch UTC — sudah memperhitungkan DST, jadi
bisa langsung dibandingkan dengan `block.timestamp` tanpa konversi zona waktu.

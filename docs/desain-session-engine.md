# Nokturn — Session Engine

> Ini komponen yang membuat seluruh tesis bekerja. Semua mekanisme lain —
> durasi batch, lebar price band, kapan lelang jalan, mode protektif — bergantung
> pada satu pertanyaan: **jam berapa sekarang di dunia nyata?**
>
> Pendamping: `desain-auction.md` · `desain-ekonomi.md` · `spek-teknis.md`

> ⚠️ **Status kompetitif (audit 11 Agustus 2026 — `ide-utama.md` §D1e).**
> **Kesadaran jam bursa bukan hal baru.** Dinari menanganinya di level mint/redeem
> (saham dasar dibeli pada pembukaan berikutnya), Ondo melepas keterikatan jam
> Wall Street pada Juli 2026, dan gTrade serta Ostium sudah lama mengatur leverage
> menjelang penutupan.
>
> Yang belum ada: **parameter eksekusi settlement spot yang berubah per sesi** —
> durasi batch, lebar price band, exposure cap, sumber harga. Yang lain sadar jam
> bursa di lapisan *penerbitan* atau *leverage*, bukan di lapisan *kliring batch*.
>
> Jangan pernah menulis "tidak ada yang tahu jam bursa". Lihat `pitch.md` §2.

---

## 1. Kenapa ini jauh lebih sulit dari kelihatannya

Kelihatannya sepele: "cek apakah sekarang jam bursa". Kenyataannya ada enam
lapisan kesulitan, dan **lima di antaranya bisa membuat protokolnya salah bertindak
di momen paling mahal.**

| # | Kesulitan | Kalau salah |
|---|---|---|
| 1 | **Daylight Saving Time** | Dua kali setahun protokolmu salah satu jam penuh — mengira bursa buka padahal tutup |
| 2 | **Hari libur bursa** | Menjalankan lelang pembukaan pada hari yang tidak ada pembukaannya |
| 3 | **Early close** | Lelang penutupan dijalankan 3 jam setelah bursa benar-benar tutup |
| 4 | **Halt tak terjadwal** | Bertindak seolah pasar normal padahal perdagangan dihentikan |
| 5 | **Drift block timestamp** | Transisi sesi meleset beberapa detik di batas |
| 6 | **Sentralisasi** | Kalau owner bisa mengarang keadaan pasar, seluruh price band jadi bohong |

---

## 2. Prinsip desain

Tiga aturan yang mengikat seluruh komponen ini:

### 2.1 Sesi adalah fungsi murni ⭐

```solidity
function sessionAt(uint64 timestamp) public view returns (Session);
```

Diberikan tabel kalender dan tabel DST, keluarannya **deterministik**. Tidak ada
input owner saat runtime, tidak ada state tersembunyi.

Konsekuensi yang sangat berharga: **fungsi ini bisa dibuktikan benar, bukan
sekadar diuji.** Domainnya terbatas dan bisa dienumerasi — target sempurna untuk
Halmos, dan bisa diuji habis pada setiap batas transisi selama satu dekade.

Ini juga berarti siapa pun bisa memverifikasi sendiri secara offchain bahwa
keadaan sesi yang dipakai protokol memang benar.

### 2.2 Fail safe, bukan fail open

Keadaan tidak diketahui → **perilaku paling konservatif**, bukan paling permisif.

Feed basi saat seharusnya jam buka? Jangan asumsikan pasar buka. Masuk mode
protektif: band diperketat, lelang tidak dijalankan, exposure cap diturunkan.

Aturan ini harus konsisten di seluruh kode, karena kegagalan mode "fail open"
selalu terjadi tepat di momen paling bergejolak.

### 2.3 Kalender bisa diubah, keadaan tidak bisa dikarang

| Yang bisa diubah owner | Yang tidak bisa |
|---|---|
| Tabel hari libur & early close (time-lock 48 jam) | Keadaan sesi saat ini |
| Tabel batas DST (time-lock 48 jam) | Harga referensi |
| Parameter per sesi, dalam rentang keras (time-lock) | Hasil kliring |

Time-lock 48 jam memastikan tidak ada yang bisa menyisipkan "hari libur palsu"
mendadak untuk memanipulasi perilaku protokol. Perubahan kalender selalu terlihat
jauh sebelum berlaku.

---

## 3. Keadaan sesi

```solidity
enum Session {
    CLOSED_OVERNIGHT,   // hari kerja, di luar pre/post market
    PRE_MARKET,         // 04:00 – 09:30 ET
    AUCTION_OPEN,       // jendela lelang pembukaan Nokturn
    OPEN,               // 09:30 – 16:00 ET (atau 13:00 saat early close)
    AUCTION_CLOSE,      // jendela lelang penutupan Nokturn
    POST_MARKET,        // 16:00 – 20:00 ET
    CLOSED_WEEKEND,
    HOLIDAY,
    PROTECTIVE          // halt / oracle tidak dapat dipercaya / keadaan tak dikenal
}
```

`PROTECTIVE` bukan keadaan waktu — ia **menimpa** keadaan waktu apa pun ketika
bukti oracle bertentangan dengan kalender.

---

## 4. Parameter per sesi

Inilah yang membuat "struktur pasar berubah mengikuti keadaan pasar" jadi konkret:

| Sesi | Durasi batch | Price band | Lelang | Exposure cap |
|---|---|---|---|---|
| `OPEN` | 10 dtk / pass-through | Paling sempit (~30 bps) | — | Penuh |
| `PRE_MARKET` | 30 dtk | Sedang (~60 bps) | — | Sedang |
| `POST_MARKET` | 30 dtk | Sedang (~60 bps) | — | Sedang |
| `CLOSED_OVERNIGHT` | 30–60 dtk | Lebar (~100 bps) | — | Sedang |
| `CLOSED_WEEKEND` | 120 dtk | Paling lebar (~150 bps) | — | Diturunkan |
| `AUCTION_OPEN` | fase lelang | Collar + perpanjangan | ✅ | Khusus |
| `AUCTION_CLOSE` | fase lelang | Collar + perpanjangan | ✅ | Khusus |
| `HOLIDAY` | 120 dtk | Paling lebar | — | Diturunkan |
| `PROTECTIVE` | Diperpanjang | Paling ketat | ❌ **tidak pernah** | Minimum |

Logikanya konsisten: **semakin tidak pasti harga wajarnya, semakin lebar band
yang diizinkan tapi semakin kecil eksposur yang diterima.** Melebarkan band tanpa
menurunkan cap adalah kesalahan desain — itu justru memperbesar kerugian maksimum
tepat saat ketidakpastian paling tinggi.

---

## 5. Menangani DST dengan benar

Jam bursa AS didefinisikan dalam **Eastern Time**, yang bergeser antara EST
(UTC−5) dan EDT (UTC−4). Transisinya: **Minggu kedua Maret** dan **Minggu pertama
November**, pukul 02:00 lokal.

### Dua pendekatan

| Pendekatan | Penilaian |
|---|---|
| Hitung aturan DST onchain (Minggu kedua Maret, dst.) | Elegan, tapi logika kalender penuh jebakan. Salah sedikit = salah satu jam, dua kali setahun |
| **Tabel batas transisi UTC, dicari dengan binary search** ✅ | ~2 entri/tahun. Sepuluh tahun = 20 entri. **Bisa diaudit dengan mata**, murah, dan mustahil salah secara halus |

**Rekomendasi: tabel.** Ini kasus di mana data eksplisit mengalahkan logika pintar.
Seorang reviewer bisa membandingkan 20 angka itu dengan kalender publik dalam lima
menit. Tidak ada yang bisa memverifikasi implementasi aturan DST secepat itu.

> ✅ **Tabelnya sudah dibuat:** [`data/nyse-calendar/dst-boundaries.csv`](../data/nyse-calendar/dst-boundaries.csv)
> — 32 batas, 2020–2035, dalam epoch UTC.
>
> Contoh dampaknya kalau tabel ini salah: jam buka NYSE bergeser dari **14:30 UTC**
> (6 Mar 2026, EST) ke **13:30 UTC** (9 Mar 2026, EDT). Satu jam penuh, dua kali
> setahun, tepat di sesi yang harganya paling pasti.
>
> ⚠️ Tabel ini memakai Energy Policy Act 2005. **Sunshine Protection Act** pernah
> beberapa kali diajukan untuk membuat DST permanen — kalau lolos, tabelnya diganti
> lewat satu transaksi time-lock. Justru itu alasan tabel mengalahkan logika:
> perubahan undang-undang jadi perubahan data, bukan perubahan kode.

---

## 6. Hari libur & early close

Hari libur NYSE **tidak bisa diturunkan dari rumus.** Good Friday bergantung pada
tanggal Paskah — menghitungnya onchain adalah ide buruk.

```solidity
struct CalendarEntry {
    uint32 date;        // hari sejak epoch
    uint8  kind;        // 0 = normal, 1 = holiday, 2 = early close
    uint32 closeTime;   // detik sejak tengah malam ET (early close = 13:00)
}
```

**Early close sering terlupakan dan konsekuensinya nyata.** Ada beberapa hari
setiap tahun ketika bursa tutup pukul 13:00 ET — sehari setelah Thanksgiving,
Malam Natal, 3 Juli. Kalau lelang penutupanmu tetap dijadwalkan pukul 16:00,
kamu menjalankan lelang tiga jam setelah pasar sungguhan tutup, dengan harga
referensi yang sudah beku. Itu bukan bug kecil — itu lelang yang menghasilkan
closing print palsu, yang lalu dikonsumsi protokol lain.

Tabelnya diisi 2 tahun ke depan sejak awal, diperbarui lewat time-lock.

> ✅ **Sudah dibuat:** [`data/nyse-calendar/calendar-entries.json`](../data/nyse-calendar/calendar-entries.json)
> — 155 hari libur + **33 early close**, 2020–2035, tervalidasi terhadap kalender
> NYSE 2020–2026 yang diketahui independen.
>
> ⚠️ **Muat onchain hanya entri ≤ 2028.** NYSE cuma menerbitkan kalender resmi ~3
> tahun ke depan; sisanya diturunkan dari aturan dan belum dikonfirmasi bursa.

### 6B. Penutupan yang tidak bisa diturunkan dari aturan apa pun ⚠️

Kalender saja tidak cukup. Ada penutupan penuh yang **tidak punya rumus**:

| Tanggal | Sebab |
|---|---|
| 9 Jan 2025 | Hari berkabung nasional — pemakaman Jimmy Carter |
| 5 Des 2018 | Hari berkabung nasional — pemakaman George H. W. Bush |
| 29–30 Okt 2012 | Badai Sandy |

Semuanya diumumkan beberapa hari sebelumnya, jadi **muat lewat time-lock 48 jam**
seperti perubahan kalender lain — jendelanya cukup.

Tapi akui konsekuensinya: **kalender onchain bisa salah** pada hari seperti ini
kalau owner tidak sempat memperbarui. Yang menangkapnya bukan kalender, melainkan
`PROTECTIVE`: kalender bilang `OPEN`, feed diam sepanjang hari → **bukti yang
bertentangan** → §2.2 berlaku, masuk mode protektif.

Ini contoh bagus kenapa dua lapisan itu perlu. Kalender adalah lapisan *ekspektasi*;
feed adalah lapisan *bukti*. Yang kedua menangkap kegagalan yang pertama.

---

## 6B. 🔴 Akhir pekan: oracle berganti peran, bukan cuma melebar

**Terverifikasi 1 Agustus 2026:** feed Chainlink **membeku total** di akhir pekan.
`max_gap` hampir setiap feed 173.000–202.000 detik (48–56 jam) — diam dari Jumat
sore sampai Senin.

Ini mengubah desain, bukan hanya parameter.

| Sesi | Chainlink | TWAP UniV3 | Cek ketidaksepakatan |
|---|---|---|---|
| `OPEN` / `PRE` / `POST` | Referensi harga wajar | Pembanding | ✅ 50 bps |
| `CLOSED_OVERNIGHT` | Referensi (masih update) | Pembanding | ✅ 150 bps |
| **`CLOSED_WEEKEND` / `HOLIDAY`** | **Jangkar penutupan Jumat** | **Sumber harga utama** | ❌ **Nonaktif** — diganti `WEEKEND_DRIFT_CAP_BPS` **1.500 bps** terhadap penutupan Jumat |

**Kenapa ini wajib.** Kalau cek ketidaksepakatan dibiarkan aktif di akhir pekan,
Chainlink yang beku di harga Jumat akan selalu berselisih dengan TWAP yang hidup
mengikuti pasar. Selisih 50 bps pasti terlampaui → **semua token masuk `PROTECTIVE`
sepanjang akhir pekan**, yaitu justru sesi yang paling ingin kita layani.

**Prinsip yang berlaku umum:** `PROTECTIVE` dipicu ketika bukti **bertentangan**.
Feed yang beku sesuai jadwal bursa **bukan** bukti yang bertentangan — itu perilaku
yang diharapkan. Membedakan "diam karena rusak" dari "diam karena bursa tutup"
adalah pekerjaan Session Engine, dan hanya bisa dilakukan kalau ia tahu kalender.

---

## 7. Halt yang tidak terjadwal

Ini satu-satunya bagian yang **tidak bisa diselesaikan kalender**. Halt LULD,
halt karena berita, dan circuit breaker seluruh pasar sifatnya mendadak dan
sering **per-simbol**, bukan per-pasar.

### Deteksi berlapis

```
1. Kalau feed oracle menyediakan flag status pasar → pakai itu (paling andal)

2. Kalau tidak, gunakan heuristik:
   feed belum update > STALENESS_OPEN[feed]     ← per-feed, parameter.md §7.1
   PADAHAL kalender bilang OPEN
     → simbol itu masuk PROTECTIVE

3. Deviasi harga ekstrem antar-update
     → PROTECTIVE, tunggu konfirmasi
```

**Penting: `PROTECTIVE` berlaku per-token, bukan per-chain.** NVDA bisa di-halt
sementara SPY berdagang normal. Menghentikan seluruh protokol karena satu simbol
di-halt adalah kesalahan desain yang akan menyakitkan di hari yang sibuk.

Pemulihan tidak boleh instan: butuh **N update feed berturut-turut yang sehat**
sebelum keluar dari `PROTECTIVE`. Ini mencegah osilasi bolak-balik saat feed
tersendat.

---

## 8. Drift timestamp dan guard band di batas

Detail praktis yang mudah terlewat.

`block.timestamp` di Arbitrum Orbit ditentukan sequencer. Umumnya dekat dengan
waktu nyata, tapi **jangan bergantung pada presisi detik**, terutama di batas sesi.

**Solusi: guard band di sekitar setiap transisi.**

```
GUARD_BAND = 60 detik

Dalam ±60 detik dari batas sesi mana pun:
  · jangan mulai batch baru
  · jangan mulai cross lelang
  · pakai parameter dari sesi yang LEBIH konservatif di antara keduanya
```

Biayanya sepele — dua menit per transisi. Yang dihindari serius: batch yang
setengahnya diselesaikan dengan aturan sesi yang salah, atau lelang pembukaan
yang cross sedetik sebelum harga referensi pembukaan tersedia.

Aturan "pakai yang lebih konservatif" membuat ambiguitas selalu berpihak pada
keamanan, konsisten dengan §2.2.

---

## 9. Daftar edge case yang wajib diuji

Ini daftar yang harus hijau semua sebelum mainnet:

| # | Kasus | Yang benar |
|---|---|---|
| 1 | Transisi DST Maret (jam "hilang") | Sesi berpindah tepat; tidak ada batch yang diselesaikan dengan aturan salah |
| 2 | Transisi DST November (jam "ganda") | Tidak ada perlakuan ganda pada jendela yang sama |
| 3 | Hari libur jatuh Senin | Akumulasi lelang pembukaan diperpanjang ke Selasa |
| 4 | Hari libur jatuh Jumat | Akhir pekan efektif 3 hari, band paling lebar |
| 5 | Early close (13:00 ET) | Lelang penutupan bergeser; closing print tetap valid |
| 6 | Early close **sebelum** hari libur | Kombinasi #4 dan #5 |
| 7 | Halt satu simbol saat OPEN | Hanya simbol itu `PROTECTIVE`; sisanya normal |
| 8 | Circuit breaker seluruh pasar | Semua simbol `PROTECTIVE`; lelang tidak dijalankan |
| 9 | Feed basi 5 menit saat OPEN | Masuk `PROTECTIVE`; keluar hanya setelah N update sehat |
| 10 | Bursa tidak buka padahal kalender bilang buka | Lelang pembukaan tidak cross; escrow dikembalikan penuh |
| 11 | Timestamp tepat di batas sesi | Guard band aktif; aturan konservatif dipakai |
| 12 | Corporate action efektif pagi pembukaan | `uiMultiplier` dibaca sebelum cross |

| 13 | **Penutupan tak terjadwal yang belum masuk tabel** (mis. hari berkabung nasional) | Kalender bilang `OPEN`, feed diam sepanjang hari → `PROTECTIVE`. Lihat §6B |

**Kasus 1–6 seluruhnya deterministik** — bisa diuji habis untuk setiap timestamp
batas selama satu dekade, bukan sekadar disampel. Lakukan itu; hasilnya adalah
klaim yang sangat kuat untuk kriteria *smart contract quality*.

Fixture-nya sudah tersedia: [`data/nyse-calendar/`](../data/nyse-calendar/) —
5.844 hari, 2020–2035, dengan epoch UTC buka/tutup yang sudah memperhitungkan DST.

---

## 10. Kenapa komponen ini layak ditonjolkan ke juri

Semua orang bisa membangun DEX. Yang membedakan Nokturn adalah **ia tahu apa
yang sedang terjadi di dunia nyata**, dan bertindak berbeda karenanya.

Session Engine adalah wujud teknis dari tesis itu. Tiga hal yang bisa kamu
tunjukkan dan sedikit tim lain bisa:

1. **Fungsi murni yang dibuktikan, bukan diuji** — Halmos pada domain penuh
2. **Pengujian habis pada batas kalender satu dekade** — DST, hari libur,
   early close, semuanya, bukan sampel acak
3. **Fail-safe yang konsisten** — setiap ambiguitas berpihak pada keamanan,
   dan itu bisa ditunjukkan baris per baris

Dan satu kalimat yang merangkumnya:

> *Protokol DeFi lain menganggap semua detik sama. Untuk saham, itu salah —
> dan kesalahan itu paling mahal tepat di jam ketika kebanyakan orang berdagang.*

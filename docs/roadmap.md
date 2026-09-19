# Nokturn — Roadmap Pasca-Menang

> **Menang bukan garis akhir; menang adalah saat kewajiban dimulai.** Hadiah
> Buildathon dibayar bertahap dan terikat milestone, jadi 75% dari nilainya baru cair
> setelah pekerjaan yang belum dikerjakan selesai.
>
> Sumber: `hackathon.md` §T&C 6.2 (struktur payout) · `distribusi.md` §7–8 (metrik &
> rencana distribusi) · `desain-ekonomi.md` §6 (jalur pendapatan) ·
> `spek-teknis.md` §9–10 (scope & fase).
>
> ⚠️ **Ini versi INTERNAL.** Roadmap yang ditulis di form submission dan dibaca juri
> ada di `pitch.md` §5b — lebih pendek, tanpa struktur payout, tanpa negosiasi KPI,
> tanpa cabang kalah. Jangan tertukar.
>
> Disusun 12 Agustus 2026 — **sebelum** Buildathon, sengaja. Kalau struktur payout
> baru dibaca setelah menang, keputusan arsitektur sudah telanjur diambil tanpa
> mempertimbangkannya.

---

## 1. Yang sebenarnya dimenangkan

| Tahap | Porsi | Syarat |
|---|---|---|
| Menang + tanda tangan grant agreement | **25%** | Administratif |
| Check-in 1 bulan | **25%** | Bukti kemajuan |
| Mainnet launch + KPI | **50%** | **Setengah hadiah ada di sini** |

Plus: **tiga tim teratas** mendapat tempat di Founder House Singapore — tiga hari
bersama tim teknis Arbitrum, mentor, dan founder ekosistem.

**Founder House adalah hadiah sebenarnya.** Lihat pola di `hackathon.md`: Buildathon
NYC memberi $15rb ke pemenang pertama; Founder House NYC memberi **$100rb** Founder-
in-Residence ke Tilt dan **$50rb** ke Bond.Credit. Founder House London membagi
~$300rb. Selisihnya satu orde besaran.

Dan pola #4: **pemenang berulang**. EqualFi menang dua kali, Tilt menang dua kali.
Jalur yang benar bukan "menang lalu selesai", melainkan **menang lalu muncul lagi
dengan kemajuan yang terlihat**.

---

## 2. Ketegangan yang harus disadari sejak sekarang

> **50% hadiah menuntut mainnet launch. Settlement core Nokturn immutable, tanpa
> proxy (`CLAUDE.md` §2 nomor 6). Deploy yang salah tidak bisa ditambal.**

Ini tarik-menarik nyata antara kecepatan mencairkan tranche terakhir dan disiplin
verifikasi tujuh lapis (`spek-teknis.md` §9.2).

**Keputusannya sudah ada dan tidak berubah:** kedalaman verifikasi bukan variabel
penyesuaian (`CLAUDE.md` §2 nomor 2). Kalau harus memilih antara mainnet cepat dan
mainnet benar, pilih benar dan **negosiasikan ulang jadwal KPI** — bukan sebaliknya.

Karena itu satu hal yang harus dibereskan **di minggu pertama setelah menang**:

> **Sepakati definisi KPI secara tertulis dengan Arbitrum Foundation, sebelum
> menulis baris kode berikutnya.**

Kalau KPI-nya "jumlah pengguna", itu mendorong ke arah yang salah — `distribusi.md`
§7 sudah menetapkan bahwa milestone pertama yang benar **bukan** "10.000 pengguna",
melainkan *price improvement terukur pada batch mainnet nyata dengan pengguna nyata,
konsisten selama dua minggu.* Usulkan itu sebagai KPI. Ia lebih sulit dipalsukan dan
lebih jujur.

---

## 3. Fase 0 — dua minggu pertama (administratif, jangan diremehkan)

| Aksi | Kenapa |
|---|---|
| Tanda tangan grant agreement, cairkan 25% | Membuka runway |
| **Sepakati KPI tertulis** | Lihat §2. Ini yang paling menentukan |
| Audit provenansi ulang pasca-demo | Memotong fitur sering meninggalkan angka yatim (`rencana-uji.md` §11.4) |
| Terbitkan hasil apa adanya | Termasuk yang gagal. Ini posisi proyek, bukan kelemahan |

⚠️ **Jangan** langsung menambah fitur. Godaan terbesar setelah menang adalah
memperluas scope selagi momentum tinggi. Scope v1.0 sudah dikunci
(`spek-teknis.md` §9), dan v1.1 sudah punya isi.

---

## 4. Fase 1 — menuju check-in 1 bulan

Target: **bukti kemajuan yang terlihat**, bukan fitur baru.

1. **Audit keamanan eksternal dimulai.** Settlement core immutable — ini bukan
   opsional dan butuh waktu tunggu. Mulai antre sekarang.
2. **Gerbang CI penuh hijau** (`CLAUDE.md` §8): Slither + Aderyn nol temuan tinggi,
   coverage inti ≥ 95%, mutation ≥ 90%, fork test nol selisih terhadap mainnet.
3. **Benchmark Stylus vs Solidity untuk `ClearingVerifier`** — satu-satunya
   pertanyaan yang masih menentukan arsitektur (`CLAUDE.md` §2 nomor 7). Putuskan
   dari angka aktivasi vs eksekusi, bukan dari tekanan waktu.
4. **Distribusi jalan paralel** (`distribusi.md` §8): percakapan integrasi dengan
   Karma, framework agent, dompet SEA. Bawa datanya, bukan janji.

---

## 5. Fase 2 — mainnet launch + KPI (tranche 50%)

**Urutan yang benar, dan jangan dibalik:**

```
audit selesai  →  deploy allowlist minimal  →  operasi tiap malam
                                            →  ukur  →  terbitkan mingguan
```

**Allowlist peluncuran lima token:** NVDA (jangkar), AAPL, TSLA, GOOGL, GME —
dipilih dari enam syarat yang ditulis lengkap di `parameter.md` §7.4. SPY ditunda
karena feednya harian bukan intraday, SPCX dikecualikan permanen karena tidak punya
feed sama sekali, META masuk v1.1 karena arusnya ada di Uniswap V4.
Keputusan ini lahir dari verifikasi, bukan preferensi — jangan dilonggarkan demi
angka volume yang lebih ramai saat peluncuran.

> 🔴 **Dikoreksi 20 September 2026.** Baris ini sebelumnya menulis empat token dan
> menyebut GME ditunda karena feed. Angka yang menundanya tidak tereproduksi, dan
> GME masuk allowlist 20 September. GOOGL diperiksa ulang lawan keenam syarat di hari
> yang sama dan dipertahankan. Lihat P6-2 di `pertanyaan-terbuka.md`.

**Cara membaca hasilnya:** pakai kurva netting sebagai **diagnostik**, bukan pameran
(`distribusi.md` §7.1). Pada pangsa 10%, netting yang diharapkan 21,0%. Kalau nyata
jatuh jauh di bawah itu, yang salah solver atau durasi batch — bukan pasar.

**Yang diterbitkan tiap minggu:** price improvement vs baseline, rasio netting vs
kurva, batch berhasil vs gagal. **Termasuk minggu yang jelek.** Konsistensi
menerbitkan angka jelek adalah satu-satunya alasan orang percaya angka bagusnya.

---

## 6. Fase 3 — setelah tranche terakhir

Isi v1.1 sudah ditetapkan, bukan dikarang sekarang:

| Item | Status |
|---|---|
| **Adapter Uniswap V4** | Masuk lewat **allowlist time-lock**, bukan deploy ulang. Menunggu perilaku hook fee dinamis `0x800000` dipahami |
| **Ring trade multi-aset** | Di luar scope v1.0 sejak awal |
| **Port Stylus** | Kalau benchmark Fase 1 mendukung. **Menuntut Settlement baru**, karena `verifier` immutable dan tidak ada jalur time-lock yang bisa menukarnya. Bedanya dengan baris adapter di atas harus disebut tiap kali keduanya disebut bersama |
| **Perluasan allowlist** | Lihat di bawah — ini keputusan strategis, bukan teknis |

### 6.1 Keputusan strategis terbesar: kapan keluar dari ekuitas

`desain-ekonomi.md` §6.2 sudah memetakan ini. Stock token cuma **2,88%** volume DEX
chain (Agustus 2026); sisanya ~**$33,9 miliar/bulan** memecoin dan kripto. Netting batch bekerja
sama baiknya untuk mereka, dan kodenya memang tidak mengasumsikan token tertentu.

> Masuk lewat celah yang dikuasai secara unik — eksekusi ekuitas di jam non-bursa —
> lalu perluas ke tempat volumenya berada.

**Tapi jangan buru-buru.** Wedge ekuitas adalah satu-satunya alasan Nokturn punya
cerita yang tidak dimiliki CoW dan UniswapX. Memperluas allowlist terlalu dini
mengubah proyek dari *"settlement yang tahu jam bursa"* menjadi *"CoW nomor sekian"* —
dan yang kedua tidak menang apa pun.

Syarat perluasan yang saya sarankan: **setelah price improvement terbukti konsisten
dua minggu di ekuitas**, bukan sebelumnya.

### 6.2 Pendanaan — jujur soal ini

Protokolnya **belum jadi bisnis** dengan pasar ekuitas onchain hari ini
(`desain-ekonomi.md` §6). Tidak ada token, tidak ada airdrop — keputusan final
(`CLAUDE.md` §2 nomor 3), jangan diusulkan ulang saat runway menipis.

Jalur yang tersisa, berurutan menurut realisme:

1. **Founder House + Founder-in-Residence** — pola menunjukkan ini jauh lebih besar
   dari hadiah Buildathon
2. **Grant ekosistem Arbitrum / dev fund Robinhood** ($1 juta dialokasikan untuk
   ekosistem developer)
3. **Fee protokol** — nyata tapi kecil sampai salah satu dari dua jalur di
   `desain-ekonomi.md` §6 bekerja

---

## 7. Kalau kalah

Ditulis sengaja, karena roadmap yang hanya punya cabang menang adalah rencana yang
belum diuji.

**Yang tidak berubah:** risetnya tetap benar dan sekarang **lebih segar, bukan lebih
usang** — ketiga angka yang sempat kedaluwarsa sudah diukur ulang 10 September 2026
(`parameter.md` §10.3–§10.4), dan pengukurannya justru naik: pemegang > $1k
477 → **804**, nilai dipegang $27,2jt → **$75,62jt**. Dan tiga edisi Open House
menunjukkan **pemenang berulang**. Open House berikutnya ada.

**Yang dikerjakan:**
1. Terbitkan risetnya sebagai barang publik — analisis off-hours, audit kompetitor,
   metodologi netting. `distribusi.md` §8 sudah menempatkan ini sebagai aksi hari
   1–14, dan nilainya tidak bergantung pada menang.
2. Kejar **satu integrasi nyata**. Satu mitra mengalahkan satu piala.
3. Masuk lagi di edisi berikutnya dengan kemajuan yang terlihat — persis pola yang
   membuat EqualFi dan Tilt menang dua kali.

---

## 8. Yang harus diputuskan pemilik proyek, bukan diasumsikan

| Pertanyaan | Kapan |
|---|---|
| KPI tertulis dengan Arbitrum Foundation | Minggu pertama setelah menang |
| Audit eksternal: vendor mana, kapan antre | Fase 1 |
| Stylus atau Solidity untuk `ClearingVerifier` | Setelah benchmark, Fase 1 |
| Kapan allowlist keluar dari ekuitas | Setelah dua minggu price improvement konsisten |
| Berapa lama runway pribadi yang tersedia | **Sekarang** — ini menentukan semua di atas |

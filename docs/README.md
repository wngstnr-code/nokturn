# Nokturn

**Lapisan settlement berbasis intent untuk ekuitas tokenized di Robinhood Chain.**
Settlement spot pertama yang mengubah parameter eksekusinya mengikuti sesi bursa —
dan menerbitkan baseline-nya supaya siapa pun bisa menghitung ulang.

> **Cara menyampaikan ini ke juri: `pitch.md`.** Klaim orisinalitas di dokumen ini
> sudah dipersempit oleh audit kompetitor 11 Agustus 2026 (`ide-utama.md` §D1b–§D1f).
> Jangan pakai versi lama yang lebih berani.

Target: **Arbitrum Open House Singapore Buildathon**
Status: **tahap desain — belum ada kode**

---

## Ringkasan

> **Protokol DeFi lain menganggap semua detik sama. Untuk saham, itu salah — dan
> kesalahan itu paling mahal tepat di jam ketika kebanyakan orang berdagang.**

**Tesisnya.** Ekuitas tokenized diperdagangkan 24/7, tapi nilainya ditentukan bursa
yang buka 6,5 jam sehari, 5 hari seminggu. Setiap venue di Robinhood Chain
memperlakukan Sabtu tengah malam persis seperti Selasa siang. Nokturn tidak:
**durasi batch, lebar price band, exposure cap, dan sumber harga semuanya berubah
mengikuti keadaan pasar dunia nyata** — DST, hari libur, early close, halt per-simbol,
feed yang membeku di akhir pekan.

**Masalahnya terukur.** **74,1% trade** dan **65,2% volume** ekuitas terjadi saat
bursa AS tutup — **33,2% di akhir pekan saja**, ketika feed oracle berhenti diperbarui
48–56 jam dan tidak ada satu pun harga penutupan resmi. Ini terjadi meskipun Uniswap,
Arcus, Lighter, dan Rialto semuanya sudah live.

Dan ekornya berbahaya: p99 pergerakan antar-trade **1.779 bps** off-hours versus
**209 bps** saat bursa buka — **8,5× lebih parah**, dan melebar, sementara ekor jam
bursa buka justru menyempit tiga kali lipat.

> ⚠️ **Direvisi 3 September 2026.** Versi sebelumnya mengklaim "p90 3,3× lebih parah"
> dari data Juli. Data Agustus **menggugurkannya**: likuiditas off-hours membaik
> drastis dan selisih p90 menyusut ke 1,27×. Masalahnya tidak lenyap, ia **pindah ke
> ekor**. Jangan pakai angka p90 yang lama — lihat `pitch.md` §2.

**Lelang pembukaan dan penutupan.**

> *Setiap bursa saham di dunia membuka dan menutup dengan lelang.
> Saham onchain — sejauh penyisiran kami — tidak punya satu pun. Kami membangunnya.*

✅ *Audit selesai 12 Agustus 2026. Lelang onchain sudah ada (Uniswap CCA), dan
Figure OPEN — bursa ekuitas teregulasi onchain — justru **memilih perdagangan
kontinu**. Yang belum ada: lelang **berulang di batas sesi** untuk aset yang sudah
diperdagangkan. Rumusan aman: `pitch.md` §3b.*

Lelang pembukaan dan penutupan dengan publikasi imbalance — **undangan terbuka
kepada likuiditas**, bukan permohonan agar likuiditas berdiri menunggu. Produk
sampingannya adalah aset paling bernilai di protokol ini: **closing print**, satu
harga penutupan harian kanonik yang terbentuk dari permintaan-penawaran nyata
onchain. Chain ini tidak punya harga pembukaan maupun penutupan resmi — sudah
diverifikasi, `transmitSecondary` Chainlink tidak pernah dipakai. Protokol lending
dan vault butuh mark harian; hari ini mereka hanya punya oracle spot.

**Mesinnya: batch settlement.** Kumpulkan intent 30–60 detik, pertemukan pembeli
dan penjual langsung di harga tengah, rutekan sisanya ke venue sebagai satu order
besar. Semua peserta batch dapat harga yang sama. Mekanisme ini bukan hal baru —
**CoW Protocol membuktikan kategorinya nyata di Ethereum**, dengan volume miliaran
dolar. Yang baru adalah membuatnya **sadar sesi**, dan memakainya untuk menghasilkan
lelang serta harga referensi yang — sejauh penyisiran kami — belum dimiliki
ekuitas onchain.

**Kategorinya TIDAK kosong — dan itu bukan masalah.** ⚠️ *Direvisi 11 Agustus 2026;
versi sebelumnya menyatakan "settlement = belum ada" dan itu salah.*

UniswapX **live dan dipakai** di Robinhood Chain, dan **tumbuh cepat**: event
`Fill` naik dari 16.072 (Juli) ke 20.898 (Agustus) ke **27.931** (1–10 September
2026) — pengirim tx berbeda naik **21 → 41 → 87** per bulan. 1inch launch partner.
Arcus (tim dYdX) venue penuh. CoW Protocol sudah membuktikan batch auction sejak
2020.

Yang membuat ruang ini tetap terbuka adalah **skalanya**, bukan kekosongannya:
rasio `Fill` terhadap tx router dominan `0x65050A9B…` tetap **di bawah 0,25%** di
ketiga bulan (0,11% / 0,24% / 0,20%) — eksekusi berbasis intent masih pangsa
kecil, meski arahnya jelas naik, dan sampel menunjukkan mayoritasnya **bukan**
stock token. Itulah dasar terukur untuk asumsi pangsa awal 10–20%. *(Terukur
10 September 2026, kueri `8663798`; menggantikan angka kumulatif lama "22.068
Fill vs 17,2 juta tx".)*

Yang belum ada bukan kategorinya, melainkan **tiga sifatnya**: baseline yang
diterbitkan sebagai catatan (bukan sekadar harga cadangan seperti Atlas), parameter
eksekusi yang berubah per sesi, dan netting antar-counterparty yang terukur.
Rinciannya: `ide-utama.md` §D1b–§D1f.

**Jaminan ke pengguna.** Tidak pernah lebih buruk dari mengeksekusi langsung di
Uniswap. Kalau solver tidak mengalahkan baseline venue, batch jadi pass-through
dan **tidak ada fee sama sekali**.

---

## Angka kunci

Semua hasil ukur sendiri dari data onchain, bukan kutipan artikel.

Angka di bawah **Agustus 2026**, dijalankan ulang 3 September 2026.

| | |
|---|---|
| Trade ekuitas saat bursa tutup | **74,1%** *(volume: 65,2%)* |
| Trade di akhir pekan | **33,2%** *(dari 12,9% di Juli)* |
| p99 pergerakan antar-trade: off-hours vs buka | **1.779 bps vs 209 bps** *(8,5×)* |
| p90 pergerakan antar-trade: off-hours vs buka | 57,4 bps vs 45,1 bps *(1,27×)* |
| **Netting off-hours, batch 45 dtk** *(backtest Agustus 2026)* | **50,1%** dari lawan transaksi berbeda · **27–33%** pada pangsa awal realistis |
| Dompet aktif di Stock Token | **139.093** *(2,3× Juli)* |
| Trade stock token per bulan | **8,58 juta**, median tiket **$57,44** |
| Volume stock token per bulan | **$1.005,6 juta** *(3,6× Juli)* |
| Share stock token dari volume DEX chain | 2,88% *(1,43% untuk allowlist v1.0)* |
| Uniswap V3 share dari volume allowlist | **82,5%** Agu — 🔴 **72,6%** di Sep 1–10, turun cepat *(kueri `8664785`)* |
| Keluarga V3 drop-in (uniswap + gigadex + ramses vcl) | **84,4%** Agu · **77,1%** Sep — terverifikasi byte-identik V3 (P5-1) |
| Total Stock Token dipegang onchain | **$75,62 juta** *(terukur, 10 September 2026)* |
| Pemegang EOA > $1.000 | **804 wallet** *(1.174 kalau smart-contract wallet ikut dihitung; terukur, 10 September 2026)* |
| Nilai dipegang kontrak vs EOA | **82,1% kontrak** ($62,06jt) vs $13,56jt EOA |
| Fill UniswapX vs tx router dominan, per bulan | **0,11% (Jul) → 0,24% (Agu) → 0,20% (1–10 Sep)** — tumbuh cepat, pengirim tx berbeda 21 → 41 → 87 |

Query Dune Agustus 2026 (dijalankan 3 September 2026): `8595234` · `8595239` ·
`8595244` · `8595247` · `8595251` · `8595303` · `8595357` · `8595365` · `8595386`

> ✅ **Sudah bisa diklik juri** (3 September 2026). Kesembilan kueri di atas
> permanen, publik, bervisualisasi, dan terkumpul di
> **[dashboard Agustus 2026](https://dune.com/passchick/nokturn-robinhood-chain-equity-market-structure-august-2026)**. Dashboard lama `wngstnrs7119` hanya memuat
> angka Juli dan tidak masuk
> **[dashboard Nokturn](https://dune.com/wngstnrs7119/nocturne-robinhood-chain-equity-settlement-research)**.
> Membuatnya permanen adalah pekerjaan yang **belum selesai**, bukan detail
> administratif: seluruh klaim "juri bisa memverifikasi sendiri" bergantung padanya.
>
> Kueri Juli lama (8194489–8194525) **tidak bisa diambil kembali** — SQL-nya hilang.
> Itu sebabnya blok Juli diganti seluruhnya, bukan disajikan sebagai pertumbuhan.

✅ **Ketiga angka di atas (kepemilikan Stock Token dan Fill UniswapX) sudah diukur
ulang 10 September 2026** dengan kueri Dune permanen dan publik: `8663760`
(pemegang & nilai), `8663787` (pemegang teratas & distribusi), `8663798` (Fill
UniswapX vs tx router dominan, per bulan). Saldo direkonstruksi dari **seluruh
riwayat event `Transfer`** atas alamat Stock Token yang terverifikasi beacon
(§10.1 `parameter.md`) — **tidak pernah dicocokkan lewat simbol**, sehingga token
penyamar (mis. `0xc2362aff…`) tidak ikut terhitung. Rincian lengkap termasuk
distribusi pemegang kontrak dan inventaris V4 vs V3: `parameter.md` §10.3–§10.4.

---

## Dokumen

### Mulai di sini
| Dokumen | Isi |
|---|---|
| [`ide-utama.md`](ide-utama.md) | **Baca pertama.** Ide, bukti data, pemetaan ke kriteria juri, dan **apa yang sudah digugurkan beserta alasannya** |
| [`roadmap.md`](roadmap.md) | **Rencana internal pasca-menang** — payout bertahap, KPI, mainnet, kapan keluar dari ekuitas, cabang kalau kalah. *Roadmap untuk submission ada di `pitch.md` §5b* |
| [`demo.md`](demo.md) | **Rancangan permukaan demo** — struk batch, batch gagal, naskah 90 detik, inventaris provenansi |
| [`pitch.md`](pitch.md) | **Baca sebelum menyampaikan apa pun ke luar.** Kalimat satu baris, klaim yang HARAM karena sudah terbantah, lima pembeda teruji, kesiapan kriteria juri |
| [`hackathon.md`](hackathon.md) | Detail hackathon: T&C, kriteria, hadiah, faucet, RPC, tooling — plus **pola pemenang edisi sebelumnya** |
| [`glosarium.md`](glosarium.md) | Istilah — termasuk yang sengaja **tidak** dipakai |

### Inti pembeda — baca dua ini kalau cuma sempat dua
| Dokumen | Isi |
|---|---|
| [`desain-session-engine.md`](desain-session-engine.md) | **Komponen yang membuat seluruh tesis bekerja.** DST, hari libur, early close, halt per-token, guard band, feed beku akhir pekan |
| [`desain-auction.md`](desain-auction.md) | **Lelang di batas sesi** — klaim dipersempit setelah audit, baca kepalanya dulu. Lelang buka/tutup, publikasi imbalance, intent ROO, **closing print sebagai barang publik** |

### Mekanisme pendukung
| Dokumen | Isi |
|---|---|
| [`desain-kliring.md`](desain-kliring.md) | Matematika harga seragam: tiga lema + bukti, penjatahan pro-rata, kliring optimistik yang bisa ditantang |
| [`desain-baseline.md`](desain-baseline.md) | **`quoteFromState`** — penyeberangan tick, arah pembulatan, batas gas, matriks uji. Kode tersulit di v1.0 |
| [`desain-agent.md`](desain-agent.md) | Agent sebagai pengirim intent & sebagai solver; kontrak mandat |

### Bisnis
| Dokumen | Isi |
|---|---|
| [`desain-ekonomi.md`](desain-ekonomi.md) | Baseline, pembagian nilai, batas fee, anti-kartel, jalur pendapatan |
| [`distribusi.md`](distribusi.md) | Kanal, cold start, pasar SEA, keputusan tanpa token, metrik yang benar |

### Implementasi
| Dokumen | Isi |
|---|---|
| [`spek-teknis.md`](spek-teknis.md) | Arsitektur, scope, tujuh lapis verifikasi, rencana build |
| [`parameter.md`](parameter.md) | **Sumber kebenaran tunggal untuk setiap konstanta** |
| [`interfaces.md`](interfaces.md) | Interface, **event**, error, model data indexer |
| [`rencana-uji.md`](rencana-uji.md) | 14 invarian, handler, differential, Halmos, mutation, adversarial |
| [`threat-model.md`](threat-model.md) | Aset, batas kepercayaan, katalog serangan, risiko sisa, runbook |
| [`pertanyaan-terbuka.md`](pertanyaan-terbuka.md) | Hasil verifikasi onchain. **Semua P0 terjawab**; sisanya tidak memblokir |

---

## Langkah berikutnya

**Semua P0 sudah terjawab** (1 Agustus 2026) — lihat
[`pertanyaan-terbuka.md`](pertanyaan-terbuka.md). Tidak ada gate KYC, Permit2
ada dan sudah dipakai pengguna nyata, 30 feed Chainlink terpetakan.

**Denda init Stylus sudah terukur** (1 Agustus 2026): **46,4rb–49,2rb gas** per
panggilan tanpa cache, dari tiga program Stylus sungguhan di mainnet. Nyata, tapi
tidak menghalangi — arsitektur verifier tidak lagi memblokir.

**Fixture kalender sudah jadi** — [`data/nyse-calendar/`](../data/nyse-calendar/):
5.844 hari 2020–2035, 32 batas DST, 155 hari libur, 33 early close. Tervalidasi
terhadap kalender NYSE 2020–2026 yang diketahui independen.

✅ **Query Dune Agustus sudah publik** (3 September 2026). Kesembilan kueri dibalik
dari `is_temp`, diberi deskripsi metodologi dan visualisasi, lalu dirakit jadi satu
dashboard bernarasi:
**[Nokturn — Robinhood Chain equity market structure (August 2026)](https://dune.com/passchick/nokturn-robinhood-chain-equity-market-structure-august-2026)**

"Bukti yang bisa diklik juri" sekarang benar-benar ada untuk angka yang dipakai.

⚠️ Dashboard lama
[wngstnrs7119](https://dune.com/wngstnrs7119/nocturne-robinhood-chain-equity-settlement-research)
memuat 12 query **Juli** dan **tidak boleh dikutip lagi** — seluruh angkanya sudah
digantikan blok Agustus. Perhatikan bahwa dashboard baru ada di handle `passchick`,
akun yang berbeda.

1. **Terbitkan analisisnya.** Dashboard-nya hidup tapi belum ada yang menunjuk ke
   sana. Belum ada pihak lain yang mempublikasikan analisis ini, jadi tulisannya
   membangun audiens sebelum produknya ada
2. **Konfirmasi ke penyelenggara:** boleh masuk dua track? Nama track kedua?
   Deadline 1 atau 4 Oktober? Lihat `docs/ide-utama.md` §C
3. Scaffold repo dengan **CI aktif sejak commit pertama** (Slither, Aderyn, gas
   snapshot, storage layout)

---

## Aturan kerja

- **Parameter berubah di [`parameter.md`](parameter.md) dulu, baru di kode.**
  Kalau ada angka di dokumen lain yang bertentangan, halaman itu yang menang
- **Lapisan verifikasi bukan variabel penyesuaian.** Kalau ada yang perlu digeser,
  geser urutan adapter — jangan pernah kedalaman verifikasi
- **Tanpa token, tanpa poin, tanpa airdrop.** Keputusan sadar; alasannya di
  [`distribusi.md`](distribusi.md) §6
- Kalau jawaban atas pertanyaan terbuka mengubah desain, **perbarui dokumennya di
  hari yang sama**

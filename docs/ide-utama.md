# IDE FINAL — Intent-Based Batch Settlement Layer
## Robinhood Chain · Arbitrum Open House Singapore Buildathon

> Dokumen tunggal: ide final, bukti pendukung, dan apa yang sudah digugurkan.
> Spek implementasi ada di `spek-teknis.md`. Detail hackathon di `hackathon.md`.
>
> Disusun 31 Juli 2026 · direstrukturisasi 1 Agustus 2026
> **Buildathon 14 Sep – 4 Okt 2026.** Deadline submission **1 Oktober** menurut T&C,
> 4 Oktober menurut halaman — pakai yang lebih ketat sampai dikonfirmasi.
> ⚠️ **Diperbaiki 10 September 2026 — versi sebelumnya menyatakan larangan yang
> tidak ada di aturan.** Dua hal yang berbeda dan jangan dicampur:
>
> **Apa yang tertulis di aturan.** T&C §3.1 mengizinkan submission berupa
> *"original work first created **or existing work that has been adjusted during
> the Buildathon** (this shall mean more than trivial development of the code
> base)"*, dan halaman HackQuest menulis *"Bring an existing project or start from
> scratch."* §7.1 mendiskualifikasi karya yang **tidak dimodifikasi** selama periode
> Buildathon — bukan karya yang sudah ada sebelumnya.
>
> **Pilihan kita.** Konfirmasi tertulis ke penyelenggara baru dikirim saat jendela
> submission buka, 14 September (naskahnya sudah siap di `hackathon.md`
> §Pesan untuk penyelenggara). Sampai ada jawaban, kita berjalan konservatif.
> Itu **pilihan**, bukan kewajiban — dan alasan mencatat bedanya: kalau eligibility
> dipersoalkan di akhir, yang berlaku adalah bunyi aturannya, bukan tafsir kita.

---

# BAGIAN A — IDENYA

## A1. Satu kalimat

> ⚠️ **Direvisi 10 September 2026 — struktur dua lapis, lihat `pitch.md` §1.**
> Untuk penyampaian ke luar, pakai persis rumusan `pitch.md` §1, bukan versi di
> bawah.

**Lapis 1 (pembuka & penutup, dipakai ke luar):** Saham tokenized di Robinhood
Chain diperdagangkan 24/7, tapi chain ini tidak punya satu pun harga pembukaan
maupun penutupan resmi. Nokturn membentuknya — lelang penutupan onchain, tiap
hari, dari permintaan-penawaran nyata, yang bisa dibaca protokol mana pun.

**Lapis 2 (bukti yang bisa dipegang, turun dari rumusan lama):**

> **Settlement spot pertama yang mengubah parameter eksekusinya mengikuti sesi
> bursa** — ia membuka dan menutup dengan lelang seperti bursa sungguhan, dan lelang
> itu menghasilkan **harga penutupan harian kanonik** yang — sejauh penyisiran
> kami (🟡 belum tuntas, lihat `desain-auction.md`) — belum dimiliki
> ekuitas onchain.

⚠️ *Direvisi 11 Agustus 2026 (turun jadi lapis 2 pada revisi 10 September 2026).
Versi lama berbunyi "venue eksekusi pertama yang tahu jam berapa sekarang" —
**salah**: Dinari, Ondo, gTrade, dan Ostium semuanya sadar jam bursa, hanya di
lapisan berbeda. Lihat §D1e. Untuk penyampaian ke luar, pakai `pitch.md`, bukan
kalimat ini.*

## A2. Tesisnya

> **Protokol DeFi lain menganggap semua detik sama. Untuk saham, itu salah — dan
> kesalahan itu paling mahal tepat di jam ketika kebanyakan orang berdagang.**

Ekuitas tokenized diperdagangkan 24/7, tapi nilainya ditentukan bursa yang buka
6,5 jam sehari, 5 hari seminggu. Setiap venue di chain ini memperlakukan Sabtu
tengah malam persis seperti Selasa siang.

Konsekuensinya bukan teori — **74,1% trade (65,2% volume) terjadi saat bursa tutup.**
Ini terjadi *meskipun* Uniswap, Arcus, Lighter, dan Rialto semuanya sudah live.

⚠️ *Revisi 3 September 2026, data Agustus 2026.* Klaim lama "p90 slippage 3,3× lebih
buruk" **sudah gugur** — likuiditas off-hours membaik drastis dan p90 sekarang cuma
1,27× (57,4 vs 45,1 bps). Masalahnya tidak lenyap, ia pindah ke ekor: **p99 off-hours
1.779,4 bps vs 209,3 bps saat bursa buka — 8,5× lebih buruk**, sementara p99 di jam
buka justru menyempit. Lihat §B1 dan `parameter.md` §1B.

Nokturn memperlakukan waktu sebagai variabel kelas satu: durasi batch, lebar price
band, exposure cap, dan **sumber harga** semuanya berubah per sesi. Di akhir pekan,
feed Chainlink membeku 48–56 jam (terukur) — jadi peran oracle **berganti**, bukan
sekadar melebar. Tidak ada protokol kripto lain yang perlu memikirkan ini, karena
di kripto masalah ini tidak ada.

## A2b. Lelang di batas sesi — pembeda kelima, audit selesai

> *Setiap bursa saham di dunia membuka dan menutup dengan lelang.
> Saham onchain — sejauh penyisiran kami — tidak punya satu pun. Kami membangunnya.*

✅ *Audit selesai 12 Agustus 2026 — klaim bertahan, tapi dipersempit.* **Lelang
onchain sudah ada** (Uniswap CCA), dan **Figure OPEN memilih perdagangan kontinu**
untuk bursa ekuitas onchain mereka. Yang belum ada: lelang **berulang di batas sesi**
untuk aset yang **sudah diperdagangkan**, dengan publikasi imbalance dan closing
print harian. Rincian: kepala `desain-auction.md` · rumusan pitch: `pitch.md` §3b.

Lelang pembukaan dan penutupan dengan **publikasi imbalance** — undangan terbuka
kepada likuiditas, bukan permohonan agar likuiditas berdiri menunggu. Ketika kontrak
menyiarkan *"ada imbalance jual NVDA $200.000 di harga indikatif $178"*, risiko yang
tidak diketahui berubah jadi peluang yang terhitung.

Produk sampingannya adalah **aset paling bernilai di protokol ini**: closing print —
satu harga penutupan harian kanonik dari permintaan-penawaran nyata onchain. Chain
ini tidak punya harga pembukaan maupun penutupan resmi; sudah diverifikasi,
`transmitSecondary` pada `DualAggregator` Chainlink **tidak pernah dipakai**.
Protokol lending dan vault butuh mark harian dan hari ini hanya punya oracle spot.

**Implikasi strategis:** closing print membuat protokol lain **mengonsumsi** Nokturn
tanpa merutekan satu order pun lewat kita. Itu mengubah posisi dari venue menjadi
infrastruktur — dan infrastruktur jauh lebih lengket.

⭐ **Diperkuat pengukuran onchain 10 September 2026.** Di Robinhood Chain,
**38 kontrak dari 24 operator berbeda — melayani 2.048 pengguna akhir — membaca
harga ekuitas 64.671 kali dalam sepuluh hari** (1–10 September 2026, 21.135
transaksi; kueri `8664020` · `8664034` · `8664051`). Semuanya lewat
`AggregatorV3Interface`, dan karena itu closing print kini diterbitkan lewat
permukaan baca drop-in yang sama, di samping interface asli — konsumen yang sudah
ada cukup mengganti satu alamat. Rincian: `desain-auction.md` §3.3.

🔴 **Angka ini salah dua kali sebelum benar, dan urutannya layak diceritakan** —
ia bukti angka kami diperiksa, bukan dikarang:

| Percobaan | Hasil | Kenapa salah |
|---|---|---|
| 1 | "31 kontrak" | 10 di antaranya **jalur tulis** (`transmit`) — ~3× terlalu besar |
| 2 | "20 kontrak / 64.809 pembacaan" | Diukur di **lapisan agregator, satu lapis terlalu dalam** — ~37× terlalu kecil. **Jangan dipakai lagi** |
| **3 ✅** | 38 kontrak / 24 operator / 2.048 pengguna | Diukur di lapisan **di atas** permukaan harga |

⚠️ **Tiga batas wajib, sebut bersamaan dengan angkanya:** (1) ini **batas bawah** —
pembacaan `eth_call` di luar transaksi tidak muncul di trace; (2) 🔴 **tidak satu
pun konsumen bisa disebut namanya** — seluruh kontraknya belum terverifikasi di
Blockscout dan operator terbesar EOA anonim, jadi jangan pernah menyebut nama
protokol tertentu; (3) ini basis konsumen yang **bisa dijangkau**, bukan yang
**sudah mengonsumsi** — belum ada protokol yang berkomitmen memakai closing print.

## A2c. Siapa yang benar-benar dilayani

Ilustrasi yang gampang dibayangkan: seseorang di Jakarta, jam 10 malam, membeli NVDA
$50 di kolam tipis dan membayar jauh lebih mahal dari seharusnya. Lawan transaksinya
sering **ada** — hanya datang 40 detik kemudian.

Tapi jujur soal angkanya: tiket median **$57,44** (Agustus 2026), pergerakan median
antar-trade off-hours **7,6 bps** → penghematan tipikal masih kecil per transaksi.
Nilainya ada di **ekor dan agregat**, bukan per-transaksi.

Karena itu pengguna inti bukan orang yang menatap layar menunggu, melainkan **arus
yang tidak keberatan menunggu**: DCA dan recurring, Batch-TWAP, rebalancing, dan
agent. Lihat [`desain-agent.md`](desain-agent.md) §2.1 — arus agent justru yang
paling mungkin saling menutup di dalam batch, karena agent banyak, sistematis, dan
strateginya beragam. Trader manusia tetap dilayani dan tetap cukup untuk membuat
protokol ini bernilai; mereka bukan satu-satunya tumpuan.

## A3. Analogi

**Loket penukaran uang di bandara.**

*Cara sekarang:* semua orang maju satu per satu. Yang tukar rupiah→dolar bayar
spread ke loket. Lima menit kemudian yang tukar dolar→rupiah datang, bayar spread
juga. Padahal keduanya bisa saling menukar langsung.

*Cara kami:* semua yang datang dalam satu menit dikumpulkan. Yang arahnya
berlawanan dipertemukan langsung **di harga tengah, tanpa spread**. Hanya
kelebihannya yang dibawa ke loket — sebagai satu transaksi besar yang dapat
harga jauh lebih baik daripada lima puluh transaksi kecil.

## A4. Cara kerja

0. **Session Engine menentukan keadaan pasar dunia nyata** — dari tabel kalender &
   DST onchain, sebagai fungsi murni yang bisa **dibuktikan** benar, bukan sekadar
   diuji. Ini yang menetapkan durasi batch, lebar band, cap, dan sumber harga.
1. **User menandatangani "niat", bukan transaksi.** Gasless. Dana tetap di dompetnya.
2. **Niat dikumpulkan** selama jendela sesi — 10 dtk saat bursa buka, 45 dtk
   overnight, 120 dtk akhir pekan.
3. **Yang saling menutup dieksekusi di harga kliring seragam** — nol spread,
   nol biaya AMM, tidak ada keunggulan urutan yang bisa dipanen.
4. **Sisa imbalance dirutekan** ke Uniswap V3 sebagai satu order agregat.
   *(v1.0 satu adapter; V4 ditunda karena hook fee dinamis tidak bisa dihitung
   dari state — lihat `spek-teknis.md` §9.1)*
5. **Semua peserta batch dapat harga yang sama.** Penjatahan pro-rata, bukan
   prioritas waktu — satu-satunya pilihan yang tahan manipulasi urutan.
6. **Price band** terhadap Chainlink + TWAP Uniswap V3. Di akhir pekan peran
   keduanya **bertukar**, karena Chainlink membeku.
7. **Di batas sesi, lelang menggantikan batch** — akumulasi, publikasi imbalance,
   pembekuan, cross. Hasilnya diterbitkan sebagai **closing print**.

**Solver** — program yang bersaing tiap batch untuk menghasilkan penghematan
terbesar — mengerjakan pencocokannya. Solusinya diverifikasi smart contract,
jadi solver **tidak perlu dipercaya**: kalau curang, kontrak menolak dan
jaminannya disita.

## A5. Posisi kategori — kenapa ini sejajar Uniswap/Morpho/Lighter

| Primitif | Robinhood Chain |
|---|---|
| Likuiditas | Uniswap, Arcus, Rialto, Pleiades |
| Kredit | Morpho |
| Derivatif | Lighter |
| Manajemen likuiditas | Arrakis |
| **Settlement / eksekusi** | UniswapX (live, 27.931 `Fill` di Sep 2026 1–10, naik dari 16.072 di Juli — terukur 10 Sep 2026, §D1b) · 1inch Fusion — **ada dan tumbuh, tapi pangsanya masih kecil** (< 0,25% dari router dominan) ⚠️ *baris ini dulu berbunyi "kosong"; salah, lihat §D1b* |

Ini kategori nyata, bukan karangan: **CoW Protocol** menempatinya di Ethereum
dan menjadi protokol tingkat pertama dengan volume miliaran dolar.

Bedanya dengan sebagian besar yang ada di sini: 1inch dan Rialto **merutekan** —
mencari venue terbaik untuk *satu* order. Menyelesaikan secara batch itu lain hal:
mencocokkan intent *satu sama lain* sebelum menyentuh venue mana pun.

⚠️ *Direvisi 11 Agustus 2026, angka diperbarui 10 September 2026. Versi lama
berbunyi "tidak ada yang menyelesaikan secara batch" — **salah**: UniswapX live
dan dipakai di chain ini (27.931 `Fill` di Sep 2026 1–10, tumbuh dari 16.072 di
Juli), dan CoW sudah membuktikan kategorinya sejak 2020. Yang membedakan bukan
kekosongan kategori melainkan skalanya — lihat §D1b.*

### A5b. "Jadi ini CoW untuk stock token?" — sebut duluan, jangan tunggu ditanya

Pertanyaan ini **pasti** datang dari juri yang paham DeFi. Sebut CoW sendiri di
kalimat ketiga; kalau mereka yang menyebutnya duluan, kamu sudah kalah satu langkah.

Jawaban jujurnya: **mekanisme batch-nya memang bukan hal baru, dan itu justru
kekuatan** — kategorinya sudah terbukti, jadi tidak perlu meyakinkan siapa pun bahwa
batch settlement bisa bekerja. Yang baru ada tiga, dan tak satu pun dimiliki CoW
karena Ethereum tidak punya masalahnya:

| | CoW | Nokturn |
|---|---|---|
| Kesadaran waktu | Tidak ada — semua detik sama | **Session Engine**: DST, hari libur, early close, halt per-simbol, feed beku akhir pekan |
| Lelang buka/tutup | Tidak ada konsepnya | **Opening & closing cross** dengan publikasi imbalance dan price collar |
| Keluaran ke ekosistem | Hanya eksekusi | **Closing print** — harga referensi harian yang dikonsumsi protokol lain |

Dan satu poin yang membalik pertanyaannya: **kalau Uniswap menambahkan batching
besok, mereka masih tidak tahu kapan NYSE tutup, kapan early close, kapan halt,
atau bagaimana menangani corporate action.** Parit yang sebenarnya bukan batching.

---

# BAGIAN B — BUKTI

Semua angka di bawah **hasil ukur sendiri dari data onchain via Dune**,
bukan kutipan artikel.

> ✅ **Sudah bisa diverifikasi pihak luar (2 Agustus 2026).** Ke-12 query semula
> berstatus `is_temp: true` — meski `is_private: false`, query temp **tidak punya
> halaman publik**. Status itu sudah dibalik ke `is_temp: false`, tiap query diberi
> visualisasi, dan semuanya dikumpulkan jadi satu dashboard publik:
> **[dune.com/wngstnrs7119/nocturne-robinhood-chain-equity-settlement-research](https://dune.com/wngstnrs7119/nocturne-robinhood-chain-equity-settlement-research)**
> Seluruh query dijalankan ulang saat publikasi; angka inti reproduksi persis
> (satu drift kecil dicatat di §B4). Lihat §B4.

## B1. Masalahnya nyata dan terukur

> ⚠️ **Revisi 3 September 2026, data Agustus 2026.** Tabel di bawah diganti
> seluruhnya dari angka Juli. Klaim lama "p90 3,3× lebih buruk" **sudah gugur** —
> lihat catatan di bawah tabel.

| | NYSE buka | NYSE tutup |
|---|---|---|
| Share trade | 25,94% | **74,06%** |
| Share volume | 34,82% | **65,18%** |
| Median pergerakan harga antar-trade | 6,5 bps | 7,6 bps (hari kerja) / 7,1 bps (akhir pekan) |
| p90 | 45,1 bps | 57,4 bps (hari kerja) / 47,6 bps (akhir pekan) |
| p99 | 209,3 bps | **1.779,4 bps (hari kerja) / 203,8 bps (akhir pekan)** |
| Trade per jam | 52.116 (13 UTC) | 9.591 (04 UTC) ⚠️ *angka Juli, belum diukur ulang* |
| Median ukuran trade | ~$50 | ~$50 ⚠️ *angka Juli; median tiket Agustus $57,44* |

🔴 **Klaim lama "p90 230,5 vs 69,0 bps, 3,3× lebih buruk" sudah GUGUR.** Likuiditas
off-hours membaik drastis: rasio p90 sekarang cuma **1,27×**. Masalahnya tidak
lenyap, ia pindah ke ekor: **p99 off-hours hari kerja 1.779,4 bps vs 209,3 bps saat
bursa buka — 8,5× lebih buruk** — sementara p99 di jam buka justru menyempit.
Framing berubah dari "eksekusi off-hours buruk secara umum" menjadi "tidak ada
harga referensi sama sekali untuk 74,1% arus, dan ekornya 8,5× lebih berbahaya".

**Mayoritas perdagangan ekuitas terjadi ketika bursa tutup — dan di ekornya
eksekusi paling buruk.** Ini terjadi *meskipun* Uniswap, Arcus, Lighter, dan
Rialto semuanya sudah live. Struktur yang ada terbukti tidak menyelesaikannya,
dari hasil akhir, bukan dari teori.

Korbannya trader ritel dengan tiket ~$57 (median Agustus 2026) — tersebar di
**seluruh 24 jam**, bukan terkonsentrasi di satu region.

> 🔴 ⚠️ **Direvisi 11 September 2026** — kueri [`8680028`](https://dune.com/queries/8680028) menggugurkan inferensi lama di sini.
> Kalimat sebelumnya menyimpulkan *"persis profil pengguna Asia Tenggara, yang
> menyumbang 81,9% volume perdagangan RWA di Bitget pada Q1 2026."*
>
> **Dua kesalahan.** Pertama, 81,9% itu statistik **CEX global**, bukan chain ini —
> persis pola yang dilarang `CLAUDE.md` §3: *verifikasi dengan data, jangan percaya
> artikel*. Kedua, diukur langsung di Robinhood Chain, jam bangun Asia memuat
> **33,54%** trade lawan ekspektasi merata **41,67%** — **di bawah**, bukan di atas.
>
> Statistik Bitget-nya sendiri tidak dibantah; yang gugur adalah **inferensinya ke
> chain ini**. Lihat `parameter.md` §10.5.

## B2. Basis penggunanya yang paling tebal di chain ini

> ⚠️ **Revisi 3 September 2026, data Agustus 2026.** "58.461 wallet" dan "600rb+
> trade/bulan" digantikan angka Agustus di bawah. Definisinya berbeda — 139.093
> adalah **dompet aktif bulanan** (bukan kumulatif "pernah menyentuh"), dan 8,58
> juta trade sebanding dengan 3,66 juta Juli (bukan dengan 600rb lama, yang
> memakai cakupan lebih sempit — lihat `ANGKA-AGUSTUS-2026.md` §9).

| | Wallet | Catatan |
|---|---|---|
| Dompet aktif per bulan | **139.093** | basis pedagang |
| Trade stock token per bulan | **8,58 juta** | median tiket **$57,44** |
| Pemegang EOA Stock Token > $1k | **804** | *terukur, 10 September 2026, Dune 8663760 — menggantikan angka lama 477* |
| Pemegang USDG > $1k | 2.923 | |

**Chain ini populasinya pedagang, bukan pemegang.** Median pemegang Stock Token
punya di bawah $10, tapi 139 ribu wallet aktif bertransaksi per bulan.

Konsekuensinya tegas: setiap primitif berorientasi *holder* — opsi, CDP, yield,
agunan — kehilangan basisnya. Yang berorientasi *trader* tidak.

## B3. Konteks pasar (harus diterima secara sadar)

- Stock token (8 token asli) = **2,88% volume DEX** chain ini (**1,43%** untuk allowlist
  v1.0); sisanya memecoin (CASHCAT, PONS, VLAD, HOODRAT)
- Total Stock Token dipegang onchain: **$75,62 juta** *(terukur, 10 September 2026,
  Dune 8663760 — menggantikan angka lama $27,2 juta dari 1 Agustus 2026)*. 82,1%
  di antaranya dipegang kontrak (V4 PoolManager saja $31,30jt), nilai dipegang
  dompet pribadi (EOA) cuma $13,56jt — lihat `parameter.md` §10.3
- CoinDesk 13 Juli 2026: *"Robinhood membangun blockchain untuk saham tokenized — memecoin yang mengambil alih"*

**Ini taruhan pada pertumbuhan pasar, bukan penangkapan pasar yang sudah besar.**
Posisi founder yang sah — Founder House menilai arah, dan ada slot hadiah yang
dicadangkan untuk Robinhood Chain — tapi pilih secara sadar.

Bedanya dengan ide-ide yang digugurkan: ini melayani populasi **terbesar yang
benar-benar ada sekarang**, bukan yang kita harap ada.

## B3b. ⭐ Solusinya juga terukur — bukan cuma masalahnya

Sampai 1 Agustus 2026, seluruh proyek ini mengukur **masalahnya** dengan sangat
teliti tapi memperlakukan **solusinya** sebagai asersi: *"lawan transaksimu sering
ada, hanya datang 40 detik kemudian."* Itu sekarang sudah diuji.

> ⚠️ **Revisi 3 September 2026, data Agustus 2026.** Blok Juli di bawah diganti
> seluruhnya — SQL kueri Juli lama tidak bisa diambil kembali, jadi ini bukan
> perbandingan pertumbuhan, melainkan jalan ulang metode identik di bulan baru.
> Semua angka netting berlabel **backtest**, tidak pernah "terukur".

Backtest atas `dex.trades` Agustus 2026 untuk allowlist v1.0 (NVDA, AAPL, TSLA,
GOOGL), jendela 45 detik, sesi off-hours:

| | |
|---|---|
| Netting **gross** kalau seluruh arus lewat Nokturn | **63,8%** |
| **Netting antar-counterparty** (lawan transaksi benar-benar berbeda) | **50,1%** |
| Netting antar-counterparty pada pangsa awal realistis (10–20%) | **27–33%** |
| Rata-rata pedagang berbeda per batch, 100% arus | 7,47 |
| Rata-rata pedagang berbeda per batch, pangsa 10–20% | **2,5–3,3** |

**Separuh volume off-hours punya lawan transaksi yang benar-benar berbeda di
jendela 45 detik yang sama.** Klaim intinya bertahan saat diuji ulang.

**Dan efek jaringannya jadi backtest.** Netting antar-counterparty naik dari
**21,4% (pangsa 5%)** ke **50,1% (pangsa 100%)** — kemiringan yang selama ini cuma
argumen teoretis di [`desain-agent.md`](desain-agent.md) §2.1 sekarang punya angka.

⭐ **Kenapa pergantian angka ini justru memperkuat posisi.** Angka lama 21–29%
dihitung dengan definisi **gross** yang masih memuat bot bolak-balik. Angka baru
27–33% dihitung dengan definisi **antar-counterparty** yang lebih ketat dan tetap
keluar lebih tinggi.

⚠️ **Pakai 27–33% untuk pitch fase awal, bukan 50,1% dan bukan 63,8%.** Angka
besar mengasumsikan monopoli arus. Kejujuran soal ini adalah bagian dari posisi
proyek — dan kurvanya justru argumen yang lebih kuat daripada satu angka besar,
karena ia menunjukkan kenapa pertumbuhan memperbaiki produk dengan sendirinya.

Detail lengkap, sapuan durasi batch, dan tiga koreksi kejujuran:
[`parameter.md`](parameter.md) §1B.

## B4. Query Dune

✅ **Dashboard 2 Agustus 2026 masih menyimpan angka Juli** (query 8194489–8194531):
**[Nokturn — Robinhood Chain equity settlement research](https://dune.com/wngstnrs7119/nocturne-robinhood-chain-equity-settlement-research)**
— berguna sebagai riwayat metode, tapi **jangan dikutip untuk angka**; seluruh
angka Juli di dokumen ini sudah digantikan blok Agustus di atas.

🔴 **Revisi 3 September 2026.** Seluruh angka Agustus 2026 berasal dari sembilan
kueri baru berikut. Kueri baru ini **bukan** penulisan ulang kueri Juli — SQL lama
tidak bisa diambil kembali — melainkan kueri baru dengan definisi sesi dan filter
yang seragam untuk kedua bulan, sehingga Juli dan Agustus sebanding satu sama lain.

| Query Agustus 2026 | Isi |
|---|---|
| `8595234` | Aktivitas bulanan stock token: trade, volume, dompet aktif, median tiket, pangsa off-hours & akhir pekan |
| `8595239` | Kualitas eksekusi: pergerakan harga antar-trade p50/p90/p99 per sesi, 8 stock token |
| `8595244` | Sama, dipecah **per token** untuk allowlist v1.0 dan per sesi |
| `8595247` | Komposisi venue (`project` × `version`) atas volume allowlist v1.0 |
| **`8595251`** | **Rasio netting per sesi, batch 45 dtk, Juli vs Agustus** |
| **`8595303`** | **Kurva netting × pangsa arus** (efek jaringan), gross dan antar-counterparty |
| **`8595357`** | **Kurva netting × durasi batch**, dasar kalibrasi `BATCH_OVERNIGHT` |
| `8595365` | Pangsa stock token dari total volume DEX chain |
| `8595386` | Volume dan dompet per stock token, Juli vs Agustus |

> ✅ **Kesembilan kueri sudah permanen, publik, dan bervisualisasi** (3 September
> 2026), terkumpul di dashboard bernarasi
> **[Nokturn — Robinhood Chain equity market structure (August 2026)](https://dune.com/passchick/nokturn-robinhood-chain-equity-market-structure-august-2026)**.
>
> ⚠️ Dashboard baru ada di handle **`passchick`**, bukan `wngstnrs7119`. Dashboard
> lama memuat angka Juli dan **tidak boleh dikutip lagi**; SQL kueri Juli hilang
> karena disimpan temporer, dan itu pelajaran yang tidak diulang untuk Agustus.

**Drift 2 Agustus (angka Juli, sudah usang — riwayat metode saja).** Saat
dijalankan ulang dari kueri asli, angka inti reproduksi persis — netting 47,59% ·
41,33% bersih · 5,33 pedagang/batch · kurva 18,51 → 47,59% · gas aktivasi Stylus
7,73–8,18jt · GME penyamar $29,6jt. Satu yang bergeser: p90 jam terburuk
237,9 → 230,5 bps (terbaik 69,9 → 69,0), rasio ekor 3,4× → 3,3×. Seluruh blok ini
digantikan angka Agustus di §B1–§B3b; lihat catatan revisi di sana.

| Query lama (usang, riwayat metode) | Isi |
|---|---|
| [8194489](https://dune.com/queries/8194489) | Komposisi volume DEX per token |
| [8194490](https://dune.com/queries/8194490) | Volume stock token per jam UTC vs sesi NYSE |
| [8194494](https://dune.com/queries/8194494) | Kualitas eksekusi per jam |
| [8194496](https://dune.com/queries/8194496) | Distribusi pemegang Stock Token |
| [8194507](https://dune.com/queries/8194507) | Kontrak bersimbol USDG |
| [8194509](https://dune.com/queries/8194509) | Distribusi pemegang USDG kanonik |
| **[8194513](https://dune.com/queries/8194513)** | **Rasio netting × durasi batch × sesi** |
| **[8194516](https://dune.com/queries/8194516)** | **Netting × pangsa pasar (efek jaringan)** |
| **[8194523](https://dune.com/queries/8194523)** | **Kualitas netting: lawan transaksi nyata vs bot bolak-balik** |
| [8194525](https://dune.com/queries/8194525) | Universe stock token vs USDG kanonik |
| [8194528](https://dune.com/queries/8194528) · [8194531](https://dune.com/queries/8194531) | Deteksi & identifikasi program Stylus |

---

# BAGIAN C — PEMETAAN KE KRITERIA JURI

| Kriteria | Argumen |
|---|---|
| **Smart contract quality** | Permukaan kecil dan tajam. **Tidak menyimpan dana pengguna dalam keadaan diam, tidak ada margin engine, tidak bisa insolven.** Kriteria ini bekerja untukmu, bukan melawanmu — kebalikan dari protokol opsi yang sempat dipertimbangkan |
| **Product-Market Fit** | Basis terukur terbesar di chain: 139.093 dompet aktif/bulan, 8,58 juta trade/bulan (Agustus 2026). Ditambah pemegang: 804 EOA memegang > $1.000 dan $75,62 juta Stock Token dipegang onchain (terukur, 10 September 2026, Dune 8663760). Bukan pasar yang diharapkan — pasar yang dihitung |
| **Innovation & Creativity** | Lima pembeda teruji: baseline yang bisa diaudit, parameter eksekusi per sesi, netting backtest, dan closing print yang bisa diinjak hari ini (`pitch.md` §3). Pembeda kelima: lelang **di batas sesi** dengan closing print — audit selesai, lihat `pitch.md` §3b (Uniswap CCA & Figure OPEN sudah ditutup). Closing print sekarang punya basis konsumen **terukur** (38 kontrak dari 24 operator, melayani 2.048 pengguna akhir, 64.671 pembacaan/10 hari; kueri `8664020` · `8664051`) dan biaya adopsi mendekati nol — konsumen mengganti satu alamat lewat permukaan `AggregatorV3Interface`, lihat §A2b. ⚠️ Tidak satu pun konsumen bisa disebut namanya (belum terverifikasi). Batch matching sendiri **bukan** klaim orisinalitas; sebut CoW dan UniswapX duluan |
| **Real Problem Solving** | Dibuktikan dengan angka sendiri: 74,1% trade terjadi saat bursa tutup, dan p99 eksekusi off-hours 8,5× lebih buruk di ekor (p90 3,3× lama sudah gugur — direvisi 3 September 2026). Kueri Agustus **permanen, publik, dan bervisualisasi** di [dashboard Agustus 2026](https://dune.com/passchick/nokturn-robinhood-chain-equity-market-structure-august-2026) — juri bisa membuka dan menjalankan ulang tiap kueri. ⚠️ Dashboard lama `wngstnrs7119` hanya memuat angka Juli dan tidak boleh dikutip, lihat §B4 |

**Strategi track — kunci ke Overall Prize.**

Kriteria penilaian kedua track **identik** dan keduanya mencadangkan slot Robinhood
Chain, jadi tidak ada keuntungan diversifikasi — yang dipilih hanyalah kolamnya.
Overall $70rb versus agentic $15rb.

Lapisan agent tetap dipertahankan sebagai **kekuatan produk** (mandat + Batch-TWAP
memperkuat kriteria Innovation), bukan sebagai pengajuan track terpisah.
`desain-agent.md` §7 sudah jujur: Nokturn bekerja penuh tanpa satu pun agent —
itu alasan bagus untuk produk, tapi alasan buruk untuk track agentic.

⚠️ **Tiga hal yang harus dikonfirmasi ke penyelenggara** sebelum ini final:
1. Boleh masuk dua track sekaligus? Kalau gratis, ikut agentic sebagai bonus —
   tapi jangan bentuk produknya untuk itu
2. Nama track kedua **"Best agentic project"** (halaman) atau **"Best promising
   products"** (T&C)? T&C membebaskan yang kedua dari skema payout 25/25/50
3. Deadline **1 Oktober** (T&C) atau **4 Oktober** (halaman)? Pakai yang lebih ketat

**Sudut agentic:** solver otonom bersaing tiap batch; solusinya diverifikasi
onchain dengan bonding & slashing. Bentuknya **persis tesis Arbitrum** — jangan
percaya, verifikasi lewat kompetisi dan kemampuan ditantang. Sama dengan fraud proof.

**Stylus:** clearing verifier — aritmetika O(N) lintas aset. Mahal di Solidity,
ekonomis di Rust. Ukuran batch menentukan seberapa sering intent saling bertemu,
jadi ini langsung menerjemahkan ke kualitas produk. Benchmark gasnya masuk pitch.

**Kenapa setara startup:** kategori terbukti (CoW), revenue standar (fee taker +
bagi hasil surplus solver), efek jaringan nyata (makin banyak order flow → makin
bagus pencocokan → makin besar penghematan). Dan **cold start-nya hilang**:
likuiditas sudah ada di Uniswap/Arcus, kamu jadi sumber order flow mereka, bukan
pesaing. Satu solver referensi milikmu sendiri cukup untuk demo hidup di mainnet.

---

# BAGIAN D — YANG SUDAH DIGUGURKAN

Bagian ini penting untuk pitch: ia membuktikan orisinalitas bukan lewat klaim,
tapi lewat audit.

## D1. Sudah diambil orang lain — jangan bangun

| Ide | Sudah dikerjakan siapa |
|---|---|
| AI agent trading saham tokenized | **Robinhood sendiri** (Agentic Trading, Mei 2026) + AlphaGrid + Tilt Protocol ($100K) + Bond.Credit ($50K) |
| Track record agent + alokasi modal | **AlphaGrid** — persis ini, di Robinhood Chain, menang London |
| RWA yield / auto-compounding | Agama Finance (live di RH Chain), Saffron |
| Index / basket token | EqualFi; dan Arbitrum memakainya sebagai tutorial resmi |
| Corporate actions engine | ERC-8056 sudah native + CorpAction Engine di HackQuest |
| Cap table / programmable equity | Obolos |
| Lending stock token | Morpho (menopang Robinhood Earn) |
| Oracle harga off-hours | **Chainlink 24/5**, **RedStone Live** |
| Risk parameter otomatis | **Chaos Labs**, **Gauntlet** |
| Kurangi leverage jelang close | gTrade sudah bertahun-tahun |
| Copy/social trading | Karma (live di RH Chain) |
| Prediction market | Meridian (RH Chain), Laytus (menang NYC) |
| Agent spending limits | Open Wallet Standard, ERC Spend Mandate, session keys |
| Verifiable inference (zkML) | EZKL, Giza, Ritual, Inference Labs ($6,3jt), Lagrange |
| Agent identity & reputation | ERC-8004, ERC-8126, AgentRank |

## D1b. Eksekusi berbasis intent — kategori JENUH, arus stock token belum

⚠️ Bagian ini ditambahkan 11 Agustus 2026. Sebelumnya D1 tidak memuat satu pun
kompetitor intent settlement — celah audit yang berbahaya, karena inilah kategori
tempat Nokturn berada.

**Klaim yang HARAM dipakai di pitch:** *"intent layer pertama untuk stock token"*.
Salah, dan mudah dipatahkan juri dalam satu pencarian.

| Protokol | Mekanisme | Status di Robinhood Chain |
|---|---|---|
| **UniswapX** | Dutch auction per-order, filler kompetitif | ✅ **Live & dipakai** — lihat pengukuran di bawah |
| **1inch Fusion / Aqua** | resolver + Dutch auction | ✅ Launch partner. Klaim "$2,5 miliar di trade saham tokenized" **sudah diuji — tidak tereproduksi**, lihat §D1c |
| **CoW Protocol** | batch auction ~30 dtk + CoW matching | ❌ Tidak ada deployment resmi. Ada satu `GPv2Settlement` di `0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD` dengan **5 transaksi** — bukan deployment CoW DAO |
| **Arcus** (tim dYdX) | DEX spot + perps stock token | ✅ Live 1 Juli, ~285rb tx minggu pertama. Venue, bukan lapisan intent |

### Pengukuran onchain (11 Agustus 2026, blok 33.769.192 — riwayat metode)

| Kontrak | Angka |
|---|---|
| **UniswapX `Fill` event, total sejak peluncuran** | 22.068 *(kumulatif, jendela tidak seragam — digantikan tabel bulanan di bawah, 10 September 2026)* |
| ↳ reactor `0x000000007a1c8e570011eedf86a2a35593013cba` | 93 tx `execute` |
| ↳ reactor `0x56d7f29b2d7f5bfeb0f024e0e391a8e75f3cc2dd` (`V3DutchOrderReactor`) | 928 tx (banyak `cancel`) |
| Router dominan `0x65050A9B…` (`swap(...)`, `0x4d819a2a`) | 17.236.459 tx *(kumulatif — lihat pecahan bulanan di bawah)* |
| Uniswap `UniversalRouter` | 7.457.565 tx |
| `1inch AggregationRouterV6` `0x1111…2A65` | 81 tx |

**Komposisi fill (sampel 20 receipt terbaru):** 19 menyentuh USDG, **hanya 2 yang
menyentuh NVDA atau TSLA.** Sisanya token lain (`0xdf0992e4…` muncul 79 kali).
Sampel kecil — perlakukan sebagai indikasi, bukan angka publikasi.

### ⭐ Pangsa eksekusi berbasis intent, per bulan — terukur ulang 10 September 2026

> Menggantikan angka kumulatif lama *"22.068 Fill vs 17,2 juta tx router dominan"*,
> yang mencampur jendela waktu berbeda. Sekarang per bulan, dari `robinhood.logs`
> topic0 `0x78ad7ec0…` dan `robinhood.transactions`. Detail metodologi:
> `parameter.md` §10.4. Kueri: **8663798**.

| Bulan | `Fill` UniswapX | Pengirim tx berbeda | Tx router `0x65050A9B…` | **Rasio Fill : tx router** |
|---|---|---|---|---|
| Juli 2026 | 16.072 | 21 | 14.974.096 | **0,11%** |
| Agustus 2026 | 20.898 | 41 | 8.812.691 | **0,24%** |
| Sep 2026 (1–10) | **27.931** | **87** | 13.669.524 | **0,20%** |

⚠️ **Catatan kejujuran wajib.** Klaim "pangsa intent masih kecil" bertahan (di bawah
0,25% di ketiga bulan) dan sekarang lebih kuat karena punya denominator bulanan yang
bisa dijalankan ulang siapa pun. Tapi arahnya jelas naik: sepuluh hari pertama
September sudah melampaui seluruh Agustus, dan pengirim tx berbeda naik 21 → 41 → 87.
**Jangan bingkai ini sebagai kategori sepi/kosong** — itu klaim yang sudah digugurkan
audit 11 Agustus. Bingkai sebagai kategori yang **baru mulai**, dengan Nokturn masuk
lebih awal.

### Kesimpulan yang boleh dipakai

1. Kategorinya **tidak kosong**. UniswapX hidup dan dipakai di chain ini, dan
   sedang tumbuh cepat (lihat tabel bulanan di atas).
2. Tapi rasio Fill terhadap tx router dominan **di bawah 0,25% di ketiga bulan
   terukur**: eksekusi berbasis intent adalah **pangsa kecil**, dan sebagian
   besarnya **bukan stock token**. Ini justru menguatkan asumsi pangsa awal 10–20%
   di backtest netting.
3. Framing yang bertahan: **bukan** "intent layer pertama", tapi *"lapisan settlement
   yang tahu jam bursa dan menerbitkan baseline-nya"*, masuk ke kategori yang baru
   mulai tumbuh, bukan kategori kosong.

### Yang benar-benar belum ada di protokol mana pun

| Pembeda | Kenapa tidak dimiliki kompetitor |
|---|---|
| **Baseline sebagai catatan yang bisa diaudit** ⚠️ *dipersempit — lihat §D1d* | CoW/UniswapX/1inch menilai solver secara offchain. **Atlas sudah memakai baseline sebagai harga cadangan**, tapi kontraknya nol event dan kegagalannya revert — jadi tidak bisa diaudit belakangan. Yang belum ada: baseline diterbitkan bersama hasil eksekusi, **termasuk untuk kegagalan** |
| **Parameter eksekusi settlement spot berubah per sesi** ⚠️ *dipersempit — lihat §D1e* | Kompetitor intent (CoW/UniswapX/1inch) memperlakukan NVDA persis seperti WETH. Kesadaran jam bursa **memang ada** di tempat lain — Dinari & Ondo di level mint/redeem, gTrade & Ostium di level leverage perps — tapi tidak ada di level kliring batch. Padahal 74,1% trade terjadi saat pasar tutup dan p99 melonjak 209,3 → 1.779,4 bps (8,5×; klaim lama "p90 69,0 → 230,5 bps, 3,3×" gugur — direvisi 3 September 2026) |
| **Netting antar-counterparty untuk stock token** | CoW melakukan CoW matching, tapi tidak ada yang mengukurnya di kelas aset ini. Kurva backtest **21,4% → 50,1%** (pangsa 5% → 100%, Agustus 2026) belum dipublikasikan siapa pun |

### ⚠️ Pelajaran metodologi — kejadian KETIGA

Percobaan pertama menyimpulkan *"reactor UniswapX ~0 transaksi"*. **Salah.**
Penyebabnya: pencarian Blockscout hanya mencocokkan **nama kontrak terverifikasi**,
dan tiga `ExclusiveDutchOrderReactor` yang muncul memang mati. Reactor yang hidup
tidak terverifikasi atau bernama lain, jadi tidak pernah muncul di hasil pencarian.

Jalur yang benar: `eth_getLogs` atas topic0 `Fill(bytes32,address,address,uint256)` =
`0x78ad7ec0e9f89e74012afa58738b6b661c024cb0fd185ee2f616c0a28924bd66`, dipotong
per 2–4 juta blok (query rentang penuh time out).

> **Pencarian berbasis nama bukan pencarian berbasis perilaku.** Cari event-nya,
> bukan namanya. Sama seperti pelajaran `dex.trades` dan `creation_traces`.

## D1c. Uji klaim 1inch "$2,5 miliar trade saham tokenized"

Diukur 11 Agustus 2026 lewat `dex_aggregator.trades` (Dune), `project LIKE '1inch%'`,
di-join ke `tokens.erc20` per chain, sejak Juni 2025. Query: Dune **8295069**.

### Hasil

| Kelompok | Volume | Trade |
|---|---:|---:|
| Ondo Global Markets (sufiks `…on`) | **$896.113.627** | 322.592 |
| ↳ di antaranya `CRCLon` + `COINon` | $618.814.479 | 14.024 |
| xStocks / Backed (sufiks `…x`) | $15.701.510 | 4.057 |
| Ticker telanjang (mayoritas false positive) | $64.808.069 | — |

**Rentang terukur: $293 juta (konservatif) – $912 juta (longgar).**
Klaim $2,5 miliar **tidak tereproduksi** pada chain yang bisa diukur — meleset
**2,7×–8,5×**.

### Tiga alasan angka ini belum final

1. **`CRCLon` + `COINon` mencurigakan.** Rata-rata per trade $24.585–$86.577,
   sementara `NVDAon` $521 dan `AAPLon` $352 — timpang 50–150×. Dua token ini saja
   = **69% dari total Ondo**. Kemungkinan besar bug harga di spell, bukan volume nyata.
   Karena itu batas konservatif mengeluarkannya.
2. **Base dan Solana belum terukur.** Base selalu timeout di tier `free` (batas 2
   menit) bahkan setelah dipotong per kuartal. Solana **tidak ada** di
   `dex_aggregator.trades`, padahal itu rumah utama xStocks. Kalau klaim 1inch
   mencakup Solana, selisihnya bisa mengecil.
3. **Penyaringan penyamar belum tuntas.** Klasifikasi masih berbasis sufiks simbol,
   bukan verifikasi issuer per alamat. Sufiks pun bisa menipu: `MetaX` cocok dengan
   pola `META`+`x` tapi bukan ekuitas. `amount_usd` juga **nol** untuk seluruh xStocks
   di chain Ink meski trade-nya nyata (NVDAx 727 trade) — jadi angka xStocks
   understated.

### False positive yang wajib dibuang (bukti aturan §5 CLAUDE.md)

| Simbol | Volume | Sebenarnya |
|---|---:|---|
| `CVX` | $52.935.630 | **Convex Finance**, bukan Chevron |
| `GME` | $6.033.771 | memecoin, bukan Stock Token |
| `BAD` | $1.872.150 | cocok pola `BA`+`D` — token acak |
| `WMTX` | $919.887 | World Mobile Token, bukan Walmart |
| `GS` (arbitrum) | $17.812 | token acak — **satu-satunya "ekuitas" 1inch di Arbitrum** |

Kalau dikelompokkan berdasarkan simbol saja, angka 1inch menggelembung
**$64,8 juta** dari token yang sama sekali bukan ekuitas.

### Kesimpulan untuk pitch

- **Jangan pakai angka $2,5 miliar sebagai fakta**, baik untuk memuji maupun
  menyerang 1inch. Sebut: *"klaim publik, tidak tereproduksi pada chain terukur;
  rentang terukur $0,3–0,9 miliar dengan Base dan Solana belum tercakup."*
- **Arus tokenized-equity 1inch praktis seluruhnya Ondo di Ethereum + BNB.**
  Bukan Robinhood Chain, bukan Stock Token. Di Robinhood Chain,
  `AggregationRouterV6` `0x1111…2A65` hanya **81 transaksi**.
- Artinya kompetitor terdekat Nokturn **tidak bermain di aset yang sama**.
  Ini menguatkan posisi, tapi hanya kalau disampaikan dengan angka yang jujur.

## D1d. Atlas & Pyth Express Relay — pembeda "baseline" harus dipersempit

Diperiksa 11 Agustus 2026. **Temuan terpenting: klaim "tidak ada yang menerbitkan
baseline" TIDAK bisa dipertahankan apa adanya.**

### Atlas (FastLane) — tumpang tindih nyata

Atlas `FastLaneOnline` / Rocketboost sudah memakai mekanisme baseline:

- Frontend meminta kuotasi **baseline lewat viewcall onchain** ke router DEX
  (Quickswap v2 / pool Uniswap), lalu menanamkannya ke dalam intent pengguna.
- Solver **harus mengalahkan baseline itu** untuk memenangkan lelang.
- Kalau **semua solver gagal**, baseline swap dieksekusi untuk pengguna.

Ini konsep yang sama dengan gagasan baseline Nokturn, dan sudah live lebih dulu
(Polygon PoS). **Jangan pernah bilang "belum ada yang melakukannya".**

### Yang masih kosong — dan ini terverifikasi, bukan asumsi

Saya baca dua kontrak utamanya:

| Kontrak | Event |
|---|---|
| `FastLaneOnlineOuter.sol` | **Nol** event dideklarasikan maupun di-emit |
| `FastLaneOnlineControl.sol` | **Nol** event dideklarasikan maupun di-emit |

Kegagalan pun **revert** (`FLOnlineOuter_FastOnlineSwap_NoFulfillment`), bukan
diterbitkan sebagai event. Artinya baseline Atlas dipakai sebagai **harga cadangan
di dalam transaksi**, bukan sebagai **catatan publik yang bisa diaudit belakangan**.

⚠️ Batas pemeriksaan: hanya dua file itu. Kontrak `Atlas` inti belum saya baca.

### Tiga perbedaan yang bertahan

1. **Baseline sebagai catatan, bukan cuma cadangan.** Nokturn menerbitkannya di
   event di samping hasil eksekusi — **termasuk untuk kegagalan** (`CLAUDE.md` §7).
   Atlas tidak menerbitkan apa pun.
2. **Sumber baseline.** Atlas: viewcall ke router, dipasok frontend → percaya pada
   pilihan sumber si frontend. Nokturn: **dihitung dari state pool di dalam
   kontrak**. Ini bukan pilihan gaya — di Robinhood Chain `staticcall` ke Quoter
   memang tidak bisa dipakai (P1-1), jadi pendekatan Atlas **tidak jalan di sini**.
3. **Kelas aset & sesi.** Atlas tidak tahu jam bursa. Tidak berubah.

### Konteks strategis

**Chainlink mengakuisisi Atlas pada 22 Januari 2026**, dan Atlas kini *exclusively
backs SVR* — produk pemulihan OEV likuidasi. Arah lelang order flow umum (Rocketboost)
tampaknya ditinggalkan. Ruangnya kosong bukan karena tidak terpikirkan, tapi karena
pemiliknya pindah fokus. **Sebutkan ini apa adanya** — lebih kuat daripada berpura-pura
tidak ada pendahulu.

### Pyth Express Relay — bukan kompetitor untuk pembeda ini

- Lelangnya **off-chain**, sealed-bid; hanya transaksi pemenang yang masuk onchain.
- Cakupannya likuidasi dan operasi bernilai yang ditentukan protokol — **bukan** swap
  pengguna dengan baseline harga.
- Tidak ada baseline onchain. Tidak menyentuh jam bursa.

Yang ia tempati: gagasan **lelang yang dikendalikan protokol**. Itu saja.

## D1e. Ondo & Dinari — mereka membangun VENUE, bukan lapisan di atas venue

Diperiksa 11 Agustus 2026, menyusul temuan §D1c bahwa Ondo adalah pemegang arus
ekuitas terbesar di 1inch.

### Ondo — pivot ke lapisan eksekusi sendiri

- **Ondo Network** live **27 Juli 2026**, menggantikan rencana Ondo Chain L1.
  Arsitekturnya memisahkan eksekusi, verifikasi, dan settlement: order dicocokkan
  **privat di dalam TEE**, attestor terdesentralisasi memverifikasi bahwa enclave
  menjalankan kode yang disetujui, settlement ke chain publik (mulai dari Ethereum).
- Ondo Global Markets → **Ondo Stocks**, TVL menembus **$1 miliar**, 438+ saham.
- Juli 2026: mint/redeem 24/7, tidak lagi terikat jam Wall Street.
- Aplikasi pertama: **Ondo Perps** — perps ekuitas 24/7, leverage sampai 20×.

**Yang diverifikasi attestor adalah integritas kode enclave, bukan kualitas harga.**
Tidak ada benchmark eksekusi maupun perbandingan baseline yang dipublikasikan.
Ini klaim yang berbeda kelas dari klaim Nokturn: *"kode yang benar berjalan"*
lawan *"harga ini bisa Anda bandingkan sendiri"*.

### Dinari — orderbook L1 sendiri

- **Dinari Financial Network**: L1 omni-chain orderbook di atas Avalanche.
- 4 Agustus 2026: seluruh **724 emiten S&P 500** bisa ditransaksikan langsung dari
  dompet self-custody oleh investor AS yang memenuhi syarat, memakai USDC.
- Kemitraan Flow Traders untuk perdagangan 24/7; kemitraan tZERO menyasar broker.
- Settlement **T+0 onchain**; kalau mint di luar jam bursa, saham dasarnya dibeli
  pada pembukaan berikutnya.

### Dampak ke posisi Nokturn

**Tidak menggugurkan.** Keduanya membangun **venue**, dan `CLAUDE.md` §4 sudah
memutuskan Nokturn bukan venue tandingan melainkan lapisan di atas venue yang ada.
Justru bertambahnya venue = bertambahnya permukaan yang bisa diagregasi.

**Tapi dua kalimat harus dipersempit:**

1. ❌ *"Tidak ada yang tahu jam bursa."* **Salah.** Dinari menangani jam bursa di
   level mint/redeem (beli saham dasar pada pembukaan berikutnya), Ondo melepas
   keterikatan jam Wall Street pada Juli 2026, dan gTrade/Ostium sudah lama
   mengatur leverage menjelang penutupan.
   ✅ Yang benar: **tidak ada yang mengubah parameter eksekusi settlement spot
   per sesi.** Kesadaran jam bursa yang ada semuanya di level *penerbitan* atau
   *leverage perps*, bukan di level *kliring batch*.

2. ❌ *"Belum ada lapisan settlement untuk ekuitas tokenized."* **Salah** — Ondo
   Network persis menyebut dirinya lapisan eksekusi/settlement.
   ✅ Yang benar: **belum ada yang settlement-nya terbuka dan bisa diverifikasi
   pihak luar.** Ondo memilih TEE privat; verifikasinya soal integritas kode, bukan
   soal harga yang bisa dihitung ulang oleh siapa pun dari state onchain.

### Kalimat yang aman dipakai

> Ondo dan Dinari membangun venue tertutup untuk ekuitas tokenized — TEE privat dan
> orderbook L1. Keduanya meminta Anda memercayai bahwa eksekusinya benar. Nokturn
> tidak meminta kepercayaan itu: baselinenya diterbitkan di event, dihitung dari
> state pool, dan bisa dihitung ulang siapa pun — termasuk ketika settlement gagal.

## D1f. Pesaing sekamar di Open House Singapore — belum bisa dilihat

Diperiksa 11 Agustus 2026.

**Submission Singapore belum dibuka.** Jendelanya **14 Sep – 4 Okt 2026** (T&C:
tenggat 1 Okt 23:59 SGT). Tidak ada project gallery untuk dilihat hari ini, dan
tidak akan ada sampai pertengahan September.

⚠️ Halaman HackQuest sempat merender ketiga tanggal jadwal sebagai `Aug 11, 2026
16:45` — itu artefak render, bukan jadwal. **Jangan panik membaca halaman itu
lewat scraper.** Sumber kebenaran jadwal tetap `docs/hackathon.md` §Schedule + T&C.

### Yang bisa diukur: base rate dari edisi sebelumnya

Gallery London, NYC, India, dan APAC bersifat publik. Hasil penyisiran:

**Nol proyek** tentang settlement berbasis intent, batch auction, atau order flow
auction — di seluruh edisi. Kategori ini belum pernah muncul di Open House.

Tapi RWA adalah tema paling ramai: **88 tim fokus RWA** dari 900+ pendaftar program
mentorship Arbitrum. Yang paling berdekatan dengan Nokturn:

| Proyek | Deskripsi | Jarak |
|---|---|---|
| **Quay Markets** | DEX berbasis oracle, market maker profesional mengutip stock token | 🟡 Terdekat — tapi **venue**, bukan lapisan di atas venue |
| **Capricorn** | DEX komposabel, likuiditas kelas HFT untuk RWA | 🟡 Venue |
| **Centok** | Akses saham dengan hambatan birokrasi lebih sedikit | 🟢 Onboarding, bukan eksekusi |
| **EqualFi** (menang NYC $5rb) | Infrastruktur RWA, index/basket | 🟢 Sudah ada di §D1 |

### Kesimpulan

- **Risiko pendahulu: rendah.** Kategori ini nol dalam empat edisi.
- **Risiko pesaing serentak: sedang.** RWA ramai, dan pola yang berulang adalah
  **orang membangun venue**. Kalau ada yang bertabrakan, kemungkinan besar bentuknya
  venue lagi — dan posisi "lapisan di atas venue" justru menguat, bukan melemah.
- **Tidak bisa dituntaskan sekarang.** Ini bukan riset yang gagal; ini riset yang
  belum bisa dijalankan. Periksa ulang **setelah 14 September**, dan sekali lagi
  menjelang tenggat.

## D2. Kandidat primitif yang diuji dan gugur

Kerangka uji: **(A)** kategori kosong · **(B)** basis pengguna ada hari ini,
terukur · **(C)** bisa dibangun berkualitas dalam 60 hari.

| Primitif | A | B | C |
|---|---|---|---|
| Opsi / derivatif terstruktur | ✅ | ❌ 804 pemegang EOA > $1k *(terukur 10 Sep 2026)*; tidak ada pembeli vol | ❌ bug margin = insolvensi |
| Yield tokenization (Pendle) | ✅ | ⚠️ 2.923 penyimpan USDG | ❌ Pendle sudah punya kemitraan USDG — tinggal deploy |
| Stablecoin / CDP | ✅ | ❌ balik ke 804 wallet | ⚠️ |
| Cross-margin | ✅ | ⚠️ | ❌ butuh integrasi permissioned |
| Asuransi / cover | ✅ | ❌ | ⚠️ |
| **Settlement berbasis intent** | ✅ | ✅ **139.093 dompet aktif/bulan** (Agustus 2026) | ✅ **permukaan kecil** |

## D3. Pelajaran yang mengikat semuanya

> **Kategori yang kosong di chain ini sebagian besar kosong karena basis asetnya
> belum ada — bukan karena belum terpikirkan. Kekosongan kategori bukan otomatis
> peluang. Uji basis penggunanya dulu.**

---

# BAGIAN E — FAKTA TEKNIS ROBINHOOD CHAIN

| Item | Nilai |
|---|---|
| Mainnet | 1 Juli 2026 · **chain ID 4663** |
| Testnet | **chain ID 46630** · `https://rpc.testnet.chain.robinhood.com` |
| Arsitektur | Arbitrum Orbit, settle ke Ethereum, DA blobs, gas = ETH, block ~100ms |
| **Stylus** | **Aktif** |
| Account abstraction | ERC-4337 + EIP-7702 live di canonical address |
| Oracle | **Chainlink `DualAggregator`** — 30 feed, 8 desimal, hidup 24 jam. ⚠️ **RedStone tidak ada di chain ini** (terverifikasi) |
| Stablecoin native | USDG (Global Dollar) — kanonik `0x5fc5360d0400a0fd4f2af552add042d716f1d168`, **6 desimal** |
| Compliance | Chainalysis KYT di level jaringan, tiap transfer |
| Dev fund | Robinhood commit **$1 juta** untuk ekosistem developer |
| Verifikasi kontrak | Blockscout |

**Stock Token:** ERC-20 18 desimal, OpenZeppelin beacon proxy, **ERC-8056**
(`uiMultiplier()` + event `UIMultiplierUpdated` untuk split/dividen tanpa mengubah
`balanceOf`). Struktur hukum: *tokenized debt securities* dari Robinhood Assets
(Jersey) Limited — tanpa hak suara atau kepemilikan. Ada transfer restriction
(gate KYC/yurisdiksi); tidak tersedia di AS, dibatasi di UK/Kanada/Swiss/UAE.

Contoh alamat mainnet: NVDA `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` ·
TSLA `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` ·
SPY `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C`

### ⚠️ Risiko teknis nomor satu — uji di hari pertama
Apakah hook transfer Stock Token bisa **menggagalkan** transfer karena gate
KYC/yurisdiksi? Kalau bisa, satu intent yang gagal tidak boleh menjatuhkan seluruh
batch — dan itu mengubah desain `finalize()`. Jangan tunggu minggu ketiga.

---

# BAGIAN F — TEMUAN SAMPINGAN (arsip)

Saat memvalidasi data, ditemukan **sedikitnya 9 kontrak bersimbol USDG /
"Global Dollar"** di chain ini. Yang kanonik punya 27,8 juta transfer; sisanya —
"United States Global Dollars", "Globals Dollars", "global dollar", semuanya
18 desimal versus 6 desimal yang asli — mengumpulkan **~790 ribu transfer**.

Perlu verifikasi lanjutan (sebagian mungkin bridged/wrapped yang sah), tapi pola
nama dan desimalnya mengarah ke impersonasi. Robinhood menyebut *compliance*
sebagai prioritas ekosistem dan belum ada yang mengisinya.

Disimpan sebagai arsip — **bukan** yang dibangun sekarang.

### F1. Konfirmasi 1 Agustus 2026 — polanya meluas ke Stock Token

Temuan USDG di atas ternyata **bukan kasus terisolasi**. Saat memverifikasi universe
token untuk backtest netting, ditemukan **`0xc2362aff2a2a4cc1f48cf3dab2c4e2605eb94ba3`**
— `name()` "GameStop", `symbol()` "GME" — yang **bukan Stock Token**: slot beacon
ERC-1967 kosong, tidak punya `uiMultiplier()`, `totalSupply` 100 miliar, dan kodenya
44 byte (klon minimal) versus 283 byte beacon proxy milik token asli.

**Ia menarik $29,6 juta volume dalam 250.840 trade selama Juli 2026.**

Dua konsekuensi:

1. **Operasional, berlaku sekarang.** Jangan pernah mengelompokkan token berdasarkan
   simbol. Verifikasi lewat beacon. Detail di [`parameter.md`](parameter.md) §10.1.
2. **Untuk arsip ini.** Kalau impersonasi terjadi pada USDG **dan** pada Stock Token,
   ia karakteristik chain, bukan anomali. Itu memperkuat catatan bahwa ada kekosongan
   compliance — tapi tetap **bukan** yang dibangun sekarang.

---

## Sumber utama

- [Robinhood built a blockchain for tokenized stocks — memecoins took over (CoinDesk)](https://www.coindesk.com/tech/2026/07/13/robinhood-built-a-blockchain-for-tokenized-stocks-memecoins-took-over)
- [Robinhood Chain Mainnet & Stock Tokens — Newsroom](https://robinhood.com/us/en/newsroom/robinhood-accelerates-global-expansion-robinhood-chain-mainnet-stock-tokens-agentic-trading/)
- [Build Your First Robinhood Chain App — Arbitrum Foundation](https://blog.arbitrum.foundation/build-your-first-dapp-on-robinhood-chain/)
- [Chainlink Tokenized Equity Feeds — Robinhood](https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood)
- [ERC-8056: Scaled UI Amount Extension](https://eips.ethereum.org/EIPS/eip-8056)
- [CoW Protocol — Fair Combinatorial Batch Auction](https://docs.cow.fi/cow-protocol/concepts/introduction/fair-combinatorial-auction)
- [Automated Market Making and Loss-Versus-Rebalancing (LVR)](https://arxiv.org/pdf/2208.06046)
- [Top Founders Take Home $300K at London Founder House](https://blog.arbitrum.foundation/top-founders-take-home-300k-at-london-founder-house/)
- [NYC Founder House — $340K in Awards](https://blog.arbitrum.foundation/nyc-founder-house-concludes-with-340k-in-awards-to-winning-teams/)
- [Southeast Asia Leads Tokenized Asset Trading in 2026](https://www.asiabusinessoutlook.com/news/southeast-asia-leads-tokenized-asset-trading-in-2026-nwid-11771.html)

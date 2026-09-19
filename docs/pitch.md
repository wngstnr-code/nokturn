# Nokturn — Pitch

> Dokumen ini mengunci **cara menyampaikan** Nokturn: kalimat pembuka, klaim yang
> boleh dipakai, klaim yang haram, dan kesiapan terhadap kriteria juri.
>
> Sumber pembedanya: audit kompetitor 11 Agustus 2026 di `ide-utama.md` §D1b–§D1f.
> Sumber pola pemenangnya: `hackathon.md` §Pola pemenang edisi sebelumnya.
>
> **Kalau audit baru menggugurkan sebuah klaim, perbarui file ini di hari yang sama.**

---

## 1. Kalimat satu baris

> ⚠️ **Direvisi 10 September 2026 — struktur dua lapis.** Versi sebelumnya membuka
> dengan metafora struk. Struk tetap dipakai, tapi **turun satu tingkat jadi lapisan
> bukti**, bukan lapisan pembuka. Alasannya di bawah; jangan kembalikan ke urutan lama
> tanpa alasan baru.

### Lapis 1 — pembuka & penutup: rel harga penutupan

> **Saham tokenized di Robinhood Chain diperdagangkan 24/7, tapi chain ini tidak
> punya satu pun harga pembukaan maupun penutupan resmi. Nokturn membentuknya —
> lelang penutupan onchain, tiap hari, dari permintaan-penawaran nyata, yang bisa
> dibaca protokol mana pun.**

### Lapis 2 — bukti yang bisa dipegang: metafora struk

> **Dan setiap transaksi dapat struk: harga yang Anda dapat, di sebelah harga
> pembandingnya, tercatat onchain. Termasuk ketika transaksinya gagal.**

### Kenapa urutannya begini

Pola pemenang (`hackathon.md`) memberi dua sinyal yang harus dipatuhi sekaligus, dan
satu kalimat tidak bisa memuaskan keduanya:

| Pola | Tuntutannya | Dipenuhi oleh |
|---|---|---|
| #1 — hadiah utama jatuh ke **rel dengan cerita institusional**, bukan mekanisme terpintar | Kalimat pembuka harus terdengar seperti infrastruktur yang dipakai orang lain | **Lapis 1.** Harga penutupan adalah **barang publik** — dan permintaannya terukur: 2.048 pengguna lewat produk yang menyelesaikan pada harga saham di satu titik waktu, hari ini cuma punya oracle spot yang beku 48–56 jam tiap akhir pekan |
| #5 — proyek paling **mekanis** mentok di posisi 2 | Jangan membuka dengan lelang, batch, atau netting | Lapis 1 menyebut **hasil** (harga penutupan), bukan mekanismenya |
| #6 — juri NYC menilai **kejelasan produk** | Harus ada satu angka yang bisa juri periksa sendiri | **Lapis 2.** Struk adalah demo, dan `demo.md` §1 dibangun di sekelilingnya |

**Kenapa lapis 1 lebih tahan banting daripada angka mana pun.** Ketiadaan harga
penutupan resmi di chain ini adalah **fakta struktural yang terverifikasi**
(`transmitSecondary` Chainlink tidak pernah dipakai; feed beku 48–56 jam tiap akhir
pekan) — bukan statistik yang bisa berubah bulan depan. Klaim p90 "3,3× lebih buruk"
sudah gugur sekali karena bertumpu pada distribusi; jangan ulangi kesalahan yang sama
dengan menaruh seluruh berat pitch di rasio p99. Lihat §4.

⭐ **Dan sejak 10 September 2026, lapis 1 punya angkanya sendiri.** Ini kalimat
pendukung terkuat untuk pembuka — pakai persis:

> **Di chain ini, 38 kontrak dari 24 operator berbeda — melayani 2.048 pengguna —
> membaca harga ekuitas onchain 64.671 kali dalam sepuluh hari. Semuanya oracle
> spot, karena itu satu-satunya yang ada. Tidak satu pun bisa menjawab "berapa
> harga penutupan NVDA kemarin?"**

Terukur 1–10 September 2026 (kueri `8664020`, `8664034`, `8664051`). Closing print
diterbitkan lewat `AggregatorV3Interface` — **interface yang sudah dipakai kontrak-
kontrak itu** — sehingga biaya adopsinya satu alamat, bukan satu proyek integrasi
(`desain-auction.md` §3.3).

> 🔴 **Angka ini sempat salah dua kali dalam satu hari, dan itu justru cerita yang
> layak diceritakan.** Percobaan pertama menghitung jalur tulis feed sebagai
> konsumen (~3× terlalu besar). Percobaan kedua mengukur di lapisan agregator, satu
> lapis terlalu dalam (~37× terlalu kecil, menghasilkan angka "20 kontrak" yang
> **jangan dipakai lagi**). Kalau juri bertanya bagaimana kami memvalidasi angka,
> ini jawabannya — lihat tabel percobaan di `desain-auction.md` §3.3.

### ⚠️ Empat batas yang mengikat lapis 1

Sebut yang relevan **bersamaan dengan klaimnya**, jangan tunggu ditanya.

| Batas | Rumusannya |
|---|---|
| **Bukan "pertama di dunia"** | Lelang onchain sudah ada (Uniswap CCA, lihat §3b). Yang boleh: chain ini **tidak punya** harga pembukaan/penutupan resmi, dan **kami membentuknya** |
| 🔴 **Tidak satu pun konsumen bisa kami sebut namanya** | Semua kontraknya **belum terverifikasi di Blockscout**; operator terbesar EOA anonim. Jangan pernah menyebut nama protokol tertentu. Yang boleh: permintaannya **terhitung dan bisa dijalankan ulang** |
| 🔴 **Jangan bilang "protokol lending butuh ini"** | Terukur: irisan lending cuma **20–38 pengguna**, dan seluruh bukunya **~$11.176** — 0,015% dari Stock Token onchain (kueri `8664264`). Mayoritas permintaan datang dari **produk taruhan atas harga saham** (`betMsft`, `betUsdg`, `JackpotFunded` — kueri `8664130`). Rumusan yang benar: *"produk yang menyelesaikan pada harga saham di satu titik waktu"*. Lihat `desain-auction.md` §3.3b |
| ✅ **Yang BOLEH dibilang soal lending — dan ini KUAT** | **Ripe Protocol** live di chain ini, dan tagline mereka sendiri: *"Borrow Against Your Tokenized Stocks Without Selling."* Terkonfirmasi lewat nama kontrak terverifikasi (`Teller`, `CurvePrices`) + token `sGREEN`, bukan tebakan. **Tapi sebut ukurannya duluan:** bukunya **~$11.176**. Rumusan: *"Ada protokol yang seluruh produknya meminjam dengan agunan saham tokenized. Bukunya sebelas ribu dolar hari ini. Kami sebut angkanya karena itulah keadaannya — dan karena kami tidak bergantung padanya."* |
| ⭐ **Jalur integrasi yang bisa ditunjuk** | Ripe punya **`PriceDesk.vy`**, *"oracle aggregator routing price requests through prioritized sources"*. Closing print masuk sebagai **satu sumber tambahan**, bukan pengganti — persis peran yang sudah dirancang ada. Ditambah permukaan `AggregatorV3Interface`, biaya integrasi mendekati nol. ⚠️ Tetap **belum ada komitmen** dari mereka; jangan sekali pun menyiratkan sebaliknya |
| ⭐⭐ **Kandidat terbesar justru bukan Ripe** | Operator desk `0xCFBD7E12…` memegang **$377.558** Stock Token (34× Ripe) dengan arus masuk **$874.940/10 hari**, menjual eksposur dari inventaris sungguhan dan mengutip dari feed yang beku 48–56 jam tiap akhir pekan. Ia butuh **closing print** — kandidat konsumen terkuat yang terukur. ⚠️ **Jangan bilang ia juga order flow:** diuji dan gugur — seluruh volume DEX mereka token treasury sendiri, cuma **8 trade** menyentuh Stock Token (kueri `8664756`). Mereka menahan risikonya, tidak melindung nilai. ⚠️ **Tidak bisa disebut namanya** (kontrak inti tidak terverifikasi, penyisiran web nihil) — rujuk lewat alamat, jangan pernah karang nama |
| **Angkanya batas bawah** | Pembacaan `eth_call` di luar transaksi tidak muncul di trace. Dan 38 sudah dibuang smart account per-pengguna, infrastruktur harga, serta jalur tulis — jadi ia angka konservatif, bukan angka terbaik |
| **Bisa dijangkau ≠ sudah berkomitmen** | Belum ada satu pun protokol yang setuju memakai closing print. Menyiratkan sebaliknya melanggar `demo.md` §5 — larangan yang lahir dari kekalahan nyata, bukan dari kehati-hatian |

### Versi 15 detik — kalau juri bertanya "kenapa perlu?"

> Tiga dari empat transaksi saham tokenized terjadi saat bursa AS tutup — sepertiganya
> di akhir pekan, ketika feed oracle berhenti diperbarui dua hari penuh. Sepanjang itu
> tidak ada satu pun harga resmi untuk dijadikan acuan. Nokturn mengumpulkan transaksi
> selama 45 detik, menjodohkan yang saling berlawanan supaya tidak perlu lewat pasar
> sama sekali, menerbitkan harga pembandingnya — dan di batas sesi, menutup hari dengan
> **satu harga penutupan** yang terbentuk dari permintaan-penawaran nyata. Siapa pun
> bisa menghitung ulang sendiri.

### Versi juri teknis

> Lapisan settlement berbasis intent untuk ekuitas tokenized, yang menghitung baseline
> dari state pool **di dalam kontrak** dan menerbitkannya bersama hasil eksekusi —
> termasuk pada kegagalan. Parameternya berubah per sesi bursa.

### Alternatif

| Kalimat | Kuat untuk | Lemah untuk |
|---|---|---|
| *"Seperti lelang pembukaan bursa, tapi onchain dan 24 jam."* | juri berlatar finansial | juri kripto — terdengar seperti fitur, bukan protokol. **Sejak revisi 10 Sep 2026 sebagian besar perannya sudah diambil lapis 1**, yang menyebut hasilnya (harga penutupan) alih-alih mekanismenya (lelang) |
| *"Kami tidak minta Anda percaya harga kami. Kami terbitkan pembandingnya."* | **penutup** | pembuka — terlalu abstrak tanpa konteks |

Ketiganya sengaja menghindari "order", "MEV protection", dan "slippage protection"
sesuai `glosarium.md`.

---

## 2. Klaim yang HARAM — digugurkan audit 11 Agustus 2026

Semua baris di bawah ini **pernah ada** di dokumen proyek dan terbukti salah.
Memakainya berarti menyerahkan kredibilitas seluruh bagian "sudah digugurkan".

| ❌ Jangan pernah bilang | Kenapa salah | ✅ Katakan ini |
|---|---|---|
| "Intent layer pertama untuk stock token" | **UniswapX live dan dipakai di Robinhood Chain**, dan **tumbuh**: `Fill` naik 16.072 → 20.898 → **27.931** per bulan (Jul → Agu → 1–10 Sep 2026, kueri `8663798`). 1inch launch partner | "Lapisan settlement yang tahu jam bursa dan menerbitkan baseline-nya" |
| "Kategorinya kosong / belum ada yang menyelesaikan secara batch" | CoW Protocol batch auction sejak 2020; UniswapX live di chain ini | "Mekanismenya sudah terbukti. Yang belum ada adalah versi yang sadar sesi dan bisa diaudit" |
| "Belum ada yang menerbitkan baseline" | **Atlas (FastLane)** sudah memakai baseline sebagai harga cadangan, live di Polygon | "Atlas memakai baseline sebagai cadangan di dalam transaksi. Nol event — jadi tidak bisa diaudit belakangan. Kami menerbitkannya" |
| "Tidak ada yang tahu jam bursa" | Dinari (mint/redeem), Ondo (lepas jam Wall Street Juli 2026), gTrade & Ostium (leverage jelang tutup) | "Tidak ada yang mengubah **parameter eksekusi settlement spot** per sesi" |
| "Belum ada lapisan settlement untuk ekuitas tokenized" | **Ondo Network** (27 Juli 2026) menyebut dirinya persis itu | "Belum ada yang settlement-nya **terbuka dan bisa diverifikasi pihak luar**. Ondo memilih TEE privat" |
| "Terukur 63,8% netting" | Backtest kontrafaktual — Nokturn belum ada saat itu | "**Backtest** 27–33% pada pangsa awal realistis" |
| 🔴 "Eksekusi off-hours 3,3× lebih buruk di p90" | **Digugurkan data Agustus 2026.** Likuiditas off-hours membaik drastis; selisih p90 menyusut dari 2,47× (Juli) ke **1,27×** (Agustus), dan akhir pekan praktis setara jam bursa buka | "Masalahnya pindah ke ekor: p99 off-hours **1.779 bps vs 209 bps** saat bursa buka — **8,5×**, dan melebar sementara ekor jam buka menyempit" |
| 🔴 "51,2% aktivitas saat bursa tutup" | Angka Juli, sudah usang | "**74,1% trade** dan **65,2% volume** saat bursa tutup (Agustus 2026); **33,2%** di akhir pekan saja" |
| "1inch cuma $0,3 miliar padahal klaim $2,5 miliar" | Base & Solana belum terukur; klaimnya bisa mencakup Solana | "Tidak tereproduksi pada chain terukur; rentang $0,3–0,9 miliar, Base dan Solana belum tercakup" |

---

## 3. Klaim yang BERTAHAN — dan buktinya

Empat pembeda inti, sudah dipersempit sampai tidak bisa dipatahkan dengan satu
pencarian. Pembeda kelima — lelang di batas sesi — ada di §3b.

| Pembeda | Bukti yang bisa ditunjukkan |
|---|---|
| **Baseline sebagai catatan yang bisa diaudit, bukan sekadar harga cadangan** | `FastLaneOnlineOuter.sol` dan `FastLaneOnlineControl.sol` = **nol event** dideklarasikan maupun di-emit; kegagalan **revert**, tidak diterbitkan |
| **Parameter eksekusi settlement spot berubah per sesi** | Kesadaran jam bursa yang ada semuanya di level penerbitan (Dinari, Ondo) atau leverage perps (gTrade, Ostium) — bukan kliring batch |
| **Netting antar-counterparty untuk stock token, dikuantifikasi** | Kurva **21,4% (pangsa 5%) → 50,1% (pangsa 100%)** — **backtest** Agustus 2026; belum dipublikasikan pihak mana pun. ⚠️ *Label diperbaiki 10 Sep 2026: baris ini sempat tertulis "terukur". Netting **selalu** backtest — `demo.md` §5* |
| ⭐ **Closing print yang bisa diinjak hari ini, bukan diusulkan** | **38 kontrak dari 24 operator** membaca harga ekuitas **64.671×/10 hari**, melayani **2.048 pengguna akhir** (kueri `8664020`, `8664051`) — semuanya lewat `AggregatorV3Interface`, dan itu persis interface yang kami terbitkan. Biaya adopsi = satu alamat. Ditambah semantik penahanan: lelang yang terlalu tipis **menolak menerbitkan harga**, bukan menerbitkan angka lemah (`desain-auction.md` §3.3) |

**Argumen pendukung terkuat — pakai ini, bukan klaim orisinalitas:**

> Chainlink mengakuisisi Atlas by FastLane pada 22 Januari 2026, dan mengarahkannya
> *exclusively* ke SVR — pemulihan OEV likuidasi. Pendahulu terdekat kami dibeli lalu
> dialihkan ke masalah lain. Ruangnya kosong bukan karena tidak terpikirkan.

Alasan teknis kenapa pendekatan Atlas **tidak bisa** dipakai di sini, bukan soal selera:
di Robinhood Chain `staticcall` ke Quoter tidak bisa dipakai untuk baseline (P1-1) —
baseline **harus** dihitung dari state pool di dalam kontrak.

---

## 3b. Pembeda kelima — lelang sesi (audit selesai 12 Agustus 2026)

❌ **Jangan bilang "lelang onchain belum ada".** Uniswap **CCA** (Continuous Clearing
Auctions) sepenuhnya onchain di v4, menghasilkan satu harga kliring pasar.

✅ **Rumusan yang bertahan:**

> Lelang onchain sudah ada — Uniswap CCA. Tapi itu **peluncuran token: sekali jalan,
> untuk aset yang belum punya harga.** Yang belum ada adalah lelang **berulang di
> batas sesi**, untuk aset yang **sudah diperdagangkan**, dengan **publikasi
> imbalance** dan **harga penutupan harian**.

**Tiga pembanding sudah ditutup:**

| Kandidat | Hasil |
|---|---|
| **Figure OPEN** | Bursa ekuitas teregulasi onchain di Provenance — **limit order book, perdagangan kontinu**, bukan lelang. Pembanding paling mungkin, dan mereka **memilih kontinu** |
| **Uniswap CCA** | Lelang onchain sungguhan, tapi untuk distribusi token — bukan sesi |
| **Superstate Opening Bell** | Penerbitan saham ter-registrasi SEC dengan harga acuan Nasdaq/NYSE — bukan lelang |

⚠️ Batas bukti: siaran pers Figure OPEN tidak menyebut jam maupun lelang secara
eksplisit; ketiadaan lelang disimpulkan dari struktur order book-nya. Kalau ditanya,
sebut batas itu — jangan mengklaim lebih pasti dari buktinya.

**Argumen terkuat dari audit ini** — dan pakai ini, bukan klaim "belum ada":

> Figure membangun bursa ekuitas teregulasi onchain dan **memilih perdagangan
> kontinu**. Uniswap membangun lelang onchain dan memakainya untuk **peluncuran
> token**. Keduanya melewati lelang sesi. Itu bukan celah yang tidak terlihat —
> itu celah yang belum ada yang butuh, sampai ada aset onchain yang nilainya
> ditentukan bursa yang tutup.

### ⭐ Bukti baru 11 September 2026 — pasarnya sudah berperilaku seperti punya lelang

Argumen di atas menjelaskan kenapa celahnya ada. Yang baru: **buktinya bahwa
permintaan itu sudah kelihatan di data**, bukan cuma disimpulkan.

> **Jam 13:00 UTC — jam yang memuat pembukaan NYSE 09:30 ET — memegang 10,62%
> volume dari hanya 6,35% trade. Rasio 1,67×. Uang besar sudah berkumpul di batas
> sesi, di pasar yang tidak punya mekanisme lelang untuk menampungnya.**

Ukuran tiket rata-rata per jendela mengonfirmasi arah yang sama: jam Asia **0,84×**
rata-rata, jam Eropa (memuat pembukaan NYSE) **1,21×**.

Terukur 1 Agustus – 11 September 2026, 10,19 juta trade, $1.253,6jt volume, allowlist
v1.0. Kueri permanen & publik: [`8680028`](https://dune.com/queries/8680028).

**Kenapa ini kuat:** ia mengubah lelang sesi dari *"celah yang belum ada yang butuh"*
menjadi *"perilaku yang sudah terjadi tanpa mekanismenya"*. Itu jenis bukti yang
tidak bisa dibantah dengan menunjuk kompetitor.

## 4. Angka yang boleh dipakai, dan labelnya

> **Seluruh blok ini diganti 3 September 2026 ke data Agustus.** Angka Juli tidak
> boleh dipakai lagi di permukaan mana pun — kalau juri menjalankan ulang kueri Juli
> hari ini, sebagian tidak akan tereproduksi.

| Angka | Label wajib |
|---|---|
| **74,1% trade** / **65,2% volume** stock token saat bursa tutup | terukur, Agustus 2026 |
| **33,2% trade di akhir pekan** | terukur — **angka paling kuat**, naik dari 12,9% di Juli |
| **p99 off-hours 1.779 bps vs 209 bps saat buka (8,5×)** | terukur — ini pengganti klaim p90 yang gugur |
| p90 off-hours 57,4 bps vs 45,1 bps saat buka (1,27×) | terukur — **sebutkan duluan**, ini angka yang melemah |
| **139.093 dompet aktif** di stock token (Agustus) | terukur, bulanan aktif — bukan kumulatif, bukan snapshot |
| **804 pemegang EOA > $1.000** (1.174 termasuk smart wallet) | terukur, **10 September 2026** — menggantikan "477", yang sekarang HARAM dipakai. Kueri `8663760` |
| **$75,62jt** total Stock Token dipegang onchain | terukur, **10 September 2026** — menggantikan "$27,2jt". Kueri `8663760` |
| **$31,3jt** dipegang Uniswap V4 PoolManager vs **$3,86jt** di pool V3 tersibuk | terukur, 10 Sep 2026 — **sisi Stock Token saja, bukan TVL pool.** Kueri `8663787` |
| **38 kontrak dari 24 operator, 2.048 pengguna akhir, 64.671 pembacaan / 10 hari** | terukur, 1–10 Sep 2026 — **angka pendukung lapis 1.** Kueri `8664020` · `8664034` · `8664051`. Tiga batas wajib ikut: **batas bawah**, **tidak ada yang bisa disebut namanya** (semua kontrak belum terverifikasi), dan **bisa dijangkau ≠ sudah berkomitmen**. ⚠️ Angka lama "20 kontrak / 64.809" **HARAM** — salah lapisan |
| **27–33% netting** | **backtest**, antar-counterparty, pangsa awal 10–20% |
| 50,1% netting antar-counterparty | **backtest**, mengasumsikan monopoli arus |
| 63,8% netting gross | **backtest** — hindari, definisinya masih memuat bot bolak-balik |
| Volume DEX chain **$34,9 miliar/bulan**; stock token **1,43%** (allowlist v1.0) | terukur, Agustus 2026 |
| **Uniswap V3 = 82,5%** volume allowlist (Agustus) | terukur — 🔴 **selalu sebut arahnya:** turun ke **72,63%** di Sep 1–10. Adapter agnostik-factory memulihkan ke **77,14%** dengan pool `gigadex` + `ramsesxyz vcl` yang **sudah diverifikasi byte-identik V3** (P5-1). Kueri `8664785`, lihat `parameter.md` §10.1 |
| **`Fill` UniswapX = 0,24% (Agu) / 0,20% (Sep 1–10) dari tx router dominan** | terukur, **10 September 2026**, per bulan. Menggantikan "22.068 vs 17,2 juta", yang mencampur jendela waktu dan tidak bisa direproduksi. Kueri `8663798` |
| ⚠️ `Fill` UniswapX naik **16.072 → 20.898 → 27.931** (Jul → Agu → Sep 1–10) | terukur — **sebutkan duluan.** Ini angka yang melawan kita: eksekusi berbasis intent tumbuh cepat. Bingkai sebagai kategori yang **baru mulai**, bukan kategori yang sepi |

**Kenapa 27–33% justru lebih kuat daripada 21–29% yang lama.** Bukan karena lebih
besar. Angka lama dihitung dengan definisi **gross**, yang masih menghitung bot
bolak-balik sebagai netting. Angka baru dihitung dengan definisi yang **lebih ketat**
— bot sudah dibuang — dan tetap keluar lebih tinggi. **Metodologinya diperketat,
angkanya naik.** Itu kalimat yang tidak bisa diserang, dan jauh lebih berharga
daripada angka besar.

Asumsi pangsa awal 10–20% tetap punya dasar terukur: eksekusi berbasis intent masih
pangsa kecil di chain ini, dan mayoritasnya bukan stock token.

**Sisi lemah yang harus disebut duluan, bukan ditunggu ditanya:** di pangsa 10–20%,
rata-rata hanya ada **2,5–3,3 pedagang berbeda per batch**. Netting-nya nyata, tapi
batch-nya tipis — dan itulah alasan durasi batch dibuat adaptif sampai 180 detik.

**Sisi lemah kedua, ditambahkan 10 September 2026:** dari $75,62jt Stock Token
onchain, **82,1% dipegang kontrak** dan **delapan alamat memegang $47,23jt**. Nilai
yang dipegang langsung oleh dompet pribadi cuma **$13,56jt**. Cara menyampaikannya:

> *"Kepemilikan ritelnya masih tipis, dan kami sebut angkanya. Tapi Nokturn tidak
> melayani stok — ia melayani arus: 8,58 juta trade dan 139.093 dompet aktif per
> bulan. Sebagian besar nilai itu duduk di pool, dan pool adalah tempat baseline
> kami dihitung."*

Ini jawaban yang sudah harus siap sebelum ditanya, karena pertanyaan **"berapa
pemegang sungguhan?"** adalah serangan paling murah ke kriteria Product-Market Fit.

---

## 5. Kesiapan terhadap kriteria juri

Dua set kriteria tidak identik — HackQuest 4 butir, T&C 6 butir. Gabungannya:

| Kriteria | Status | Catatan |
|---|---|---|
| **Deployed di chain Arbitrum** | 🔴 Belum | **Syarat lolos**, bukan kriteria nilai. Tanpa ini nol |
| Smart contract quality | 🔴 Belum ada kode | Tidak bisa dinilai |
| Technical implementation | 🔴 Belum ada kode | Tidak bisa dinilai |
| Innovation / Creativity | 🟢 Kuat | Bertahan setelah lima putaran audit |
| Novelty (bonus T&C) | 🟢 Kuat | Baseline yang bisa diaudit — terverifikasi di kontrak Atlas |
| Real Problem Solving | 🟢 Kuat — **tapi hanya di lapis 1** | Ketiadaan harga penutupan resmi adalah **fakta struktural**, dan permintaannya terhitung: 38 kontrak, 24 operator, 2.048 pengguna, 64.671 pembacaan / 10 hari. Lapis 2 dan 3 **pendukung, bukan fondasi** — rincian dan jawaban jujur di §5a |
| Potential impact | 🟢 Kuat | Kurva netting **21,4% → 50,1%**; pasar tumbuh 3,6× volume dan 2,3× dompet dalam sebulan |
| Product-Market Fit | 🟢 **Kuat** ⬆️ | **Dinaikkan 10 September 2026** dari 🟡. Ketiga angka usang sudah diukur ulang: pemegang > $1k **477 → 804** (+69%), nilai dipegang **$27,2jt → $75,62jt** (2,8×), di atas **139.093 dompet aktif**/bulan. Butir ini dulu lemah karena angkanya kedaluwarsa, bukan karena pasarnya kecil |
| **Presentation quality** | 🔴 **Terlemah** | Belum ada permukaan produk |
| Use of Arbitrum technology | 🟡 Belum diputuskan | Stylus menunggu benchmark |

**Empat butir merah menuntut kode yang berjalan.** Aturan *original work* di T&C
justru melarang implementasi dimulai sebelum Buildathon (14 September); brainstorming,
riset, dan wireframing sebelum event diperbolehkan. Posisi sekarang — riset onchain
selesai, semua P0 terjawab, desain terkunci — **tepat apa yang boleh dikerjakan**.

**Yang tidak bisa dikejar dengan riset lebih banyak:** deployment dan presentasi.
Keduanya hanya selesai dengan mengirim kode dan membangun permukaan yang bisa dilihat.

---

## 5a. Real Problem Solving — rincian dan batasnya

> Disusun 11 September 2026. Butir ini dipecah keluar dari tabel §5 karena satu sel
> tidak bisa memuat perbedaan kekuatan antar-lapisan — dan perbedaan itulah yang
> menentukan apakah klaimnya bertahan saat ditekan.
>
> **Aturan pemakaian: pimpin dengan lapis 1. Selalu.** Lapis 2 dan 3 hanya boleh muncul
> sebagai pendukung. Memimpin dengan lapis 3 mengulang persis kesalahan yang sudah
> menggugurkan klaim p90 3,3×.

### Tiga lapis, diurutkan dari yang paling tahan tekanan

| # | Masalah | Kekuatan | Kenapa |
|---|---|---|---|
| **1** | **Chain ini tidak punya harga pembukaan/penutupan resmi** | 🟢 **Kuat** | **Fakta struktural, bukan statistik.** `transmitSecondary` Chainlink tidak pernah dipakai; feed beku 48–56 jam tiap akhir pekan. Tidak bisa gugur bulan depan karena distribusinya bergeser |
| **2** | **74,1% arus berjalan tanpa harga pembanding yang bisa diverifikasi** | 🟡 **Sedang** | Nyata secara logis, tapi **tidak terasa**. Tidak ada yang mengeluh, karena tidak ada yang bisa tahu. Itu sekaligus alasan celahnya masih terbuka **dan** alasan ia sulit dijual sebagai rasa sakit |
| **3** | **Kualitas eksekusi off-hours** | 🔴 **Lemah — sebagian sudah mati** | p50 6,5–7,6 bps (baik), p90 off-hours **1,27×** (nyaris tanpa selisih), akhir pekan praktis setara jam bursa buka. **Masalah median sembuh sendiri dalam sebulan, tanpa Nokturn.** Yang tersisa cuma ekor p99 8,50× |

### Kenapa lapis 1 memenuhi definisi "masalah nyata" secara ketat

Bukan karena angkanya besar — tapi karena **jenis buktinya**. Ada pihak yang sudah
membayar biaya workaround hari ini:

> **38 kontrak dari 24 operator berbeda — melayani 2.048 pengguna — membaca harga
> ekuitas onchain 64.671 kali dalam sepuluh hari. Semuanya oracle spot, karena itu
> satu-satunya yang ada.**

Itu tanda tangan masalah nyata: **kode yang sudah ditulis membutuhkannya, lalu
terpaksa memakai pengganti yang lebih buruk.** Bukan masalah yang perlu diyakinkan
ke siapa pun — masalah yang sudah dialami diam-diam.

⭐ **Penguat kedua, 11 September 2026 — tidak ada satu pun jam mati.**

> **Tiap jam dari 24 jam memuat 2,76%–6,90% trade, dan jam paling sepi sekalipun
> masih punya 30.544 pengirim berbeda (tersibuk: 55.100). Pasar ini benar-benar
> tidak pernah tidur — dan tidak satu pun dari jam-jam itu punya harga resmi.**

Untuk pasar yang asetnya ditentukan bursa yang tutup 17,5 jam sehari, distribusi
serata itu adalah fakta struktural, bukan statistik yang bisa bergeser. Ia menutup
bantahan paling jelas terhadap lapis 1 — *"kalau tidak ada yang berdagang saat tutup,
buat apa harga penutupan?"* Terukur 1 Agustus – 11 September 2026, 10,19 juta trade,
kueri permanen & publik [`8680028`](https://dune.com/queries/8680028).

Terukur 1–10 September 2026, kueri `8664020` · `8664034` · `8664051`.
⚠️ Batas-batas yang wajib disebut bersamaan dengan klaim ini ada di **§1 "Empat batas
yang mengikat lapis 1"** — terutama: **tidak satu pun konsumen boleh disebut namanya**,
dan **belum ada satu pun yang berkomitmen**.

### ⭐ Konsekuensi yang belum eksplisit di dokumen lain: siapa pelanggannya

Lapis 1 adalah masalah **infrastruktur**, bukan masalah **pengguna akhir**. 2.048
pengguna itu ada **di balik** 38 kontrak. Artinya pelanggan Nokturn yang sebenarnya
adalah operator kontrak, bukan trader ritel.

Itu bukan kelemahan — itu **justru pola #1 pemenang** (`hackathon.md`): hadiah utama
jatuh ke rel, bukan ke aplikasi ritel. Liquida menang dengan rel agunan gilt.

**Konsekuensi ke permukaan produk:** yang didemokan seharusnya **kontrak lain membaca
closing print Nokturn lewat `AggregatorV3Interface`**, bukan seseorang menekan tombol
swap. Biaya adopsinya satu alamat, bukan satu proyek integrasi. Lihat §6 dan
`demo.md` §1.

### Dua hal yang harus disebut duluan, bukan ditunggu ditanya

**1. 🔴 Metrik eksekusi bukan kerugian — dan kami belum mengukur kerugiannya.**

"Pergerakan harga antar-trade" adalah **proxy kualitas eksekusi**, bukan *realized
loss* yang dialami pengguna. Pembedaan ini sudah kami buat sendiri di konteks lain
(`pertanyaan-terbuka.md` §RONDE 4, soal drift TSLA: *"Itu bukan metrik yang sama"*).

Kalau juri bertanya **"jadi berapa dolar yang hilang?"** — jawabannya:

> *"Itu proxy kualitas eksekusi, bukan kerugian yang direalisasi. Kami belum mengukur
> angka dolarnya, dan kami tidak mau mengarangnya. Yang sudah terukur adalah
> ketiadaan harga pembandingnya — dan itu yang kami perbaiki."*

Jangan karang angka dolar. Melanggar aturan 9 (`CLAUDE.md`) sekaligus §4 dokumen ini.

**2. Pasarnya kecil — sebut duluan.**

Allowlist v1.0 = **1,43%** dari volume DEX chain. **804 EOA** pegang > $1k. Cuma
**$13,56jt** ada di dompet pribadi (82,1% sisanya di kontrak). Kalau kami yang bilang
"kecil", itu kekuatan. Kalau juri yang menemukannya duluan, itu kelemahan.

### Yang HARAM di butir ini

| Jangan tulis | Kenapa |
|---|---|
| *"Eksekusi off-hours 3,3× lebih buruk"* | Digugurkan data Agustus 2026. Lihat §2 |
| Memimpin dengan ekor p99 8,50× | Statistik distribusi — jenis klaim yang sudah gugur sekali di dokumen ini |
| *"Pengguna kehilangan $X"* | Belum diukur. Metriknya proxy, bukan realized loss |
| Menyebut nama protokol konsumen | Kontraknya belum terverifikasi di Blockscout. Lihat §1 |
| *"Protokol lending membutuhkan ini"* | Irisan lending cuma 20–38 pengguna, buku ~$11.176 |
| 🔴 *"Arus off-hours ini pada dasarnya arus Asia / Asia Tenggara"* | **Diuji 11 September 2026 dan GUGUR.** Jam 00–09 UTC (08–18 SGT) cuma memuat **33,54%** trade — **di bawah** ekspektasi merata 41,67%. Puncaknya justru sesi NYSE. Kueri `8680028` publik, jadi juri bisa membantahnya sendiri |

---

## 5b. Roadmap untuk submission — yang dibaca juri

> Ini versi **keluar**. Rencana operasi internalnya di `roadmap.md` — jangan
> tertukar: yang itu memuat struktur payout, negosiasi KPI, dan cabang kalau kalah.
> Juri tidak perlu membacanya.
>
> Kriteria yang menilai bagian ini: *"roadmap ringkas yang berlanjut setelah
> Buildathon"* (kriteria pemenang NYC) dan **potential impact** (T&C).

### Versi tabel — pakai ini di form submission

| Fase | Kapan | Yang dikirim | Bagaimana Anda bisa memeriksanya |
|---|---|---|---|
| **v1.0 — Buildathon** | Okt 2026 | Settlement batch sadar sesi · baseline diterbitkan onchain · lelang buka/tutup · adapter Uniswap V3 · allowlist 5 token (NVDA, AAPL, TSLA, GOOGL, GME) | Kontrak terverifikasi di Blockscout; tiap batch punya event berisi baseline |
| **Audit & mainnet** | Nov–Des 2026 | Audit keamanan eksternal · deploy mainnet dengan allowlist minimal · operasi tiap malam | Laporan audit publik; alamat kontrak; batch bisa ditelusuri |
| **Bukti, bukan janji** | Des 2026 – Jan 2027 | **Laporan mingguan: price improvement vs baseline, rasio netting, batch berhasil dan gagal** | Diterbitkan terbuka, termasuk minggu yang jelek |
| **v1.1** | Q1 2027 | Adapter Uniswap V4 lewat allowlist time-lock, tanpa deploy ulang · ring trade multi-aset | Perubahan allowlist punya time-lock 48 jam yang bisa diawasi |
| **Port Stylus** | Q1 2027, bila benchmark mendukung | `ClearingVerifier` versi Rust. **Menuntut Settlement baru, bukan proposal time-lock** | Alamat kontrak baru, diumumkan sebagai migrasi dan bukan sebagai pembaruan |
| **Perluasan** | Setelah price improvement konsisten 2 minggu | Allowlist keluar dari ekuitas — mesin yang sama melayani sisa volume chain | Satu transaksi time-lock, bukan protokol baru |

### Empat kalimat yang membuat roadmap ini berbeda

Sertakan keempatnya. Ini yang membedakan roadmap jujur dari roadmap generik:

1. **Kami tidak menjanjikan jumlah pengguna.** Milestone pertama kami adalah *price
   improvement terukur pada batch mainnet nyata, konsisten dua minggu* — angka yang
   bisa diverifikasi orang lain, bukan angka yang bisa kami karang.
2. **Kami menerbitkan minggu yang jelek juga.** Konsistensi menerbitkan angka buruk
   adalah satu-satunya alasan orang percaya angka bagusnya.
3. **Perluasan pasar menunggu bukti, bukan momentum.** Mesin yang sama bekerja untuk
   seluruh volume chain, tapi allowlist tidak dibuka sebelum eksekusi ekuitasnya
   terbukti.
4. **Settlement core immutable, tanpa proxy.** Yang bisa berubah hanya allowlist dan
   parameter, lewat time-lock 48 jam. Roadmap ini **tidak bisa** dijalankan dengan
   diam-diam mengubah aturan main di belakang pengguna.

> ### ⚠️ Dua baris roadmap di atas datang lewat jalur yang berbeda, jangan disamakan
>
> Ini kalimat yang paling gampang salah diucapkan, dan juri yang membaca kontraknya
> akan menangkapnya.
>
> **Adapter V4 datang lewat time-lock.** `adapterAllowed` adalah mapping yang
> dikuasai timelock, jadi menambah venue adalah satu proposal 48 jam dan kontraknya
> tidak berubah sama sekali.
>
> **Port Stylus tidak bisa.** `verifier` adalah `immutable` di `Settlement`, jadi
> menukarnya berarti **Settlement baru di alamat baru**. Tidak ada proposal timelock
> yang bisa melakukannya, dan itu memang disengaja. Verifier adalah yang memutuskan
> sebuah solusi sah, dan kunci yang bisa menukarnya adalah kunci yang bisa mengubah
> arti seluruh protokol dalam satu transaksi.
>
> Rumusan yang benar kalau ditanya: *"Venue baru masuk lewat time-lock. Mengganti
> verifier tidak bisa, karena ia immutable, jadi port Stylus adalah migrasi ke kontrak
> baru yang kami umumkan sebagai migrasi."*
>
> **Haram:** menyebut port Stylus sebagai "upgrade", "pembaruan", atau apa pun yang
> menyiratkan alamat yang sama. Itu klaim yang dipatahkan dengan satu pembacaan
> `Settlement.sol` baris 72.

### Yang HARAM masuk roadmap submission

| Jangan tulis | Kenapa |
|---|---|
| Token, poin, airdrop, TGE | Keputusan final, `distribusi.md` §6. Menyebutnya sekali saja merusak posisi "tanpa kunci yang bisa memindahkan dana" |
| Target jumlah pengguna atau TVL | Tidak bisa diverifikasi, dan mengundang pertanyaan **"berapa pemegang sungguhan?"** dalam bentuk terburuknya — 804 EOA > $1k, dan cuma $13,56jt dipegang dompet pribadi. Jawabannya sudah disiapkan di §4; jangan pancing pertanyaannya lebih awal dari yang perlu |
| "Multi-chain" / "cross-chain" di v1.x | Belum ada di scope mana pun. Menambahnya terdengar seperti roadmap tempelan |
| Tanggal yang lebih presisi dari yang bisa dipenuhi | Audit eksternal punya waktu tunggu yang tidak kita kendalikan. Pakai bulan, jangan tanggal |
| Fitur yang belum diputuskan (mis. port Stylus tanpa "bila benchmark mendukung") | Kondisikan, jangan janjikan |
| Port Stylus disebut sebagai upgrade atau pembaruan | `verifier` immutable, jadi ia Settlement baru di alamat baru. Lihat kotak di atas |

### Kalau hanya ada ruang untuk tiga baris

> **Okt 2026** — v1.0: settlement batch sadar sesi dengan baseline diterbitkan onchain, lima token ekuitas, adapter Uniswap V3.
> **Nov–Des 2026** — audit eksternal, mainnet, lalu laporan mingguan price improvement yang bisa diverifikasi siapa pun.
> **Q1 2027** — v1.1 (adapter V4 lewat time-lock) dan perluasan allowlist setelah eksekusi ekuitasnya terbukti konsisten.

## 6. Konsekuensi ke rancangan demo

Dari pola pemenang (`hackathon.md`): hadiah utama jatuh ke rel dengan cerita
institusional, **bukan** ke mekanisme paling pintar; dan proyek paling mekanis
mentok di posisi 2.

1. **Baseline adalah DEMO, bukan slide arsitektur.** Juri bisa memverifikasi satu
   angka; juri tidak akan membaca `desain-kliring.md`. **Rancangannya: `demo.md`.**
2. **Rancang permukaan demo sejak awal, jangan disisakan ke akhir.** Aturan tanpa-mock
   (`CLAUDE.md` §9) membuatnya jauh lebih sulit dirakit belakangan daripada fitur biasa.
3. **Sebut risiko sisa duluan.** `threat-model.md` §5 memuat sepuluh; menyajikannya
   lebih dulu adalah bagian dari posisi proyek ini.
4. **Kontinuitas bernilai.** Payout 25/25/50 terikat milestone pasca-event, dan dua
   tim tercatat menang dua kali.

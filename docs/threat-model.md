# Nokturn — Threat Model

> Ditulis di awal, bukan di akhir. Kesalahan desain adalah kelas bug termahal dan
> **tidak ada alat yang bisa menemukannya** — hanya penalaran eksplisit yang bisa.
>
> Pendamping: `desain-kliring.md` · `desain-auction.md` · `desain-session-engine.md`

---

## 1. Aset yang layak diserang

| Aset | Kenapa berharga | Eksposur |
|---|---|---|
| Dana pengguna saat `finalize()` | Nilai penuh batch | **Hanya di dalam satu transaksi atomik** |
| Dana ter-escrow di lelang | Nilai penuh lelang | 5–10 menit, sejak pembekuan sampai cross |
| Bond solver | Modal solver | Berkelanjutan |
| **Closing print** | **Dikonsumsi protokol lain** — bisa memicu likuidasi di tempat lain | Berkelanjutan, dan **inilah aset bernilai tertinggi** |
| Keadaan sesi | Menentukan price band & exposure cap | Berkelanjutan |
| Fee protokol | Kecil | Berkelanjutan |

**Pengamatan penting:** aset paling berharga bukan dana yang lewat — melainkan
**integritas closing print**, karena kesalahannya merambat ke protokol lain yang
memakainya untuk menandai agunan. Serangan paling menguntungkan bukan mencuri dari
Nokturn, tapi **memakai Nokturn untuk mencuri di tempat lain.**

Ini membentuk seluruh prioritas mitigasi di dokumen ini.

---

## 2. Aktor & batas kepercayaan

| Aktor | Kepercayaan | Yang bisa dia lakukan paling buruk |
|---|---|---|
| Pengguna | Nol | Kirim intent sampah, intent tanpa dana |
| Solver | Nol, tapi **bonded** | Ajukan solusi buruk/tidak valid; menang lalu grief |
| **Koordinator** (mempool intent) | **Semi-terpercaya** ⚠️ | Sensor intent; bocorkan intent ke solver favorit |
| Owner / governance | Terbatas + time-lock 48 jam | Ubah kalender, allowlist, parameter — dalam rentang keras |
| Guardian | Terbatas, **tanpa** time-lock | **Hanya pause.** Tidak bisa memindahkan dana |
| Oracle (Chainlink `DualAggregator`) | Terpercaya dengan pemeriksaan | Beri harga salah/basi |
| Pasar onchain (TWAP UniV3) | Nol kepercayaan; sumber pembanding | Terdislokasi / dimanipulasi lewat volume |
| Venue (Uniswap, Arcus, Rialto) | **Kode eksternal, nol kepercayaan** | Reentrancy, kembalian bohong |
| Sequencer Robinhood Chain | Diwarisi, di luar kendali kita | Urutkan ulang, sensor |

### 2.1 Pembagian kekuasaan yang disengaja

```
Guardian  → pause instan, tanpa time-lock, TIDAK BISA menyentuh dana
Owner     → ubah parameter, time-lock 48 jam, dalam rentang keras
Siapa pun → TIDAK ADA yang bisa memindahkan dana pengguna
```

Polanya: **penghentian darurat harus cepat, tapi harus tidak berdaya.** Guardian
yang dikompromikan hanya bisa mengganggu, tidak bisa mencuri. Owner yang
dikompromikan memberi 48 jam untuk terdeteksi dan direspons.

#### Terpasang 19 September 2026, dan tiga hal yang mempersempitnya

Sampai hari itu bagian ini menggambarkan sesuatu yang belum ada di kode. `Guarded`
sekarang diwarisi `Settlement` dan `AuctionHouse`, dan spesifikasinya ada di
`parameter.md` §8 dengan permukaannya di `interfaces.md` §1.1.

Tiga hal membatasinya, dan ketiganya di kode bukan di kebijakan.

**Tidak ada unpause.** Pause membawa tenggat enam jam dan lepas sendiri. Guardian
tidak bisa mencabutnya, dan tidak ada orang lain yang perlu. Baris lama di
`parameter.md` yang meminta owner meng-unpause setelah enam jam tidak pernah bisa
dieksekusi, karena owner-nya timelock 48 jam.

**Alamatnya parameter, bukan immutable.** Guardian boleh pause lagi begitu yang
lama lepas, jadi kunci yang bocor bisa menahan protokol terus-menerus. Plafonnya
**48 jam**, yaitu waktu timelock merotasi alamatnya.

**Pause tidak pernah menyentuh jalur keluar.** `refundEscrow` baru menjawab setelah
lelangnya terminal, jadi pause yang memblokir `abortAuction` akan menjebak escrow.
Kunci yang bisa menjebak dana sama buruknya dengan kunci yang bisa memindahkannya,
dan lebih licin karena tidak terbaca seperti pencurian. Daftar lengkapnya di
`parameter.md` §8.2, dan `test/Guardian.t.sol` menelusuri tiap jalur keluar dalam
keadaan pause.

---

## 3. Katalog serangan

Kolom **Sisa** = risiko yang masih ada setelah mitigasi. Ditulis jujur.

### 3.1 Lapisan intent

| Serangan | Mitigasi | Sisa |
|---|---|---|
| Replay lintas chain | `chainId` di domain separator EIP-712 | — |
| Replay di chain yang sama | Bitmap nonce | — |
| **Intent sebagai opsi gratis** ⚠️ | Intent yang ditandatangani dan publik pada dasarnya adalah opsi gratis bagi solver — ia bisa menunggu dan hanya menyertakannya saat menguntungkan. Mitigasi: jendela validitas pendek, intent terikat sesi, kliring harga seragam | **Ada.** Melekat pada semua sistem berbasis intent, termasuk CoW. Persempit, tidak bisa dihapus |
| Intent tanpa dana untuk membuang waktu solver | Solver cek saldo & allowance; lelang wajib escrow | Kecil |
| **Sensor oleh koordinator** ⚠️ | **Jalur pengiriman langsung ke kontrak** selalu tersedia sebagai escape hatch — lebih mahal gasnya, tapi tidak bisa disensor koordinator | **Ada**, tapi ada jalan keluar |
| Koordinator membocorkan intent ke solver favorit | Mempool intent publik sejak awal — kalau semua orang melihatnya, tidak ada yang punya keistimewaan | Kecil |

### 3.2 Kliring & settlement

| Serangan | Mitigasi | Sisa |
|---|---|---|
| Solusi tidak valid | Verifier menolak; bond disita | — |
| **Penyalinan solusi** ⚠️ | Solver B melihat solusi A di mempool, ajukan ulang dengan surplus +1 wei. **Tidak ada commit–reveal di v1.** Mitigasi: jendela solusi pendek, syarat bond | **Ada dan diakui.** Item pengerasan v1.1. Sebutkan di pitch |
| Menang lalu gagal `finalize` (grief) | Slashing; siapa pun boleh `finalize`; ada solusi fallback | Kecil |
| Solver tunggal menetapkan fee semaunya | **Batas keras di kontrak: maks 20% savings ATAU 3 bps notional** | — |
| Reentrancy lewat adapter | Allowlist adapter (time-lock) + ReentrancyGuard + **pengukuran delta saldo** | Kecil |
| Token aneh: fee-on-transfer, rebasing, hook ERC-777 | **Jangan pernah percaya nilai kembalian** — ukur saldo sebelum & sesudah. Vetting per-token sebelum masuk allowlist | Kecil |
| Panen debu pembulatan | Pembulatan selalu berpihak ke kontrak; invarian debu ≥ 0; debu disapu ke protokol, bukan ke solver | — |
| `uiMultiplier` berubah di tengah batch | Baca multiplier di awal dan saat settle; kalau berubah → revert batch untuk token itu | — |
| Hook transfer Stock Token menggagalkan transfer | ✅ **Terjawab 31 Juli 2026: tidak ada gate KYC/yurisdiksi.** `transfer` & `transferFrom` via Permit2 ke alamat baru berhasil; semua probe antarmuka pembatasan (ERC-1404, `isBlocked`, `isFrozen`, `isBlacklisted`) revert. Semua Stock Token berbagi satu beacon → logika identik. Desain `finalize()` berlaku apa adanya | **Kecil.** Dua sisa: token **Pausable** (`paused()` ada, kini `false`) → cek sebelum kliring; dan blocklist alamat tersanksi **tidak bisa dibuktikan tidak ada** → balance-delta assertion tetap wajib |

### 3.3 Lelang — permukaan bernilai tertinggi

| Serangan | Mitigasi | Sisa |
|---|---|---|
| Imbalance palsu untuk memancing lawan lalu batal | Escrow sejak pembekuan | — |
| **Manipulasi closing print** ⚠️ | Penyerang berdagang sungguhan pada harga buruk untuk menggeser print, lalu memanen di protokol yang memakainya — likuidasi lending, atau (lebih mungkin di chain ini) penyelesaian taruhan yang ukurannya dia pilih sendiri lebih dulu, lihat §4. Mitigasi: collar terhadap oracle, **ambang volume minimum untuk menerbitkan print**, mekanisme tantangan | **Ada.** Dibatasi lebar collar. Lihat §4 |
| Spam tantangan | Tantangan wajib bond; hadiah hanya kalau berhasil | — |
| Grief tantangan untuk menunda cross | Jendela tantangan tetap; maksimum N tantangan lalu eksekusi yang terbaik | Kecil |
| Lelang gagal, escrow tersangkut | **Jalur pengembalian harus selalu bisa dipanggil**, tanpa syarat, oleh siapa pun. Diuji sebagai invarian | — |

### 3.4 Session engine

| Serangan | Mitigasi | Sisa |
|---|---|---|
| Owner menyisipkan hari libur palsu | Time-lock 48 jam — perubahan kalender selalu terlihat jauh sebelum berlaku | — |
| Oracle dipalsukan agar terlihat basi | Masuk `PROTECTIVE`; keluar hanya setelah N update sehat | Kecil |
| Sequencer menggeser timestamp | Guard band 60 detik; transisi berskala menit, drift detik tidak berpengaruh | — |
| Kesalahan tabel DST | Pengujian habis pada setiap batas selama satu dekade | — |

### 3.5 Oracle

| Serangan | Mitigasi | Sisa |
|---|---|---|
| **Satu feed dikompromikan atau rusak** | **Dua sumber independen: Chainlink + TWAP Uniswap V3.** Selisih > 50 bps → `PROTECTIVE` untuk token itu | Kecil |
| Kedua feed salah bersamaan | Exposure cap membatasi kerugian maksimum | **Ada.** Dibatasi cap |
| Feed basi saat akhir pekan | Toleransi staleness per sesi; band melebar tapi cap mengecil | — |

> ### Keputusan desain — diperbarui 1 Agustus 2026
> Rencana awal memakai **Chainlink + RedStone**. Verifikasi onchain menunjukkan
> **RedStone tidak ada di Robinhood Chain**; dokumentasi chain-nya sendiri hanya
> menyebut Chainlink.
>
> **Pengganti: Chainlink versus TWAP Uniswap V3** — dan ini justru lebih kuat.
> Dua oracle dari kategori yang sama hanya melindungi dari kegagalan operasional.
> **Satu oracle dan satu pasar** melindungi dari keduanya, karena sumbernya
> benar-benar berbeda: Chainlink dari agregasi bursa off-chain, TWAP dari transaksi
> nyata onchain.
>
> Ketidaksepakatannya pun bermakna secara spesifik: entah feed rusak/basi,
> **atau** pasar onchain sedang terdislokasi. Keduanya alasan sah masuk
> `PROTECTIVE`. Ketidaksepakatan adalah informasi.
>
> Biayanya nol tambahan: state pool Uniswap V3 **sudah** dibaca untuk perhitungan
> baseline.

### 3.6 Ekonomi & governance

| Serangan | Mitigasi | Sisa |
|---|---|---|
| Kartel solver mengajukan solusi buruk | **Pass-through otomatis** — kolusi tidak menghasilkan apa pun | — |
| Wash trading untuk memanen imbalan | **Tidak ada token, tidak ada emisi.** Tidak ada yang bisa dipanen | — |
| Owner meng-allowlist adapter jahat | Time-lock 48 jam + rentang parameter keras + exposure cap | Kecil |
| Kunci owner dikompromikan | Time-lock memberi 48 jam untuk deteksi; guardian bisa pause instan | Kecil |
| Kunci guardian dikompromikan | Guardian **hanya bisa pause** — mengganggu, tidak bisa mencuri | — |

> **Properti yang layak disebut ke juri:** karena Nokturn **tidak punya token dan
> tidak punya emisi**, seluruh kelas serangan farming — wash trading, sybil untuk
> reward, likuiditas tentara bayaran — **tidak ada permukaannya sama sekali.**

---

## 4. Serangan bernilai tertinggi, dianalisis serius

### Manipulasi closing print untuk memicu likuidasi di protokol lain

**Kenapa ini yang terburuk.** Nilai yang dipertaruhkan bukan isi batch — melainkan
posisi beragunan di protokol lain yang memakai print kita untuk menandai nilai.
Penyerang bisa rugi kecil di lelang untuk untung besar di tempat lain.

**Jalur serangannya.** Ambil sisi berlawanan di lelang penutupan pada harga
seburuk mungkin dalam batas collar, dorong print ke tepi collar, lalu likuidasi
posisi yang jadi rentan karenanya.

**Mitigasi berlapis:**

| Lapis | Isi |
|---|---|
| Collar | Print tidak bisa menyimpang lebih dari `collarBps` dari oracle. **Ini yang membatasi kerugian maksimum** |
| Ambang volume | Di bawah volume minimum, terbitkan status `insufficient`, **bukan angka menyesatkan** |
| Metadata | Print selalu terbit bersama volume dan jumlah peserta, supaya konsumen bisa menyaring sendiri |
| Tantangan | Harga suboptimal bisa ditantang dan dihukum |
| **Panduan konsumen** | **Dokumentasikan secara eksplisit: pakai print sebagai referensi sekunder, bukan oracle tunggal** |

**Sisa risiko, dinyatakan terus terang:** penyerang bermodal cukup **bisa**
menggeser print dalam batas collar dengan berdagang sungguhan. Yang kita jamin
adalah **batas atas penyimpangan**, bukan kemustahilan.

Lapis terakhir — panduan konsumen — adalah yang paling penting dan paling sering
diabaikan. Menerbitkan angka yang dipakai orang lain untuk melikuidasi posisi
adalah tanggung jawab; katakan batasannya dengan jelas, jangan pasarkan sebagai
oracle sempurna.

### 🔴 Diperbarui 10 September 2026 — risiko ini NAIK, dan kami menaikkannya sendiri

Keputusan hari ini (`desain-auction.md` §3.3) menerbitkan closing print lewat
permukaan **drop-in `AggregatorV3Interface`**, supaya konsumen yang sudah ada bisa
mengadopsinya dengan mengganti satu alamat. Dasarnya terukur: **38 kontrak dari
24 operator berbeda, melayani 2.048 pengguna akhir, membaca harga ekuitas 64.671
kali dalam 10 hari** (kueri `8664020` · `8664051`).

**Konsekuensi jujurnya: keputusan itu menaikkan risiko ini, bukan menurunkannya.**
Biaya adopsi mendekati nol berarti probabilitas dikonsumsi naik, dan probabilitas
dikonsumsi adalah faktor pengali di seluruh analisis di atas. Menurunkan hambatan
adopsi tanpa mengakui ini sama saja memindahkan risiko ke pihak lain diam-diam.

**Satu mitigasi baru, dan kebetulan ia mengenai titik terlemah.**

Serangan ini paling murah tepat ketika **partisipasi tipis** — sedikit lawan berarti
sedikit modal untuk menggeser print ke tepi collar. Semantik penahanan yang baru
menutup persis jendela itu:

> Ketika `PRINT_MIN_VOLUME` (1.000 USDG) atau `PRINT_MIN_PARTICIPANTS` (5) tidak
> terpenuhi, **tidak ada ronde baru yang dibuat.** `latestRoundData` tetap
> mengembalikan print valid terakhir dengan `updatedAt` aslinya yang lebih tua.
> Pemeriksaan staleness milik konsumen sendiri yang kemudian menolaknya.

Artinya: **tidak ada print murah untuk diserang.** Lelang yang cukup tipis untuk
digeser murah adalah lelang yang tidak menghasilkan angka sama sekali. Penyerang
dipaksa masuk ke lelang yang sudah ramai — persis kondisi ketika serangan jadi mahal.

⚠️ Ini **mempersempit**, bukan menutup. Penyerang yang bersedia menyediakan volume
dan peserta sendiri tetap bisa melewati gerbang. Yang berubah adalah harga tiket
masuknya, dan tiket itu kini punya lantai yang bisa dihitung: minimal 5 alamat
berbeda dan 1.000 USDG volume nyata, dieksekusi melawan collar.

### 🔴 Diperbarui lagi 10 September 2026 — profil penyerangnya bukan yang kami kira

Analisis di atas mengasumsikan jalur bayaran **likuidasi di protokol lending**.
Pengukuran komposisi konsumen (`desain-auction.md` §3.3b) menunjukkan itu **irisan
terkecil**: lending cuma 20–38 pengguna. Yang terbesar adalah **produk taruhan atas
harga saham** — `betMsft`, `betUsdg`, `cashOut`, event `JackpotFunded`.

**Itu profil serangan yang berbeda, dan dalam satu hal lebih buruk:**

| | Likuidasi lending | **Penyelesaian taruhan** |
|---|---|---|
| Bayaran | Terbatas ukuran posisi yang rentan | Terbatas ukuran taruhan — bisa **dipilih sendiri penyerang sebelum print** |
| Waktu | Penyerang menunggu posisi jadi rentan | Penyerang **menentukan sendiri** kapan bertaruh |
| Arah | Butuh harga bergerak melewati ambang | Butuh harga bergerak **ke sisi mana pun yang dia taruhkan** |

Penyerang yang bisa memilih ukuran dan arah taruhannya lebih dulu, lalu menggeser
print, punya kendali lebih besar daripada penyerang yang menunggu likuidasi.
**Ini menaikkan prioritas mitigasi, bukan menurunkannya.**

Yang menahan tetap sama dan tetap mengikat: collar membatasi penyimpangan maksimum,
gerbang partisipasi menutup jendela termurah, dan **panduan konsumen di bawah
berlaku untuk produk penyelesaian persis seperti untuk lending** — mungkin lebih.

⚠️ **Kami belum tahu apakah ada produk taruhan yang akan memakai closing print.**
Tidak ada satu pun konsumen yang berkomitmen. Bagian ini adalah pemetaan risiko
**kalau** adopsi terjadi, bukan klaim bahwa ia sudah terjadi.

### Panduan konsumen — versi konkret

Risiko sisa #4 menyebut "panduan konsumen diterbitkan". Ini isinya, dan ia harus
ikut terbit bersama alamat kontraknya, bukan menyusul:

| Aturan untuk konsumen | Kenapa |
|---|---|
| **Pakai sebagai referensi kedua, jangan tunggal** | Print berasal dari satu lelang harian. Ia lebih sulit dimanipulasi daripada spot sesaat, tapi lebih jarang. Keduanya punya kegagalan yang berbeda — pakai keduanya |
| **Terapkan pemeriksaan staleness sendiri** | Kami melaporkan `updatedAt` yang sebenarnya dan tidak pernah memalsukannya, justru supaya pemeriksaanmu bekerja. `PRINT_MAX_AGE_ADVISORY` 30 jam adalah anjuran kami, bukan gerbang kami |
| **Baca metadata volume & peserta sebelum memakai** | Tersedia lewat `INokturnClose`. Print yang lolos gerbang minimum tetap bisa tipis; ambangmu boleh lebih ketat dari ambang kami |
| **Batasi deviasi terhadap oracle primermu** | Kalau print menyimpang lebih dari toleransimu terhadap Chainlink, perlakukan sebagai sinyal untuk berhenti — bukan sebagai harga |
| **Jangan pakai untuk likuidasi otomatis tanpa lapis kedua** | Ini kasus penggunaan paling berbahaya dan paling mungkin dicoba orang. Katakan terus terang, jangan tunggu ada yang rugi dulu |

---

## 5. Risiko sisa — ringkasan jujur

Ini yang kamu katakan ke juri tanpa diminta. Menyajikannya duluan membuatmu
terlihat seperti pembangun sistem produksi; menyembunyikannya lalu ketahuan
membuatmu terlihat sebaliknya.

| # | Risiko sisa | Status |
|---|---|---|
| 1 | **Penyalinan solusi antar-solver** — tidak ada commit–reveal di v1 | Diakui; v1.1 |
| 2 | **Koordinator adalah titik sentralisasi** | Diakui; jalur onchain langsung tersedia sebagai escape hatch |
| 3 | **Masalah opsi gratis** pada intent yang ditandatangani | Melekat pada semua sistem intent; dipersempit, tidak dihapus |
| 4 | **Print bisa digeser dalam batas collar** | Dibatasi, tidak dimustahilkan; panduan konsumen diterbitkan |
| 5 | **Kode belum diaudit pihak ketiga** | Dikompensasi exposure cap, tujuh lapis verifikasi, bug bounty |
| 6 | **Sequencer chain di luar kendali kita** | Diwarisi dari Robinhood Chain. Ada feed liveness di chain ini dan kami memilih **tidak** menggerbanginya. Alasan terukur di bawah tabel |
| 7 | **Blocklist alamat tersanksi tidak bisa dibuktikan tidak ada** — gate KYC sudah terbukti tidak ada, tapi ketiadaan blocklist hanya bisa dibuktikan negatif dari sampel | Dipersempit; balance-delta assertion + `paused()` check |
| 8 | **Feed Chainlink membeku 48–56 jam tiap akhir pekan** — TWAP jadi sumber utama, dan TWAP bisa dimanipulasi lewat volume | Dibatasi `WEEKEND_DRIFT_CAP_BPS` 1.500 + exposure cap ×0,5 + `TWAP_WINDOW` 30 menit |
| 9 | **Nokturn akan jadi program Stylus ke-4 di chain ini** — hanya tiga yang pernah diaktifkan, dua di antaranya cuma dipanggil 1–2 kali. Tidak ada jam terbang Stylus di chain ini untuk dijadikan rujukan | Denda init terukur (46,4rb–49,2rb gas) dan tidak menghalangi; versi Solidity tetap ada sebagai oracle differential, jadi ada jalan mundur kalau Stylus bermasalah |
| 10 | **Dimensi regulasi belum dipetakan** — Stock Token secara hukum adalah *tokenized debt securities* terbitan Robinhood Assets (Jersey) Ltd, bukan saham dan bukan token utilitas. Menjalankan lapisan settlement di atas sekuritas, dengan pengguna nyata dan pengambilan fee, menyentuh wilayah yang belum kami telaah. Transfer restriction memang ada di token (gate yurisdiksi), dan sudah diverifikasi **tidak** memblokir `transfer`/`transferFrom` biasa — tapi ketiadaan gate teknis bukan izin hukum | **Tidak dimitigasi, dibatasi ruang lingkupnya.** Selama buildathon: tanpa pengguna pihak ketiga, tanpa fee, tanpa solicitation — hanya kontrak yang bisa diverifikasi publik plus settlement uji memakai dana sendiri. Konsultasi hukum wajib **sebelum** menerima intent dari orang lain. Jangan jadikan ini kejutan yang muncul pertama kali dari mulut juri |


### Kenapa feed liveness sequencer tidak dipakai, diukur 21 September 2026

Praktik baku di L2 adalah menolak membaca harga sesaat setelah sequencer pulih,
karena transaksi yang tertahan dieksekusi sekaligus di harga yang sudah basi. Chain
ini punya feed untuk itu, di `0x3cd5824b…`, dan kami sempat berencana membacanya.
Pengukuran membatalkannya.

| Waktu | Jawaban |
|---|---|
| 25 Agustus 07.43 | 1 |
| 25 Agustus 07.54 | 0 |
| 25 Agustus 09.19 | 1 lalu 0, di blok yang sama |
| 3 September 16.02 | 1 lalu 0, di blok yang sama |

Enam tulisan seumur hidupnya, dan pembacaan langsung hari ini menjawab **1**, dengan
`updatedAt` 3 September. Delapan belas hari diam. Dalam konvensi Chainlink, 1 berarti
sequencer turun, jadi protokol yang menggerbangi harga dengan feed ini hari ini tidak
akan menyelesaikan satu batch pun.

Ia juga bukan Sequencer Uptime Feed kanonik. `version()` menjawab 1, `decimals()`
menjawab 0, dan namanya sendiri menyebut dirinya *keeper heartbeat*. Dua kali ia
berkedip 1 lalu 0 di dalam satu blok, yang terbaca seperti uji coba dan bukan
insiden.

Jadi gerbang itu tidak dipasang, dan risikonya tetap terbuka apa adanya. Menggerbangi
keamanan dengan sumber yang berperilaku seperti ini menambah permukaan gagal alih
alih menguranginya. Kalau feed ini nanti berdetak teratur dan semantiknya
terdokumentasi, keputusan ini ditinjau ulang.

Kueri `8795706`.

---

## 6. Deteksi & respons

### 6.1 Yang dipantau

| Sinyal | Ambang | Aksi |
|---|---|---|
| Invarian menyimpang | Sekali pun | **Pause otomatis** + alert |
| Harga kliring di tepi collar | 3× berturut-turut | Alert, selidiki |
| Selisih dua oracle | Di atas ambang | `PROTECTIVE` untuk token itu |
| Solusi gagal `finalize` | 2× dalam sehari | Selidiki solver, pertimbangkan slash |
| Volume lelang di bawah minimum | Tiap kejadian | Tandai print `insufficient` |
| Saldo kontrak menyimpang dari yang diharapkan | Sekali pun | **Pause** |

Terpasang 20 September 2026. Keenam sinyal di atas sekarang punya kode dan tempat,
yaitu `M1` sampai `M7` di `parameter.md` §8.3. Lima yang bisa dijawab dari state chain
ada di `contracts/script/MonitorChecks.sol`, dan dua yang butuh riwayat ada di
`contracts/tools/monitor.py`.

Pembagiannya bukan kerapian. Ketiga pemeriksaan yang memanggil pause, yaitu `M1`,
`M2`, dan `M3`, semuanya fungsi murni dari state saat ini, jadi jalur pause tidak
bergantung pada jurnal lokal, indexer, maupun archive node. Yang butuh menghitung
kejadian sepanjang waktu tidak pernah memanggil pause.

### 6.2 Klasifikasi insiden

| Tingkat | Isi | Respons |
|---|---|---|
| **P0** | Dana berisiko, invarian dilanggar | Guardian pause **segera**; umumkan dalam 1 jam |
| **P1** | Print salah terbit; oracle tidak dapat dipercaya | `PROTECTIVE`; beri tahu konsumen print |
| **P2** | Solver berulang kali grief | Slash; naikkan syarat bond lewat `setMinBond`, plafon 50.000 USDG |
| **P3** | Anomali tanpa dana berisiko | Selidiki dalam 24 jam |

Baris P2 sempat menjanjikan sesuatu yang tidak bisa dilakukan. Sampai 20 September
2026 `MIN_BOND` adalah `constant`, jadi satu-satunya cara menaikkan syarat bond
adalah deploy ulang kontrak inti yang immutable. Sejak bond jadi parameter
bergubernur, respons itu benar-benar tersedia, lewat time-lock 48 jam seperti
perubahan parameter lain. Rincian kalibrasinya di `parameter.md` §5A.

### 6.3 Runbook

Ditulis 19 September 2026, sebelum mainnet dan bukan saat insiden terjadi. Kelima
poin di bawah dulu berupa daftar hal yang harus ditulis. Sekarang isinya.

#### 1. Kunci guardian

Satu keystore `cast wallet`, dipegang pemilik proyek, dengan alamatnya tercatat di
`deployments/<chain id>.json` dan di `.env` sebagai `NOKTURN_GUARDIAN`. Ia tidak
memegang dana, jadi kehilangan kunci ini bukan kehilangan aset, melainkan kehilangan
kemampuan menghentikan.

Kalau kunci hilang atau bocor, jalurnya sama, yaitu proposal timelock `setGuardian`
ke alamat baru. Butuh 48 jam, dan selama itu protokol tetap berjalan normal kalau
kuncinya hilang, atau tertahan berulang kalau kuncinya bocor.

Kontak 24 jam bukan janji yang bisa dibuat satu orang. Selama buildathon, ruang
lingkupnya dibatasi ke settlement uji dengan dana sendiri (risiko sisa nomor 10),
jadi tidak ada pihak ketiga yang bergantung pada waktu respons. **Sebelum menerima
intent dari orang lain, ini harus jadi rotasi berisi lebih dari satu orang.** Jangan
biarkan baris ini tetap berbunyi "satu orang" di hari pertama ada pengguna nyata.

#### 2. Kriteria pause

Diturunkan dari §6.1, dan sengaja pendek supaya tidak ada yang diperdebatkan saat
panik. **Pause kalau salah satu terjadi.**

- Invarian mana pun menyimpang, sekali pun
- Saldo kontrak menyimpang dari yang diharapkan, sekali pun
- Insiden P0 menurut §6.2, yaitu dana berisiko

**Jangan pause untuk sisanya.** Harga kliring di tepi collar, selisih oracle, solver
yang gagal `finalize`, dan volume lelang di bawah minimum semuanya punya respons
sendiri yang lebih tepat, dan pause justru menghalanginya. Ketidaksepakatan oracle
ditangani `PROTECTIVE` per token, bukan penghentian protokol.

Ragu antara pause dan tidak, **pause**. Ongkosnya enam jam dan ia lepas sendiri.

#### 3. Template komunikasi

Tiga penerima, tiga isi berbeda.

**Pengguna.** Apa yang berhenti, apa yang tidak, dan kapan ia lepas. Sebut bahwa
escrow dan refund tetap jalan selama pause, karena itu pertanyaan pertama yang akan
muncul dan jawabannya menenangkan.

**Konsumen print.** Print penutupan mana yang terpengaruh, dan apakah ia tetap sah.
Ini yang paling mendesak, karena protokol lain bisa memakai print kita sebagai harga
dan mereka butuh tahu sebelum ronde likuidasi berikutnya (§4).

**Mitra integrasi.** Alamat kontrak yang tersentuh, blok kejadiannya, dan apakah ABI
atau parameternya berubah.

Ketiganya terbit di kanal publik yang sama dengan post-mortem, dan yang pertama
dalam satu jam untuk P0.

#### 4. Prosedur pemulihan

**Tidak ada syarat unpause, karena tidak ada unpause.** Poin ini dulu meminta
syaratnya, dan itu sudah tidak berlaku sejak `parameter.md` §8.1.

Yang ada adalah enam jam untuk menjawab satu pertanyaan, yaitu apakah penyebabnya
sudah hilang. Kalau belum, guardian pause lagi. Itu keputusan yang diulang tiap enam
jam, bukan sekali di awal.

Perbaikan yang butuh perubahan parameter atau allowlist masuk lewat timelock dan
memakan 48 jam, jadi ia akan melewati beberapa siklus pause. Itu memang bentuknya.
Yang tidak bisa diperbaiki sama sekali adalah logika settlement, karena kontraknya
immutable. Kalau bug ada di sana, jalurnya bukan pemulihan melainkan menghentikan
protokol sampai lepas, mengumumkan, dan deploy yang baru.

#### 5. Post-mortem publik

Wajib untuk P0 dan P1, dalam tujuh hari. Memuat lini masa, penyebab, apa yang
terdeteksi otomatis dan apa yang tidak, dan apa yang berubah agar tidak terulang.

Terbit apa adanya termasuk kalau penyebabnya kesalahan kami sendiri.
`pertanyaan-terbuka.md` sudah memuat klaim yang gugur dan metodologi yang salah dua
kali, dan itu aset paling kuat repo ini. Post-mortem yang menyembunyikan penyebab
membuang aset itu.

---

## 7. Kenapa dokumen ini penting untuk penilaian

Kriteria juri menyebut *"minimal security vulnerabilities"*. Yang membedakan
proyek yang terlihat siap produksi bukan klaim "kode kami aman" — tapi kemampuan
menunjukkan:

- **Aset mana yang paling berharga**, dan kenapa itu bukan yang kelihatan jelas
- **Batas kepercayaan yang dinyatakan**, bukan diasumsikan
- **Kekuasaan yang dibagi secara sengaja** — cepat tapi tak berdaya, kuat tapi lambat
- **Risiko sisa yang diakui duluan**, bukan setelah ditemukan orang lain

> *Kami tidak mengklaim protokol ini tidak bisa diserang. Kami menunjukkan
> serangan apa yang mungkin, berapa batas kerugiannya, dan bagaimana kami tahu
> ketika itu terjadi.*

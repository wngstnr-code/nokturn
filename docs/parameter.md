# Nokturn — Registry Parameter

> **Satu-satunya sumber kebenaran untuk setiap konstanta.**
> Kalau ada angka di dokumen lain yang bertentangan dengan halaman ini, **halaman
> ini yang menang** — dan dokumen itu harus diperbaiki.
>
> Kolom *Alasan* wajib diisi. Angka tanpa alasan akan "diperbaiki" orang lain
> di kemudian hari, termasuk oleh dirimu sendiri tiga minggu lagi.

---

## 1. Sesi & batching

| Konstanta | Nilai | Alasan |
|---|---|---|
| `GUARD_BAND` | **60 detik** | `block.timestamp` Orbit ditentukan sequencer. Transisi sesi berskala menit, jadi 60 dtk menutup drift tanpa biaya berarti |
| `BATCH_OPEN` | **10 dtk** / pass-through | Likuiditas bagus saat bursa buka — jangan tambah latensi yang tidak perlu |
| `BATCH_PRE_MARKET` | **30 dtk** | Likuiditas mulai menipis |
| `BATCH_POST_MARKET` | **30 dtk** | Sama seperti pre-market |
| `BATCH_OVERNIGHT` | **45 dtk** | **Dikalibrasi ulang dari backtest netting Agustus 2026** — lihat §1B. Pada metrik antar-counterparty, 45 dtk menangkap **90,2%** netting yang tersedia di 300 dtk dengan **15%** latensinya. Lututnya ada di 20–30 dtk; 45 dtk duduk di sisi datar |
| `BATCH_WEEKEND` | **60 dtk** | **Diturunkan dari 120 dtk pada 16 September 2026.** Premis lama, yaitu "arus paling jarang", terbantah data Agustus. Angka baru memakai ambang imbal hasil marginal yang sama dengan `BATCH_OVERNIGHT`. Langkah 45 ke 60 dtk bernilai 0,101 pp/dtk, langkah 60 ke 90 dtk hanya 0,051 pp/dtk. Lihat §1B |
| `BATCH_HOLIDAY` | **120 dtk** | **Sengaja tidak ikut turun.** Tidak ada satu pun pengukuran untuk hari libur bursa, jadi nilai konservatif dipertahankan dan durasi adaptif yang mempersempitnya kalau arus ternyata tebal |
| `BATCH_PROTECTIVE` | **180 dtk** | Perlambat saat keadaan tidak dapat dipercaya |
| `BATCH_ADAPTIVE_MIN` | **20 dtk** | Batas bawah saat arus tebal |
| `BATCH_ADAPTIVE_MAX` | **180 dtk** | Batas atas saat arus tipis |

**Durasi adaptif.** Durasi efektif = nilai dasar sesi, disesuaikan laju kedatangan
intent, dijepit ke `[BATCH_ADAPTIVE_MIN, BATCH_ADAPTIVE_MAX]`.
Arus tipis → perpanjang untuk mengumpulkan. Arus tebal → perpendek karena pasangan
sudah mudah ditemukan.

---

## 1B. ⭐ Backtest netting — dasar kalibrasi durasi batch

Diukur ulang **3 September 2026** dari `dex.trades` **Agustus 2026**, allowlist v1.0
(NVDA, AAPL, TSLA, GOOGL). Menggantikan seluruh blok Juli 2026 — jangan campur
keduanya, definisi sesi dan penyaringnya berbeda.

**Dua definisi dilaporkan berdampingan:**

| Istilah | Rumus | Kapan dipakai |
|---|---|---|
| **Gross** | `2 × min(beli, jual) / total` | Batas atas mekanis. Masih menghitung bot bolak-balik |
| **Antar-counterparty** ⭐ | Posisi tiap alamat di-net dulu, baru dipertemukan antar alamat: `2 × min(Σ net beli, Σ net jual) / total` | **Angka yang dipakai di pitch.** Round trip satu alamat tidak dihitung sebagai netting |

### Rasio netting per durasi batch — Agustus 2026, 100% arus

Kolom kiri tiap sesi = **antar-counterparty**, kanan = gross.

| Durasi | NYSE buka | **OFF_HOURS** | Akhir pekan | Pedagang/batch (off-hours) |
|---|---|---|---|---|
| 10 dtk | 38,50% / 46,91% | **42,16% / 53,26%** | 41,48% / 52,71% | 3,56 |
| 20 dtk | 42,63% / 52,23% | **46,41% / 58,39%** | 45,96% / 58,84% | 4,85 |
| 30 dtk | 44,57% / 55,35% | **48,43% / 61,22%** | 48,41% / 62,46% | 5,95 |
| **45 dtk** ⭐ | **46,68% / 58,99%** | **50,05% / 63,76%** | **50,26% / 65,94%** | **7,47** |
| 60 dtk | 48,07% / 61,39% | **51,23% / 65,59%** | 51,77% / 68,35% | 8,87 |
| 90 dtk | 49,37% / 64,93% | **52,33% / 68,12%** | 53,29% / 71,74% | 11,48 |
| 120 dtk | 49,82% / 66,79% | **53,46% / 70,24%** | 54,11% / 73,62% | 13,92 |
| 300 dtk | 50,69% / 74,16% | **55,51% / 76,43%** | 56,43% / 80,06% | 26,96 |

**Kenapa 45 detik — dasarnya justru menguat.** Pada metrik antar-counterparty,
45 dtk menangkap **90,2%** dari netting yang tersedia di 300 dtk (50,05% dari 55,51%),
dengan **15%** latensinya. Di Juli angka itu 73%; kurvanya sekarang mendatar jauh
lebih awal karena arusnya tiga kali lebih tebal, sehingga pasangan ditemukan lebih
cepat. Imbal hasil marginal off-hours: 20→30 dtk +0,202 pp/dtk, 30→45 dtk
+0,108 pp/dtk, 45→60 dtk +0,079 pp/dtk. Lututnya ada di antara 20 dan 30 detik,
dan 45 dtk duduk nyaman di sisi datar.

**Konsekuensi yang perlu disadari:** 30 dtk di Agustus (48,43%) sudah mengungguli
45 dtk di Juli (47,6% gross) dengan sepertiga latensi lebih sedikit. Kalau arus terus
menebal, `BATCH_ADAPTIVE_MIN` = 20 dtk akan sering tersentuh, dan itu memang perilaku
yang diinginkan. Jangan memperpendek nilai dasarnya karena satu bulan data di pasar
yang sedang tumbuh cepat — biarkan mekanisme adaptif yang menurunkannya.

### `BATCH_WEEKEND` diturunkan 120 dtk ke 60 dtk (16 September 2026)

Alasan yang tertulis untuk 120 dtk adalah *"arus paling jarang, butuh jendela
terpanjang untuk menemukan pasangan."* **Data Agustus membatalkan premis itu:**

| | Juli 2026 | Agustus 2026 |
|---|---|---|
| Pangsa akhir pekan dari seluruh trade stock token | 12,9% | **33,2%** |
| Pedagang berbeda per batch 45 dtk, akhir pekan | 4,14 | **8,01** |
| Pedagang berbeda per batch 45 dtk, off-hours hari kerja | 5,30 | 7,47 |

Akhir pekan **bukan lagi sesi paling tipis** — batch akhir pekan sekarang justru
lebih ramai daripada off-hours hari kerja. Dan imbal hasil dari menunggu lebih lama
tipis: 60 dtk memberi 51,77%, 120 dtk memberi 54,11%, jadi **+2,34 pp ditukar dengan
tambahan 60 detik latensi** untuk sepertiga dari seluruh arus.

**Keputusan 16 September 2026: `BATCH_WEEKEND` 120 dtk turun ke 60 dtk.**

Angkanya tidak dipilih dari selera, melainkan dari ambang yang dokumen ini sudah
pakai untuk berhenti di 45 dtk pada `BATCH_OVERNIGHT`. Imbal hasil marginal akhir
pekan, metrik antar-counterparty, 100% arus.

| Langkah | Tambahan netting | Per detik |
|---|---|---|
| 45 ke 60 dtk | +1,51 pp | **0,101 pp/dtk** |
| 60 ke 90 dtk | +1,52 pp | 0,051 pp/dtk |
| 90 ke 120 dtk | +0,82 pp | **0,027 pp/dtk** |

`BATCH_OVERNIGHT` berhenti di 45 dtk karena langkah berikutnya hanya bernilai
0,079 pp/dtk. Ambang yang sama, diterapkan ke akhir pekan, berhenti tepat di 60 dtk.
Langkah 45 ke 60 masih di atas ambang, langkah 60 ke 90 sudah di bawahnya. Nilai
lama 120 dtk membayar 60 detik latensi tambahan dengan imbal 0,027 pp/dtk, yaitu
tiga kali lebih mahal daripada yang sudah ditolak di overnight.

**Kenapa tidak sekalian disamakan 45 dtk dengan overnight.** Akhir pekan satu-satunya
sesi tanpa Chainlink hidup, dengan cek ketidaksepakatan nonaktif dan price band
berjangkar ke TWAP (§7.3). Saat dua angka sama-sama dibela data, yang dipilih adalah
yang menyisakan lebih sedikit volume untuk dirutekan ke venue dengan referensi lebih
lemah. Selisihnya kecil dan disebut kecil, yaitu 51,77% lawan 50,26%.

Ini juga bukan pertukaran. Turun dari 120 ke 60 dtk **memperbaiki** latensi untuk
sepertiga arus, dan yang dilepas hanya 2,34 pp netting.

**`BATCH_HOLIDAY` tetap 120 dtk.** Tidak ada pengukuran hari libur sama sekali, dan
aturan proyek melarang menulis kode yang bergantung pada sesuatu yang belum diukur.

### ⚠️ Tiga koreksi kejujuran atas angka di atas

**1. Ini batas atas, bukan ramalan.** Tabel di atas mengasumsikan **100% arus lewat
Nokturn**. Dengan pangsa nyata, batch jadi lebih tipis. Kurva Agustus, off-hours,
batch 45 dtk:

| Pangsa Nokturn | **Antar-counterparty** ⭐ | Gross | Pedagang/batch |
|---|---|---|---|
| 5% | **21,43%** | 31,92% | 1,94 |
| **10%** | **27,19%** | 37,99% | 2,47 |
| 15% | **30,43%** | 41,17% | 2,90 |
| **20%** | **33,39%** | 44,41% | 3,29 |
| 25% | 35,73% | 47,06% | 3,63 |
| 30% | 38,06% | 49,51% | 3,95 |
| 50% | 42,81% | 54,99% | 5,09 |
| 75% | 46,65% | 59,79% | 6,35 |
| 100% | **50,05%** | 63,76% | 7,47 |

**Angka yang pantas dipakai di pitch fase awal: 27–33%** (antar-counterparty,
pangsa 10–20%), bukan 50,05% dan bukan 63,76%.

> **Kenapa pergantian ini memperkuat posisi, bukan sekadar menaikkan angka.**
> Angka lama 21–29% dihitung dengan definisi **gross**, yang masih menghitung bot
> bolak-balik sebagai netting. Angka baru 27–33% dihitung dengan definisi yang
> **lebih ketat** — bot sudah dibuang — dan tetap keluar lebih tinggi. Metodologinya
> diperketat, angkanya naik. Itu kalimat yang tidak bisa diserang.

Bentuk kurvanya tetap argumen inti: **21,4% di pangsa 5% naik ke 50,1% di pangsa
100%.** Klaim di `desain-agent.md` §2.1 dan `desain-ekonomi.md` §6 bahwa "makin banyak
arus → makin bagus eksekusi" punya kemiringan yang ada angkanya.

**Sisi yang harus disebut duluan, bukan disembunyikan:** di pangsa awal 10–20%,
rata-rata hanya ada **2,5–3,3 pedagang berbeda per batch** off-hours. Netting-nya
nyata, tapi batch-nya tipis. Ini justru alasan `BATCH_ADAPTIVE_MAX` = 180 dtk penting
di fase peluncuran: saat arus tipis, jendela harus melebar sendiri.

**2. Metode sampling pangsa.** Sampling deterministik atas `tx_hash`, sehingga satu
transaksi ikut atau tidak **secara utuh**, bukan per leg. Ini lebih setia pada
kenyataan daripada sampling per baris: pengguna merutekan satu transaksi, bukan
separuh transaksi.

**3. Cakupan `dex.trades`.** Hanya venue yang ter-decode. Sesuai pelajaran metodologi
di `pertanyaan-terbuka.md`, anggap ini **lantai**, bukan gambaran penuh. Pasangan
silang (mis. NVDA→TSLA) juga tidak dihitung — hanya leg terhadap USDG.

### Perbandingan dengan blok Juli yang digantikan

Metode konsisten (definisi gross, sesi sama, dijalankan bersamaan atas kedua bulan):

| Netting gross, 45 dtk, 100% arus | Juli 2026 | Agustus 2026 |
|---|---|---|
| NYSE buka | 52,35% | 58,99% |
| Off-hours | **50,36%** | **63,76%** |
| Akhir pekan | 56,47% | 65,94% |

⚠️ Angka Juli hasil jalan ulang (50,36%) sedikit berbeda dari 47,6% yang tercatat
sebelumnya — himpunan token dan batas sesinya tidak identik, dan SQL kueri lama
tidak bisa diambil kembali karena tersimpan sebagai kueri temporer. **Karena itu
blok Juli diganti seluruhnya, bukan disajikan sebagai pertumbuhan.** Untuk metrik
antar-counterparty tidak ada pembanding Juli sama sekali dengan definisi yang sama.

Query Agustus 2026: `8595251` (netting per sesi) · `8595303` (kurva pangsa) ·
`8595357` (kurva durasi).

> ✅ **Ketiganya sudah permanen dan publik** (3 September 2026), lengkap dengan
> deskripsi metodologi dan visualisasi, di dashboard
> **[Nokturn — Robinhood Chain equity market structure (August 2026)](https://dune.com/passchick/nokturn-robinhood-chain-equity-market-structure-august-2026)**.
> Kurva pangsa (`8595303`) dan kurva durasi (`8595357`) tampil sebagai grafik garis
> yang bisa dibaca langsung.

---

## 2. Price band (penyimpangan maksimum dari oracle)

| Sesi | Nilai | Alasan |
|---|---|---|
| `OPEN` | **30 bps** | Harga wajar paling pasti |
| `PRE_MARKET` / `POST_MARKET` | **60 bps** | Sesi lebih tipis |
| `CLOSED_OVERNIGHT` | **100 bps** | Tidak ada referensi hidup |
| `CLOSED_WEEKEND` / `HOLIDAY` | **150 bps** | Ketidakpastian tertinggi |
| `PROTECTIVE` | **20 bps** | Paling ketat — keadaan tidak dapat dipercaya |
| `BAND_CEILING` | **300 bps** | **Plafon keras di kontrak.** Governance tidak bisa melampauinya, apa pun alasannya |

> **Prinsip yang mengikat:** semakin lebar band, semakin kecil exposure cap.
> Melebarkan band tanpa menurunkan cap memperbesar kerugian maksimum tepat saat
> ketidakpastian paling tinggi. Keduanya harus bergerak berlawanan arah.

---

## 3. Lelang

| Konstanta | Nilai | Alasan |
|---|---|---|
| `DISCLOSURE_WINDOW` | **30 menit** sebelum bel | Cukup waktu bagi likuiditas untuk merespons imbalance yang diumumkan |
| `FREEZE_OFFSET` | **5 menit** sebelum cross | Cutoff pembatalan; setelah ini imbalance dijamin nyata |
| `ESCROW_DURATION` | freeze → cross (**~5 menit**) | Sesingkat mungkin sambil tetap membuat angka imbalance kredibel |
| `COLLAR_INITIAL` | **200 bps** | Lebih lebar dari band biasa — gap pembukaan memang nyata |
| `COLLAR_STEP` | **+50 bps** per perpanjangan | Melonggar bertahap, seperti penundaan pembukaan di bursa |
| `EXTENSION_PERIOD` | **5 menit** | Waktu tambahan bagi likuiditas masuk |
| `MAX_EXTENSIONS` | **3** | Setelah itu eksekusi di tepi collar; lelang tidak boleh menggantung selamanya |
| `CHALLENGE_WINDOW` | **120 detik** | Cukup untuk verifikasi offchain dan pengiriman tantangan |
| `CHALLENGE_BOND` | **500 USDG** | Cukup mahal untuk mencegah spam, cukup murah untuk tidak menghalangi penantang jujur |
| `CHALLENGE_REWARD` | **50%** bond yang disita | Sisanya ke protokol |
| `PRINT_MIN_VOLUME` | **1.000 USDG** | Di bawah ini closing print terbit sebagai `insufficient`, **bukan angka menyesatkan** |
| `PRINT_MIN_PARTICIPANTS` | **5** | Mencegah "lelang" yang isinya satu pihak |
| `CROSS_BOND` | **500 USDG** | Ditambahkan 16 September 2026. Sisi lawan dari `CHALLENGE_BOND`. Solver yang mengirim cross ikut mempertaruhkan angka yang sama, jadi tantangan tidak pernah gratis di satu sisi saja |
| `CROSS_DELAY_OPEN` | **300 detik** setelah bel | Sama dengan jendela harga referensi pembukaan. Cross lelang pembukaan baru boleh berjalan setelah referensinya terbentuk, karena tanpa itu ROO tidak punya arti |
| `MAX_AUCTION_INTENTS` | **256** per lelang | Batas gas. Pencarian harga kliring berbiaya kuadratik terhadap panjang buku, dan buku yang tidak terbatas membuat lelang bisa dimatikan dengan mengisinya |
| `MAX_CROSS_EXECUTIONS` | **128** per cross | Batas gas untuk penghitungan peserta berbeda, yang juga kuadratik |

### 3.0b Empat keputusan yang lahir saat menulis `AuctionHouse`

> Ditambahkan **16 September 2026**, saat kontraknya ditulis. Keempatnya menutup
> celah yang tidak terlihat selama desainnya masih berupa dokumen.

**1. Escrow ditarik saat pembekuan, bukan saat commit.** `desain-auction.md` §2.6
memilih Opsi A dan menyebut jendela freeze sampai cross. Tapi §4 menulis bahwa harga
indikatif dihitung dari intent yang sudah ter-escrow, padahal harga indikatif terbit
30 menit sebelum bel dan pembekuan baru terjadi 5 menit sebelumnya. Keduanya tidak
bisa benar sekaligus. Yang menang adalah `ESCROW_DURATION`, karena ia parameter dan
karena menahan dana pengguna sepanjang akhir pekan adalah harga yang jauh lebih mahal
daripada yang hendak dibeli.

Konsekuensinya harus ditulis apa adanya, bukan disamarkan. Harga indikatif selama
fase pengungkapan berasal dari intent yang **berkomitmen**, bukan yang sudah
ter-escrow. Angka yang dijamin nyata adalah yang terbit di `AuctionFrozen`, dan itu
satu-satunya angka yang boleh disebut kredibel. Penarikan escrow lewat Permit2 pada
saat pembekuan sekaligus menyaring intent yang saldonya sudah pindah, karena
penarikan yang gagal berarti intent itu gugur dari buku.

**Dan satu lagi yang menutup sisanya, ditambahkan sore harinya.** Saat commit,
kontrak memverifikasi tanda tangan Permit2 milik pemilik dengan membangun ulang
digest yang nanti diverifikasi Permit2 sendiri. Jadi siapa pun boleh merelai
komitmen, tapi tidak ada yang bisa mengisi buku atas nama orang lain. Tanpa itu,
256 slot buku bisa dihabiskan dengan modal gas saja, dan pemeriksaan saldo tidak
cukup karena saldo orang lain bisa dibaca siapa pun. Digest yang salah berarti
semua komitmen ditolak di mainnet, dan mock tidak bisa menangkapnya karena mock
akan setuju dengan jawaban yang sama salahnya, jadi pembuktiannya ada di
`contracts/test/fork/AuctionHousePermit2Fork.t.sol` lawan Permit2 yang
benar-benar terpasang.

**2. Cross lelang pembukaan menunggu 300 detik setelah bel.** Harga referensi
pembukaan menurut §2.3 adalah TWAP 300 detik pertama sesi `OPEN`. Pada detik bel
berbunyi, jendela itu belum terisi, jadi cross yang berjalan tepat di bel selalu
jatuh ke fallback dan ROO kehilangan seluruh maknanya. Cross karena itu baru boleh
berjalan setelah `CROSS_DELAY_OPEN`. Kalau feed tetap tidak update dua kali dalam
jendela itu, intent ROO gugur dan escrow-nya kembali penuh, sementara lelang tetap
berjalan untuk MOO dan LOO dengan harga feed sebagai referensi.

**3. Solver ikut mempertaruhkan bond.** `CHALLENGE_BOND` menghukum penantang yang
salah. Tanpa sisi lawannya, solver yang mengirim harga buruk tidak menanggung apa
pun dan penantang jujur membiayai koreksi itu sendirian. `CROSS_BOND` menutup asimetri
tersebut. Yang kalah kehilangan bond-nya, 50% ke yang menang dan 50% ke protokol,
persis seperti `CHALLENGE_REWARD` yang sudah tertulis.

**4. Cross v1.0 tidak menyentuh venue.** Sisa imbalance tidak dirutekan ke Uniswap
dari dalam lelang. Solver yang ingin menyerap sisa itu ikut berkomitmen seperti
peserta lain dan menanggung risikonya sendiri, yang justru membuat angka imbalance
di `AuctionFrozen` tetap berarti. Routing venue di dalam cross masuk v1.1, dan itu
keputusan yang diambil dari pengukuran, bukan dari kekurangan waktu.

### 3.1 Permukaan baca closing print — konstanta kompatibilitas

> Ditambahkan **10 September 2026**. Alasan lengkap: `desain-auction.md` §3.3.
>
> 🔴 **Angka dikoreksi di hari yang sama, sebelum dipakai ke luar.** Versi pertama
> menyebut *"20 kontrak"* — itu **salah**, karena menghitung di lapisan agregator
> Chainlink, satu lapis terlalu dalam. Kesembilan pembaca di sana adalah
> **infrastruktur harga per-simbol**, bukan konsumen. Angka yang benar, diukur di
> lapisan **di atas** permukaan harga (1–10 September 2026):
>
> | | |
> |---|---|
> | Pembacaan harga ekuitas | **64.671** |
> | Kontrak konsumen berbeda | **749** |
> | Pengguna akhir berbeda | **2.048** |
> | Transaksi | **21.135** |
> | **Lapisan protokol** (kontrak dengan ≥6 pengguna) | **38 kontrak dari 24 operator** |
>
> Kueri `8664020` · `8664034` · `8664041` · `8664051`. **Semuanya** lewat
> `AggregatorV3Interface` — interface buatan sendiri tidak bisa mereka pakai tanpa
> menulis kode baru.

| Konstanta | Nilai | Alasan |
|---|---|---|
| `PRINT_DECIMALS` | **8** | Sama persis dengan `DualAggregator` Chainlink di chain ini. Konsumen yang sudah menormalkan 8 desimal tidak perlu mengubah apa pun |
| `PRINT_ROUND_ID` | **hari sesi** (`uint80`, `YYYYMMDD`) | Monoton naik, bisa dibaca manusia, dan `getRoundData(20260910)` langsung menjawab "berapa penutupan 10 September?" tanpa indeks terpisah |
| `PRINT_UPDATED_AT` | **stempel waktu cross yang sebenarnya** | 🔴 **Tidak pernah `block.timestamp`.** Lihat larangan di bawah |
| `PRINT_MAX_AGE_ADVISORY` | **30 jam** | Bukan gerbang di kontrak kami — **anjuran untuk konsumen**. Satu sesi + margin akhir pekan ditangani konsumen lewat logika mereka sendiri. Kami hanya melaporkan umur sebenarnya |

### 🔴 Larangan yang mengikat pada permukaan baca

Ini bukan preferensi gaya. Melanggarnya menghancurkan seluruh posisi proyek ini.

| Larangan | Kenapa |
|---|---|
| **Jangan pernah menyetel `updatedAt` ke `block.timestamp`** | Closing print memang basi 23 jam by design. Memalsukan kesegaran = membuat pemeriksaan staleness konsumen gagal senyap. Itu persis kelas bahaya yang aturan tanpa-mock ada untuk mencegah |
| **Jangan pernah mengarang angka untuk menutup lubang** | Kalau gerbang `PRINT_MIN_VOLUME` / `PRINT_MIN_PARTICIPANTS` tidak terpenuhi, **tidak ada ronde baru dibuat.** `latestRoundData` tetap mengembalikan print valid terakhir dengan `updatedAt` aslinya yang lebih tua — sehingga logika staleness konsumen **menolaknya dengan benar, atas kemauan mereka sendiri** |
| **Jangan pernah menyebutnya pengganti Chainlink** | Ia **referensi kedua** yang berasal dari transaksi sungguhan. Menempatkannya sebagai pengganti mengundang orang memakainya sebagai harga spot, dan ia bukan harga spot |
| **Jangan pernah mengklaim ada yang sudah mengonsumsinya** | Basis konsumen itu **bisa dijangkau**, bukan **sudah berkomitmen** — dan tidak satu pun terverifikasi di Blockscout, jadi namanya pun tidak kita ketahui. `demo.md` §5 melarang menampilkan konsumsi yang belum ada |

> **Simetrinya sengaja.** Batch yang gagal tetap menerbitkan baseline-nya
> (`CLAUDE.md` §7). Lelang yang terlalu tipis **menolak menerbitkan harga**.
> Keduanya kalimat yang sama: *protokol ini melaporkan keadaan sebenarnya, terutama
> ketika keadaan sebenarnya tidak menguntungkan kami.* Itu satu-satunya alasan orang
> punya sebab mempercayai angka yang terbit.

---

## 4. Fee & pembagian nilai

| Konstanta | Nilai | Alasan |
|---|---|---|
| Bagian pengguna | **80%** savings | Pengguna harus jadi penerima manfaat utama, dan angka ini bisa dipasarkan |
| Bagian solver | **15%** savings | Cukup untuk menutup gas + infra + margin |
| Bagian protokol | **5%** savings | Kecil dan sengaja — pertumbuhan lebih penting daripada ekstraksi |
| `FEE_CAP_SHARE` | **20%** savings | Batas keras gabungan solver + protokol |
| `FEE_CAP_NOTIONAL` | **3 bps** notional | Batas kedua; **yang berlaku adalah yang lebih kecil** |
| `MIN_SAVINGS_THRESHOLD` | **1 bps** notional | Di bawah ini → pass-through, **fee nol** |

> **Kenapa dua batas.** Batas pertama menjaga proporsionalitas. Batas kedua menjaga
> kalau savings terhitung besar karena anomali. Solver monopoli — yaitu kamu di
> awal — tetap tidak bisa memeras, dan properti itu bisa dibaca dari kode.

Gas settlement diganti ke solver **sebelum** pembagian, supaya batch kecil tetap
layak dikerjakan.

---

## 4B. Baseline (`quoteFromState`)

| Konstanta | Nilai | Alasan |
|---|---|---|
| `MAX_TICK_CROSSINGS` | **32** | ✅ **Dikonfirmasi dari pengukuran 16 September 2026**, bukan lagi tebakan. Lihat tabel di bawah |
| `MAX_LOOP_STEPS` | **128** | Termasuk langkah batas-kata bitmap yang **bukan** penyeberangan likuiditas |

**Penyeberangan tick terukur, keempat pool allowlist**, 19 September 2026, lewat
`quoteWithStats` pada fork mainnet. Diukur ulang karena pengukuran sebelumnya hanya
satu pool, dan karena fork-nya ternyata membaca state 2 Agustus. Lihat catatan di
bawah.

| USDG masuk | NVDA | AAPL | TSLA | GOOGL |
|---|---|---|---|---|
| 5.000 (= `CAP_PER_BATCH`) | **0** | **0** | **0** | **0** |
| 10.000 | 0 | 0 | 1 | 0 |
| 25.000 | 0 | 1 | 1 | 0 |
| 50.000 | 0 | 4 | 2 | 1 |
| 250.000 | 1 | ditolak | 12 | 15 |
| 1.000.000 | 13 | ditolak | ditolak | ditolak |
| **Ukuran terbesar yang bisa dikuotasi** | **$1,81jt** | **$214rb** | **$304rb** | **$358rb** |

Likuiditas dalam rentang saat diukur, NVDA `2,77e19` · AAPL `1,68e18` ·
TSLA `6,95e17` · GOOGL `5,24e18`. Fee 500 untuk NVDA, AAPL, dan GOOGL, 3000 untuk
TSLA.

Keempatnya berhenti tepat di 32 penyeberangan, bukan karena kehabisan likuiditas.
Artinya `MAX_TICK_CROSSINGS` memang yang mengikat di ukuran itu, dan angkanya bisa
dibaca sebagai kapasitas.

Tiga hal yang sekarang berdiri di atas data.

1. **Pada cap peluncuran, penyeberangan nol di keempat pool.** `desain-baseline.md`
   §6 menyebut ini asumsi yang harus diverifikasi dan bukan diandalkan. Sudah
   diverifikasi, dan sekarang untuk semua pool bukan cuma jangkarnya.
2. **32 tetap benar dan tidak diubah.** Margin terhadap cap peluncuran adalah 43 kali
   pada pool tertipis, yaitu AAPL di $214rb lawan $5rb.
3. 🔴 **Di plafon governance `CAP_PER_BATCH` $500.000, AAPL tidak bisa dikuotasi
   sama sekali.** Klaim lama "penyeberangan masih di sekitar 5 di plafon" salah dan
   jangan dipakai lagi. Menaikkan cap ke plafon berarti menerima bahwa satu token
   allowlist jatuh ke pass-through, atau menaikkan `MAX_TICK_CROSSINGS` lebih dulu,
   dan yang kedua menaikkan gas verifikasi terburuk.

**GME, ditambahkan ke allowlist 20 September 2026.** Diukur terpisah karena masuk
belakangan, dengan metode dan adapter yang sama. Pool `0xE2b46c90…`, fee 500,
Uniswap V3, $145,5jt volume September.

| USDG masuk | Penyeberangan | Harga efektif | Dampak vs cap |
|---|---|---|---|
| 5.000 (= `CAP_PER_BATCH`) | 1 | $22,54 | 0 bps |
| 10.000 | 1 | $22,55 | 4 bps |
| 50.000 | 14 | $22,71 | 75 bps |
| 250.000 | ditolak | | |

Harga efektif di cap peluncuran berselisih **di bawah satu bps** terhadap feed
Chainlink yang membaca $22,55 pada saat yang sama. Dua sumber independen sepakat,
dan itu pemeriksaan yang tidak bisa diberikan tabel kedalaman sendirian.

GME menyeberang satu tick di cap peluncuran, satu-satunya dari kelima pool yang
tidak nol. Masih jauh di bawah ambang empat yang dijaga gerbang, dan disebut di sini
supaya tidak terbaca sebagai kelalaian saat ada yang memeriksa.

🔴 **"Ukuran terbesar yang bisa dikuotasi" bukan ukuran kedalaman.** Baris itu
mencatat ukuran terbesar yang tidak ditolak adapter, dan sebuah pool bisa terus
menjawab jauh setelah jawabannya tidak berarti. Diterapkan ke kandidat META pada
20 September, angkanya keluar **$4jt** sekaligus harga efektif **76 kali lipat**
harga di cap peluncuran, tanpa pernah melanggar `MAX_TICK_CROSSINGS`. Baca baris itu
selalu bersama **dampak harga dalam bps**, yang sekarang ikut dicetak. Di sepuluh
kali cap, kelima pool berada di NVDA 1 bps, GOOGL 6 bps, AAPL 16 bps, TSLA 34 bps,
GME 75 bps.

⚠️ Angka ini pasar hidup, bukan konstanta. `test/fork/PoolDepthFork.t.sol` mengukur
ulang tiap malam, menegaskan cap peluncuran menyentuh paling banyak empat tick dan
setiap pool masih menjawab di sepuluh kali cap, lalu mencetak tabel ini apa adanya.
Ukur lagi sebelum menambah pool baru ke allowlist adapter.

### 4C. Batas bawah baseline — ditambahkan 20 September 2026

**Masalah yang ditutupnya.** Sampai hari ini `Solution.baselineQuotes` datang dari
solver dan tidak ada apa pun onchain yang memeriksanya. `ClearingVerifier` hanya
menolak baseline yang **dilebihkan**, lewat `executedBuy >= baselineQuotes[k]`.
Baseline yang **dikurangi** lolos, dan dari situ `savings` dihitung, plafon fee
ditentukan, dan pemenang lelang dipilih. Rinciannya di `pertanyaan-terbuka.md` P7-1,
lengkap dengan dua solusi yang eksekusinya identik sampai wei dan hanya berbeda
baseline.

**Aturannya.** Untuk setiap arah pasangan yang muncul di sebuah batch, jumlah
`baselineQuotes` pada arah itu tidak boleh di bawah `quoteFromState` atas **jumlah
`executedSell` arah itu**. Satu kuotasi per arah, bukan satu per intent.

| Konstanta | Nilai | Alasan |
|---|---|---|
| `baselineAdapter` | Diset governance, awalnya kosong | Adapter yang dipakai menghitung lantai. Wajib ada di `adapterAllowed` dan `isQuotable()`. Parameter, bukan immutable, supaya adapter V4 di v1.1 masuk lewat time-lock |

**Kalau lantainya tidak bisa dihitung, batch jadi pass-through.** Itu terjadi kalau
`baselineAdapter` belum diset, atau kuotasinya revert karena
`TooManyTickCrossings`, pool tidak terdaftar, atau fee dinamis. Dalam kasus itu
`savings` dipaksa nol, yang berarti solver tidak boleh menahan apa pun dan fee nol.
Batch tetap selesai dan pengguna tetap menerima penuh. Ini perilaku yang sama dengan
"tidak ada baseline" yang sudah ditetapkan `desain-baseline.md` §5, dan arah amannya
sama. **Tanpa informasi, protokol tidak menagih.**

**Celah sisa, dan kenapa ia dapat diterima.** Lantai agregat lebih longgar daripada
kebenaran, tepat sebesar dampak harga antara satu perdagangan gabungan dan volume
yang sama dipecah jadi beberapa intent. Diukur 20 September 2026 lewat
`test/fork/BaselineBoundFork.t.sol`, dalam bps dari baseline jujur.

| Token | $172 | $1.000 | $5.000, cap | $50.000 |
|---|---|---|---|---|
| NVDA | 0 | 0 | 0 | 1 |
| GOOGL | 0 | 0 | 0 | 3 sampai 6 |
| AAPL | 0 | 0 | 0 sampai 1 | 10 sampai 16 |
| TSLA | 0 | 0 | 1 sampai 3 | 19 sampai 34 |
| GME | 0 | 0 sampai 1 | 1 sampai 3 | 69 sampai 85 |

Kolom $172 adalah tiket median Agustus $57,44 dikali tiga, yaitu bentuk batch yang
sebenarnya pada pangsa awal. **Pada bentuk itu celahnya nol di kelima token.**
Rentangnya pecahan 2, 3, 5, dan 10 intent.

Plafon fee mengambil 20% dari surplus, jadi celah baseline 3 bps menaikkan plafon
paling banyak 0,6 bps notional, dengan langit langit keras tetap 3 bps. Sebelum
aturan ini celahnya tidak terbatas sampai langit langit itu.

**Biaya gas, satu kuotasi per arah pasangan.**

| Token | $172 | $5.000, cap | $50.000 |
|---|---|---|---|
| TSLA | 24.572 | 25.493 | 53.394 |
| GOOGL | 25.589 | 25.557 | 39.948 |
| GME | 25.713 | 40.233 | 287.296 |
| AAPL | 26.073 | 40.945 | 85.546 |
| NVDA | 26.416 | 26.416 | 26.348 |

Batch nyata menyentuh satu sampai tiga pasangan, jadi tambahannya sekitar 50 sampai
160 ribu gas. Pada 0,01 gwei itu 0,0000016 ETH, dan biaya data L1 di chain ini nol.

⚠️ **Biaya kuotasi tumbuh dengan ukuran.** GME menghabiskan 287 ribu gas di $50.000
karena empat belas penyeberangan. Menaikkan `CAP_PER_BATCH` ke arah plafon governance
menaikkan biaya ini juga, jadi ukur lagi sebelum menaikkannya.

**Yang tidak ditutup aturan ini.** Pembagian baseline di antara intent pada pasangan
yang sama masih ditentukan solver. Yang tidak bisa lagi digeser adalah totalnya, dan
totalnya yang menentukan `savings`, plafon fee, dan pemenang lelang.

---

> **Arah pembulatan `baselineReceived`: KE ATAS.** Ini pengecualian sadar terhadap
> §9 ("kuantitas diterima pengguna dibulatkan ke bawah") — baseline bukan jumlah
> yang dibayarkan ke siapa pun, ia nilai pembanding yang menentukan fee.
> Membulatkannya ke bawah berarti mengklaim penghematan yang tidak terjadi dan
> mengenakan fee berlebih. Alasan lengkap: `desain-baseline.md` §2.

---

## 4C. Satuan harga di permukaan settlement

Ditemukan 17 September 2026, saat menormalkan desimal di `AgentMandate`.

**Harga di `Solution.prices` dan di `oraclePrices` adalah USD 18 desimal per satuan
terkecil token, dikali 1e18. Bukan per satu token utuh.**

| Token | Desimal | Harga pasar | Nilai di permukaan ini |
|---|---|---|---|
| USDG | 6 | 1 USD | `1e30` |
| NVDA | 18 | 200 USD | `200e18` |

### 4C.1 Kenapa ini bukan soal gaya penulisan

Sebelum perbaikan, `Settlement` dan `ClearingVerifier` menghitung nilai sebagai
`jumlah * harga / 1e18` sementara harganya per token utuh. Untuk token 18 desimal
itu kebetulan benar. Untuk USDG yang 6 desimal, angkanya 1e12 kali terlalu kecil.

Yang ikut salah karena itu, seluruhnya. Exposure cap per batch, per token, dan
global. Plafon fee. Angka savings. Volume netted dan routed di event. Ambang
passthrough satu basis poin. Dengan kata lain setiap angka dolar yang diterbitkan
protokol ini, untuk aset yang mengutip hampir semua pasangan di chain ini.

Lebih dari itu, `_checkUniformPrice` juga homogen dalam harga. Dengan harga per
token utuh, satu batch USDG lawan NVDA berukuran wajar akan terbaca sebagai dua
ratus dolar masuk dan empat puluh ribu miliar dolar keluar, lalu ditolak
`NonUniformPrice`. Jadi pasangan yang paling umum di chain ini sebenarnya tidak
bisa kliring sama sekali.

### 4C.2 Kenapa test tidak menangkapnya

Karena fixture-nya menjual **200e18 USDG**, yaitu dua ratus triliun dolar kalau
satuannya dibaca benar. Suite-nya konsisten dengan dirinya sendiri dan salah
bersama-sama. Itu bentuk kegagalan yang sama dengan data mock, cuma letaknya di
test, jadi aturan 9 tidak menangkapnya.

Fixture sekarang memakai 200e6 USDG, dan ada dua test yang mengunci akibatnya.
Satu memastikan batch enam desimal terukur sebagai empat ratus dolar di exposure
cap. Satu lagi memastikan harga per token utuh **ditolak**, bukan diselesaikan.

### 4C.3 Kewajiban solver

Solver mengutip harga dalam konvensi yang sama. `Settlement` menormalkan harga
oracle di batasnya sendiri, jadi band check membandingkan dua angka yang satu
satuan. Tidak ada array desimal yang dioper ke mana-mana, dan `ClearingVerifier`
tetap `pure`.

---

## 5. Solver

| Konstanta | Nilai | Alasan |
|---|---|---|
| `minBond` | **500 USDG** awal, plafon **50.000 USDG** | Parameter bergubernur, bukan konstanta. Lihat §5A |
| `UNBOND_COOLDOWN` | **7 hari** | Slashing masih bisa dijangkau setelah perilaku buruk terdeteksi |
| `SLASH_FAILED_FINALIZE` | **10%** bond | Grief; merugikan tapi tidak fatal |
| `SLASH_INVALID_SURPLUS` | **25%** bond | Lebih berat — ini upaya menipu, bukan kelalaian |
| `SOLUTION_WINDOW` | **10 detik** | Cukup untuk mengirim; cukup pendek untuk mempersempit penyalinan solusi |
| `MAX_SOLUTIONS_PER_SOLVER` | **3** per batch | Cegah spam mempool |

### 5A. Kenapa bond jadi parameter, dan kenapa 500 bukan 5.000

Ditulis 20 September 2026, mengganti nilai konstan 5.000 USDG yang berlaku sebelumnya.

Nilai lama disetel untuk protokol yang sudah besar, sementara exposure cap disetel
untuk protokol yang baru mulai. Satu sisi bisa naik lewat governance dan satu sisi
beku sebagai `constant`, jadi keduanya berpisah justru di bulan-bulan saat solver
pihak ketiga paling dibutuhkan datang.

**Aritmetika yang menunjukkannya.** Fee dibatasi `min(surplus x 20%, notional x 3 bps)`
dan solver menerima 75% darinya.

| | Peluncuran | Plafon governance |
|---|---|---|
| `CAP_GLOBAL_DAILY` | $200.000 | $20.000.000 |
| Fee maksimum seluruh protokol per hari | $60 | $6.000 |
| Kolam pendapatan solver per hari, semua solver digabung | **$45** | **$4.500** |
| Bond lama, konstan | $5.000 | $5.000 |
| Balik modal kalau satu solver menang setiap batch | **111 hari** | 1,1 hari |

Di peluncuran, seorang solver mengunci $5.000 untuk memperebutkan $45 sehari bersama
solver lain. Sementara keuntungan maksimum dari mencurangi satu batch adalah plafon
fee-nya sendiri, yaitu $5.000 x 3 bps = $1,50, dan `SLASH_INVALID_SURPLUS` 25% dari
bond lama berarti $1.250. Pencegahannya delapan ratus kali lipat dari yang bisa
didapat, dan itu bukan kalibrasi.

**Nilai baru diturunkan dari kolam itu, bukan ditebak.** Bond disetel setara sekitar
sebelas hari pendapatan solver seluruh protokol pada cap yang sedang berlaku.

```
minBond = CAP_GLOBAL_DAILY / 400
```

Di peluncuran $200.000 / 400 = **500 USDG**. Di plafon $20.000.000 / 400 =
**50.000 USDG**. Rasionya bertahan karena keduanya naik seratus kali lipat.

Pencegahannya tetap tebal. `SLASH_INVALID_SURPLUS` 25% dari 500 adalah $125, yaitu
delapan puluh tiga kali keuntungan maksimum satu batch, dan `SLASH_FAILED_FINALIZE`
10% adalah $50, masih tiga puluh tiga kali.

**Aturan kenaikan sama dengan exposure cap.** Boleh digandakan setelah tujuh hari
berturut-turut tanpa insiden, lewat time-lock, seperti perubahan parameter lain. Kalau
cap naik tanpa bond ikut naik, rasio sebelas hari itu yang jadi pengingat bahwa
keduanya bergerak bersama.

**Lantai 500 USDG ditegakkan di kode, bukan cuma ditulis di sini.** `isActive` berbunyi
`bonded >= minBond`, jadi nilai nol akan membuat setiap alamat yang tidak pernah bond
sama sekali terbaca sebagai solver aktif. Itu bukan pelonggaran parameter, itu
mematikan gerbangnya. Lantai juga berarti bond tidak pernah bisa turun di bawah
kalibrasi yang diluncurkan, searah dengan cap yang hanya boleh naik.

**Solver yang sudah bond saat nilai naik menjadi tidak aktif sampai menambah.** Tidak
ada grandfathering, sama seperti cap yang mengetat berlaku untuk semua orang sekaligus.
Perubahannya lewat time-lock 48 jam, jadi peringatannya dua hari penuh.

---

## 5B. Mandat agent

Ditulis 17 September 2026, saat `AgentMandate.sol` dibuat.

| Konstanta | Nilai | Alasan |
|---|---|---|
| `MANDATE_MAX_TOKENS` | **8** | Batas panjang `allowedTokens`. Validasi menyapu array ini di tiap otorisasi, jadi panjangnya harus terbatas supaya biayanya bisa dihitung. Allowlist v1.0 sendiri lima token |
| `MANDATE_MAX_DURATION` | **90 hari** | Jarak terjauh `expiry` boleh berada dari saat mandat dibuat. Mandat yang tidak pernah kedaluwarsa adalah approval tak terbatas dengan nama lain |
| `MANDATE_DAY` | **hari kalender New York** | Batas reset `maxNotionalPerDay`. Bukan tengah malam UTC, karena tengah malam UTC jatuh di tengah sesi `POST_MARKET` dan akan memberi agent dua anggaran harian dalam satu malam Amerika |

### 5B.1 Celah yang ditemukan saat menulis kontraknya

`desain-agent.md` §3.2 mengandaikan intent bertanda-agent bisa langsung
dieksekusi Settlement. Ternyata tidak bisa. `Settlement._pull` memindahkan dana
lewat `permit2.permitWitnessTransferFrom(..., i.owner, ...)`, dan Permit2 hanya
menerima tanda tangan yang berasal dari `i.owner` sendiri. Tanda tangan agent
ditolak Permit2 sebelum Settlement sempat berpendapat.

Keputusan pemilik proyek, 17 September 2026. `AgentMandate` men-deploy satu akun
klon deterministik per pasangan pemilik dan agent. Alamat klon itulah yang jadi
`i.owner` pada intent agent, dan ia menjawab EIP-1271 dengan bertanya balik ke
registry. Permit2 tidak berubah, `Settlement._pull` tidak berubah, dan pemilik
menyetor ke akun itu hanya sebesar yang boleh diperdagangkan agent. Radius
ledakan agent yang dikompromikan dibatasi dua kali, oleh setoran dan oleh mandat.

Dua alternatif digugurkan. Delegasi EIP-7702 lebih bersih secara pengalaman
pengguna tapi mengganti seluruh kode EOA pemilik, jadi bentrok dengan delegasi
dompet lain, dan toleransi dompet Robinhood terhadapnya belum pernah diukur di
chain 4663. Mode AllowanceTransfer Permit2 paling sedikit kodenya tapi
membatalkan properti satu tanda tangan menutupi transfer sekaligus syarat dagang,
lalu meninggalkan allowance berdiri ke Settlement.

### 5B.2 Otorisasi dulu, validasi kemudian

EIP-1271 `isValidSignature` adalah fungsi `view`, jadi ia tidak bisa mencatat
apa pun. Anggaran harian karena itu dibukukan di panggilan terpisah. Agent
memanggil `authorize`, kontrak menjalankan seluruh aturan mandat, membukukan
notional, lalu menandai digest Permit2 itu sebagai sah. Setelah itu
`isValidSignature` cuma membaca tanda yang sudah ada.

Harganya satu transaksi tambahan per intent. Imbalannya, setiap pemakaian mandat
jadi peristiwa onchain yang bisa diaudit lewat `MandateUsed`, bukan konsekuensi
diam dari sebuah tanda tangan. Biaya data L1 di chain ini nol, jadi transaksi
tambahan itu murah.

Intent yang diotorisasi tapi tidak pernah terisi mengembalikan anggarannya lewat
`releaseUnspent`, yang membaca bitmap nonce Permit2 untuk memastikan nonce-nya
memang belum pernah terpakai. Isian sebagian tetap membebani anggaran penuh.
Arah pembulatan itu berpihak ke pemilik, sesuai aturan pembulatan §9.

---

## 6. Exposure cap (peluncuran → skala)

| Konstanta | Nilai awal | Plafon governance |
|---|---|---|
| `CAP_PER_BATCH` | **$5.000** | $500.000 |
| `CAP_PER_TOKEN_DAILY` | **$50.000** | $5.000.000 |
| `CAP_GLOBAL_DAILY` | **$200.000** | $20.000.000 |

**Aturan kenaikan:** boleh digandakan setelah **7 hari berturut-turut tanpa insiden**
(nol pelanggaran invarian, nol `finalize` gagal, nol masuk `PROTECTIVE` yang tidak
dijelaskan). Kenaikan lewat time-lock seperti perubahan parameter lain.

> Inilah yang membuat mainnet awal aman meski belum diaudit: **kerugian maksimum
> menjadi angka yang dihitung, bukan yang diharapkan.**

Saat sesi `WEEKEND`, `HOLIDAY`, atau `PROTECTIVE`, seluruh cap **dikalikan 0,5**.

---

## 7. Oracle

> **Diperbarui 1 Agustus 2026 setelah verifikasi onchain.** RedStone **tidak ada**
> di Robinhood Chain. Sumber kedua diganti menjadi **TWAP Uniswap V3** — dan itu
> justru lebih kuat, karena mode kegagalannya benar-benar berbeda dari oracle.

### 7.1 Staleness — per feed, bukan global

Diturunkan dari cadence terukur atas seluruh riwayat feed, 22 Juni sampai 18
September 2026 (p99 jeda antar-update, dibulatkan ke atas). **Wajib per-feed:**
cadence antar-aset berbeda sampai empat kali di sesi `OPEN`.

> ### Alamat lengkap dan pengukuran ulang, 19 September 2026
>
> Tabel di bawah ini dibuat 1 Agustus 2026 dari cadence 24 sampai 31 Juli, lalu
> diukur ulang 16 September atas jendela yang terlalu pendek. **Tiga hal di
> dalamnya sekarang salah**, dan ketiganya menyentuh `PriceOracle`.
>
> **1. Yang tercatat adalah alamat aggregator, bukan proxy.** `0xC9D16E4F...` tidak
> punya `aggregator()`, sedangkan `0x379ec4f7...` punya dan menunjuk ke sana. Feed
> Chainlink dikonsumsi lewat proxy supaya aggregator bisa diganti tanpa memutus
> konsumen. Alamat lengkap keduanya untuk allowlist v1.0.
>
> | Token | Proxy, ini yang dipakai kontrak | Aggregator, yang tercatat sebelumnya | `description()` |
> |---|---|---|---|
> | **NVDA** | `0x379ec4f7c378f34a1b47e4f3cbebcbac3e8e9f15` | `0xC9d16E4f2569b9E3ea0468fD85844953713DC2a2` | `RHNVDA / USD` |
> | **AAPL** | `0x6b22a786baa607d76728168703a39ea9c99f2cd0` | `0xBb11A21267cFDb63d4935d99a499133DD1744ACb` | `Robinhood AAPL / USD` |
> | **TSLA** | `0x4a1166a659a55625345e9515b32adecea5547c38` | `0x7A6b81ba7FbCB90104d8C496158Cf383cD7233b1` | `RHTSLA / USD` |
> | **GOOGL** | `0xf6f373a037c30f0e5010d854385ca89185ae638b` | `0x11eD6d598eF565DDA86fAfE7E779303e7CC6b2Bd` | `Robinhood GOOGL / USD` |
> | **GME** | `0x27C71df6A64fB476468EdF256CF72c038baB5B67` | `0xf83Cde62D1Cd90dE8d2Bf3332B90c590985aD679` | `Robinhood GME / USD` |
>
> Semuanya 8 desimal. GOOGL sebelumnya tidak punya baris di tabel di bawah sama
> sekali, padahal ia ada di allowlist v1.0. Sekarang punya.
>
> **2. Ada dua keluarga feed, dan yang kedua baru berumur empat hari.** Selain
> keluarga `RH*` di atas, ada keluarga bernama polos: `NVDA / USD`
> (`0xe5f00a9e04ed6d86dc53bfcd8de4bad22e4fe5e4`), `GOOGL / USD`
> (`0x3d5661b635da3bb607a95be39d4d28fc24f4c683`), `AAPL / USD`
> (`0x273cb738fe4ef162bcdfb603c89da224e1b67b0e`). Ketiganya memancarkan
> `AnswerUpdated` pertamanya **15 September 2026 pukul 09.03 UTC**, dalam rentang
> sepuluh detik satu sama lain. Keluarga polos mengukur saham biasa, bukan token
> Robinhood, dan **tidak dibaca satu konsumen pun** di chain ini.
>
> **3. Cadence sebenarnya, diukur atas seluruh riwayat feed.** Pengukuran 16
> September memakai jendela 1 sampai 16 September dan **tidak tereproduksi**.
> Angka di bawah ini memakai seluruh 88 hari sejak `AnswerUpdated` pertama pada
> 22 Juni 2026, dengan jeda akhir pekan dikeluarkan dari ember off-hours supaya
> ia tidak mencemari angka semalam. Kueri `8776938` dan `8776980`.
>
> | Feed | OPEN p50 | OPEN p95 | OPEN p99 | Semalam p95 | Semalam p99 |
> |---|---|---|---|---|---|
> | TSLA | 783 dtk | 7.153 | **14.885** | 31.890 | **59.585** |
> | NVDA | 1.107 dtk | 8.686 | **18.785** | 31.412 | **60.379** |
> | GOOGL | 1.359 dtk | 15.227 | **54.617** | 43.664 | **64.792** |
> | AAPL | 1.477 dtk | 19.441 | **63.260** | 55.684 | **66.801** |
>
> Basis 1.279 update TSLA, 1.061 NVDA, 798 GOOGL, 645 AAPL. Nol baris akhir pekan
> pada keluarga `RH`, jadi §7.3 tetap berdiri apa adanya.
>
> **Selisih harga antar keluarga jauh lebih lebar dari satu sampel 41 bps.**
> Diukur di setiap update keluarga polos terhadap jawaban `RH` terakhir saat itu,
> 15 sampai 19 September, kueri `8776946`.
>
> | Token | p50 | p95 | max |
> |---|---|---|---|
> | AAPL | 14,4 bps | 43,0 | 74,9 |
> | GOOGL | 19,2 bps | 207,6 | 256,4 |
> | NVDA | 26,7 bps | 162,3 | 213,6 |
>
> Sebagian dari selisih itu adalah keterlambatan `RH`, bukan ketidaksepakatan.
> Saat diukur, jawaban `RH` rata-rata sudah berumur dua sampai empat jam. Keduanya
> tidak bisa dipisahkan dengan data yang ada sekarang.
>
> **Keputusan, 19 September 2026.** `PriceOracle` v1.0 memakai **keluarga `RH`
> saja**. Keluarga polos ditolak untuk v1.0 karena umurnya empat hari dan tidak
> ada konsumen lain yang akan menyadari kalau ia rusak. Ia juga tidak dipasang
> sebagai pemeriksa kedua, karena p95 selisihnya 208 bps sementara
> `ORACLE_DISAGREE_BPS` sesi `OPEN` adalah 50 bps. Alarm yang berbunyi rutin pada
> kondisi normal sama saja dengan tidak ada alarm.
>
> Satu sifat keluarga polos tetap dicatat dan dipantau, yaitu ia terus memperbarui
> di akhir pekan sementara `RH` membeku. Buktinya baru satu akhir pekan. Lihat
> P6-3 di `pertanyaan-terbuka.md`.

**Ambang staleness allowlist v1.0, diturunkan 19 September 2026.** Aturannya
**p99 dibulatkan ke atas ke kelipatan seribu**, bukan p95. Alasannya, p95 berarti
satu dari dua puluh batch di sesi teramai jatuh ke `PROTECTIVE` tanpa ada yang
rusak. Yang menahan kerugian adalah exposure cap dan price band, bukan staleness.
`STALENESS_OPEN` dibaca dari kolom OPEN p99, `STALENESS_CLOSED` dari semalam p99.

| Aset | Proxy yang dibaca kontrak | `STALENESS_OPEN` | `STALENESS_CLOSED` | Layak diluncurkan |
|---|---|---|---|---|
| TSLA | `0x4a1166a6…` | 15.000 dtk | 60.000 dtk | Ya |
| NVDA | `0x379ec4f7…` | 19.000 dtk | 61.000 dtk | Ya |
| GOOGL | `0xf6f373a0…` | 55.000 dtk | 65.000 dtk | Ya, lihat P6-2 |
| AAPL | `0x6b22a786…` | 64.000 dtk | 67.000 dtk | Ya |
| GME | `0x27C71df6…` | 65.000 dtk | 56.000 dtk | Ya, ditambahkan 20 September 2026 |

Nilai lama yang diturunkan dari p95 Juli, yaitu `STALENESS_OPEN` 6.000 dtk untuk
NVDA dan TSLA serta 10.000 dtk untuk AAPL, **jangan dipakai lagi**. Ketiganya
terlalu ketat terhadap perilaku feed yang terukur.

GME satu-satunya yang `STALENESS_CLOSED`-nya lebih kecil daripada `STALENESS_OPEN`.
Itu bukan salah ketik. Feednya memang lebih teratur di luar jam bursa daripada di
dalamnya, p99 55.818 dtk semalam lawan 64.479 dtk saat buka.

Token di luar allowlist v1.0 belum diukur ulang di atas basis 88 hari. Angka Juli
untuk META, MSFT, GME, dan SPY disimpan sebagai jejak di §1B dan tidak boleh
dipakai untuk menyetel apa pun sebelum diukur ulang dengan metode yang sama.
SPCX tetap dikecualikan permanen karena tidak punya feed sama sekali.

| Konstanta | Nilai | Alasan |
|---|---|---|
| `STALENESS_FLOOR` | **600 detik** | Batas bawah; feed tercepat pun p95-nya ~750 dtk |
| `STALENESS_CEILING` | **200.000 detik** | Di atas ini feed dianggap mati. Harus melampaui jeda akhir pekan (lihat §7.3) |
| `TWAP_WINDOW` | **1.800 detik** (30 mnt) | Cukup panjang untuk mahal dimanipulasi, cukup pendek untuk responsif. Cardinality pool NVDA 6.000 — sangat mencukupi |
| `HEALTHY_UPDATES_TO_EXIT` | **3** berturut-turut | Cegah osilasi masuk-keluar `PROTECTIVE` |

> ⚠️ **Tabel di atas hanya menilai kualitas feed.** Itu satu dari tiga syarat.
> **Allowlist final ada di [§7.4](#74-allowlist-peluncuran--dikoreksi)** — yang
> menyaring dengan volume DAN kualitas feed DAN likuiditas akhir pekan.
> Jangan memakai bagian ini sebagai dasar allowlist.

### 7.2 Sumber harga

| Sumber | Peran | Catatan |
|---|---|---|
| **Chainlink `DualAggregator`** | Referensi utama (hari kerja) | 30 feed, 8 desimal, antarmuka `AggregatorV3` |
| **TWAP Uniswap V3** | Pembanding — **dan sumber utama saat akhir pekan** | Gratis; sudah dibaca untuk baseline |
| ~~RedStone~~ | ❌ Tidak ada di chain ini | Terverifikasi 1 Agu 2026 |

### 7.3 🔴 Perilaku akhir pekan — feed Chainlink MEMBEKU

Terukur: `max_gap` hampir setiap feed **173.000–202.000 detik (48–56 jam)** —
feed benar-benar diam dari Jumat sore sampai Senin.

**Karena itu peran oracle harus berganti per sesi:**

| Sesi | Chainlink | TWAP UniV3 | Cek ketidaksepakatan |
|---|---|---|---|
| `OPEN` / `PRE` / `POST` | Referensi harga wajar | Pembanding | ✅ `ORACLE_DISAGREE_BPS` = **50 bps** |
| `CLOSED_OVERNIGHT` | Referensi (masih update) | Pembanding | ✅ **150 bps** (dilonggarkan) |
| **`CLOSED_WEEKEND` / `HOLIDAY`** | **Jangkar penutupan Jumat** — bukan harga wajar | **Sumber harga utama** | ❌ **NONAKTIF** |

| Konstanta akhir pekan | Nilai | Alasan |
|---|---|---|
| `WEEKEND_DRIFT_CAP_BPS` | **1.500 bps** | Lihat kalibrasi di bawah. **Bukan** price band — ini circuit breaker untuk anomali/manipulasi, bukan pagar harga normal |
| `WEEKEND_BAND_ANCHOR` | TWAP UniV3 | Price band mengacu ke TWAP, bukan ke Chainlink yang beku |

**Kalibrasi dari drift Jumat→Senin yang terukur (Juli 2026):**

| Token | p50 drift | **max drift** |
|---|---|---|
| NVDA | 112 bps | **136 bps** |
| MSFT | 219 bps | 219 bps |
| SPCX | 172 bps | 279 bps |
| AAPL | 84 bps | 399 bps |
| META | 572 bps | 572 bps |
| **TSLA** | 350 bps | **781 bps** |

> ⚠️ **Tebakan awal 500 bps SALAH dan berbahaya.** TSLA sudah tercatat drift
> **781 bps** dalam sampel satu bulan — cap 500 bps akan mematikan TSLA ke
> `PROTECTIVE` di akhir pekan normal, tanpa ada yang rusak sama sekali.
>
> **1.500 bps** dipilih agar tidak menyala pada pergerakan pasar normal. Tugasnya
> menangkap kerusakan dan manipulasi, bukan volatilitas. Perlindungan terhadap
> kerugian tetap datang dari **exposure cap** (yang sudah dikalikan 0,5 di akhir
> pekan), bukan dari drift cap.
>
> ⚠️ **Sampelnya hanya 2–4 akhir pekan** (chain baru sebulan). Di TradFi, gap
> akhir pekan 3–5% biasa dan 10%+ terjadi saat berita besar. **Tinjau ulang
> parameter ini setelah 3 bulan riwayat mainnet.**

**TWAP terbukti hidup di akhir pekan** — bukan asumsi:

| Token | Trade akhir pekan | % dari total | p50 jeda antar-trade |
|---|---|---|---|
| NVDA | 20.960 | 15,7% | **2 detik** |
| GME | 13.162 | 12,2% | 2 detik |
| SPY | 1.008 | 12,0% | 5 detik |
| MSFT | 866 | 11,7% | 11 detik |
| TSLA | 760 | 6,0% | 50 detik |
| AAPL | 805 | 3,7% | 112 detik |

> ⚠️ **Tanpa aturan §7.3, seluruh token akan masuk `PROTECTIVE` sepanjang akhir
> pekan** — yaitu sesi yang paling ingin kita layani. Bug desain yang tertangkap
> saat verifikasi, bukan saat implementasi.

### 7.4 Allowlist peluncuran — DIKOREKSI

> ### Syarat masuk allowlist, dinyatakan lengkap 20 September 2026
>
> Sebelumnya dokumen ini menyebut tiga syarat. Pemeriksaan GME dan META pada
> 20 September menunjukkan ada dua lagi yang selama ini dipakai tanpa pernah
> ditulis, dan yang kelima hampir meloloskan token yang seharusnya gugur. Kelimanya
> harus lolos. Satu gagal berarti token itu tidak masuk, seberapa pun bagus sisanya.
>
> | # | Syarat | Diukur dengan | Ambang |
> |---|---|---|---|
> | 1 | **Gerbang Stock Token** | `StockTokenGate`, slot beacon dan `uiMultiplier()` | Mutlak, ditegakkan kode |
> | 2 | **Volume** | Dune, 30 hari, hanya token asli | Cukup tebal untuk memberi lawan arah per batch |
> | 3 | **Kualitas feed** | p99 jeda `AnswerUpdated` sesi `OPEN`, seluruh riwayat feed | Setara token allowlist terburuk yang sudah diterima |
> | 4 | **Likuiditas akhir pekan** | Jumlah trade dan jeda antar-trade Sabtu Minggu | Hidup, karena 74% arus ada di luar jam bursa |
> | 5 | **Kedalaman pool** | `PoolDepthFork`, dampak harga bps di sepuluh kali cap | Menjawab di sepuluh kali cap, paling banyak empat penyeberangan di cap |
> | 6 | **Venue dominan bisa dikuotasi** | Volume per venue dari `dex.trades` | Mayoritas arus ada di venue yang adapter v1.0 bisa baca |
>
> **Syarat keenam yang baru ditulis, dan kenapa ia mahal kalau terlewat.** META
> lolos syarat dua sampai lima dengan nyaman. Feednya ketiga terbaik, nettingnya
> kedua terbaik, volumenya di atas TSLA. Tapi 95% arusnya ada di Uniswap V4 yang
> tidak bisa dikuotasi adapter v1.0, dan pool V3 yang tersisa harganya 109 bps dari
> feednya sendiri. Memasukkannya berarti menerbitkan harga pembanding dari pool yang
> memegang seperdua puluh arus token itu. Klaim price improvement terhadap baseline
> seperti itu tidak akan bertahan diperiksa, dan itu persis kelas klaim yang sudah
> digugurkan audit 11 Agustus 2026.
>
> **Syarat satu berbeda jenis dari lima lainnya.** Ia ditegakkan mesin, tidak bisa
> dinegosiasikan, dan `Bootstrap` menolak membangun batch kalau ada token yang
> gagal. Syarat dua sampai enam adalah penilaian manusia di atas pengukuran, dan
> jejaknya wajib ada di dokumen ini sebelum tokennya masuk kode.
>
> **Prosedurnya.** Ukur keenamnya, tulis hasilnya di sini, baru ubah
> `script/Addresses.sol` dalam PR yang sama. Setelah mainnet berdiri, penambahan
> berjalan lewat proposal timelock 48 jam, bukan deploy ulang.

Rekomendasi sebelumnya (NVDA, TSLA, **META**, **MSFT**) dibuat dari kualitas feed
saja. Setelah volume per-token diukur, **META dan MSFT terlalu tipis**.

| Token | Volume | Feed | Likuiditas akhir pekan | Drift maks | Putusan |
|---|---|---|---|---|---|
| **NVDA** | Tertinggi ($83jt) | ✅ p95 5.281 dtk | ✅ 20.960 trade, jeda 2 dtk | 136 bps | ✅✅ **Jangkar** |
| **AAPL** | Sedang (21.873) | ✅ p95 8.965 dtk | ⚠️ 805 trade | 399 bps | ✅ |
| **TSLA** | Sedang (12.606) | ✅ p95 5.281 dtk | ⚠️ 760 trade | 781 bps | ✅ |
| **GOOGL** | Sedang (11.613) | ✅ | ⚠️ 1.372 trade | — | ✅ |
| GME | **#2 ($56jt)** | ❌ p95 **64.297 dtk** | ✅ 13.162 trade | — | ⚠️ **Ditunda — feed pemblokirnya** |
| SPCX | #3 ($38jt) | ❌ **tidak ada feed** | Sedang | 279 bps | ❌ **Dikecualikan permanen** |
| MSFT | Rendah (7.407) | ✅ | ❌ 866 trade | 219 bps | ⚠️ Marginal |
| META | **Rendah (<500)** | ✅ | — | 572 bps | ⚠️ Volume terlalu tipis |
| SPY | Rendah (8.432) | ❌ p95 **86.417 dtk** | ⚠️ 1.008 trade | — | ⚠️ Ditunda |

**Allowlist v1.0: NVDA, AAPL, TSLA, GOOGL, GME.**

> ### GME ditambahkan 20 September 2026, dan kenapa penundaannya sudah tidak berdiri
>
> Baris GME di tabel di atas menundanya karena feed, dengan p95 64.297 detik dari
> jendela 24 sampai 31 Juli. Angka itu **tidak tereproduksi**. Diukur atas seluruh
> 88 hari riwayat feed dengan jeda akhir pekan dikeluarkan, p95-nya 46.370 dan
> p99-nya 64.479, yang menempatkannya sekelas AAPL di 63.260. AAPL ada di allowlist
> sejak awal. Lihat pelajaran metodologi kedelapan di `pertanyaan-terbuka.md`.
>
> Ketiga syarat diperiksa ulang, bukan hanya yang dulu menggugurkannya.
>
> | Syarat | GME |
> |---|---|
> | Volume | Nomor tujuh dari 192 token, $240,4jt dalam 30 hari |
> | Kualitas feed | p99 sesi `OPEN` 64.479 dtk, sekelas AAPL |
> | Likuiditas akhir pekan | 13.162 trade, jeda antar-trade 2 detik |
> | Kedalaman pool | 75 bps di sepuluh kali cap, lihat §4B |
> | Venue | Uniswap V3 dominan, $145,5jt lawan $2,6jt di V4 |
>
> Token aslinya `0x1b0E319c6A659F002271B69dB8A7df2F911c153E`, lolos gerbang beacon
> dan `uiMultiplier()` tepat 1e18. **Jangan tertukar dengan memecoin bersimbol GME**
> `0xc2362aff…` yang slot beacon-nya kosong, lihat `CLAUDE.md` §5.

> ### GOOGL diperiksa ulang 20 September 2026, dan dipertahankan
>
> P6-2 lahir dari angka yang menempatkan GOOGL sebagai feed terburuk di allowlist,
> dan angka itu tidak tereproduksi. Karena incumbent tidak pantas dapat kelonggaran
> yang tidak diberikan ke pendatang, GOOGL diukur ulang lawan **keenam** syarat, bukan
> hanya yang dulu mempertanyakannya.
>
> | # | Syarat | GOOGL | Putusan |
> |---|---|---|---|
> | 1 | Gerbang Stock Token | Lolos beacon, `uiMultiplier()` bergeser dari 1e18 | Lolos |
> | 2 | Volume | **$294,2jt / 30 hari, nomor dua dari lima** | Lolos dengan lega |
> | 3 | Kualitas feed | p99 sesi `OPEN` 54.617 dtk, terburuk kedua setelah AAPL 63.260 | Lolos, sekelas incumbent |
> | 4 | Likuiditas akhir pekan | 416.048 trade, **$80,8jt, nomor dua dari lima** | Lolos |
> | 5 | Kedalaman pool | **7 bps di sepuluh kali cap**, 1 crossing di cap, bisa dikuotasi sampai $286.886 | Lolos, paling tebal dari yang terukur |
> | 6 | Venue dominan | Uniswap V3 44,8%, plus 6,5% di venue yang byte-identik | Lolos, sekelas TSLA |
>
> **Syarat enam adalah satu satunya yang sempit, dan perbandingannya yang menentukan.**
> GOOGL punya pangsa V3 terendah dari kelima token. Tapi TSLA ada di 46,2%, praktis
> sama, dan TSLA incumbent yang tidak pernah dipertanyakan. Yang gugur karena venue
> adalah META di **5,2%**, satu tingkat besaran di bawah. GOOGL tidak berada di kelas
> itu.
>
> Dan pool V3 GOOGL bukan pool yang ditinggalkan arus. Ia memutar $131,9jt lewat
> 701.560 trade dan harganya paling tebal dari semua yang diukur. Pola META, yaitu
> pool tipis yang harganya 109 bps dari feednya sendiri, tidak ada di sini.
>
> | Token | Volume 30 hari | Uniswap V3 | Pangsa V3 | Uniswap V4 |
> |---|---|---|---|---|
> | NVDA | $1.247,1jt | $955,1jt | 76,6% | $195,3jt |
> | **GOOGL** | **$294,2jt** | $131,9jt | **44,8%** | $140,1jt |
> | GME | $241,4jt | $226,5jt | 93,8% | $7,2jt |
> | AAPL | $224,9jt | $116,9jt | 52,0% | $52,6jt |
> | TSLA | $118,6jt | $54,8jt | 46,2% | $46,4jt |
>
> ⚠️ **Pangsa V3 di tabel ini adalah batas atas, bukan angka presisi.** Lebih dari 80%
> trade V4 tidak membawa `amount_usd`, jadi volume V4 understated dan pangsa V3 karena
> itu overstated. Ini P5-2 yang masih terbuka. Kelima token terkena efek yang sama,
> jadi **urutannya jauh lebih kokoh daripada levelnya**, dan yang dipakai memutuskan
> di sini adalah urutannya.
>
> 🔴 **Satu angka lama di tabel di bawah salah besar.** Baris GOOGL menulis volumenya
> "Sedang (11.613)". Itu hitungan trade dari cakupan lama yang jauh lebih sempit, dan
> membacanya sebagai ukuran volume menempatkan GOOGL di urutan keempat padahal ia
> **nomor dua**. Bentuknya sama dengan pelajaran metodologi kedelapan, yaitu angka yang
> stabil dan mengukur benda lain. Kueri `8779088`.

**Yang masih di luar, dan alasannya masing-masing berbeda.**

**SPY** tetap ditunda, dan pengukuran ulang justru memperkuat penundaannya. Atas 88
hari riwayat, ia hanya mencatat 76 jeda di sesi `OPEN` dengan p50 25.748 detik dan
p99 mentok di 86.428 detik. Itu tanda feed harian, bukan feed intraday. Volumenya
naik 42 kali lipat, feednya tidak ikut.

**SPCX** tetap dikecualikan permanen. Tidak ada feed sama sekali, dan tidak akan
ada, karena aset pra-IPO tidak punya bursa induk.

**META** diperiksa tuntas 20 September dan **gugur karena venue, bukan karena feed
maupun kedalaman**. Feednya justru ketiga terbaik dengan p99 19.868 detik, netting
per batch-nya kedua terbaik di 45,4%, dan volumenya $116,8jt. Tapi arusnya ada di
Uniswap V4, $97,5jt lawan $5,4jt di V3, sementara adapter v1.0 hanya V3. Pool V3
yang tersisa sepuluh kali lebih tipis daripada GME dan harganya 109 bps di atas
feed, yaitu pola pool yang ditinggalkan arus. Menempatkannya di allowlist berarti
menerbitkan harga pembanding dari pool yang memegang seperdua puluh arusnya. **META
masuk di v1.1 bersama adapter V4.**

**AMC dan GLD** belum pernah diperiksa sama sekali, dan keduanya ada di sepuluh
besar volume. Bukan ditolak, melainkan belum diukur.

Catatan yang tidak nyaman tapi penting, **diperbarui 20 September 2026.** Kalimat
lama di sini menyebut GME dan SPCX sebagai dua token yang tidak bisa diluncurkan
karena infrastruktur oracle. Untuk GME itu sudah tidak benar dan ia sekarang ada di
allowlist. Yang tetap benar, dan tetap harus disebut di pitch, adalah bahwa **SPY
dan SPCX tidak bisa diluncurkan karena feednya, bukan karena likuiditasnya**, dan
keduanya token volume nomor dua dan nomor tiga.

Diukur atas 30 hari dan 192 token asli, **allowlist v1.0 dengan lima token memegang
31,9% volume stock token**. Sebut angka itu apa adanya. Ia bukan mayoritas, dan
yang menahannya adalah infrastruktur harga di chain ini, bukan pilihan kita.

**Sumber harga referensi:** lihat §7.2 (peran dasar) dan §7.3 (peran bergeser saat
akhir pekan — Chainlink membeku, TWAP jadi sumber utama). Jangan menyalin ulang
tabelnya ke sini; satu tempat saja.

⚠️ **`transmitSecondary` pada `DualAggregator` tidak pernah dipakai** (nol panggilan).
Tidak ada harga pembukaan/penutupan resmi yang terekspos onchain — lihat §12.

---

## 8. Governance & kontrol darurat

| Konstanta | Nilai | Alasan |
|---|---|---|
| `TIMELOCK_DELAY` | **48 jam** | Cukup untuk mendeteksi kunci owner yang dikompromikan |
| Guardian pause | **instan, tanpa time-lock** | Penghentian darurat harus cepat |
| Guardian unpause | **tidak bisa** | Guardian sengaja dibuat tidak berdaya |
| `PAUSE_DURATION` | **6 jam**, lalu lepas sendiri | Cukup untuk telaah; tidak melumpuhkan kalau pause-nya keliru |
| Alamat guardian | parameter, diubah lewat time-lock | Membatasi griefing kunci bocor ke 48 jam |
| Kekuasaan memindahkan dana | **tidak ada, untuk siapa pun** | Properti inti; bisa diverifikasi dengan membaca kode |

Yang bisa diubah lewat time-lock: allowlist token, allowlist adapter, parameter
sesi (dalam rentang keras), tabel kalender, tabel DST, exposure cap, parameter fee
(dalam batas keras), dan alamat guardian.

### 8.1 Pause berakhir sendiri, tidak ada yang mencabutnya

Diperbaiki 19 September 2026. Baris lama berbunyi "owner unpause setelah 6 jam
cooldown", dan itu **tidak bisa dieksekusi siapa pun**. Owner di desain ini adalah
timelock 48 jam, jadi setiap panggilan owner butuh dua hari dan angka enam jam itu
tidak pernah bisa tercapai.

Yang menggantikannya, `pause()` menulis tenggat enam jam ke depan dan tidak ada
fungsi unpause sama sekali. Ia lewat begitu saja.

Bentuk ini mempertahankan keempat maksud aslinya. Penghentian tetap instan. Guardian
tetap tidak berdaya, karena ia bahkan tidak bisa mencabut pause-nya sendiri. Enam jam
tetap jadi jendela telaah. Dan pause yang keliru tidak melumpuhkan protokol selama
dua hari.

Guardian boleh memanggil `pause()` lagi selama insidennya berlanjut. Artinya kunci
guardian yang bocor bisa menahan protokol terus-menerus, dan batasnya adalah **48 jam**,
yaitu waktu yang dibutuhkan timelock untuk merotasi alamatnya. Itu sebabnya alamat
guardian adalah parameter, bukan nilai immutable.

### 8.2 Pause menghentikan nilai masuk, tidak pernah nilai keluar

Kunci yang bisa menjebak dana pengguna sama buruknya dengan kunci yang bisa
memindahkannya, dan lebih licin karena tidak terbaca seperti pencurian. Aturan 5 di
`CLAUDE.md` mencakup keduanya.

`refundEscrow` hanya bisa dipanggil setelah lelangnya `EXECUTED` atau `ABORTED`, jadi
pause yang memblokir `abortAuction` akan menjebak escrow sampai pause lepas. Itu jalur
yang harus dijaga secara eksplisit, bukan diserahkan pada kehati-hatian.

| Dihentikan pause | Tidak pernah dihentikan |
|---|---|
| `Settlement.submitSolution` | `Settlement.expireBatch` |
| `Settlement.finalize` | `Settlement.submitIntentOnchain` |
| `AuctionHouse.openAuction` | `AuctionHouse.abortAuction` |
| `AuctionHouse.commitAuctionIntent` | `AuctionHouse.refundEscrow` |
| `AuctionHouse.freeze` | `AuctionHouse.cancelBeforeFreeze` |
| `AuctionHouse.submitCross` | `AuctionHouse.extend` |
| `AuctionHouse.challenge` | `AuctionHouse.publishIndicative` |
| `AuctionHouse.executeCross` | Seluruh `SolverRegistry`, termasuk `withdrawBond` |

`SolverRegistry` sengaja tidak punya guardian. Ia tidak menyelesaikan apa pun, dan
`withdrawBond` adalah jalur keluar yang harus selalu hidup.

### 8.3 Pemantauan — enam sinyal, dua di antaranya memanggil pause

Ditambahkan 20 September 2026. `threat-model.md` §6.1 mendaftar enam sinyal dan
§6.3 poin 2 menetapkan kriteria pause. Bagian ini menetapkan **nilai dan jalurnya**,
supaya yang berjalan bisa dibandingkan dengan yang tertulis.

Satu temuan yang membentuk seluruh rancangannya. **Kedua sinyal yang memanggil pause
adalah fungsi murni dari state chain saat ini.** Keempat sinyal lain butuh riwayat,
dan keempatnya tidak memanggil pause. Artinya jalur pause tidak butuh archive node,
tidak butuh indexer, dan tidak butuh basis data lokal yang bisa melenceng dari chain.

| Sinyal §6.1 | Kode | Sumber data | Aksi |
|---|---|---|---|
| Invarian menyimpang | `M1` `M2` | state | **pause** |
| Saldo kontrak menyimpang | `M3` | state | **pause** |
| Selisih dua oracle | `M4` | state | lapor, `PROTECTIVE` sudah otomatis onchain |
| Volume lelang di bawah minimum | `M5` | state | lapor, print sudah ditandai onchain |
| Harga kliring di tepi collar 3× | `M6` | riwayat event | lapor |
| Solusi gagal `finalize` 2× sehari | `M7` | riwayat event | lapor |

#### Yang memanggil pause

| Kode | Pemeriksaan | Ambang |
|---|---|---|
| `M1` | `balanceOf(settlement)` untuk tiap token allowlist dan USDG | **nol**, sekali pun tidak |
| `M2` | `balanceOf(timelock)` untuk tiap token allowlist dan USDG | **nol**, sekali pun tidak |
| `M3` | `balanceOf(auctionHouse)` lawan escrow yang belum dibayarkan | saldo **>=** escrow |

`M1` adalah invarian `theSettlementCoreNeverHoldsATokenBetweenCalls` yang dibaca dari
chain sungguhan alih alih dari harness. Settlement menahan selisih biaya lalu
membagikan seluruhnya di panggilan yang sama, jadi di antara transaksi ia memegang
nol. Kebocoran, sisa pembulatan, dan saldo tersangkut ketiganya muncul di sini
sebagai angka bukan nol.

`M2` adalah `theGovernorNeverHoldsAToken`. Timelock mengatur allowlist dan parameter,
dan tidak ada jalur yang memberinya token.

`M3` adalah `theHouseAlwaysHoldsEveryEscrowItHasNotPaidOut`. Escrow ditarik saat
freeze dan dilepas saat cross atau refund, jadi bukunya bisa ditelusuri dari state
lewat `bookLength`, `bookAt`, dan `commitment`.

| Konstanta | Nilai | Alasan |
|---|---|---|
| `MONITOR_AUCTION_LOOKBACK` | **64 lelang** | Lima token kali dua jenis kali dua hari adalah dua puluh. Enam puluh empat menutup tiga hari lebih dengan lega, dan membatasi jumlah pembacaan state per putaran |
| `MONITOR_INTERVAL` | **60 detik** | Batch terpendek 45 detik. Interval yang lebih rapat tidak menambah apa pun karena satu batch tidak bisa menyelesaikan dua kali |
| `MAX_LOG_SPAN` | **101 blok** | Batas endpoint, terukur 20 September 2026. Bukan pilihan kami |
| `MAX_CATCHUP_BLOCKS` | **6.000 blok** | Sekitar sepuluh menit. Di atas itu mengejar ketinggalan berarti enam ratus panggilan, dan sinyal yang hidup lebih berharga daripada sinyal yang lengkap |

#### Batas endpoint yang membentuk kedua sinyal riwayat

Terukur 20 September 2026 di `robinhood.drpc.org`, mainnet dan testnet, dan hasilnya
bukan yang tertulis di pesan errornya.

Log **dilayani setidaknya 60 juta blok ke belakang**, jauh melampaui jendela state
yang cuma 20 sampai 40 ribu blok. Jadi kalimat lama bahwa endpoint ini bukan archive
node benar untuk state dan **tidak benar untuk log**.

Tapi satu kueri tidak boleh melebihi **101 blok**, apa pun filternya dan seberapa pun
sedikit yang cocok. Kueri 102 blok atas satu event langka yang tidak cocok dengan apa
apa tetap ditolak. Endpoint menolaknya dengan pesan *ranges over 10000 blocks are not
supported on free plan*, dan **angka sepuluh ribu itu bukan yang sedang ia ukur**.

Konsekuensinya langsung. Satu hari log adalah 864.000 blok, yaitu **8.554 panggilan**,
jadi mengisi mundur jendela sehari saat pemantau baru dinyalakan tidak masuk akal.
Enam puluh detik chain adalah enam ratus blok, yaitu **enam panggilan**, dan itu
masuk akal.

Karena itu hitungan `M7` **mulai dari saat pemantau dinyalakan**, disimpan di
jurnalnya sendiri dan dipangkas ke 24 jam berjalan. Hari pertama sebuah pemantau baru
karena itu punya jendela yang belum penuh. Itu disebut di keluarannya, bukan
disembunyikan, dan pemantau yang sempat mati melaporkan berapa blok yang tidak pernah
ia baca.

#### Kenapa `M1` sampai `M3` boleh memanggil pause tanpa manusia

`threat-model.md` §6.1 sudah menulis "pause otomatis" untuk invarian yang menyimpang,
dan §6.3 poin 2 menutupnya dengan kalimat ragu antara pause dan tidak, pause.

Yang membuat itu aman di sini bukan keyakinan bahwa pemantaunya benar, melainkan
bentuk `pause()` itu sendiri. Ia tidak bisa memindahkan satu token pun, ia tidak
pernah menghalangi jalur keluar (§8.2), dan ia lepas sendiri setelah enam jam tanpa
ada yang perlu mencabutnya. Pemantau yang keliru karena itu berbiaya enam jam
penerimaan intent, bukan dana yang terjebak.

Batasnya tetap ada dan disebut di sini, bukan disembunyikan. Pemantau yang memanggil
`pause()` sendiri harus memegang kunci guardian dalam keadaan siap pakai, dan kunci
panas adalah kunci yang bisa bocor. Yang membatasi kerusakannya adalah rotasi alamat
guardian lewat timelock, **48 jam**, persis seperti tertulis di §8.1.

Karena itu penyiarannya **tidak pernah jadi bawaan**. Menjalankan pemantau tanpa
argumen hanya membaca dan melapor, dan tidak butuh kunci sama sekali. Penyiaran
menuntut kunci disebut eksplisit saat dijalankan.

#### Satu hal yang pemantau ini tidak bisa buktikan

Daftar token yang dipantau datang dari konstanta, bukan dari chain, karena
`tokenAllowed` adalah mapping dan mapping tidak bisa ditelusuri isinya. Pemantau
memeriksa bahwa tiap token yang ia pantau memang ada di allowlist. Ia **tidak bisa**
membuktikan tidak ada token allowlist yang luput dari pantauannya.

Yang menutup celah itu bukan kode melainkan bentuk governance. Token hanya masuk
allowlist lewat proposal timelock, dan proposal itu terbit 48 jam di muka. Kalau
daftar di konstanta tidak ikut diperbarui di PR yang sama, itu kelalaian yang
terlihat, bukan kegagalan yang sunyi.

---

## 9. Pembulatan & debu

| Aturan |
|---|
| Semua aritmetika bilangan bulat; **tidak ada pembagian** di jalur pemeriksaan limit |
| Kuantitas yang **diterima pengguna** selalu dibulatkan **ke bawah** |
| ⚠️ **Pengecualian: `baselineReceived` dibulatkan KE ATAS** — lihat §4B |
| Selisih pembulatan tidak boleh membuat konservasi nilai negatif |
| Debu disapu ke **protokol**, tidak pernah ke solver — supaya solver tidak punya insentif memainkan pembulatan |
| Invarian: akumulasi debu **selalu ≥ 0** |

---

## 10. Alamat terverifikasi (mainnet 4663, per 1 Agustus 2026)

| Item | Alamat |
|---|---|
| USDG kanonik (**6 desimal**) | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` |
| Beacon Stock Token (semua token berbagi) | `0xe10b6f6b275de231345c20d14ab812db62151b00` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Pool NVDA-USDG UniV3 (fee 500) — memegang **$3,86jt** sisi Stock Token (§10.3) | `0xD4EB21209C4D6093F80B5B84F5C45CC093EA14A3` |
| Pool GME-USDG UniV3 (fee 10000) — ✅ berisi GME **asli**. **Bukan** pool yang dipakai adapter, lihat blok GME di §10 | `0xE9713F453ADB9245B19559790C96F470A18F2FDF` |
| Uniswap V4 PoolManager — memegang **$31,3jt** sisi Stock Token (§10.3) | `0x8366A39CC670B4001A1121B8F6A443A643E40951` |
| ArcusSettlement | `0x006102B16A04C20306A28B652745D3973D7D24FA` |
| **Uniswap V3 factory yang benar-benar dipakai** | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |

> ### Factory dan pool allowlist, diverifikasi 16 September 2026
>
> **Alamat factory kanonik Uniswap `0x1F98431c…` bukan factory di chain ini.**
> Kontrak di alamat itu memang ada, tapi tidak menjawab `getPool` maupun `owner`,
> jadi ia bukan `UniswapV3Factory`. Catatan lama di `pertanyaan-terbuka.md` P2-6
> yang menyebutnya "Uniswap V3 factory" hanya mengukur ukuran kode, bukan identitas.
> Factory yang benar-benar membuat pool stock token adalah `0x1f7d7550…`, dibaca
> dari `factory()` pada pool NVDA dan dikonfirmasi lewat `feeAmountTickSpacing(500)`
> yang mengembalikan 10, sama dengan Uniswap V3 standar.
>
> Ini memperkuat, bukan mengubah, keputusan **adapter agnostik terhadap factory**
> di `CLAUDE.md` §2 aturan 4. Alamat factory tidak boleh di-hardcode.
>
> | Token | Fee | Pool | `token0` | `liquidity` | `tickSpacing` | Cardinality |
> |---|---|---|---|---|---|---|
> | **NVDA** | 500 | `0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3` | **USDG** | 1,32e19 | 10 | 6.000 |
> | **AAPL** | 500 | `0xAae0d815EE56e4092a5E5C2911E676Fea50B2d6D` | **USDG** | 1,41e18 | 10 | 1.801 |
> | **TSLA** | **3000** | `0xf4ACdAEEB7022862A763C9B1B885e11191c889E3` | **TSLA** | 8,85e17 | 60 | 1.801 |
> | **GOOGL** | 500 | `0x34D0dC122CF9A8Eb296fC5e0D3A233625D7d19b7` | **GOOGL** | 5,65e18 | 10 | 1.801 |
>
> Pool lain yang ada tapi tidak dipilih: NVDA fee 100 dan 10000 (likuiditas nol),
> NVDA fee 3000 `0xB944cec3…`, AAPL fee 3000 `0x783C9bbB…` dan 10000 `0x3714aa81…`,
> TSLA fee 500 `0xc4f0172D…` dan 10000 `0xB349FB08…`, GOOGL fee 3000 `0x553e9a45…`.
>
> **Tiga hal yang mengikat implementasi adapter.**
>
> 1. **TSLA satu-satunya yang kedalamannya ada di fee 3000, bukan 500.** Likuiditas
>    fee 3000 dua belas kali lipat fee 500. Adapter tidak boleh mengunci satu fee
>    tier, dan pilihan pool per pasangan masuk allowlist.
> 2. **Urutan token benar-benar tidak konsisten, sekarang terbukti bukan dugaan.**
>    USDG ada di `token0` untuk NVDA dan AAPL, tapi di `token1` untuk TSLA dan
>    GOOGL. `zeroForOne` wajib diturunkan dari `token0()`, persis seperti
>    `desain-baseline.md` §3.1 memperingatkan.
> 3. **Cardinality pool selain NVDA adalah 1.801, bukan 1.500** seperti tercatat
>    sebelumnya. `TWAP_WINDOW` 1.800 detik tetap aman.

> ### Pool GME, ditambahkan 20 September 2026
>
> GME masuk allowlist setelah tabel di atas ditulis, jadi barisnya menyusul di sini
> dan tidak disisipkan ke catatan tanggal 16.
>
> | Token | Fee | Pool | `token0` | `liquidity` | `tickSpacing` | Cardinality |
> |---|---|---|---|---|---|---|
> | **GME** | 500 | `0xE2b46c905E12Ab8E2f864e4821a4325884C1B126` | **GME** | 9,55e17 | 10 | 1.860 |
>
> Ini alamat yang dipegang `Addresses.POOL_GME`. Dibaca ulang dari chain pada
> 20 September 2026, `factory()` menjawab `0x1f7d7550…`, sama dengan keempat pool
> lainnya, dan `token0` adalah GME sehingga `zeroForOne` mengikuti pola TSLA dan
> GOOGL, bukan pola NVDA dan AAPL.
>
> **Ada pool GME kedua, dan pilihannya perlu ditulis karena angka mentahnya
> menyesatkan.** Pool `0xE9713F453ADB9245B19559790C96F470A18F2FDF` fee 10000 membawa
> `liquidity` 2,42e18, yaitu 2,5 kali lipat pool yang dipilih. Yang menentukan bukan
> angka itu. `tickSpacing` di sana 200 lawan 10, jadi likuiditas yang sama tersebar
> di rentang harga dua puluh kali lebih lebar, dan fee-nya 100 bps lawan 5 bps. Arus
> nyata juga ada di pool fee 500, yaitu $145,5jt volume September. Kedalaman pool
> fee 500 diukur dengan `CandidateDepthFork.t.sol` dan tercatat di
> `pertanyaan-terbuka.md`, satu crossing di cap peluncuran dan masih menjawab di
> sepuluh kali cap.
>
> **Yang belum diukur, dan ditulis supaya tidak terbaca sebagai kelalaian.**
> Kedalaman pool fee 10000 tidak pernah dijalankan lewat `CandidateDepthFork`.
> Keputusan ini berdiri di atas volume dan biaya fee, bukan di atas perbandingan
> kedalaman langsung. Preseden TSLA di tabel atas berjalan ke arah sebaliknya, yaitu
> fee 3000 menang atas fee 500, dan di sana yang memutuskan memang kedalaman
> terukur. Kalau pool GME pernah jadi titik keberatan, ini pengukuran yang harus
> dijalankan lebih dulu.

### 10.1 Alamat Stock Token — terverifikasi lewat beacon

**Cara verifikasi (wajib sebelum menambah token ke allowlist):** baca slot beacon
ERC-1967 `0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50`.
Stock Token asli **selalu** menunjuk ke `0xe10b6f6b275de231345c20d14ab812db62151b00`.
Cek kedua: `uiMultiplier()` (`0xa60bf13d`) harus **ada dan tidak revert**, serta
bernilai **>= 1e18**.

> ### Koreksi 16 September 2026, dibaca langsung dari mainnet
> Aturan lama berbunyi *"harus bernilai `1e18`"*. Aturan itu **sudah salah dan
> berbahaya**, karena kalau ditulis apa adanya ke `Deploy.s.sol` ia menolak jangkar
> allowlist kita sendiri. Nilai terbaca hari ini.
>
> | Token | `uiMultiplier()` | Berubah pada | Waktu New York |
> |---|---|---|---|
> | **NVDA** | 1,000775159164630595e18 | blok 58958493, 10 Sep | 20:00, bursa tutup |
> | **AAPL** | 1,000566080061092436e18 | blok 36351132, 14 Agu | **11:12, bursa buka** |
> | **MSFT** | 1,000412952576205964e18 | blok 60351979, 11 Sep | **11:10, bursa buka** |
> | **GOOGL** | 1,000193924414112587e18 | blok 63752473, 15 Sep | **11:10, bursa buka** |
> | TSLA, GME, SPY, SPCX | tepat 1e18 | belum pernah | — |
>
> Tiga hal yang terukur dan mengikat implementasi.
>
> 1. **Perubahannya satu lompatan diskret, bukan akrual berjalan.** Nilai bertahan
>    persis di `1e18` selama berminggu-minggu, lalu naik sekali. Jadi pemeriksaan
>    multiplier di awal dan saat settle tetap murah.
> 2. **Tiga dari empat perubahan terjadi di tengah sesi `OPEN`**, sekitar 11:10
>    waktu New York. Jebakan ini menyala di sesi paling ramai, bukan di jam sepi.
> 3. **Harga pool tidak ikut melompat.** Tick pool NVDA-USDG fee 500 dibaca di
>    58955000, 58958492, 58958494, dan 58962000 bergerak 222220 ke 222214, yaitu
>    kebisingan normal, tanpa lompatan di blok perubahan. Besaran perubahan NVDA
>    77,5 bps, jadi lompatan sebesar itu akan terlihat jelas kalau ada. Konsekuensi
>    langsung: **jangan pernah mengalikan dengan `uiMultiplier` di jalur akuntansi
>    atau baseline.** Saldo mentah yang benar, dan multiplier murni lapisan tampilan.

| Token | Alamat | Vol Juli | **Vol Agustus** | Dompet Agu | Allowlist v1.0 |
|---|---|---|---|---|---|
| **NVDA** | `0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec` | $125,0jt | **$436,4jt** | 76.397 | ✅ Jangkar |
| SPCX | `0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea` | $40,8jt | **$212,9jt** | 56.537 | ❌ Tidak ada feed |
| 🔴 SPY | `0x117cc2133c37b721f49de2a7a74833232b3b4c0c` | $5,1jt | **$211,6jt** | 67.064 | ⚠️ Ditunda — feed. **Lihat peringatan di bawah** |
| **GME** | `0x1b0e319c6a659f002271b69db8a7df2f911c153e` | $72,1jt | $72,0jt | 42.442 | ✅ Ditambahkan 20 Sep 2026, lihat §7.4 |
| **AAPL** | `0xaf3d76f1834a1d425780943c99ea8a608f8a93f9` | $16,1jt | $36,1jt | 34.176 | ✅ |
| **TSLA** | `0x322f0929c4625ed5bad873c95208d54e1c003b2d` | $9,1jt | $17,3jt | 27.320 | ✅ |
| **GOOGL** | `0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3` | $7,6jt | $11,3jt | 19.713 | ✅ |
| MSFT | `0xe93237c50d904957cf27e7b1133b510c669c2e74` | $4,5jt | $8,1jt | 19.436 | ⚠️ Volume tipis |

> ⚠️ **Cakupan kolom volume berubah.** Kolom Juli lama hanya menghitung leg terhadap
> USDG; kolom di atas menghitung **semua pasangan**, dijalankan ulang 3 September 2026
> (query `8595386`) sehingga Juli dan Agustus sebanding satu sama lain. Karena itu
> angka Juli di sini lebih tinggi dari yang tercatat sebelumnya — bukan pertumbuhan,
> melainkan cakupan yang lebih lebar.

> ### 🔴🔴 Peta venue allowlist — 4,9% yang hilang sudah terpetakan, dan hasilnya menyentuh keputusan adapter (10 Sep 2026)
>
> Selama ini dokumen hanya melacak dua venue: Uniswap V3 (82,5%) dan V4 (12,6%),
> menyisakan **~4,9% tanpa penjelasan**. Sisa itu sekarang terukur penuh
> (kueri `8664785`). **Angka Agustus tereproduksi persis** — V3 82,53%, V4 12,56% —
> jadi metodenya sebanding dengan yang sudah tercatat.
>
> | Venue | Agu 2026 | **Sep 1–10** | Arah |
> |---|---|---|---|
> | `uniswap v3` | **82,53%** | **72,63%** | 🔴 **turun 9,9 pp dalam 10 hari** |
> | `uniswap v4` | 12,56% | 13,38% | — |
> | **`uponrh v3`** | 2,73% | **9,27%** | ⬆️ **3,4×** |
> | **`ramsesxyz vcl`** | 0,39% | **3,48%** | ⬆️ **8,9×** |
> | `gigadex v3` | 1,45% | 1,03% | — |
> | `ramsesxyz vdlmm` | 0,32% | <0,2% | — |
> | 9 venue lain (sheriff, 1inch-LOP, pancakeswap, swaphood, robinswap, sushiswap, uniswap v2, …) | ~0,02% | ~0,02% | debu |
>
> **Dua kesimpulan, dan yang kedua lebih penting daripada yang pertama.**
>
> **1. Pangsa Uniswap V3 sedang turun cepat.** 82,53% → 72,63% dalam sepuluh hari.
> Kalimat di `CLAUDE.md` §2 aturan 4 — *"keputusan adapter tunggal sekarang menutupi
> mayoritas pasar yang jauh lebih besar"* — masih benar, tapi **trennya melawan**.
> Jangan kutip 82,5% tanpa menyebut arahnya.
>
> **2. ⭐ Tapi lihat label versinya: `uponrh v3`, `gigadex v3`, `ramsesxyz vcl`.**
> Ketiganya berkonsentrasi likuiditas bergaya V3, dan `dex.trades` men-decode
> ketiganya lewat jalur **v3**. Kalau interface pool-nya memang kompatibel V3
> (`slot0`, `liquidity`, `ticks`, `feeGrowth…`), maka **`quoteFromState` yang sama
> bekerja untuk mereka — yang berbeda hanya alamat factory/pool.**
>
> | Cakupan | Agu 2026 | Sep 1–10 |
> |---|---|---|
> | Hanya Uniswap V3 | 82,53% | **72,63%** |
> | **Keluarga V3 drop-in** (uniswap + gigadex + ramses vcl) | **84,37%** | **77,14%** |
> | + `uponrh` (butuh decoder sendiri — lihat P5-1) | 87,10% | **86,41%** |
>
> Dengan adapter V3 yang **agnostik terhadap factory** dan digerbangi
> `adapterAllowlist`, cakupan September naik dari 72,63% ke **77,14%** dengan pool
> yang sudah terbukti kompatibel — **tanpa menambah satu pun kelas venue baru**.
>
> 🔴 **Yang WAJIB diverifikasi sebelum ini jadi keputusan** — jangan tulis kode yang
> bergantung padanya sampai terukur (`CLAUDE.md` §2 aturan 7):
> 1. `staticcall` ke pool `uponrh` dan `gigadex`: apakah `slot0()`, `liquidity()`,
>    `ticks(int24)`, dan `tickSpacing()` ada dan bersemantik sama dengan Uniswap V3?
> 2. Apakah ada fee dinamis atau hook — kegagalan yang **sudah** menggugurkan V4
>    (`spek-teknis.md` §9.1). Kalau `uponrh` memakai hook fee dinamis, ia gugur
>    dengan alasan yang sama.
> 3. `ramsesxyz vcl` kemungkinan Ramses CL (turunan Algebra/V3) — **verifikasi
>    terpisah**, jangan diasumsikan sama.
>
> ⚠️ **Batas data.** V4 punya **1,49 juta trade tanpa harga** di Agustus dan
> **2,92 juta** di September pada tabel ini, jadi volume V4 kemungkinan
> **understated**. Angka V3 relatif bersih (29rb dan 26rb tanpa harga). Jangan pakai
> pangsa V4 sebagai angka presisi.
>
> ⚠️ Volume allowlist Sep 1–10 sudah **$671,3jt** — laju bulanan ~4× Agustus.
> Ini pasar yang bergerak cepat; peta venue ini punya masa kedaluwarsa pendek.
>
> ### ✅ P5-1 TERJAWAB (10 Sep 2026) — dua kompatibel, satu varian
>
> Diuji lewat `eth_call` langsung ke mainnet 4663 (bypass DNS `--resolve` ke
> `172.66.147.70`, `CLAUDE.md` §9), dengan pool Uniswap V3 NVDA-USDG
> `0xD4EB…14A3` sebagai **kontrol**. Pool yang diuji adalah pembawa volume
> allowlist terbesar di tiap venue (kueri `8664813`).
>
> | Venue | Pool | `slot0()` | `ticks()` | `tickBitmap()` | `observe()` | `fee()` | Vonis |
> |---|---|---|---|---|---|---|---|
> | **Uniswap V3** (kontrol) | `0xD4EB…14A3` | 7 word | 8 word | 1 | 6 | 500 statis | — |
> | **`gigadex v3`** | `0xF2852136…` | **7** | **8** | 1 | 6 | 100 statis | ✅ **Identik** |
> | **`ramsesxyz vcl`** | `0xDAC1904D…` | **7** | **8** | 1 | 6 | 250 statis | ✅ **Identik** |
> | **`uponrh v3`** | `0x19D55ABA…` | **6** ⚠️ | **10** ⚠️ | 1 | 6 | 500 statis | 🟡 **Varian** |
>
> **Temuan 1 — tidak satu pun gugur karena alasan V4.** `fee()` mengembalikan nilai
> **statis** di keempatnya (500/100/250/500). **Tidak ada penanda fee dinamis
> `0x800000`.** Baseline bisa dihitung dari state di ketiganya.
>
> **Temuan 2 — `gigadex` dan `ramsesxyz vcl` byte-identik dengan Uniswap V3.**
> Adapter yang sama bekerja apa adanya; yang berbeda hanya alamat pool.
>
> **Temuan 3 — `uponrh` varian, dan inilah yang akan pecah diam-diam.** `slot0()`
> mengembalikan **6 word, bukan 7**: layoutnya V3 **tanpa** field `unlocked` di
> akhir. Lima field pertama bersemantik identik (terverifikasi: `sqrtPriceX96`,
> `tick` 218713, `observationIndex`, `obsCardinality` 120, `feeProtocol`).
> **Meng-ABI-decode-nya sebagai tuple V3 tujuh-field akan gagal.** Dan `ticks()`
> mengembalikan **10 word, bukan 8** — dua field tambahan yang **urutannya belum
> diverifikasi**, sehingga `liquidityNet` belum boleh dipercaya ada di posisi kedua.
>
> ### Keputusan yang lahir dari ini
>
> | Cakupan volume allowlist | Agu 2026 | **Sep 1–10** |
> |---|---|---|
> | Uniswap V3 saja (posisi v1.0 hari ini) | 82,53% | **72,63%** |
> | **+ `gigadex` + `ramsesxyz vcl`** (drop-in, terverifikasi) | **84,37%** | **77,14%** |
> | + `uponrh` (butuh decoder toleran + verifikasi `ticks()`) | 87,10% | **86,41%** |
>
> 1. **Tulis `UniswapV3Adapter` agnostik terhadap factory.** Alamat pool datang dari
>    `adapterAllowlist`, bukan konstanta factory. Ini bukan penambahan scope — ini
>    menghindari hardcode, persis prinsip `spek-teknis.md` §9.1.
> 2. **Masukkan pool `gigadex` dan `ramsesxyz vcl` lewat time-lock allowlist**, bukan
>    deploy ulang. Cakupan September naik **72,63% → 77,14%** tanpa kode baru.
> 3. **`uponrh` TIDAK masuk v1.0.** Ia butuh jalur decode sendiri dan satu verifikasi
>    lagi (urutan field `ticks()`, dari source atau dari pool ber-tick aktif).
>    Kandidat v1.1 — dan bernilai, karena ia sendirian **9,27%** dan tumbuh 3,4×.
>
> ⚠️ **Batas bukti.** Yang diuji adalah **bentuk ABI dan nilai fee**, bukan
> kesetaraan matematika penuh. Sebelum pool mana pun masuk allowlist produksi,
> gerbang `rencana-uji.md` tetap berlaku: **fork test nol selisih** terhadap state
> mainnet nyata per pool. Uji ini memindahkan `gigadex`/`ramses` dari "tidak
> diketahui" ke "layak diuji", bukan ke "terbukti".

> ### 🔴 SPY naik 42× dan sekarang token nomor dua — keputusan allowlist perlu ditinjau
>
> SPY melompat dari $5,1jt (Juli) ke **$211,6jt** (Agustus) dengan 67.064 dompet.
> Volumenya sekarang **3,3× gabungan AAPL + TSLA + GOOGL** ($64,7jt).
>
> SPY ditunda dari allowlist v1.0 karena **cadence feed Chainlink-nya terlalu jarang**
> (`pertanyaan-terbuka.md` P0-3). Alasan itu belum tentu batal — cadence feed tidak
> bisa diukur dari `dex.trades` dan **belum diperiksa ulang**. Tapi ongkos menundanya
> sudah berubah drastis.
>
> **Aksi yang belum dikerjakan:** ukur ulang cadence feed SPY `0x78BCB218…` untuk
> Agustus 2026. Kalau membaik, SPY masuk lewat time-lock allowlist, bukan deploy
> ulang. Kalau tetap jarang, keputusan menundanya berdiri — tapi **sebutkan volumenya
> apa adanya**, jangan disembunyikan karena tidak nyaman.
>
> SPCX ($212,9jt, nomor tiga) tetap dikecualikan permanen: tidak punya feed sama
> sekali, dan itu tidak berubah karena volume.

> ### 🔴 Ada memecoin yang menyamar sebagai Stock Token
> **`0xc2362aff2a2a4cc1f48cf3dab2c4e2605eb94ba3`** — `name()` = **"GameStop"**,
> `symbol()` = **"GME"**. Terverifikasi **bukan** Stock Token:
>
> | | GME asli `0x1b0e…` | Penyamar `0xc236…` |
> |---|---|---|
> | Slot beacon | `0xe10b6f6b…` ✅ | **kosong** |
> | `uiMultiplier()` | ada, `>= 1e18` ✅ | **tidak ada** |
> | `totalSupply` | 46.420 | **100.000.000.000** |
> | Ukuran kode | 283 byte (beacon proxy) | 44 byte (klon minimal) |
>
> **Ia menarik $29,6 juta volume dalam 250.840 trade di bulan Juli** — pengguna
> nyata benar-benar memperdagangkannya.
>
> **Konsekuensi:** setiap analitik yang mengelompokkan berdasarkan **simbol**
> menggabungkan keduanya. Angka "GME $98jt" akan salah 30%. Pola ini identik dengan
> ≥9 kontrak bersimbol USDG di `ide-utama.md` §F — **ini bukan kasus terisolasi,
> ini karakteristik chain.**
>
> Allowlist Nokturn berbasis **alamat**, jadi protokolnya aman. Yang berisiko
> adalah analitik, dasbor, dan klaim di pitch.

### 10.2 ⚠️ Konsentrasi allowlist

NVDA = **$436,4jt dari $501,0jt** total allowlist v1.0 → **87,1%** (Agustus 2026).
Naik dari 79,6% di Juli. AAPL, TSLA, dan GOOGL digabung cuma **12,9%**.

Dan allowlist v1.0 sekarang cuma mencakup **49,8%** dari seluruh volume stock token
($501,0jt dari $1.005,6jt), turun dari 56,3% di Juli — karena pertumbuhan terbesar
justru terjadi di SPY dan SPCX yang ada di luar allowlist.

Artinya netting v1.0 praktis bertumpu pada satu token. Ini bukan alasan menambah
token — GME dan SPY diblokir feed, SPCX tidak punya feed sama sekali — tapi **harus
dinyatakan apa adanya**, dan berarti kegagalan feed NVDA berdampak jauh lebih besar
daripada yang disiratkan daftar allowlist. Lihat `distribusi.md` §4.

**Feed Chainlink** (`DualAggregator 1.0.0`, 8 desimal):

| Aset | Feed |
|---|---|
| NVDA | `0xC9D16E4F2569B9E3EA0468FD85844953713DC2A2` |
| TSLA | `0x7A6B81BA7FBCB90104D8C496158CF383CD7233B1` |
| GME | `0xF83CDE62D1CD90DE8D2BF3332B90C590985AD679` |
| SPY | `0x78BCB218FA04B9B3A278EBC865ED320BF8DEFBAC` |
| AAPL | `0xBB11A21267CFDB63D4935D99A499133DD1744ACB` |
| MSFT | `0xC3B117F52CF17DD4369EAF5EAF7CF0E2F91B4E30` |
| META | `0xC190B6164B9E320A6400CDAB0085A2E0E2B9738E` |
| GOOGL | `0x11ED6D598EF565DDA86FAFE7E779303E7CC6B2BD` |
| AMZN | `0x93503DFC97157CDB8AADCCAF70452621D598FDEB` |

*(21 feed lain terdaftar di `pertanyaan-terbuka.md` P0-3)*

---

### 10.3 ⭐ Kepemilikan Stock Token — diukur ulang 10 September 2026

> Menggantikan tiga angka yang sejak 1–11 Agustus 2026 ditandai *"belum diukur
> ulang"* di `pitch.md` §4 dan `CLAUDE.md` §6. Ketiganya sekarang **terukur, dengan
> kueri permanen dan publik.**

**Metodologi.** Saldo direkonstruksi dari **seluruh riwayat event `Transfer`** atas
delapan Stock Token yang alamatnya terverifikasi beacon (§10.1) — **tidak pernah
dicocokkan lewat simbol**, sehingga penyamar seperti `0xc2362aff…` tidak bisa ikut
terhitung. Harga dari `prices.latest` (semua token 18 desimal). Alamat kontrak
dipisahkan lewat anti-join ke `robinhood.creation_traces`.

| Item | 1 Agu 2026 | **10 Sep 2026** | Δ |
|---|---|---|---|
| Total nilai Stock Token dipegang onchain | $27,2jt | **$75,62jt** | **2,8×** |
| **Pemegang EOA > $1.000** | 477 | **804** | **+69%** |
| Pemegang > $1.000 termasuk smart wallet | — | **1.174** | baru |
| Pemegang EOA > $10.000 | — | **107** | baru |
| Pemegang EOA > $100 | — | **7.065** | baru |
| Alamat EOA dengan saldo > 0 | — | **216.258** | baru |
| Nilai dipegang EOA | — | **$13,56jt** | baru |
| Nilai dipegang kontrak | — | **$62,06jt** (82,1%) | baru |

**Distribusi pemegang kontrak** — memisahkan likuiditas venue dari ekor dompet AA:

| Ukuran | Jumlah alamat | Nilai |
|---|---|---|
| ≥ $1jt | **8** | **$47,23jt** |
| $100rb–1jt | 35 | $10,67jt |
| $10rb–100rb | 87 | $2,51jt |
| $1rb–10rb | 283 | $0,84jt |
| $100–1rb | 1.726 | $0,51jt |
| < $100 | **91.347** | $0,30jt |

⚠️ **Jangan sebut "93.495 kontrak memegang stock token" tanpa konteks.** 91.347 di
antaranya memegang **di bawah $100** dan totalnya cuma $299rb — itu ekor dompet
**ERC-4337**, bukan infrastruktur. Filter kontrak yang naif akan salah
mengklasifikasi mereka, ke dua arah sekaligus.

> 🔴 **Angka yang menjelaskan kenapa jebakan ini berulang — ukur sekali, ingat
> selamanya.** Robinhood Chain menjalankan **5.892.471 user operation ERC-4337 dari
> 336.852 smart account berbeda dalam sepuluh hari**, lewat **4 EntryPoint**
> (1–10 September 2026, kueri `8664424`).
>
> Sepertiga juta dompet berbentuk kontrak. Itu sebabnya **tiga** pengukuran berbeda
> di proyek ini tersesat oleh hal yang sama dalam satu hari: 91.347 pemegang debu di
> atas, 541 "kontrak konsumen" satu-pengguna (`desain-auction.md` §3.3), dan satu
> alarm palsu soal kustodi agunan (§3.3b).
>
> **Aturan tetap: di chain ini, "kontrak" tidak pernah berarti "protokol" sampai
> dibuktikan.** Uji yang murah dan definitif: apakah alamatnya muncul sebagai
> `sender` di `UserOperationEvent` (`topic0 = 0x49628fd1…`). Dan **selalu jalankan
> kontrol** — "nol kecocokan" tidak berarti apa pun sampai kamu membuktikan kueri
> itu bisa menemukan sesuatu.

### 🔴 V4 memegang inventarisnya, V3 memutar volumenya

| Alamat | Identitas | Sisi Stock Token | Pangsa volume allowlist (Agu) |
|---|---|---|---|
| `0x8366A39C…` | **Uniswap V4 PoolManager** | **$31,30jt** (41,4% dari seluruh Stock Token onchain) | **12,6%** |
| `0xD4EB…14A3` | Pool NVDA-USDG UniV3 fee 500 | **$3,86jt** | bagian dari **82,5%** |

Satu alamat singleton V4 memegang **delapan kali** inventaris pool V3 yang paling
sibuk, tapi memproses **seperenam** volumenya. **Turnover-nya yang berbeda, bukan
kedalamannya.**

Konsekuensi ke keputusan adapter: **tidak berubah untuk v1.0.** Baseline dihitung
terhadap tempat arus benar-benar dieksekusi, dan itu V3 (`CLAUDE.md` §2 aturan 4).
Tapi angka ini **memperkuat** kasus V4 di v1.1 — inventarisnya ada di sana dan
menganggur, dan itu argumen yang lebih baik daripada "V4 juga ada".

⚠️ Kedua angka adalah **sisi Stock Token saja**; sisi USDG tidak ikut dihitung, jadi
ini bukan TVL pool. Sebut apa adanya.

**Kueri (permanen, publik, 10 September 2026):**
`8663760` (pemegang & nilai) · `8663787` (pemegang teratas & distribusi) ·
`8663798` (Fill UniswapX vs router dominan, lihat §10.4)

### 10.4 ⭐ Pangsa eksekusi berbasis intent — diukur ulang 10 September 2026

Menggantikan angka kumulatif lama *"22.068 `Fill` UniswapX vs 17,2 juta tx router
dominan"*, yang mencampur jendela waktu berbeda dan karena itu tidak bisa
direproduksi. Sekarang **per bulan, dari `robinhood.logs` topic0
`0x78ad7ec0…` dan `robinhood.transactions`**.

| Bulan | `Fill` UniswapX | Pengirim tx berbeda | Tx router `0x65050A9B…` | Alamat berbeda | **Rasio Fill : tx router** |
|---|---|---|---|---|---|
| Juli 2026 | 16.072 | 21 | 14.974.096 | 86.066 | **0,11%** |
| Agustus 2026 | 20.898 | 41 | 8.812.691 | 75.340 | **0,24%** |
| Sep 2026 (1–10) | **27.931** | **87** | 13.669.524 | 99.772 | **0,20%** |

**Dua bacaan, keduanya harus disebut:**

1. **Klaim "pangsa intent masih kecil" bertahan dan sekarang lebih kuat** — karena
   punya denominator bulanan yang bisa dijalankan ulang siapa pun, bukan angka
   kumulatif. Rasionya **di bawah 0,25% di ketiga bulan**.
2. ⚠️ **Tapi arahnya jelas naik.** Sepuluh hari pertama September sudah melampaui
   seluruh Agustus (27.931 > 20.898), dan pengirim tx berbeda naik **21 → 41 → 87**.
   Eksekusi berbasis intent sedang tumbuh cepat di chain ini. **Jangan bingkai ini
   sebagai kategori yang sepi** — bingkai sebagai kategori yang baru mulai, dengan
   Nokturn masuk lebih awal. Membesar-besarkan "kekosongan" persis kesalahan yang
   sudah digugurkan audit 11 Agustus (`pitch.md` §2).

---

## 11. Nilai yang masih belum ditetapkan

| Item | Diblokir oleh |
|---|---|
| Ambang laju arus untuk durasi adaptif | Butuh data batch nyata — kalibrasi setelah 1 minggu mainnet |
| Titik impas Stylus vs Solidity untuk `ClearingVerifier` | Butuh **dua implementasi** untuk diukur. Denda init sudah terukur: **46,4rb–49,2rb gas** uncached (lantai 8.832) — nyata tapi tidak menghalangi. Lihat `pertanyaan-terbuka.md` P1-3 |
| Kalibrasi ulang `WEEKEND_DRIFT_CAP_BPS` | Sampel sekarang hanya 2–4 akhir pekan. Tinjau setelah 3 bulan riwayat mainnet (§7.3) |

**Sudah tidak terbuka lagi** — jangan dibuka ulang tanpa bukti baru:

| Dulu terbuka | Jawabannya |
|---|---|
| Daftar token allowlist awal | ✅ §7.4 — NVDA, AAPL, TSLA, GOOGL |
| Staleness per feed | ✅ §7.1 — tabel per-feed, diturunkan dari cadence terukur |
| Identitas 4 kontrak venue besar | ✅ `pertanyaan-terbuka.md` Ronde 2 — semuanya teridentifikasi |
| Definisi "harga referensi pembukaan" | ✅ §12 |

### 10.5 ⭐ Distribusi jam perdagangan — diukur 11 September 2026

Kueri permanen & publik: **[`8680028`](https://dune.com/queries/8680028)**.
Periode 1 Agustus – 11 September 2026 · allowlist v1.0 (4 alamat terverifikasi) ·
**10,19 juta trade** · **$1.253,6jt** volume.

**Distribusi per jendela:**

| Jendela (UTC) | Jam | % trade | % volume | Ekspektasi merata | Tiket rata-rata |
|---|---|---|---|---|---|
| Asia-Pasifik bangun (08–18 SGT) | 0–9 | **33,54%** | 28,31% | 41,67% | **0,84×** |
| Eropa bangun (memuat pembukaan NYSE) | 10–13 | 17,89% | 21,66% | 16,67% | **1,21×** |
| NYSE buka | 14–19 | **31,54%** | **34,35%** | 25,00% | 1,09× |
| Malam AS / Asia tidur | 20–23 | 17,03% | 15,69% | 16,67% | 0,92× |

**Dua temuan yang boleh dipakai:**

1. **Tidak ada jam mati.** Rentang seluruh 24 jam cuma **2,76%–6,90%** trade per jam.
   Jam tersepi (07:00 UTC) masih punya **30.544 pengirim berbeda**; tersibuk
   (15:00 UTC) **55.100**. Dipakai di `pitch.md` §5a sebagai penguat lapis 1.
2. **Volume menumpuk di batas sesi.** Jam 13:00 UTC (09:00 ET, memuat pembukaan
   NYSE 09:30) memegang **10,62% volume dari 6,35% trade — rasio 1,67×**.
   Dipakai di `pitch.md` §3b.

🔴 **Hasil negatif — jangan dilitigasi ulang.** Kueri ini dibuat untuk menguji apakah
arus off-hours menumpuk di jam Asia, sebagai dasar kemungkinan memposisikan Nokturn
sebagai produk Asia Tenggara. **Tidak.** Jam Asia justru **di bawah** ekspektasi
merata (33,54% vs 41,67%), dan puncak aktivitas ada di sesi NYSE. Klaim
*"pasar ini secara empiris pasar Asia"* **salah** — dan kuerinya publik, jadi siapa
pun bisa membantahnya.

⚠️ **Batas metodologis yang tetap berlaku andai hasilnya kebalikannya:** jam bukan
geografi. Data onchain tidak pernah bisa menetapkan lokasi pengguna — arus otomatis
jalan 24 jam dan VPN ada. Jam hanyalah proxy lemah untuk zona waktu.

---

### 10.6 Alamat gladi resik testnet 46630, dipasang ulang 20 September 2026

Chain 46630 tidak punya USDG kanonik, tidak punya Stock Token, dan tidak punya pool
Uniswap V3. Sudah diverifikasi di `pertanyaan-terbuka.md` P2-6 dan diukur ulang dengan
membaca ukuran kode di alamat mainnet masing-masing, ketiganya nol. Permit2
satu-satunya yang benar-benar ada, di alamat kanonik yang sama, 18.307 karakter
bytecode.

Supaya `Deploy`, `Bootstrap`, dan `Lock` bisa dilatih ujung ke ujung di rantai
publik, umpannya dipasang lebih dulu lewat `script/testnet/DeployTestnetFixtures.s.sol`.
Alamatnya dicatat di sini dulu, baru jadi konstanta di `script/Addresses.sol`, sama
seperti setiap alamat yang tidak dimiliki protokol ini.

**Angkatan pertama 19 September 2026 sudah tidak dipakai.** GME masuk allowlist pada
20 September, jadi seluruh set dipasang ulang menjadi lima, bukan ditambah satu.
Alasannya bukan kerapian. Token kuota dan keempat token lama tidak punya alasan untuk
dipertahankan, dan satu set yang lahir dalam satu transaksi berurutan lebih gampang
dipercaya daripada campuran dua angkatan yang harus dijelaskan.

| Peran | Simbol | Alamat |
|---|---|---|
| Token kuota, 6 desimal | `tQUOTE` | `0x4559EF47891FD74571c76852De21E0966409Edce` |
| Stand in stock token | `tNVDA` | `0x43945b9Cd5E5ea57470961D28476aB9749fD6835` |
| Stand in stock token | `tAAPL` | `0xc471d303fb69F8D710c31Bd3667145646f3d093D` |
| Stand in stock token | `tTSLA` | `0x67157B1ee27c3Bd5f2Cf76f0847A8df98D2FC246` |
| Stand in stock token | `tGOOGL` | `0x357F431e365f1A6c65304A4aC7002345D8B60481` |
| Stand in stock token | `tGME` | `0xb3953D77e5dDb251B3F9C9C38a49B4cB28cbe92d` |
| Pool `tNVDA` | | `0x1B72BEddb369A5A2F69c66F262aBF49D048fa093` |
| Pool `tAAPL` | | `0x6c28c436BB2743482Bfd59E8d5A1aC95c41d6e79` |
| Pool `tTSLA` | | `0xEd7Bbc056fb1bE91f692dbDb289BEbA1e83dB2DC` |
| Pool `tGOOGL` | | `0x2Cd4A3d3d3dF3Cdc72655Fd6E28Ab0B3395FE2d1` |
| Pool `tGME` | | `0x0C36D92bd5Ac4564C1010937B191dE21B7c2C302` |

Seluruhnya dibaca ulang dari chain setelah deploy, bukan disalin dari keluaran script.
Token kuota 6 desimal, kelima stock token 18 desimal, kelima pool `fee` 3000.

Multiplier-nya meniru mainnet, yaitu `tNVDA` 1,0032e18, `tAAPL` 1,0011e18,
`tGOOGL` 1,0007e18, lalu `tTSLA` dan `tGME` tepat 1e18. Gerbang yang cuma pernah
melihat satu nilai bukan gerbang yang terlatih, dan dua yang tepat 1e18 ada karena
kedua token itu memang belum bergeser di mainnet.

Harga pool-nya angka bulat sembarang, 200, 230, 420, 250, dan 25, dan tick-nya adalah
logaritma rasio harga mentah dengan stock token sebagai `token0`. Tidak ada pasar di
46630 yang memberi harga, jadi angka ini dipilih supaya terbaca, bukan supaya jadi
kuotasi siapa pun. Angka 25 untuk `tGME` kebetulan dekat dengan pool GME mainnet yang
duduk di tick `-245.446`.

| Pool | Tick terbaca | `token0` |
|---|---|---|
| `tNVDA` | `-223.338` | stock |
| `tAAPL` | `+221.941` | kuota |
| `tTSLA` | `+215.918` | kuota |
| `tGOOGL` | `-221.107` | stock |
| `tGME` | `+244.134` | kuota |

Tiga dari lima terurut terbalik di angkatan ini, jadi tick-nya positif karena harganya
jadi resiprokal. Di angkatan pertama cuma `tAAPL` yang begitu. Urutannya ditentukan
alamat yang keluar dari deploy dan bukan sesuatu yang dipilih, jadi jangan pakai tanda
tick sebagai penanda token apa pun.

**Apa yang gladi resik ini buktikan, dan apa yang tidak.** Di 46630, `StockTokenGate`
memeriksa nilai yang kontrak umpan itu tulis sendiri untuk diperiksa. Lolosnya
membuktikan bentuk batch bootstrap benar dan **tidak membuktikan apa pun tentang
gerbangnya**. Yang membuktikan gerbang adalah `test/fork/Bootstrap.fork.t.sol`
terhadap token mainnet sungguhan. Hal yang sama berlaku untuk adapter. Pool uji
menjawab pembacaan state dengan likuiditas rata dan `swap` yang selalu revert, jadi ia
melatih `setPool` dan tidak melatih kuotasi terhadap likuiditas nyata.

Alamat di atas tidak pernah terbaca di mainnet. `Addresses` memilih berdasarkan
`block.chainid`, dan 4663 tidak punya cabang ke sini.

### Endpoint RPC testnet berubah, 19 September 2026

`rpc.testnet.chain.robinhood.com` sekarang ikut dicegat DNS ISP Indonesia, resolve ke
`block.gmedia.id` di `103.217.209.188`. Gejalanya menyesatkan seperti kasus mainnet,
keluar sebagai `invalid peer certificate: NotValidForName` alih-alih halaman blokir.
IP aslinya `172.66.147.70` dan `104.20.46.209`, di belakang `customer-origin.offchainlabs.com`.

Ganti ke `https://robinhood-testnet.drpc.org`. Sudah dicek melayani `eth_blockNumber`,
`eth_gasPrice`, `eth_getBalance`, `eth_getCode`, `eth_getTransactionCount`, dan
`eth_sendRawTransaction`, bukan cuma `eth_chainId`. Membuktikan lewat satu panggilan
saja adalah kesalahan yang sudah pernah terjadi di proyek ini dengan endpoint mainnet.

---

## 12. ⚠️ Harga referensi pembukaan (ROO) — definisi baru

Tidak ada harga pembukaan resmi onchain. `transmitSecondary` pada `DualAggregator`
tidak pernah dipakai, dan `cutoffTime()` tidak punya getter publik.

**Definisi pengganti:**

| Konstanta | Nilai | Alasan |
|---|---|---|
| `OPEN_REF_WINDOW` | **300 detik** setelah pembukaan | TWAP feed Chainlink selama 5 menit pertama sesi `OPEN` menurut kalender SessionManager kita sendiri |
| `OPEN_REF_MIN_UPDATES` | **2** | Kalau feed tidak update cukup sering dalam jendela itu, ROO tidak bisa diselesaikan → intent ROO dibatalkan dan escrow dikembalikan |

**Istilah:** sebut **"harga referensi pembukaan"**, jangan "harga pembukaan resmi".
Kita tidak punya yang kedua, dan mengklaimnya akan runtuh saat ditanya juri.

---

## 13. Ukuran kampanye invariant

Ditulis 17 September 2026, saat empat kampanye invariant yang menutup I1 sampai
I14 pertama kali bisa dijalankan.

`foundry.toml` sudah memuat sebuah profil `deep` sejak hari pertama, dengan
`runs = 20000` dan `depth = 256`. Angka itu ditulis sebelum ada satu pun handler,
dan setelah diukur ternyata tidak pernah bisa selesai. Satu suite saja butuh
5,12 juta panggilan, dan suite lelang menempuh 117 panggilan per detik, jadi
sekitar dua belas jam untuk satu suite di laptop dan lebih lama lagi di runner
GitHub yang batasnya enam jam per job.

| Profil | runs | depth | Panggilan per suite | Kapan |
|---|---|---|---|---|
| `default` | 128 | 64 | 8.192 | Di laptop, sebelum push |
| `ci` | 512 | 128 | 65.536 | Tiap pull request |
| `deep` | **2000** | **256** | **512.000** | Tiap malam, satu runner per suite |

Empat suite berjalan paralel di CI, satu runner masing-masing, sehingga totalnya
2,05 juta panggilan per malam dan jam dindingnya ditentukan oleh suite yang
paling lambat.

**Kenapa depth yang dipertahankan, bukan runs.** Depth adalah panjang rantai aksi
dalam satu run, dan bug yang tersisa di protokol ini berbentuk urutan, bukan satu
nilai yang salah. Bond yang dibayar dua kali baru muncul setelah submit cross,
lalu tantangan yang gagal, lalu abort, tiga aksi berurutan pada lelang yang sama.
Menaikkan runs menambah titik awal baru, menaikkan depth menambah kedalaman
rantai yang bisa ditempuh dari tiap titik awal. Yang kedua yang menemukan bug itu.

**Ukuran terpakai.** Suite lelang adalah yang menentukan, karena satu aksinya
menjalankan lelang utuh. Lima commitment dengan tanda tangan ECDSA sungguhan,
freeze dengan lima tarikan Permit2, pencarian harga indikatif yang kuadratik
terhadap panjang buku, cross, dan eksekusi. Tiga suite lain praktis gratis di
sampingnya, 109 detik dari 111 detik pada pengukuran 50 kali 256.

---

## Aturan perubahan

1. Ubah **di sini dulu**, baru di kode
2. Wajib isi kolom alasan
3. Kalau parameter melanggar prinsip di §2 (band lebar ⇄ cap kecil), perbaiki
   prinsipnya secara eksplisit atau jangan ubah parameternya

# Nokturn — Strategi Distribusi

> Bagian tersulit, dan tempat kebanyakan proyek infrastruktur mati. Bukan karena
> teknologinya gagal, tapi karena **tidak ada yang pernah menemukannya.**
>
> Pendamping: `ide-utama.md` · `desain-ekonomi.md` · `desain-agent.md`

---

## 1. Kebenaran yang harus dihadapi duluan

**Tidak ada yang bangun pagi ingin memakai "lapisan settlement".**

Orang ingin membeli NVDA. Settlement adalah sesuatu yang terjadi *pada* mereka,
bukan sesuatu yang mereka cari. Artinya jalur langsung ke konsumen mahal dan lambat.

Jalur yang realistis: **hadir di tempat transaksinya sudah dimulai.**

Tapi ada satu masalah yang harus dijawab jujur sebelum menyusun rencana apa pun.

### 1.1 Masalah latensi versus agregator ⚠️

Insting pertama: "integrasikan ke 1inch dan Rialto, mereka sudah merutekan."

**Itu tidak cocok.** Agregator dibangun di atas asumsi *kuotasi sekarang, isi
sekarang*. Batch butuh 30–60 detik. Itu bukan penyesuaian kecil — itu kontrak UX
yang berbeda secara fundamental.

Menyadari ini di awal menghemat berminggu-minggu usaha yang salah arah. Agregator
**bukan** kanal pertama. Kanal pertama adalah tempat di mana penundaan sudah
dapat diterima, atau di mana tidak ada manusia yang menatap spinner.

---

## 2. Momen yang harus dimenangkan

Jangan berebut momen *"saya mau transaksi sekarang"* — Uniswap dan Arcus menang di sana.

Menangkan momen: ***"saya mau transaksi tapi pasarnya sedang jelek."***

Konkretnya: pengguna di Jakarta, jam 22:00, membuka DEX untuk beli NVDA senilai
$50 dan melihat peringatan price impact. **Itulah momennya.**

> *"Price impact 2,1% — atau tunggu 45 detik dan dapat harga lebih baik."*

Kalimat itu adalah produknya. Datanya berubah sejak Juli, tapi argumennya tetap
berdiri — hanya pindah ke ekor: p90 off-hours vs bursa buka kini nyaris setara
(57,4 vs 45,1 bps, 1,27×; sebutkan duluan, ini angka yang melemah), tapi p99
melebar ke **1.779 bps versus 209 bps saat bursa buka (8,5×)**. Untuk 74,1% arus
yang terjadi saat bursa tutup, tidak ada harga referensi sama sekali — dan
ekornya makin berbahaya.

---

## 3. Empat kanal, berurutan

### Fase 1 — Buktikan (aplikasi sendiri + dasbor penghematan publik)

Tujuannya **bukan volume. Tujuannya angka.**

Bangun aplikasi sendiri yang cukup baik, lalu terbitkan **dasbor publik yang
menunjukkan berapa yang dihemat Nokturn untuk pengguna** — per batch, live,
dengan metodologi yang bisa direproduksi siapa pun (metodologi Dune yang sudah
kupakai untuk mengukur masalahnya).

Dasbor ini melakukan empat pekerjaan sekaligus:

| Pekerjaan | Kenapa |
|---|---|
| Bukti untuk juri | Angka mainnet nyata, bukan klaim |
| Konten pemasaran | "Kami menghemat $X malam ini" adalah konten yang menjelaskan dirinya |
| Kredibilitas ke integrator | Mitra tidak perlu percaya, mereka bisa memeriksa |
| Dasar fee | **Angkanya sama persis** dengan yang dipakai membayar solver |

Satu metrik untuk semuanya. Tidak ada cerita ganda.

### Fase 2 — Tertanam (mereka yang sudah punya pengguna)

| Mitra | Kenapa cocok |
|---|---|
| **Router agregator `0x65050A9B…`** ⭐⭐ | **Kanal berleverage tertinggi — ditemukan lewat verifikasi onchain 1 Agu 2026.** **25.316 alamat berbeda, 1,13 juta panggilan dalam 3 hari.** Ini pintu masuk order flow ritel yang sebenarnya, hampir pasti router yang dipakai Robinhood Wallet. Dirutekan oleh dia mengalahkan aplikasi sendiri dalam skala apa pun. Tapi ingat batasan latensi §1.1 — perlu jalur "kuotasi sekarang, settle di batch" |
| **Agent & framework agent** ⭐ | **Integrator paling ideal secara teknis.** Tidak ada manusia menatap spinner, jadi toleransi latensinya tinggi. Dan menurut `desain-agent.md`, arus agent justru yang paling mungkin saling menutup. Virtuals sudah ada di chain ini |
| **Karma** (social trading) | Mobile-first, non-kustodial, kreator dapat bagian dari volume yang mereka hasilkan. Penggunanya persis profil ritel yang kita layani. Eksekusi lebih baik = kreator terlihat lebih baik |
| Dompet yang melayani SEA | Pemilik pengguna sesungguhnya |
| Robinhood Wallet | Kanal distribusi utama chain ini. Sulit, tapi program ekosistem ($1jt) adalah pintunya |

**Ekonomi kemitraan bersih:** mitra dapat bagian fee — dan fee hanya ada kalau
penghematan ada. Pendapatan mitra otomatis selaras dengan manfaat pengguna. Tidak
perlu negosiasi rumit soal insentif.

### Fase 3 — Tarikan infrastruktur (closing print)

Ini kanal yang paling tidak jelas dan paling kuat: **protokol lain mulai
bergantung pada Nokturn tanpa merutekan satu order pun lewat kita.**

Begitu sebuah protokol memakainya, kamu berhenti jadi venue yang bisa diganti dan
mulai jadi infrastruktur yang tertanam.

> 🔴 **Dikoreksi 10 September 2026.** Kalimat sebelumnya berbunyi *"Closing print
> dikonsumsi Morpho untuk menandai agunan, oleh vault untuk NAV, oleh pelaporan"* —
> ditulis dalam bentuk **sudah terjadi**. Itu **belum terjadi**, dan menuliskannya
> begitu melanggar aturan tanpa-mock (`CLAUDE.md` §9) di permukaan yang paling
> berbahaya: dokumen strategi yang kalimatnya gampang bocor ke pitch.

**Yang terukur, dan ini dasar fase 3 yang sebenarnya** (1–10 September 2026, kueri
`8664020` · `8664130`): **2.048 pengguna akhir** lewat **38 kontrak dari 24
operator** membaca harga ekuitas onchain. Komposisinya bukan yang kita duga —
didominasi **produk taruhan atas harga saham** (`betMsft`, `betUsdg`,
`JackpotFunded`), dengan lending hanya 20–38 pengguna. Rinciannya:
`desain-auction.md` §3.3b.

**Konsekuensi ke strategi kanal ini:** target fase 3 bukan "yakinkan Morpho".
Targetnya **produk yang menyelesaikan pada harga saham di satu titik waktu** — dan
pertanyaan pembuka ke mereka sudah jelas dengan sendirinya: *dengan harga apa kalian
menyelesaikan pada Sabtu malam, ketika feed sudah beku 48 jam?*

⭐ **Satu target sudah punya nama: [Ripe Protocol](https://www.ripe.finance/).**
Tagline mereka sendiri *"Borrow Against Your Tokenized Stocks Without Selling"*, dan
mereka sudah live di chain ini — terkonfirmasi lewat nama kontrak terverifikasi
(`Teller`, `CurvePrices`) dan token `sGREEN`. Yang membuatnya jalur nyata, bukan
harapan: arsitektur mereka punya **`PriceDesk.vy`**, agregator oracle yang
merutekan permintaan harga lewat **sumber berprioritas**. Closing print masuk
sebagai satu sumber tambahan — bukan penggantian, bukan integrasi baru.

⚠️ Dua batas yang harus ikut disebut tiap kali: buku agunan mereka di chain ini
**~$11.176**, dan **belum ada komitmen apa pun** dari mereka. Rinciannya
`desain-auction.md` §3.3b.

🔴 **Tapi Ripe bukan target terbesar — dan ini mengubah urutan.** Operator
`0xCFBD7E12…` memegang **$377.558** Stock Token (34× Ripe) dengan arus masuk
**$874.940 dalam sepuluh hari**, lewat desk yang menjual eksposur dari inventaris
sungguhan (`buy` / `cashOut`, harga dari feed Chainlink). Ia butuh **dua** hal yang
kita bangun sekaligus:

| Kebutuhan mereka | Yang kita punya | Status |
|---|---|---|
| Harga penyelesaian saat bursa tutup | **Closing print** — mereka mengutip dari feed yang beku 48–56 jam, untuk 74,1% arus | ✅ Cocok |
| Menyeimbangkan inventaris $377rb lewat pasar | Settlement batch | 🔴 **GUGUR — mereka tidak melakukannya** |

> 🔴 **Dikoreksi di hari yang sama (10 Sep 2026).** Versi pertama paragraf ini
> menyebut operator ini masuk **fase 2 dan fase 3 sekaligus**, dengan alasan
> inventarisnya pasti di-rebalance lewat DEX. **Diukur, dan salah:** seluruh volume
> DEX mereka adalah token treasury sendiri (`NET`) — Uniswap V2 $3,76jt, V4 $507rb —
> dan hanya **8 trade** yang menyentuh Stock Token (kueri `8664756` · `8664764`).
> Mereka menyerap sisi lawan pengguna langsung dan **menahan risikonya**, bukan
> melindung nilai di pasar.
>
> **Mereka fase 3 saja.** Sama seperti Ripe — hanya 34× lebih besar. Jangan hitung
> arus yang tidak ada; itu persis cara roadmap kehilangan kredibilitas.

⚠️ Batasnya keras: **mereka tidak bisa disebut namanya** — kontrak inti tidak
terverifikasi, tidak ada dokumentasi publik, penyisiran web nihil. Dalam pitch,
rujuk sebagai *"operator desk terbesar di chain ini, dengan alamat yang bisa
diperiksa"*, bukan dengan nama karangan.

Perhatikan urutannya: fase 3 **tidak butuh pengguna sama sekali** — ia butuh
lelang penutupan yang berjalan andal. Itu bisa dicapai lebih dulu daripada volume.

### Fase 4 — Perluas ke tempat volumenya berada

Stock token cuma 2,88% volume DEX chain ini (Agustus 2026). Sisanya ~$33,9
miliar/bulan adalah memecoin dan kripto — dan trader memecoin adalah korban
MEV paling parah.

Mesinnya sama persis. Menambah token = satu transaksi time-lock.

> Masuk lewat celah yang kamu kuasai secara unik, lalu perluas ke tempat volumenya
> berada. Wedge sempit, pasar luas, mesin sama.

---

## 4. Cold start: kenapa tidak ada tebing

Kekhawatiran wajar: *netting butuh dua sisi dalam satu jendela. Di awal arusnya
tipis. Bagaimana kalau tidak ada lawan transaksi?*

**Tidak apa-apa — dan ini properti desain, bukan pembelaan.**

Batch berisi satu intent tetap berfungsi: solver merutekannya ke venue terbaik.
Pengguna dapat routing yang baik, cuma tanpa bonus netting. Ketika arus menebal,
netting mulai muncul dan penghematan naik.

> **Protokolnya menurun secara mulus menjadi router biasa. Tidak ada tebing,
> tidak ada ambang minimum, tidak ada momen "belum cukup pengguna untuk berguna".**

Dua hal yang mempercepat pematangan:

**Durasi batch adaptif.** Jangan hanya mengikuti sesi — ikuti juga **laju
kedatangan intent**. Arus tipis → batch lebih panjang untuk mengumpulkan.
Arus tebal → batch lebih pendek karena pasangan sudah mudah ditemukan.
*(Ini penyempurnaan pada Session Engine — parameter durasi jadi fungsi dari sesi
DAN laju arus.)*

**Pusatkan pada sedikit ticker dulu.** Allowlist v1.0 adalah **NVDA (jangkar),
AAPL, TSLA, GOOGL** — lihat `parameter.md` §7.4, sumber kebenarannya. Memusatkan
arus di sedikit pasangan membuat netting muncul jauh lebih cepat daripada
menyebarkannya ke dua puluh ticker.

> ⚠️ **Jangan bertumpu pada GME meski volumenya nomor dua.** Feed Chainlink-nya
> p95 64.297 detik — terlalu jarang untuk menegakkan price band. Sama untuk SPY.
> **SPCX dikecualikan permanen**: tidak punya feed sama sekali. Ini batasan
> infrastruktur oracle, bukan likuiditas, dan harus disebut apa adanya di pitch.
>
> Konsekuensi distribusi yang tidak nyaman: **NVDA harus menanggung hampir seluruh
> beban netting di awal.** Ia satu-satunya token dengan volume tinggi, feed rapat,
> DAN likuiditas akhir pekan tebal (20.960 trade, jeda 2 detik).
>
> **Sekarang ada angkanya: NVDA = 79,6% volume allowlist v1.0** ($111,7jt dari
> $140,4jt, Juli 2026). AAPL, TSLA, dan GOOGL digabung cuma seperlima.
>
> Rencanakan cold start dengan asumsi itu, bukan dengan empat token yang setara.
> Praktiknya: **luncurkan dengan NVDA lebih dulu**, tiga lainnya menyusul setelah
> operasi stabil. Menyebarkan arus tipis ke empat token justru menunda munculnya
> netting. Lihat `parameter.md` §10.2.

---

## 5. Asia Tenggara sebagai pasar pertama

> 🔴 **Direvisi 11 September 2026.** Bagian ini dulu dibuka dengan *"konsekuensi
> logis dari data"*. **Dua dari empat barisnya ternyata tidak punya dukungan data**,
> dan satu di antaranya dibantah langsung oleh pengukuran kami sendiri — kueri
> [`8680028`](https://dune.com/queries/8680028), `parameter.md` §10.5.
>
> Keputusan **go-to-market**-nya tetap berdiri; yang dicabut adalah pembenaran yang
> salah. SEA dipilih karena **siapa yang membangunnya**, bukan karena data onchain
> menunjukkan penggunanya ada di sana.

| Fakta | Implikasi | Status |
|---|---|---|
| ~~SEA = 81,9% volume RWA (Bitget Q1 2026)~~ | ~~Penggunanya memang di sini~~ | 🔴 **Dicabut.** Statistik **CEX global**, bukan chain ini. Tidak boleh dipakai menyimpulkan komposisi pengguna Robinhood Chain |
| ~~74,1% trade saat bursa AS tutup~~ → ~~jam kerja SEA~~ | ~~**Jam kerja SEA adalah jam produkmu**~~ | 🔴 **Dibantah data sendiri.** "Bursa AS tutup" ≠ "jam kerja SEA" — NYSE cuma buka ~6,5 dari 24 jam, jadi 74,1% sebagian besar konsekuensi mekanis. Diukur langsung: jam bangun Asia **33,54%** lawan ekspektasi merata **41,67%** |
| Robinhood masuk Indonesia lewat akuisisi | Angin dari belakang | 🟢 Bertahan |
| **Kamu builder Indonesia** | Kredibilitas, bahasa, akses komunitas | 🟢 **Bertahan — dan ini sekarang alasan utamanya, bukan pendukung** |

**Yang tetap benar, dan lebih kuat karena lebih jujur:** pasar ini tidak punya jam
mati sama sekali — tiap jam dari 24 jam punya **30.544–55.100 pengirim berbeda**.
Jadi SEA bukan *satu-satunya* jam produk ini bernilai; ia **salah satu dari 24**.
Memulai dari SEA adalah keputusan distribusi yang masuk akal karena kamu punya
akses ke sana, **bukan** karena arusnya menumpuk di sana.

Praktiknya tidak berubah: bahasa Indonesia lebih dulu, lalu Vietnam dan Filipina.
Komunitas Telegram dan Discord lokal, bukan Twitter berbahasa Inggris.

⚠️ **Jangan pernah** menulis ulang klaim *"jam kerja SEA adalah jam produkmu"* atau
*"pengguna terbesar aset ini ada di SEA"*. Keduanya sudah diuji dan gugur, dan
kuerinya publik — juri bisa membantahnya sendiri.

---

## 6. Keputusan: tanpa token, tanpa poin, tanpa airdrop

Ini keputusan sadar, dan alasannya perlu dinyatakan.

Jalur normal proyek DeFi baru: umumkan poin, tarik volume tentara bayaran, pamerkan
angka besar, lalu lihat semuanya menguap saat insentif berhenti.

**Kami tidak melakukan itu**, karena tiga alasan yang saling menguatkan:

1. **Nilai Nokturn bisa diukur.** Kalau kami harus membayar orang untuk memakainya,
   itu artinya belum bekerja. Insentif akan menyembunyikan sinyal yang justru paling
   kami butuhkan
2. **Volume tentara bayaran merusak data.** Satu-satunya aset terkuat kami adalah
   pengukuran jujur atas penghematan nyata. Volume palsu menghancurkannya
3. **Konsisten dengan threat model** — tanpa token dan tanpa emisi, seluruh kelas
   serangan farming tidak punya permukaan sama sekali

Ini juga posisi yang membedakan di depan juri: hampir setiap proyek lain akan
menunjukkan grafik yang dibeli dengan insentif.

---

## 7. Metrik yang benar

Godaannya melaporkan jumlah pengguna dan volume. Untuk protokol seumur ini,
keduanya menyesatkan.

| Metrik | Kenapa ini yang benar |
|---|---|
| **Price improvement terukur vs baseline venue** ⭐ | Metrik inti. Sama dengan dasar fee. Bisa diverifikasi orang lain |
| Rasio netting (% volume yang saling menutup internal) | Mengukur apakah efek jaringan mulai bekerja. **Sudah ada baseline backtest** — lihat di bawah |
| Batch yang berhasil per malam | Keandalan operasional |
| Konsumen closing print | Kedalaman tarikan infrastruktur |
| Pengguna berulang | Apakah penghematannya cukup terasa untuk kembali |

Milestone pertama yang realistis **bukan** "10.000 pengguna". Melainkan:
**price improvement terukur pada batch mainnet nyata dengan pengguna nyata,
konsisten selama dua minggu.** Itu yang meyakinkan juri, dan itu juga yang
meyakinkan mitra integrasi.

### 7.1 Target netting yang harus dikejar — dari backtest

Backtest Agustus 2026 (`parameter.md` §1B) memberi tolok ukur yang konkret, jadi
rasio netting mainnet nyata bisa langsung dibandingkan dengan yang seharusnya:

| Pangsa arus | Netting yang diharapkan (45 dtk, off-hours, antar-counterparty) |
|---|---|
| 5% | 21,4% |
| 10% | 27,2% |
| 20% | 33,4% |
| 50% | 42,8% |

**Cara memakainya:** kalau netting mainnet nyata jatuh **jauh di bawah** baris yang
sesuai dengan pangsa saat itu, ada yang salah dengan solver atau durasi batch —
bukan dengan pasar. Ini mengubah rasio netting dari angka pameran menjadi **alat
diagnostik**, dan itu jauh lebih berguna.

Dan ia memberi cerita distribusi yang jujur: *"pada pangsa 10% kami menghemat X;
kurvanya menunjukkan angka itu naik ke Y pada pangsa 50%, dan inilah alasan
integrasi berikutnya penting."* Kurva mengalahkan satu angka besar.

---

## 8. Rencana 63 hari untuk distribusi

Berjalan **paralel** dengan pembangunan, bukan setelahnya.

| Hari | Aksi |
|---|---|
| 1–14 | Terbitkan analisis masalah — grafik spread per jam, metodologi terbuka. **Ini menarik perhatian sebelum ada produk**, dan membangun kredibilitas di komunitas SEA |
| 15–30 | Percakapan integrasi: Karma, framework agent, dompet SEA. Bawa datanya, bukan janji |
| 31–45 | Dasbor penghematan live di testnet; rilis SDK awal ke calon mitra |
| 46–52 | Mainnet. Umumkan dengan **angka nyata dari malam pertama**, bukan janji |
| 53–63 | Operasikan tiap malam. Terbitkan hasil mingguan. Kejar satu integrasi nyata atau satu surat minat |

**Yang paling bernilai dan paling sering dilewatkan:** menerbitkan analisis masalah
di hari 1–14, jauh sebelum produknya ada. Kamu punya data onchain yang belum
dipublikasikan siapa pun. Itu membangun audiens dan kredibilitas lebih dulu,
sehingga peluncuranmu punya tempat untuk mendarat.

---

## 9. Risiko distribusi yang jujur

| Risiko | Penilaian |
|---|---|
| **Pengguna tidak mau menunggu 30–60 detik** | Risiko terbesar. Mitigasi: bingkai sebagai pilihan, bukan paksaan — tampilkan harga instan dan harga batch berdampingan, biarkan pengguna memilih |
| Mitra integrasi lambat bergerak | Karena itu aplikasi sendiri dan closing print dikerjakan lebih dulu — keduanya tidak butuh izin siapa pun |
| Pasar ekuitas onchain tidak tumbuh | Fase 4 (perluas ke seluruh chain) adalah lindung nilainya, dan kodenya sudah siap |
| Venue besar menyalin batching | Butuh mereka mengubah struktur pasar inti, dan mereka justru diuntungkan merutekan lewat kita. Lagipula keunggulanmu bukan batching — tapi **kesadaran keadaan pasar dunia nyata** |

Yang terakhir layak ditekankan: kalau Uniswap menambahkan batch besok, mereka
masih tidak tahu kapan NYSE tutup, kapan early close, kapan halt, atau bagaimana
menangani corporate action. **Itu parit yang sebenarnya.**

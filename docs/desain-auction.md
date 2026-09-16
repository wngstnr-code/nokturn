# Nokturn — Desain Lelang Pembukaan & Penutupan

> Bagian ini adalah inti intelektual protokol: mekanisme yang diadaptasi langsung
> dari cara bursa saham sungguhan menangani momen paling berbahaya dalam sehari.
> Soal seberapa jauh ia belum ada padanannya onchain — baca status audit di bawah.

> ✅ **Status audit: SELESAI (12 Agustus 2026) — klaim bertahan, tapi dipersempit.**
>
> **Lelang onchain dengan satu harga kliring SUDAH ADA.** Uniswap **CCA**
> (Continuous Clearing Auctions) sepenuhnya onchain di v4: bid tersebar ke seluruh
> blok tersisa sehingga tidak bersaing di kecepatan, lalu menghasilkan satu harga
> kliring pasar. Jangan pernah bilang "lelang onchain belum ada".
>
> Tapi CCA adalah **peluncuran token: sekali jalan, untuk aset yang belum punya
> harga**. Tidak ada sesi, tidak ada publikasi imbalance, tidak ada harga penutupan
> harian.
>
> ✅ **Yang bertahan, dalam bentuk sempit:** lelang **berulang di batas sesi**, untuk
> aset yang **sudah diperdagangkan**, dengan **publikasi imbalance** dan **closing
> print harian**. Itu belum ditemukan padanannya onchain.
>
> **Tiga jejak yang sudah ditutup:**
> - **Figure OPEN** — jaringan ekuitas publik onchain di Provenance. Memakai **limit
>   order book dengan perdagangan kontinu** lewat ATS mereka, **bukan** lelang
>   buka/tutup. Ini pembanding paling mungkin — bursa ekuitas teregulasi onchain —
>   dan mereka justru **memilih kontinu**. ⚠️ Siaran persnya sendiri tidak menyebut
>   jam maupun lelang; ketiadaan lelang disimpulkan dari struktur order book-nya.
> - **Uniswap CCA** — lihat di atas. Kelas berbeda: distribusi, bukan sesi.
> - **Superstate Opening Bell** — penerbitan langsung saham ter-registrasi SEC dengan
>   harga acuan Nasdaq/NYSE. Bukan mekanisme lelang.
>
> Rumusan yang aman untuk pitch ada di `pitch.md` §3b.
>
> Dokumen pendamping: `ide-utama.md` (ide & bukti) · `spek-teknis.md` (implementasi)

---

## 1. Masalah yang diselesaikan

### 1.1 Skenario yang menghancurkan

Jumat malam, bursa AS tutup. Sabtu, berita buruk soal NVDA keluar.

Sepanjang akhir pekan, semua orang ingin menjual. Tapi harga onchain hanya
"mengambang di atas ekspektasi", karena tidak ada referensi hidup. Tidak ada yang
mau jadi lawan transaksi — siapa pun yang membeli sekarang berisiko memegang
posisi yang harganya bisa jatuh jauh lebih dalam saat bel berbunyi.

Senin, bursa buka. Yang terjadi dengan struktur yang ada sekarang:

1. Semua order yang tertahan menghantam kolam likuiditas **sekaligus**
2. Kolam itu masih tipis — market maker belum sepenuhnya kembali
3. Harga terjun **melewati** level wajar karena tekanan sesaat, bukan karena nilai
4. Posisi beragunan jadi *underwater*, likuidasi terpicu, menambah tekanan jual
5. Yang mengeksekusi paling akhir dapat harga terburuk — padahal informasinya sama

**Ini bukan kegagalan harga. Ini kegagalan struktur.** Semua orang punya informasi
yang sama; yang membedakan hasil mereka hanyalah urutan kedatangan.

### 1.2 Bagaimana bursa sungguhan menyelesaikannya

Setiap bursa saham besar di dunia memakai **lelang** untuk momen ini, bukan
perdagangan kontinu. Alasannya persis sama.

Tiga hal yang mereka lakukan, dan ketiganya akan kita bawa onchain:

1. **Akumulasi** — intent dikumpulkan sebelum pembukaan, tidak langsung dieksekusi
2. **Publikasi imbalance** — bursa menyiarkan harga indikatif dan besarnya
   ketimpangan sebelum bel. Ini **undangan terbuka** kepada penyedia likuiditas
3. **Satu harga kliring** — semua dieksekusi di harga yang sama, dengan *price collar*
   yang membatasi seberapa jauh harga pembukaan boleh menyimpang

Hasilnya: pembukaan dan penutupan adalah **dua momen paling likuid dalam sehari**.
Closing auction saja menyerap sekitar 10% dari seluruh volume ekuitas AS.

**Onchain, mekanisme ini belum kami temukan padanannya** — lelang onchain memang ada
(Uniswap CCA), tapi untuk peluncuran token, bukan untuk batas sesi. Lihat status
audit di kepala dokumen.

---

## 2. Lelang Pembukaan (Opening Cross)

### 2.1 Empat fase

```
FASE 1 — AKUMULASI                    (sepanjang off-hours / akhir pekan)
  Intent bertanda REOPEN dikumpulkan.
  Belum bisa dieksekusi. Pembatalan bebas.
        │
FASE 2 — PENGUNGKAPAN INDIKATIF       (T-30 menit sebelum bel)
  Publikasi tiap blok:
    · harga kliring indikatif
    · besar & arah imbalance
  ← INI YANG MENGUNDANG LIKUIDITAS
        │
FASE 3 — PEMBEKUAN                    (T-5 menit)
  Intent lelang tidak bisa lagi dibatalkan.
  Snapshot intent yang "backed" diambil.
        │
FASE 4 — CROSS                        (bel + konfirmasi oracle)
  Satu harga kliring seragam untuk semua.
  Sisa imbalance → venue / diserap solver.
        │
  → Sesi normal dimulai
```

### 2.2 Fase 2 adalah jawaban atas "siapa lawan transaksinya?"

Ini bagian terpenting dari seluruh desain, dan sering disalahpahami.

Kamu **tidak perlu likuiditas yang berdiri menunggu.** Kamu perlu **mengumumkan
kebutuhannya.**

Ketika kontrak menyiarkan *"ada imbalance jual NVDA senilai $200.000 di harga
indikatif $178"*, itu bukan sekadar informasi. Itu peluang dengan risiko yang
**terdefinisi dan terhitung** bagi siapa pun yang bisa melakukan lindung nilai —
solver, market maker, arbitrageur lintas venue.

Bandingkan dengan keadaan sekarang: penyedia likuiditas harus menebak apakah akan
ada arus jual besar Senin pagi, dan menanggung risiko itu sendirian sepanjang akhir
pekan. Wajar mereka menghilang.

**Publikasi imbalance mengubah risiko yang tidak diketahui menjadi peluang yang
terukur.** Itulah kenapa bursa sungguhan melakukannya, dan itulah kenapa
mekanisme ini menyelesaikan cold-start likuiditas di momen paling sulit.

### 2.3 Cara menentukan harga kliring

Hierarki yang dipakai bursa sungguhan, diadopsi apa adanya:

| Prioritas | Aturan |
|---|---|
| 1 | **Maksimalkan volume yang bisa dieksekusi** |
| 2 | Kalau seri → **minimalkan imbalance sisa** |
| 3 | Kalau masih seri → **paling dekat dengan harga referensi** |

Harga referensi = **harga referensi pembukaan** (TWAP feed Chainlink 300 detik
pertama sesi `OPEN`), dengan fallback ke harga feed terakhir bila jendela referensi
belum terisi. ⚠️ Bukan harga pembukaan resmi bursa — itu tidak tersedia onchain.

Memakai hierarki yang sama dengan bursa sungguhan bukan kemalasan — ini yang
membuat desainmu **autentik-ekuitas**, bisa dipertahankan di depan juri
institusional, dan tidak terlihat seperti mekanisme karangan.

### 2.4 Price collar & perpanjangan

Harga kliring tidak boleh menyimpang lebih dari `collarBps` dari referensi.

Kalau harga yang memaksimalkan volume berada **di luar collar**, jangan paksakan.
Bursa sungguhan menunda pembukaan; kita lakukan hal setara:

```
if (clearingPrice outside collar) {
    extend auction by EXTENSION_PERIOD    // mis. 5 menit
    widen collar by COLLAR_STEP           // mis. +50 bps
    republish indicative price + imbalance
    // maksimum N kali perpanjangan, lalu eksekusi di batas collar
}
```

Perpanjangan memberi waktu tambahan bagi likuiditas untuk masuk — dan karena
harga indikatif terus dipublikasikan, insentifnya makin kuat seiring collar melebar.

### 2.5 Jenis intent khusus lelang

Di sinilah kita mendapat sesuatu yang **tidak punya alasan untuk ada di protokol
kripto**, karena masalahnya tidak ada di kripto. Diadaptasi dari jenis order ekuitas nyata:

| Jenis | Perilaku | Untuk siapa |
|---|---|---|
| **MOO** — Market-on-Open | Eksekusi di berapa pun harga kliring | Yang ingin pasti keluar/masuk |
| **LOO** — Limit-on-Open | Eksekusi hanya jika harga kliring dalam limit absolut | Yang punya batas harga tegas |
| **ROO** — Reference-on-Open ⭐ | Limit **relatif terhadap harga referensi pembukaan**, mis. *"tidak lebih buruk dari 50 bps dari harga referensi pembukaan"* | **Yang paling penting** |

> ### ⚠️ Koreksi 1 Agustus 2026 — definisi ROO
> Versi awal dokumen ini menyebut *"harga pembukaan resmi"*. **Itu tidak tersedia
> onchain.** Verifikasi mainnet menunjukkan `DualAggregator` Chainlink memang punya
> jalur `transmitSecondary` dan `setCutoffTime`, tapi **`transmitSecondary` tidak
> pernah dipakai** (nol panggilan di semua jam) dan `cutoffTime()` tidak punya
> getter publik.
>
> **Definisi yang berlaku:** *harga referensi pembukaan* = TWAP feed Chainlink
> selama **300 detik pertama** sesi `OPEN` menurut kalender SessionManager kita
> sendiri. Kalau feed tidak update minimal 2× dalam jendela itu, intent ROO
> dibatalkan dan escrow dikembalikan penuh.
>
> Substansinya tidak berubah — pengguna tetap menyatakan **toleransi terhadap harga
> wajar**, bukan menebak angka absolut hari Sabtu. Yang berubah hanya sumber
> referensinya, dan kejujuran dalam menamainya.
>
> ⚠️ **SPCX dan aset pra-IPO lain tidak punya feed sama sekali** — ROO tidak bisa
> didefinisikan untuk mereka. Kecualikan dari allowlist.

**Kenapa ROO penting.** Seorang pengguna menandatangani niat hari Sabtu, ketika
belum ada yang tahu harga wajar Senin. Limit absolut yang dia tetapkan hari Sabtu
bisa jadi konyol setelah gap terjadi — entah terlalu longgar (dia dieksekusi jauh
lebih buruk dari harga pasar yang sebenarnya adil) atau terlalu ketat (dia tidak
tereksekusi sama sekali padahal ingin keluar).

ROO memecahkan ini: **pengguna menyatakan toleransi terhadap harga wajar, bukan
tebakan atas angka absolut.** Ini persis yang dibutuhkan orang biasa yang tidak
bisa begadang menunggu bel, dan tidak ada protokol kripto yang punya konsep ini
karena di kripto tidak ada "harga pembukaan resmi".

### 2.6 Pembekuan pembatalan — dan trade-off kustodinya

**Masalah:** kalau intent bisa dibatalkan sampai detik terakhir, seseorang bisa
mengajukan intent jual besar palsu untuk menggeser harga indikatif, memancing
lawan transaksi masuk, lalu membatalkannya sebelum cross.

Bursa sungguhan menyelesaikannya dengan **cutoff pembatalan** — setelah waktu
tertentu, order lelang tidak bisa ditarik. *(Di sini "order" sah — itu istilah bursa
sungguhan. Padanan Nokturn-nya: intent lelang.)*

Onchain lebih rumit: tanda tangan bisa "dibatalkan" secara de facto hanya dengan
memindahkan dana atau mencabut allowance. Ada dua jalan:

| Opsi | Cara | Konsekuensi |
|---|---|---|
| **A — Escrow saat beku** ✅ | Intent lelang wajib mengunci dana ke kontrak sejak fase pembekuan sampai cross (5–10 menit) | Harga indikatif **dijamin nyata**. Konsekuensinya: kontrak memegang dana selama jendela pendek |
| **B — Snapshot + bond** | Verifikasi saldo & allowance saat snapshot; yang menarik dana setelahnya kena slashing bond | Tanpa kustodi, tapi harga indikatif hanya "kemungkinan besar nyata", dan pengecualian peserta mengubah harga bagi yang lain |

**Rekomendasi: Opsi A**, hanya untuk lelang.

Alasannya: seluruh nilai fase 2 bergantung pada **kredibilitas angka imbalance**.
Kalau penyedia likuiditas tidak bisa mempercayai angka itu, mereka tidak akan
datang, dan mekanismenya runtuh. Escrow 5–10 menit adalah harga yang pantas untuk
jaminan itu.

**Penting:** ini pengecualian yang terbatas dan disengaja. **Batch off-hours biasa
tetap tanpa kustodi sama sekali.** Perbedaannya harus ditulis eksplisit di threat
model dan di dokumentasi pengguna — jangan disamarkan.

> ### Koreksi 16 September 2026, saat `AuctionHouse` ditulis
>
> Bagian ini dan §4 tidak bisa keduanya benar. §4 menulis bahwa harga indikatif
> dihitung dari intent yang sudah ter-escrow, tapi harga indikatif terbit 30 menit
> sebelum bel sementara pembekuan baru terjadi 5 menit sebelumnya. Yang menang
> adalah `ESCROW_DURATION` di `parameter.md` §3, karena ia parameter, dan karena
> menahan dana pengguna sepanjang akhir pekan jauh lebih mahal daripada yang
> hendak dibeli.
>
> **Yang berlaku di kode.** Escrow ditarik lewat Permit2 pada saat pembekuan.
> Harga indikatif selama fase pengungkapan berasal dari intent yang berkomitmen,
> bukan yang sudah ter-escrow, dan itu harus disebut apa adanya. Angka yang
> dijamin nyata adalah yang terbit di `AuctionFrozen`.
>
> **Yang menutup sebagian celahnya.** Saat commit, kontrak memeriksa bahwa pemilik
> benar-benar memegang dananya dan sudah menyetujui Permit2. Dana masih bisa pergi
> sesudahnya, dan kalau itu terjadi penarikan escrow gagal, intent itu gugur dari
> buku, dan kegagalannya terbit sebagai `CommitmentDropped`. Jadi buku tidak bisa
> diisi intent yang tidak ada uangnya, tanpa seorang pun diambil kustodinya lebih
> awal.
>
> Tiga keputusan lain lahir di hari yang sama dan ketiganya ada di
> `parameter.md` §3.0b, yaitu penundaan cross 300 detik agar ROO punya referensi,
> bond yang juga dipertaruhkan solver, dan cross v1.0 yang tidak menyentuh venue.


---

## 3. Lelang Penutupan — dan produk sampingan yang bernilai

### 3.1 Mekanisme

Sama dengan lelang pembukaan, dijalankan menjelang bel penutupan NYSE:
akumulasi → pengungkapan indikatif → pembekuan → cross.

Fungsinya berbeda: memberi jalan keluar yang teratur **sebelum** likuiditas
menghilang untuk 17,5 jam berikutnya. Ini justru momen ketika pengguna paling
butuh kepastian eksekusi.

### 3.2 Closing print sebagai barang publik ⭐

Lelang penutupan menghasilkan sesuatu yang tidak dimiliki chain ini:

> **Satu harga penutupan harian yang kanonik, terbentuk dari permintaan dan
> penawaran nyata onchain — bukan cerminan oracle.**

Kenapa ini berharga:

- **Protokol lending butuh mark harian.** Menandai agunan hari ini bergantung
  sepenuhnya pada oracle spot. Closing print memberi referensi kedua yang berasal
  dari transaksi sungguhan
- **Vault & produk terstruktur butuh NAV harian**
- **Perhitungan performa, pajak, dan pelaporan** butuh titik referensi harian
- Di TradFi, harga penutupan adalah **angka paling banyak dikutip** — dipakai untuk
  valuasi portofolio, margin harian, dan penyelesaian derivatif

> 🔴 **Koreksi 10 September 2026 — daftar di atas adalah alasan teoretis, dan
> pengukuran menunjukkan komposisi nyatanya BERBEDA.** Versi sebelumnya menyebut
> Morpho sebagai contoh konsumen. Itu **dugaan**, bukan pengukuran, dan proyek ini
> tidak boleh memakai dugaan sebagai bukti. Komposisi konsumen harga ekuitas yang
> sebenarnya di chain ini ada di §3.3 — didominasi **produk taruhan atas harga
> saham**, bukan lending. Baca itu sebelum memakai argumen mana pun di daftar ini.

**Implikasi strategis:** closing print membuat protokol lain **mengonsumsi**
Nokturn meski mereka tidak merutekan order lewatmu. Itu mengubahmu dari venue
menjadi infrastruktur — dan infrastruktur jauh lebih lengket daripada venue.

Terbitkan lewat interface yang gampang dipakai:

```solidity
interface INokturnClose {
    function closingPrice(address token, uint32 day)
        external view returns (uint256 price, uint256 volume, uint64 timestamp);
    function lastClose(address token)
        external view returns (uint256 price, uint64 timestamp);
}
```

Manipulasinya mahal secara alami: harga penutupan berasal dari lelang dengan
volume nyata dan dibatasi collar terhadap oracle. Untuk menggesernya, penyerang
harus benar-benar bertransaksi dalam volume besar melawan collar — dan itu
biayanya nyata, bukan gratis seperti memanipulasi spot sesaat di kolam tipis.

### 3.3 ⭐ Membuatnya bisa diinjak — permukaan baca kompatibel Chainlink

> Ditambahkan **10 September 2026.** Bagian ini lahir dari satu pengukuran yang
> mengubah cara kami memandang §3.2.

**Pengukurannya — dan dua koreksi yang harus ikut diceritakan.**

Pengukuran ini salah **dua kali** sebelum benar, dan keduanya kesalahan yang sama
persis dengan tiga pelajaran metodologi yang sudah tercatat di proyek ini
(`CLAUDE.md` §9). Ceritakan urutannya ke juri — ia bukti bahwa angka kami diperiksa,
bukan dikarang.

| Percobaan | Hasil | Kenapa salah |
|---|---|---|
| 1 | "31 kontrak membaca feed" | **10 di antaranya jalur tulis** (`transmit`, `0xb1dc65a4` — OCR feed itu sendiri). Menggelembungkan ~3× |
| 2 | "20 kontrak membaca feed" | Diukur di **lapisan agregator Chainlink — satu lapis terlalu dalam.** Sembilan "pembaca" terbesar ternyata **infrastruktur harga per-simbol** (18 kontrak berbytecode identik dari satu deployer), bukan konsumen. Mengecilkan **~37×** |
| **3 ✅** | Diukur di lapisan **di atas** permukaan harga | Angka yang dipakai |

**Angka yang benar** (1–10 September 2026):

| | |
|---|---|
| Pembacaan harga ekuitas | **64.671** |
| Kontrak konsumen berbeda | **749** |
| **Pengguna akhir berbeda** | **2.048** |
| Transaksi | **21.135** |

**Dan bentuknya lebih berguna daripada totalnya** — karena chain ini penuh dompet
ERC-4337 yang gampang disalahhitung sebagai protokol (pelajaran yang sama dengan
91.347 pemegang debu di `parameter.md` §10.3):

| Bentuk konsumen | Kontrak | Pembacaan | Pangsa |
|---|---|---|---|
| **>50 pengguna — lapisan protokol** | **2** | 24.596 | **38,0%** (satu melayani **1.274** pengguna) |
| 6–50 pengguna | 36 | 10.763 | 16,6% |
| 2–5 pengguna | 170 | 14.930 | 23,1% |
| 1 pengguna — kemungkinan smart account | 541 | 14.382 | 22,2% |

**Angka yang aman dipakai ke luar: 38 kontrak dari 24 operator berbeda, melayani
2.048 pengguna akhir.** Itu lapisan multi-pengguna — sudah dibuang smart account
per-pengguna, sudah dibuang infrastruktur harga, sudah dibuang jalur tulis.

Satu operator mendominasi: **6 kontrak, 1.472 pengguna, 39% seluruh pembacaan**,
dikerahkan 24 Juli – 27 Agustus 2026.

🔴 **Batas yang wajib disebut duluan: tidak satu pun bisa kami sebut namanya.**
Seluruh kontrak konsumen **belum terverifikasi di Blockscout**, dan operator
terbesar adalah EOA anonim tanpa label publik. Jadi kami **tidak bisa** bilang
"protokol X membaca ini". Yang bisa kami bilang: permintaannya nyata, terhitung,
dan bisa dijalankan ulang siapa pun. Menyebut nama yang tidak kami ketahui adalah
persis jenis klaim yang audit-audit sebelumnya gugurkan.

⚠️ Angka ini juga **batas bawah**: pembacaan lewat `eth_call` di luar transaksi
tidak muncul di trace. Yang terhitung justru populasi yang tepat — konsumen
**onchain**, satu-satunya yang bisa mengonsumsi closing print di dalam kontrak.

Kueri: `8664020` (total) · `8664034` (bentuk) · `8664041` (per kontrak) ·
`8664051` (per operator).

### 3.3b 🔴 Siapa konsumennya sebenarnya — dan kenapa ini mengubah argumen

Nama protokolnya tidak bisa kami ketahui (semua kontrak belum terverifikasi), tapi
**fungsinya bisa** — dari selektor yang dipanggil ke entrypoint mereka, diresolusi
lewat `api.openchain.xyz` (kueri `8664130`, 1–10 September 2026):

| Fungsi | Bukti selektor / event | Pengguna, 10 hari |
|---|---|---|
| **Taruhan atas harga saham** | `betMsft(uint256,uint256)` · `betUsdg(...)` · `cashOut(...)` · `claimLoot(...)` · event `JackpotFunded(uint256,uint256)` | **1.121** pada satu produk `deposit`, +717 pada fungsi kedua |
| **Lending / money market** | `deposit(address,uint256,address,address)` · `withdraw(...)` · **`borrow(uint256,address,bool,bool)`** | 38 · 29 · **20** |
| Yield / vault | `harvest(uint256,uint256)` · `unstake(...)` · `zapDeposit(...)` · `depositSingle(...)` · `distribute(...)` | 40 · 19 · 18 · 13 |
| Trading | `buy(uint256,uint256,uint256)` · `buyQuoted(bytes32,uint32,uint32,uint256)` | 30 · 25 |

**Konsekuensi jujurnya, dan ini harus disampaikan duluan:** argumen lama
*"protokol lending butuh mark harian"* **berlaku untuk irisan yang kecil** — sekitar
20–38 pengguna, bukan 2.048. Permintaan harga ekuitas terbesar di chain ini datang
dari **produk yang bertaruh atas harga saham**, dan produk taruhan butuh harga
**spot pada saat penyelesaian**, bukan harga penutupan harian.

### 🔴 Dan ukurannya membalik urutan prioritas — operator taruhan 34× lebih besar

Operator `0xCFBD7E12…` menjalankan **fork Olympus** (staking rebasing + bonding:
event `Rebased` · `LogRebase` · `BondCreated` · `Staked`/`Unstaked` · `Wrap`/`Unwrap`
· fungsi `index()`) dengan **"Desk" bertema per aset** di atasnya — satu di antaranya
terverifikasi bernama **`FlightSimDesk`**, dan di situlah `betMsft(uint256,uint256)`
berada. Fleet-nya **128 kontrak**, termasuk ERC-20 dan ERC-721 sendiri.

| | Ripe Protocol | **Operator `0xCFBD7E12…`** |
|---|---|---|
| Stock Token dipegang | $11.176 | **$377.558** (34×) |
| Arus masuk 10 hari | — | **$874.940** (MSFT $445.605 + USDG $429.335) |
| Pengguna | 20–38 | **1.121** pada satu fungsi `deposit` |
| Bisa disebut namanya | ✅ Ya | ❌ Tidak — kontrak inti tidak terverifikasi, tidak ada jejak publik |

Rincian kepemilikannya: NVDA **$130.658** · SPCX **$115.291** · AAPL **$110.197** ·
MSFT **$21.397** · GOOGL $16. Terkonsentrasi di satu kontrak inventaris
`0x757122439…` ($333.379) yang selektornya `buy(uint256,uint256,uint256)` dan
`cashOut(uint256,uint256,uint256)`.

**Bentuk itu penting.** Inventaris Stock Token **asli** + `buy`/`cashOut` + harga dari
feed Chainlink = **desk yang menjual eksposur dari persediaan sungguhan**, bukan
taruhan kertas murni. Mereka butuh **harga penyelesaian yang adil ketika bursa
tutup** — hari ini mereka mengutip dari feed yang beku 48–56 jam tiap akhir pekan,
untuk 74,1% arus. Itu membuat mereka kandidat konsumen closing print terkuat yang
terukur di chain ini.

> 🔴 **Diuji dan GUGUR di hari yang sama (10 Sep 2026): mereka BUKAN order flow.**
>
> Dugaan yang wajar — *"inventaris $377rb yang berputar $874rb per sepuluh hari
> pasti di-rebalance lewat DEX, dan itu arus yang bisa kita layani"* — **salah.**
>
> Seluruh volume DEX operator ini adalah **token treasury mereka sendiri (`NET`)**:
> Uniswap **V2** $3,76jt (7.913 trade) dan **V4** $507rb, lawan USDG dan ETH. Yang
> menyentuh Stock Token hanya **8 trade** (NET↔SPY di V4). Kueri `8664756` ·
> `8664764`, Agustus–September 2026.
>
> **Artinya mereka menyerap sisi lawan pengguna langsung dan menahan risikonya**,
> bukan melindung nilai di pasar. Tidak ada arus ekuitas mereka yang bisa dilayani
> Nokturn hari ini. Mereka konsumen harga, **titik** — dan itu tetap berharga, tapi
> jangan dihitung dua kali.

⚠️ **Temuan sampingan yang menyentuh peta venue kita: Uniswap V2 ada dan ramai di
chain ini, dan tidak disebut di dokumen mana pun.** Satu operator saja memutar
$3,76jt di sana. Untuk allowlist v1.0 ini tidak mengubah apa pun — volumenya bukan
Stock Token, dan keputusan adapter tetap berdasar pangsa volume allowlist (V3 82,5%,
V4 12,6%). Tapi dua hal jadi layak diperiksa: **(a)** apakah ~4,9% volume allowlist
yang tidak tercakup V3+V4 sebagian ada di V2, dan **(b)** V2 relevan untuk Fase 4
(`distribusi.md`), ketika mesin yang sama melayani volume non-ekuitas.

⚠️ **Batas bukti.** Kami tahu bentuk onchain-nya, **bukan** mekanisme produknya.
Kontrak intinya tidak terverifikasi, tidak ada dokumentasi publik, dan penyisiran web
atas `FlightSimDesk` tidak menemukan jejak proyek ini. Jangan menyebut namanya,
jangan mendeskripsikan mekanismenya lebih jauh dari selektor dan event yang terbaca.

**Kenapa itu tetap tidak menggugurkan closing print — malah menajamkannya.**
Perhatikan apa yang sebenarnya dibutuhkan `betMsft`: **harga acuan pada satu titik
waktu yang disepakati.** Lalu perhatikan keadaan chain ini: 74,1% trade terjadi saat
bursa tutup, feed membeku 48–56 jam tiap akhir pekan, dan ekor p99 off-hours 8,5×
lebih lebar. **Dengan harga apa taruhan MSFT diselesaikan pada Sabtu malam?**

Hari ini jawabannya: oracle spot yang beku, atau harga kolam tipis di ekor yang
paling berbahaya. Closing print — terbentuk dari lelang, terbit bersama volume dan
jumlah peserta, dan **menolak terbit** ketika terlalu tipis — adalah jawaban yang
lebih baik untuk pertanyaan itu daripada keduanya.

### Satu-satunya konsumen yang benar-benar menandai Stock Token — dan ukurannya

> ✅ **Diverifikasi terhadap dugaan yang salah (10 Sep 2026) — angka di bawah
> BERTAHAN.** Blockscout menampilkan tab **User operations** pada kedua alamat
> kustodi, yang sempat kami baca sebagai bukti keduanya **smart account ERC-4337**
> milik pengguna, bukan vault protokol. Kalau itu benar, angka $11.176 **salah**.
>
> **Ternyata tidak.** Tab itu dirender Blockscout untuk alamat mana pun — ia muncul
> tidak konsisten bahkan antara dua pembacaan halaman yang sama. Uji langsung ke
> data: **nol** dari seluruh deployment `0xEF3CB775…` pernah muncul sebagai `sender`
> di `UserOperationEvent` (kueri `8664401`). Kontrolnya juga lolos — event itu
> **ada** dan ramai di chain ini: **5.892.471 user operation dari 336.852 sender
> berbeda** dalam 10 hari, di 4 EntryPoint (kueri `8664424`). Jadi nol berarti nol,
> bukan kueri yang kosong.
>
> 🔴 **Dua aturan tetap yang lahir dari episode ini:**
> 1. **Tab atau label di explorer bukan bukti.** Ini kejadian **kelima** di proyek
>    ini sebuah view menyesatkan (`CLAUDE.md` §9). Verifikasi ke event atau
>    precompile-nya langsung, selalu.
> 2. **Selalu jalankan kontrol untuk hasil nol.** "Nol kecocokan" tidak berarti apa
>    pun sampai kamu membuktikan kuerinya bisa menemukan sesuatu. Tanpa kueri
>    `8664424`, temuan ini akan dibuang karena alasan yang salah.
>
> ⭐ **Dan angka kontrolnya sendiri berharga:** 336.852 smart account aktif dalam 10
> hari menjelaskan ketiga distorsi pengukuran hari ini sekaligus — 91.347 pemegang
> debu (`parameter.md` §10.3), 541 kontrak satu-pengguna (§3.3), dan alarm palsu ini.
> **Di chain ini, "kontrak" tidak pernah berarti "protokol" sampai dibuktikan.**

⭐ **Dan ternyata ia BISA disebut namanya: [Ripe Protocol](https://www.ripe.finance/).**
Ini satu-satunya konsumen harga ekuitas di chain ini yang identitasnya berhasil
dipastikan — lewat nama kontrak terverifikasi, bukan tebakan.

| Bukti | Temuan |
|---|---|
| Nama kontrak di Blockscout | `0x2D3CB2B3…` = **`Teller`** · `0x8BF03188…` = **`CurvePrices`** |
| Token share | `0x290A5238…` = **sGREEN, "Savings Green USD"** — 13 pemegang, supply 49.860 |
| Selektor khas | `claimLoot(address,bool)` · `borrow(uint256,address,bool,bool)` |
| Padanan di dokumentasi Ripe | `Teller.vy` = *"primary user interface for deposits, withdrawals, borrowing"* · `Lootbox.vy` = mesin distribusi hadiah · `CurvePrices.vy` & `ChainlinkPrices.vy` = sumber harga · sGREEN = GREEN berbunga (ERC-4626) |

**Dan tesis produk mereka adalah kalimat ini, dari halaman depan mereka sendiri:**

> *"Borrow Against Your Tokenized Stocks Without Selling."*

Jadi argumen "lending butuh mark harian untuk ekuitas tokenized" **bukan hipotesis
dan bukan analogi** — ada protokol yang seluruh produknya persis itu, sudah live di
chain ini, dan sudah membaca feed ekuitas Chainlink lewat `ChainlinkPrices.vy`.

| Peran | Alamat | Catatan |
|---|---|---|
| Entrypoint pengguna (`Teller`) | `0x2D3CB2B3…` | **Net nol** — router, tidak menyimpan apa pun |
| Operator / deployer | `0xEF3CB775…` | Fleet 20+ tipe bytecode berbeda, 13–25 KB |
| Vault agunan | `0x4F89C946…` | **$10.929** — NVDA $10.576 · GME $153 · SPCX $122 · AAPL $50 · GOOGL $26 · TSLA $3 |
| Vault agunan | `0xABC93B41…` | **$247** di enam token. **Bytecode identik** dengan di atas — dua instance tipe vault yang sama |

### ⭐ Jalur integrasinya sudah ada di arsitektur mereka, bukan perlu dibujuk

Ripe punya **`PriceDesk.vy`** — dokumentasi mereka menyebutnya *"oracle aggregator
routing price requests through prioritized sources"*, dengan alasan eksplisit agar
tidak ada satu oracle pun jadi titik kegagalan tunggal.

Artinya menambahkan closing print **bukan** menuntut mereka menulis integrasi baru
atau mengganti oracle. Ia jadi **satu sumber tambahan di daftar prioritas** — persis
peran yang sudah dirancang ada, dan persis posisi yang kami klaim sejak awal:
**referensi kedua, bukan pengganti** (`parameter.md` §3.1). Ditambah permukaan baca
`AggregatorV3Interface`, biaya integrasinya mendekati nol.

Ini jalur adopsi paling konkret yang dimiliki proyek ini — dan ia lahir dari
pengukuran, bukan dari daftar keinginan.

🔴 **Dan seluruh bukunya sekitar $11.176.** Terhadap $75,62jt Stock Token onchain,
itu **0,015%**. Satu posisi NVDA menyusun 95% di antaranya.

**Cara menyampaikannya, dan jangan dibalik urutannya:** sebut ukurannya **duluan**,
baru maknanya. *"Ada satu money market yang menandai Stock Token. Bukunya sebelas
ribu dolar. Kami sebut angkanya karena itulah keadaannya hari ini — dan karena
lapisan yang kami bangun tidak bergantung padanya."*

⚠️ Catatan allowlist: kustodi itu memegang **SPCX dan GME**, dua token yang justru
**di luar** allowlist v1.0 karena feed-nya. Closing print v1.0 akan menutupi
~$10.652 dari $11.176 buku itu — sebut batas ini kalau ditanya.

⚠️ **Tapi jangan membalikkannya jadi klaim.** Kami **tidak** punya bukti satu pun
dari mereka menginginkannya, dan produk taruhan juga menaikkan taruhan manipulasi
print (`threat-model.md` §4). Rumusan yang jujur:

> *"Permintaan harga ekuitas di chain ini terukur dan sebagian besar datang dari
> produk yang menyelesaikan pada harga saham di satu titik waktu. Itu persis
> pertanyaan yang tidak punya jawaban baik ketika bursa tutup — dan itu 74% waktu."*

**Kesimpulan yang mengubah desain.** Kedua puluh kontrak itu terhubung ke
`AggregatorV3Interface`. `INokturnClose` di §3.2 adalah interface buatan sendiri —
bagus untuk konsumen baru, **tidak bisa dipakai** oleh konsumen yang sudah ada tanpa
menulis kode integrasi baru. Barang publik yang menuntut pekerjaan integrasi sebelum
bisa dipakai bukan rel; ia proposal.

Karena itu closing print diterbitkan lewat **dua permukaan**, bukan satu:

```solidity
// Permukaan 1 — drop-in. Konsumen yang sudah ada mengganti satu alamat, selesai.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);          // 8, sama dgn Chainlink
    function description() external view returns (string memory);
    function latestRoundData() external view returns (
        uint80 roundId,      // hari sesi, YYYYMMDD
        int256 answer,       // harga penutupan
        uint256 startedAt,   // pembukaan lelang penutupan
        uint256 updatedAt,   // 🔴 waktu cross SEBENARNYA, tidak pernah block.timestamp
        uint80 answeredInRound
    );
    function getRoundData(uint80 roundId) external view returns (...);
}

// Permukaan 2 — asli. Untuk konsumen yang mau metadata kualitasnya.
interface INokturnClose {
    function closingPrice(address token, uint32 day)
        external view returns (uint256 price, uint256 volume, uint64 timestamp);
    function lastClose(address token)
        external view returns (uint256 price, uint64 timestamp);
}
```

**Empat larangan yang mengikat** — dikunci di `parameter.md` §3.1, jangan
dilonggarkan di kode: `updatedAt` tidak pernah dipalsukan · tidak pernah mengarang
angka untuk menutup lubang · tidak pernah diposisikan sebagai pengganti Chainlink ·
tidak pernah mengklaim ada yang sudah mengonsumsinya.

**Yang terjadi ketika lelang terlalu tipis** — dan ini bagian terbaiknya:

> Tidak ada ronde baru yang dibuat. `latestRoundData` tetap mengembalikan print valid
> terakhir, dengan `updatedAt` aslinya yang lebih tua. Pemeriksaan staleness milik
> konsumen sendiri kemudian menolaknya — **atas kemauan mereka, dengan aturan mereka.**
> Kami tidak pernah menyodorkan angka yang tidak layak dipercaya, dan tidak pernah
> menyembunyikan bahwa hari itu kosong.

Simetrinya dengan sisa protokol disengaja. Batch yang gagal tetap menerbitkan
baseline-nya. Lelang yang tipis **menolak menerbitkan harga**. Keduanya kalimat yang
sama: *protokol ini melaporkan keadaan sebenarnya, terutama ketika keadaan sebenarnya
tidak menguntungkan kami.*

**Kenapa ini yang membuat posisinya berubah.** Sebelum bagian ini, closing print
adalah "barang publik" tanpa jalur adopsi — bagus di slide, tidak bisa dipegang.
Sesudahnya ia punya **basis konsumen yang terukur (38 kontrak dari 24 operator, 2.048 pengguna
akhir), biaya adopsi yang
mendekati nol (ganti satu alamat), dan aturan kejujuran yang bisa diverifikasi
dengan membaca kode.** Itu yang membedakan infrastruktur dari niat baik.

⚠️ **Yang TETAP tidak boleh diklaim:** bahwa kontrak-kontrak itu akan mengadopsinya.
Mereka **bisa dijangkau**, bukan **sudah berkomitmen**. Kalimat yang aman:
*"Dua puluh kontrak membaca harga ekuitas onchain hari ini, dan semuanya lewat
interface yang kami dukung sejak hari pertama."*

---

## 4. Permukaan serangan & mitigasi

| Serangan | Mitigasi |
|---|---|
| Imbalance palsu untuk memancing lawan transaksi | Escrow sejak pembekuan (§2.6) |
| Manipulasi harga indikatif di menit akhir | Harga indikatif dihitung dari intent yang sudah ter-escrow; pembekuan menutup jendelanya |
| Manipulasi oracle saat cross | Price collar + perpanjangan; cross tidak berjalan sebelum oracle mengonfirmasi pembukaan resmi |
| Solver menahan solusi agar lelang gagal | Bond + slashing; siapa pun boleh memanggil `finalize`; ada solusi fallback dari harga referensi |
| Corporate action tepat di pagi pembukaan | Baca `UIMultiplierUpdated`; sesuaikan intent lelang sebelum cross, atau batalkan lelang untuk token itu dan kembalikan escrow |
| Bursa tetap tutup (libur tak terduga / halt) | Oracle sesi menggerbangi cross. Kalau tidak buka dalam jendela maksimum → escrow dikembalikan penuh |
| Volume lelang terlalu tipis untuk harga bermakna | Volume minimum untuk menerbitkan closing print; di bawah itu, tandai sebagai `insufficient` alih-alih menerbitkan angka menyesatkan |

---

## 5. Kenapa bagian ini yang paling kuat di depan juri

**Innovation & Creativity.** Bukan mekanisme karangan — ini adaptasi setia dari
struktur pasar yang mengelola triliunan dolar setiap hari, dibawa ke tempat yang
belum pernah memilikinya. Hierarki harga, price collar, perpanjangan, MOO/LOO,
publikasi imbalance: semuanya punya padanan nyata yang bisa kamu rujuk.

**Real Problem Solving.** Skenario Senin pagi adalah kerugian nyata yang bisa
dihitung, bukan ketidaknyamanan.

**Product-Market Fit.** ROO melayani orang yang tidak bisa begadang menunggu bel —
dan itu **tiap zona waktu di luar Amerika**, bukan satu region saja.

> ⚠️ **Direvisi 11 September 2026** — kueri [`8680028`](https://dune.com/queries/8680028) mengukur distribusi jam perdagangan
> dan **menggugurkan klaim lama** *"hampir semua orang di Asia Tenggara, pengguna
> terbesar aset ini"*. Jam bangun Asia (00–09 UTC) cuma memuat **33,54%** trade —
> **di bawah** ekspektasi merata 41,67%. Rumusan yang bertahan justru lebih kuat
> karena lebih luas: **tidak ada satu pun jam mati** — tiap jam dari 24 jam punya
> 30.544–55.100 pengirim berbeda, dan tak satu pun punya harga resmi.
> Lihat `parameter.md` §10.5.

**Smart contract quality.** Mekanisme lelang punya invarian yang bersih dan bisa
diuji secara ketat: volume maksimum, harga seragam, collar dihormati, escrow selalu
kembali kalau lelang batal.

**Dan satu kalimat yang gampang diingat juri:**

> *Setiap bursa saham di dunia membuka dan menutup dengan lelang.
> Saham onchain tidak punya satu pun. Kami membangunnya.*

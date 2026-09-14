# Nokturn — Model Ekonomi & Insentif Solver

> Pertanyaan yang dijawab dokumen ini: **kenapa solver mau datang, dari mana
> uangnya, dan bagaimana memastikan pengguna tidak dirugikan ketika solver
> sedikit atau bahkan cuma satu.**
>
> Pendamping: `desain-auction.md` · `desain-agent.md` · `spek-teknis.md`

---

## 1. Dari mana nilainya benar-benar berasal

Sebelum bicara pembagian, kita harus jujur soal sumbernya. Ada empat, dan
semuanya nilai yang **diciptakan**, bukan dipindahkan dari pihak lain.

| Sumber | Isi |
|---|---|
| **Netting (CoW)** | A beli NVDA, B jual NVDA. Tanpa batch, keduanya membayar spread + fee ke kolam. Di dalam batch mereka bertransaksi langsung di harga tengah. **Penghematannya dua kali lipat** — untuk A dan untuk B |
| **Agregasi** | Sisa imbalance dieksekusi sebagai satu order, bukan lima puluh order kecil. Price impact jauh lebih rendah |
| **Gas** | Satu transaksi settlement untuk N intent, bukan N transaksi |
| **Routing** | Solver memilih eksekusi terbaik lintas venue yang ter-allowlist. **v1.0 = Uniswap V3 saja** — adapter tambahan masuk lewat time-lock, bukan deploy ulang |

Poin penting untuk pitch: **tidak ada satu pun yang berasal dari mengambil nilai
dari pihak lain.** Ini bukan MEV yang dipindahkan — ini pemborosan yang dihapus.
Bandingkan dengan sandwich bot, yang keuntungannya persis kerugian orang lain.

---

## 2. Baseline: angka yang menentukan segalanya

Semua ekonomi protokol ini bergantung pada satu pertanyaan:
**dibandingkan apa?**

### 2.1 Kenapa "dibanding limit price" salah

Godaan pertama: surplus = seberapa jauh eksekusi lebih baik dari limit pengguna.
Murah dan gampang diverifikasi onchain.

Tapi salah secara ekonomis. Pengguna yang menetapkan limit longgar akan terlihat
"dihemat banyak" padahal tidak ada penghematan nyata. Solver jadi terinsentif
mencari pengguna ceroboh, bukan menghasilkan eksekusi bagus.

### 2.2 Kenapa "dibanding harga tengah oracle" juga salah

Godaan kedua: bandingkan dengan mid oracle.

Juga salah — karena transaksi yang ter-netting **memang dieksekusi di harga tengah**.
Diukur begini, surplusnya nol. Padahal penghematannya nyata: pengguna terhindar
dari membayar spread.

### 2.3 Baseline yang benar ✅

> **Baseline = berapa yang benar-benar akan kamu dapat kalau mengeksekusi sendiri
> di venue terbaik, pada ukuran itu, di blok itu juga.**

Solver wajib menyertakan kuotasi baseline; kontrak memverifikasinya lewat
`IVenueAdapter.quoteFromState()` — **menghitung ulang dari state pool**
(`slot0`, `liquidity`, `fee`) memakai matematika Uniswap. Murni `view`.
Untuk menekan gas, kuotasi diambil **per pasangan pada volume agregat**, bukan
per intent.

### 2.4 Dua batasan yang menentukan bentuk implementasi

Keduanya hasil verifikasi onchain 1 Agustus 2026, dan keduanya mempersempit
desain ke sesuatu yang lebih jujur.

**Batasan 1 — hanya Uniswap V3 yang bisa dijadikan baseline.**

Quoter Uniswap **tidak bisa** dipanggil lewat `staticcall`: ia menjalankan swap
lalu revert, sehingga mencoba `SSTORE`, dan `STATICCALL` menolak setiap upaya
modifikasi state. Karena itu baseline dihitung dari state pool, bukan dikuotasi.

Tapi itu hanya berlaku untuk pool ber-fee statis. **Pool Uniswap V4 dominan memakai
hook dengan fee dinamis** (`0x800000` — 5.540 + 4.515 pool stock), sehingga fee
ditentukan hook saat swap dan keluarannya tidak dapat dihitung dari state sama
sekali.

→ **Adapter v1.0 = Uniswap V3 saja.** Adapter yang tidak bisa dihitung wajib
mengembalikan `isQuotable() == false`, dan `Settlement` hanya memakai adapter
yang `isQuotable()` untuk baseline. V3 tetap mayoritas volume ($193,8jt vs $106,1jt).

**Batasan 2 — pembanding yang paling jujur tidak bisa diverifikasi kontrak.**

Pintu masuk order flow ritel sesungguhnya adalah router agregator
`0x65050A9B7E5075A2BA5CED7B1B64EE66262C40DC` — **1.131.568 panggilan dari 25.316
alamat berbeda** dalam 3 hari. Itulah yang benar-benar dialami pengguna, jadi
secara ekonomi itulah pembanding yang paling jujur.

**Tapi router itu tidak punya fungsi kuotasi** — semua selector umum revert.
Maka dua hal harus dipisahkan dan tidak boleh dicampur:

| | Sumber | Sifat | Dipakai untuk |
|---|---|---|---|
| **Baseline onchain** | State pool Uniswap V3 | ✅ Terverifikasi kontrak, trustless | **Dasar fee** |
| **Metrik publikasi** | Simulasi offchain terhadap router | ⚠️ Metodologi terbuka, **bukan** jaminan protokol | Dasbor & pitch |

> **Jangan pernah menyebut perbandingan-terhadap-router itu trustless.**
> Dan jangan mengklaim penghematan terhadap satu pool tunggal seolah itu yang
> dialami pengguna — kalau pengguna sebenarnya memakai agregator, klaim itu
> melebih-lebihkan, dan itu persis jenis kesalahan yang akan dibongkar juri.

```
savings = Σᵢ (received_i − baselineReceived_i)
```

**Dan inilah yang membuatnya elegan:** angka yang dipakai membayar solver adalah
**angka yang sama persis** yang kamu tunjukkan ke juri dan ke pengguna.
Satu metrik, tanpa cerita ganda. Kalau kamu bilang *"kami menghemat $X untuk
pengguna"*, itu literal angka yang jadi dasar fee.

---

## 3. Pembagian nilai

```
savings (diukur vs baseline venue)
   ├── 80%  → PENGGUNA        (langsung diterima di harga eksekusinya)
   ├── 15%  → SOLVER          (pemenang batch)
   └──  5%  → PROTOKOL
```

### 3.1 Aturan yang membuat modelnya jujur

**Fee nol kalau tidak ada penghematan.**
Kalau solusi terbaik tidak mengalahkan baseline venue, **tidak ada yang dibayar**
— tidak solver, tidak protokol. Pengguna tetap dieksekusi (atau batch jadi
pass-through, §4.1).

Ini kalimat pemasaran yang kuat dan **benar secara literal**:

> *Kamu hanya membayar kalau kami mengalahkan pasar. Dan kamu menyimpan 80% dari
> selisihnya.*

### 3.2 Dua batas keras di kontrak

Karena di awal kemungkinan besar **hanya ada satu solver — kamu sendiri** —
kompetisi belum menekan fee. Kontraknya yang harus menekan:

| Batas | Nilai |
|---|---|
| Fee maksimum sebagai porsi savings | **20%** (solver + protokol digabung) |
| Fee maksimum sebagai porsi notional | **3 bps** |

Yang berlaku adalah yang lebih kecil. Artinya **solver monopoli pun tidak bisa
memeras**, dan properti ini bisa dibaca langsung dari kode oleh siapa pun.

Ini penting untuk juri: kamu tidak meminta kepercayaan bahwa kamu akan bersikap
wajar saat jadi satu-satunya solver. Kamu menunjukkan kode yang membuatnya mustahil.

---

## 4. Pengaman pengguna

### 4.1 Invarian terkuat: tidak pernah lebih buruk dari baseline ⭐

```
if (bestSolution.savings < minSavingsThreshold) {
    → batch jadi PASS-THROUGH:
      tiap intent dirutekan langsung ke venue terbaik
}
```

**Konsekuensinya: memakai Nokturn tidak pernah lebih buruk daripada memakai
Uniswap langsung.** Skenario terburuknya adalah imbang, ditambah penundaan
sepanjang jendela batch.

Ini menghapus keberatan terbesar terhadap adopsi. Pengguna tidak perlu menimbang
risiko — hanya menimbang waktu tunggu 30–60 detik melawan penghematan.

Sebagai invarian yang diuji, ini juga tajam dan mudah dinyatakan:
*tidak ada peserta yang berakhir lebih buruk dibanding tidak ikut batch.*

### 4.2 Lapisan lain

| Pengaman | Isi |
|---|---|
| Limit price | Tidak pernah dilanggar, apa pun yang terjadi |
| Price band vs oracle | Harga kliring tidak bisa menyimpang jauh meski semua limit longgar |
| Exposure caps | Batas notional per batch/token/hari |
| Escrow lelang dikembalikan penuh | Kalau lelang batal, dana kembali seluruhnya |

---

## 5. Ekonomi dari sisi solver

### 5.1 Biaya yang ditanggung solver

| Biaya | Catatan |
|---|---|
| Gas settlement | Dibayar solver, **diganti dari fee sebelum pembagian** — supaya batch kecil tetap layak dikerjakan |
| Infrastruktur | Node, mesin solver, monitoring |
| Modal | **Nol kalau merutekan sisa ke venue.** Modal hanya perlu kalau solver memilih menyerap sisa ke bukunya sendiri |

Poin penting: **solver tidak butuh modal untuk ikut.** Itu menurunkan hambatan
masuk drastis dibanding jadi market maker, dan itulah sebabnya jaringan solver
bisa tumbuh tanpa izin.

### 5.2 Kompetisi tanpa kartel

Risiko: solver diam-diam sepakat mengajukan solusi seadanya lalu berbagi fee.

Empat hal yang membuatnya sulit:

1. **Masuk tanpa izin** — kartel manapun bisa dirusak satu pendatang baru
2. **Baseline objektif** — solusi malas terlihat jelas buruk karena diukur
   terhadap kuotasi venue nyata, bukan terhadap sesama solver
3. **Pass-through otomatis** — kalau semua solusi buruk, protokol melewati mereka
   dan merutekan langsung. **Kartel tidak menghasilkan apa pun**
4. **Papan skor publik** — performa diturunkan dari fakta settlement onchain

Poin 3 yang paling menentukan: berkolusi untuk memberi solusi buruk tidak
menghasilkan uang, karena batch-nya tidak jadi milik mereka.

### 5.3 Bootstrap

Fase awal kamu menjalankan satu-satunya solver. Itu wajar dan tidak memalukan —
CoW pun begitu. Yang penting **jalur pendatang baru terbuka sejak hari pertama**:
solver referensi open source, dokumentasi, dan pendaftaran tanpa izin.

Katakan apa adanya ke juri: *"satu solver hari ini, tanpa izin sejak hari pertama,
dan kontraknya membatasi apa yang bisa diambil solver mana pun."*

---

## 6. Angka pendapatan — dihitung jujur

Perkiraan kasar dengan data yang terukur hari ini:

> ⚠️ **Dihitung ulang 3 September 2026 ke basis Agustus.** Basis lama $148 juta/bulan
> berasal dari cakupan Juli yang lebih sempit dan **tidak sebanding**. Basis baru
> adalah volume **allowlist v1.0** (NVDA, AAPL, TSLA, GOOGL) — bukan seluruh stock
> token — karena itulah yang benar-benar dilayani v1.0.

| | |
|---|---|
| Volume allowlist v1.0 di DEX (satu sisi) | **$501,0 juta/bulan** *(Agustus 2026)* |
| Asumsi Nokturn merebut 20% | **~$100 juta/bulan** |
| **Rasio netting pada pangsa 20%** | **33,4%** *(backtest Agustus 2026, bukan asumsi — `parameter.md` §1B)* |
| Penghematan rata-rata (asumsi) | 5–15 bps |
| Savings yang diciptakan | **$50rb – $150rb/bulan** |
| Pendapatan protokol (5%) | **$2.500 – $7.500/bulan** |
| Pendapatan solver (15%) | **$7.500 – $22.500/bulan** |

**Pertumbuhan tiga kali lipat dalam sebulan mengubah skalanya, bukan kesimpulannya.**
Volume allowlist naik dari $157,8 juta (Juli) ke $501,0 juta (Agustus), dan angka di
atas ikut naik ~3,2×. Tetap saja ini **belum jadi bisnis** — lihat paragraf di bawah.
Jangan memakai satu bulan pertumbuhan untuk memproyeksikan bulan berikutnya.

> **Yang sekarang terukur dan yang masih asumsi.** Rasio netting **33,4% pada pangsa
> 20%** sudah di-backtest dari data Agustus 2026. Yang masih asumsi adalah **berapa bps
> yang dihemat per unit volume** — itu butuh baseline `quoteFromState` yang nyata,
> jadi baru bisa diukur setelah adapter jalan.
>
> Artinya §1 tabel sumber nilai sekarang punya bobot yang jelas: **netting** menyentuh
> ~27–33% volume pada pangsa awal, sisanya bergantung pada **agregasi + routing**.
> Jangan bangun pitch yang seolah netting menanggung semuanya.

**Ini kecil, dan jangan disamarkan.** Dengan pasar ekuitas onchain hari ini,
protokolnya belum jadi bisnis. Ada dua jalur yang mengubahnya, dan keduanya nyata.

### 6.1 Jalur 1 — pasar ekuitasnya tumbuh

Seluruh tesis Robinhood Chain bergantung pada ini. Kalau volume ekuitas naik 10×,
pendapatannya naik 10×. Kamu bertaruh searah dengan chain-nya sendiri.

⭐ **Dan taruhan itu mulai terbayar.** Antara Juli dan Agustus 2026 volume stock token
naik **3,6×** ($280,2jt → $1.005,6jt) dan dompet aktif **2,3×** (59.785 → 139.093).
Bukan lagi jalur hipotetis.

⚠️ **Tapi satu bulan bukan tren.** Jangan mengekstrapolasi laju ini ke bulan
berikutnya, dan jangan memakainya sebagai proyeksi pendapatan di pitch. Yang boleh
disebut adalah pertumbuhan yang sudah terjadi, bukan yang diandaikan berlanjut.

### 6.2 Jalur 2 — mesin yang sama melayani seluruh chain ⭐

Ini yang lebih penting, dan sudah tersedia karena **scope-nya penuh sejak awal**:
kodenya umum, tidak mengasumsikan token tertentu, hanya digerbangi allowlist.

Ingat komposisi chain yang kuukur: stock token cuma **2,88%** volume DEX
(Agustus 2026). Sisanya — sekitar **$33,9 miliar/bulan** — adalah memecoin dan
kripto.
Dan trader memecoin adalah korban MEV paling parah di seluruh kripto.

Netting batch dan perlindungan urutan bekerja **persis sama baiknya** untuk mereka.

> **Strateginya: masuk lewat celah yang kamu kuasai secara unik — eksekusi ekuitas
> di jam non-bursa — lalu perluas ke tempat volumenya berada.**
>
> Wedge-nya sempit dan dapat dipertahankan. Pasarnya luas. Mesinnya sama.

Ini juga yang membuat "pasarnya kecil" berhenti jadi kelemahan di depan juri.
Jawabannya bukan berharap — jawabannya: *tambahkan token ke allowlist lewat satu
transaksi time-lock.* Kemampuannya sudah ada di kode, eksposurnya yang dikontrol.

---

## 7. Ringkasan untuk pitch

| Pertanyaan | Jawaban satu kalimat |
|---|---|
| Dari mana nilainya? | Pemborosan yang dihapus — bukan nilai yang diambil dari pihak lain |
| Dibanding apa diukur? | Kuotasi venue nyata di blok yang sama; metrik yang sama untuk fee dan untuk klaim |
| Siapa dapat apa? | Pengguna 80%, solver 15%, protokol 5% |
| Kalau tidak menghemat? | Fee nol, dan batch jadi pass-through |
| Bisa lebih buruk dari Uniswap? | **Tidak pernah.** Terburuk imbang, plus tunggu 30–60 detik |
| Kalau solver cuma satu? | Kontrak membatasi maksimum 20% savings atau 3 bps notional |
| Kalau solver berkolusi? | Pass-through otomatis membuat kolusi tidak menghasilkan apa pun |
| Pendapatan hari ini? | Kecil — dan jalur pertumbuhannya sudah ada di kode |

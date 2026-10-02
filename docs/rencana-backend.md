# Nokturn. Rencana Kerja Backend

> Pemilik dokumen: Dharu. Turunan dari `pembagian-tugas.md` §3, dipersempit ke
> keadaan nyata repo pada 20 September 2026 dan diikat ke kode kontrak yang sudah
> berjalan, bukan ke dokumen desain.
>
> Kalau dokumen ini dan kode kontrak berbeda, **kode yang menang**, dan dokumen ini
> yang diperbaiki di hari yang sama (`CLAUDE.md` §2 nomor 8).
>
> Dokumen ini ditulis setelah 14 September, jadi ia tunduk pada `CLAUDE.md` §11.4
> dan §11.6.

---

## 0. Posisi hari ini

| | |
|---|---|
| Tanggal | 20 September 2026, hari ke-7 dari 17 |
| Tenggat | 1 Oktober 2026, 23:59 SGT |
| Sisa hari kerja | **11** |
| Kontrak | Selesai, ter-deploy di testnet 46630, ABI ada di `packages/shared/abi/` |
| Backend | **Nol baris.** `solver/`, `api/`, `indexer/`, `analytics/`, `infra/` belum ada |

**M1 sudah lewat tanpa terpenuhi.** Titik sinkronisasi M1 di `pembagian-tugas.md` §5
menuntut ujung ke ujung di fork pada hari ini, dan bagian backend dari rantai itu
belum ada. Aturannya sudah tertulis di kolom kalau meleset, yaitu hentikan fitur baru
dan integrasi duluan. Rencana di bawah menaati itu, jadi urutannya bukan lagi infra,
coordinator, solver, indexer secara berurutan penuh, melainkan **satu jalur tipis yang
menyala dari ujung ke ujung dulu, baru dipertebal**.

Yang tidak berubah, dan tidak boleh berubah karena tekanan waktu, ada tiga. Aturan
tanpa mock di permukaan produk, gerbang nol selisih pada baseline, dan kedalaman
verifikasi. Ketiganya ada di `CLAUDE.md` §2 nomor 2 dan nomor 9.

---

## 1. Yang sudah ada, jangan dibangun ulang

| Sudah ada | Di mana | Artinya buat kamu |
|---|---|---|
| Seluruh kontrak inti | `contracts/src/` | Tinggal dipanggil. Jangan salin logikanya, baca saja |
| ABI ter-generate | `packages/shared/abi/` | Sumber tunggal. Jangan tulis ABI tangan |
| Alamat dan konstanta | `packages/shared/addresses.ts` | Impor dari sini |
| Mirror tipe Solidity | `packages/shared/types.ts` | `Intent`, `Solution`, enum sesi, bitmask |
| Deploy testnet 46630 | `contracts/deployments/46630.json` | Settlement, oracle, adapter, registry, semua hidup |
| Umpan testnet | `contracts/deployments/46630-fixtures.json` | Lima token uji dan lima pool |
| Skrip deploy dan bootstrap | `contracts/script/` | Dipakai ulang untuk deploy ke fork lokal |
| Fork test baseline | `contracts/test/fork/BaselineVectorsFork.t.sol` | Vektor pembanding kalkulatormu |
| Dua belas kueri Dune | `data/dune-queries/` | Bahan replay dan analitik |
| Kalender NYSE ter-precompute | `data/nyse-calendar/` | Jangan hitung ulang kalender di backend |

**Yang belum ada sama sekali** adalah kelima direktori milikmu,
`packages/shared/api-types.ts`, dan `.github/workflows/backend.yml`.

---

## 2. Tujuh fakta kontrak yang mengikat backend

Bagian ini adalah inti dokumen. Ketujuhnya dibaca langsung dari kode yang ter-deploy,
bukan dari dokumen desain, karena keduanya sempat menyimpang. Setiap satu dari tujuh
ini, kalau salah, menghasilkan revert atau angka salah yang tidak kelihatan.

### 2.1 Tanda tangan pengguna adalah tanda tangan Permit2, bukan tanda tangan Intent

Ini kesalahan nomor satu yang akan kamu buat kalau hanya membaca `interfaces.md` §2.
`Settlement._pull` memanggil `permit2.permitWitnessTransferFrom`, jadi yang
ditandatangani pengguna adalah **struct Permit2 dengan Intent sebagai witness**, bukan
struct Intent sendirian.

Sumber: `contracts/src/Settlement.sol` baris 398, dan
`contracts/src/libraries/Permit2Witness.sol`.

Yang harus dirakit di coordinator dan di frontend Nabil, persis begini:

```
domain     = Permit2 EIP-712 domain, verifyingContract = 0x000000000022D473030F116dDEE9F6B43aC78BA3
typeString = Settlement.WITNESS_TYPE_STRING   // baca dari kontrak, jangan hardcode
witness    = IntentLib.hash(intent)           // typehash Intent + 14 field, urutan tetap
permitted  = { token: intent.sellToken, amount: intent.sellAmount }
spender    = alamat Settlement                // Permit2 mengikat ke msg.sender-nya
nonce      = intent.nonce
deadline   = intent.validUntil
```

`WITNESS_TYPE_STRING` dan `INTENT_TYPEHASH` dibaca dari kontrak lewat `eth_call` saat
boot, lalu di-cache. Menyalinnya ke konstanta TypeScript adalah definisi ganda, dan
definisi ganda adalah sumber bug paling mahal di proyek tiga orang.

Verifikasi offchain sebelum menerima intent, jangan menunggu revert. Rekonstruksi
digest, `recoverAddress`, bandingkan dengan `intent.owner`. Untuk intent bertanda
`AGENT_SIGNED`, pemiliknya adalah `MandateAccount` dan verifikasinya lewat EIP-1271
`isValidSignature`, bukan ecrecover.

### 2.2 `batchId` adalah timestamp, bukan penghitung

Sumber: `contracts/src/Settlement.sol` baris 182.

```
duration     = SessionManager.batchDuration(SessionManager.sessionAt(batchId))
syarat       = batchId % duration == 0
syarat       = SessionManager.inGuardBand(batchId) == false
collectStart = batchId - duration
collectEnd   = batchId
solveEnd     = batchId + 10
```

Empat akibat yang harus masuk ke scheduler.

1. `batchDuration` mengembalikan **0** untuk `AUCTION_OPEN` dan `AUCTION_CLOSE`, dan
   `batchWindow` revert dengan `BatchMisaligned` kalau durasinya nol. Selama dua fase
   itu tidak ada batch biasa sama sekali, arusnya pindah ke `AuctionHouse`.
2. Durasinya berubah per sesi, yaitu 10, 30, 45, 60, 120, dan 180 detik. Jadi
   kelipatan yang sah ikut berubah saat sesi berganti.
3. `inGuardBand` benar dalam 60 detik di kedua sisi batas sesi, jadi ada lubang
   berdurasi 120 detik di setiap pergantian sesi yang **tidak punya batch**. Ini bukan
   bug, ini penyerap drift sequencer. Coordinator menahan intent, bukan menolaknya.
4. **Jendela solusi hanya 10 detik.** `SOLUTION_WINDOW = 10`. Solver tidak punya waktu
   untuk mulai berpikir setelah batch tutup. Dia menghitung sepanjang jendela
   pengumpulan, menyimpan solusi kandidat, dan di detik penutupan hanya memperbarui
   harga oracle serta baseline lalu mengirim.

Setelah `solveEnd` ada `FINALIZE_DEADLINE = 300` detik. Lewat itu siapa pun boleh
memanggil `expireBatch` dan pemenang yang tidak memfinalisasi **kena slash**. Jadi
`finalize` adalah kewajiban solver, bukan pilihan.

### 2.3 Satuan harga adalah USD per satuan terkecil token

Sumber: `contracts/src/types/Types.sol` pada field `Solution.prices`, dan
`parameter.md` §4C.

| Token | Desimal | Harga pasar | Nilai di `prices[]` |
|---|---|---|---|
| USDG | 6 | 1 USD | `1e30` |
| NVDA | 18 | 200 USD | `200e18` |

Ini bukan soal gaya penulisan. `parameter.md` §4C.1 mencatat bahwa dengan konvensi per
token utuh, satu batch USDG lawan NVDA akan ditolak `NonUniformPrice`, dan pasangan
paling umum di chain ini tidak bisa kliring sama sekali. `Settlement` menormalkan harga
oracle di batasnya sendiri, jadi solver wajib memakai konvensi yang sama atau band
check membandingkan dua satuan berbeda.

Rumus konversinya, dari `refPrice` yang 1e18 per token utuh:

```
priceOnSurface = refPrice * 1e18 / 10**decimals(token)
```

### 2.4 `baselineQuotes` punya dua pemeriksaan, dan keduanya berlawanan arah

Sumber: `contracts/src/ClearingVerifier.sol` baris 113, dan
`contracts/src/Settlement.sol` baris 340.

| Pemeriksaan | Bentuk | Gagal jadi apa |
|---|---|---|
| Per eksekusi | `executedBuy >= baselineQuotes[k]` | `WorseThanBaseline` |
| Per arah pasangan | `Σ baselineQuotes arah itu >= quoteFromState(sell, buy, Σ executedSell arah itu)` | `BaselineBelowVenue` |

Yang pertama melarang baseline yang **dilebihkan**, yang kedua melarang baseline yang
**dikurangi**. Solver terjepit di antara keduanya, dan itu memang tujuannya.

Cara mengisinya yang selalu lolos keduanya, yaitu kuotasi **per intent** atas
`executedSell` masing-masing. Kuotasi pool cekung terhadap ukuran, jadi jumlah kuotasi
per intent selalu lebih besar atau sama dengan kuotasi atas totalnya, sehingga lantai
agregat otomatis terpenuhi. Yang gagal adalah mengisinya dari harga rata-rata atau
dari TWAP.

Kalau `quoteFromState` revert untuk **satu arah saja**, `_baselineFloor` mengembalikan
`priced == false` dan `savings` dipaksa **nol untuk seluruh batch**. Maka
`claimedSavings` juga wajib nol, atau `submitSolution` revert dengan `SavingsMismatch`.
Solver menyiapkan jalur ini sebagai jalur normal, bukan kasus langka.

### 2.5 `claimedSavings` harus sama sampai satu wei

Sumber: `contracts/src/ClearingVerifier.sol` baris 122.

```
savings = Σ over k of  floor( (executedBuy[k] - baselineQuotes[k]) * prices[buyTokenIndex] / 1e18 )
```

Pembagiannya **per suku, bukan di akhir**. Menjumlahkan dulu lalu membagi sekali
menghasilkan angka yang berbeda beberapa wei, dan `submitSolution` akan revert. Di
TypeScript ini berarti `BigInt` dengan pembagian lantai di dalam loop, bukan di luar.

### 2.6 Konservasi nilai memakai `minOut`, bukan hasil swap sebenarnya

Sumber: `contracts/src/Settlement.sol` baris 656.

```
venueDeltas[tokenIn]  -= call.amountIn
venueDeltas[tokenOut] += call.minOut
```

Jadi kalau solver memasang `minOut` terlalu longgar, konservasi gagal dan solusinya
ditolak. Kalau terlalu ketat, swap-nya sendiri yang revert saat `finalize`. Kelebihan
antara `minOut` dan hasil nyata tertinggal di kontrak sebagai debu, dan debu disapu ke
protokol, tidak pernah ke solver.

`_venueDeltas` juga menolak adapter yang `isQuotable()` bernilai false, jadi tidak ada
rute ke venue yang tidak bisa dijadikan baseline.

### 2.7 Exposure cap dihitung dari notional jual, dan akhir pekan membaginya dua

Sumber: `contracts/src/Settlement.sol` baris 538.

Nilai awalnya `$5.000` per batch, `$50.000` per token per hari, dan `$200.000` global
per hari. `_capScale` membagi **seluruhnya dengan dua** saat `CLOSED_WEEKEND`,
`HOLIDAY`, atau `PROTECTIVE`. Notional dihitung dari sisi jual saja, yaitu
`Σ executedSell * prices[sellToken] / 1e18`.

Artinya batch demo akhir pekan mentok di `$2.500`. Ukuran intent di harness replay
harus dipilih dengan angka itu di kepala, bukan ditemukan saat `finalize` revert di
depan juri.

---

## 3. Temuan infrastruktur, diukur 20 September 2026

Diukur ulang hari ini karena seluruh rencana infra bergantung padanya, dan catatan
17 September menyimpulkan sebaliknya. Perintahnya ada di §5 hari 1 supaya siapa pun
bisa menjalankan ulang.

Endpoint `https://robinhood.drpc.org`, head 67.851.739.

| Yang diuji | Hasil |
|---|---|
| `eth_getStorageAt` di head dikurangi 30 juta blok | **Berhasil.** Blok itu adalah 16 Agustus 2026 |
| `eth_call` dan `eth_getCode` di head dikurangi 25 juta blok | **Berhasil.** 22 Agustus 2026 |
| 30 panggilan paralel | Berhasil semua, tanpa error rate limit |
| `eth_getLogs` dengan `fromBlock` tidak sama dengan `toBlock` | **Ditolak**, termasuk rentang 1.000 blok. Pesannya menyesatkan, menyebut 10.000 |
| `eth_getLogs` satu blok, dan bentuk `blockHash` | Berhasil |
| `eth_getBlockReceipts` | Berhasil |

Tiga akibat langsung.

1. **Blok fork bisa dipatok, dan replay Agustus bisa berjalan di state Agustus.** Ini
   membuat demo netting jauh lebih kuat daripada rencana semula. `ForkFixture.sol` dan
   `pertanyaan-terbuka.md` keduanya masih menulis 20 sampai 40 ribu blok, jadi temuan
   ini perlu masuk ke `pertanyaan-terbuka.md` dan perlu dibicarakan dengan Wangsit
   sebelum dipakai, karena ia menyentuh keputusan yang sudah dia ambil.
2. **Indexer tidak bisa backfill dari endpoint publik lewat rentang log.** Dia menunjuk
   ke anvil lokal, yang melayani rentang dengan normal, atau menyusur blok per blok
   dengan `eth_getBlockReceipts`.
3. **Perilaku endpoint bergerak dalam tiga hari.** Jadi jangan bergantung padanya.
   Patok blok, ambil snapshot `anvil --dump-state`, dan demo berdiri di atas snapshot.

---

## 3B. Uji ketahanan F1, hasil 20 September 2026

Fork yang sudah berdiri diserang dengan skenario terburuk, bukan cuma dipakai.
Enam temuan, semuanya terukur di fork yang berjalan, dan semuanya bisa
direproduksi lewat `make postman-resilience`.

Empat di antaranya menyentuh kode yang belum ditulis, yaitu F9 penjadwal batch
dan F21 siklus hidup solver. Baca ini sebelum menulis keduanya.

### R1. Jam fork tertinggal dari jam laptop, dan selisihnya bertambah

Terukur **11.492 detik**, yaitu 3 jam 11 menit. Sebabnya fork mulai dari
timestamp blok yang dipatok, dan blok itu sendiri sudah berumur 2 jam 47 menit
saat dipatok karena marginnya 100.000 blok. Tiap kali anvil direstart, jam chain
kembali ke timestamp blok itu sementara jam laptop terus jalan, jadi selisihnya
tumbuh.

```
drift = (umur patokan saat ini) - (lama anvil hidup)
```

**Akibatnya.** Kode yang menghitung `batchId` dari `Date.now()` menghasilkan
batch tiga jam di masa depan. `batchWindow` menerimanya tanpa protes, karena ia
hanya memeriksa penyejajaran dan guard band, bukan kedekatan dengan sekarang.
Kegagalannya baru muncul di `submitSolution` sebagai `SolutionWindowClosed`,
dan tidak ada satu pun bagian dari error itu yang menyebut soal jam.

**Aturan yang mengikat.** Ambil waktu dari `block.timestamp` lewat
`eth_getBlockByNumber`, tidak pernah dari `Date.now()`. Berlaku di coordinator,
solver, dan indexer.

### R2. Jendela solusi hanya 10 detik dari tiap 60 detik

Dipetakan detik demi detik. `submitSolution` diterima **hanya** pada offset 1
sampai 10 setelah batas batch. Pada offset 0 dan 11 ke atas ia menolak dengan
`SolutionWindowClosed`.

| Sesi | Durasi batch | Jendela | Duty cycle |
|---|---|---|---|
| CLOSED_WEEKEND | 60 dtk | 10 dtk | 16,7% |
| CLOSED_OVERNIGHT | 45 dtk | 10 dtk | 22,2% |
| PRE_MARKET, POST_MARKET | 30 dtk | 10 dtk | 33,3% |
| OPEN | 10 dtk | 10 dtk | 100%, dan batch bertumpuk |

**Akibatnya.** Solver tidak punya waktu berpikir setelah batch tutup. Dia harus
sudah memegang solusi kandidat sebelum batas, lalu di detik penutupan hanya
menyegarkan harga oracle dan baseline. Kalau perakitan solusi makan lebih dari
10 detik, solver itu tidak akan pernah menang sekali pun.

### R3. Blok yang lambat membuat jendela itu mustahil dicapai

Dengan interval mining 15 detik, offset yang teramati selama 90 detik adalah
**11, 12, 27, 42, dan 57**. Jendela 1 sampai 10 tidak pernah kena sekali pun.
Nol solusi bisa masuk, dan gejalanya terlihat seperti solver rusak.

**Aturannya.** `make fork` memakai `--block-time 1`. Jangan dinaikkan di atas 5
detik tanpa menghitung ulang jendela ini.

### R4. `inGuardBand(now)` bernilai false tidak berarti batch boleh dibuka

Ini jebakan paling halus dari keenamnya.

| Waktu | `inGuardBand(now)` | `batchWindow(batchId sejajar)` |
|---|---|---|
| transisi minus 61 dtk | false | ok |
| transisi minus 60 dtk | **true** | BatchInGuardBand |
| transisi | true | BatchInGuardBand |
| transisi plus 60 dtk | **false** | **BatchInGuardBand** |
| transisi plus 90 dtk | false | ok |

Baris keempat itu masalahnya. Jam dinding sudah keluar dari band, tapi
`batchWindow` tetap menolak, karena yang diperiksanya adalah
`inGuardBand(batchId)`, dan `batchId` yang sejajar jatuh kembali ke dalam band.

**Aturannya.** Uji `inGuardBand(batchId)`, jangan pernah `inGuardBand(now)`.

### R5. Pergantian sesi mengubah durasi batch, dan penyejajaran lama jadi salah

Di batas Senin 04:00 UTC, sesi berpindah dari `CLOSED_WEEKEND` ke
`CLOSED_OVERNIGHT`, dan durasi batch berubah dari **60 ke 45 detik**.

Kelipatan persekutuan terkecil 60 dan 45 adalah **180**. Artinya `batchId` yang
sah di kedua sisi transisi hanyalah kelipatan 180, yaitu **satu dari tiga**.
Coordinator yang menyimpan durasi 60 di memori akan terus mengeluarkan kelipatan
60, dan dua pertiganya revert dengan `BatchMisaligned` setelah transisi.

**Aturannya.** Baca `batchDuration(sessionAt(batchId))` untuk setiap batch, jangan
di-cache melewati batas sesi.

### R6. Lubang tanpa batch di transisi lebih lebar dari 120 detik

Guard band 60 detik di kedua sisi, tapi karena yang diuji adalah `batchId` yang
sejajar, `batchId` pertama yang sah setelah transisi adalah transisi plus 90
detik pada durasi 45. Jadi lubangnya sekitar **150 detik**, bukan 120.

Ini perilaku yang benar, bukan bug. Yang salah adalah memperlakukannya sebagai
gangguan. Coordinator menahan intent selama lubang itu dan membukanya lagi di
batch pertama yang sah.

### Yang diuji dan ternyata tidak rapuh

| Skenario | Hasil |
|---|---|
| Fork di head persis, margin nol | Tetap menyala dan menjawab `slot0` |
| `evm_revert` setelah lompat waktu 17 jam | Mengembalikan jam **dan** sesi dengan benar |
| Transfer token keluar dari pool | `slot0`, `liquidity`, dan kuotasi tidak bergeser sama sekali |
| State pool di fork lawan mainnet asli | **Byte-identik** di blok yang sama |

### Penjaga yang dipasang hari ini

Temuan yang cuma ditulis di dokumen tidak menghentikan siapa pun mengulanginya.
Tiga penjaga dipasang di kode, dan masing-masing menutup temuan tertentu.

| Penjaga | Menutup | Bentuknya |
|---|---|---|
| `packages/shared/batch.ts` | R1, R4, R5, dan durasi nol di fase lelang | Satu satunya jalan sah menghitung `batchId`. `nextValidBatchId` untuk coordinator, `solvableBatchId` untuk solver |
| `make check-batch` | ketiganya, sebagai gerbang | Uji diferensial lawan `batchWindow` di rantai, 41 pemeriksaan, dua arah |
| `fork.sh` menolak block time di atas 5 detik | R3 | Mati dengan pesan yang menyebut jendela 10 detik |
| Baris `clock drift` di `make status` | R1, sebagai diagnosis | Menyebut selisihnya dan menyuruh pakai `block.timestamp` |

**Aturan yang mengikat sejak sekarang.** Jangan pernah menghitung `batchId` dengan
tangan di `api/`, `solver/`, maupun `indexer/`. Panggil helper itu. Kalau ketemu
jebakan ketujuh, memperbaikinya cukup di satu tempat, bukan tiga.

Uji diferensialnya memeriksa **dua arah**, bukan satu. Tiap `batchId` yang
diberikan helper wajib diterima kontrak, **dan** tidak boleh ada `batchId` sah di
antara waktu yang ditanya dan yang diberikan. Tanpa arah kedua, helper yang
terlalu penakut akan lolos uji sambil melewatkan batch yang sebenarnya bisa
dipakai.

Cakupannya tujuh sesi dan empat durasi, yaitu `CLOSED_WEEKEND` 60 detik,
`CLOSED_OVERNIGHT` 45, `PRE_MARKET` dan `POST_MARKET` 30, `OPEN` 10, serta kedua
fase lelang yang durasinya nol dan dilompati ke transisi berikutnya.

### Cara menjalankan ulang semuanya

```bash
make check-batch        # 41 pemeriksaan helper lawan rantai
make postman            # regenerate kedua koleksi
make postman-resilience # 15 permintaan, 33 assertion
```

Koleksi itu mengambil snapshot di awal dan mengembalikannya di akhir. Kalau
jalannya terputus di tengah, jalankan `make revert` sebelum mempercayai apa pun
yang dikatakan fork.

---

## 3C. Akun bawaan anvil tidak bisa dipakai di chain ini

Ditemukan 20 September 2026 saat membuktikan digest witness Permit2, dan ini
jenis jebakan yang bisa memakan satu hari penuh.

**Kesepuluh akun bawaan anvil punya kode di mainnet 4663.** Dua puluh tiga byte,
diawali `0xef0100`, yaitu penanda delegasi EIP-7702. Semuanya menunjuk ke kontrak
yang sama, `0x8a5b10eb2faf57665f63709ec4b3943a3b005df6`.

Ini masuk akal begitu dilihat. Kunci privat akun bawaan anvil dipublikasikan di
tiap startup, jadi siapa pun bisa memasang delegasi 7702 di atasnya, dan di chain
yang punya 7702 aktif seseorang memang sudah melakukannya.

**Bukan artefak fork.** Diperiksa langsung ke `robinhood.drpc.org`, bukan cuma ke
anvil.

### Kenapa ini mematikan

`SignatureVerification.verify` di Permit2 bercabang pada `claimedSigner.code.length`.
Nol berarti jalur ECDSA. Bukan nol berarti jalur EIP-1271, dan Permit2 memanggil
`isValidSignature` ke akun itu.

Kontrak delegasi di atas tidak punya fungsi itu, jadi panggilannya revert **tanpa
data**. Bukan `InvalidSigner`, bukan `InvalidNonce`, bukan pesan apa pun. Cuma
`0x`.

Gejalanya menyesatkan sempurna. Tanda tangan benar, digest benar, allowance ada,
saldo ada, selector ada di bytecode, calldata ter-decode balik dengan sempurna.
Satu satunya cara menemukannya adalah membaca trace eksekusi.

### Yang berubah

Fork sekarang memakai mnemonic proyek sendiri, bukan bawaan anvil, dan
`infra/accounts.json` mencatat sepuluh alamat turunannya. Ketika dipilih,
kesepuluhnya diperiksa ke mainnet asli dan semuanya nol byte.

`make fund` memeriksa ulang setiap kali dijalankan dan **gagal** kalau salah satu
akun demo punya kode, dengan pesan yang menyebut `0xef0100`. Delegasi baru bisa
muncul kapan saja, jadi ini pemeriksaan berulang, bukan sekali.

### Aturan yang mengikat

Jangan pernah memakai alamat yang kunci privatnya publik sebagai penanda tangan
di chain ini. Itu termasuk akun bawaan anvil, akun bawaan hardhat, dan alamat
contoh mana pun yang beredar di internet.

Dan lebih umum, **sebuah akun yang punya kode bukan EOA**. Harness replay nanti
menyentuh masalah yang sama kalau alamat yang diambil dari arus Agustus ternyata
sudah terdelegasi, jadi periksa sebelum menandatangani, bukan sesudah revert.

### Cara menjalankan ulang buktinya

```bash
make check-permit2
```

Tiga pemeriksaan. Permit2 menerima tanda tangan yang dibangun dari digest kita,
token benar benar berpindah, dan pemanggil lain tidak bisa memakai tanda tangan
yang sama karena Permit2 mengikatnya ke `msg.sender`.

Buktinya lewat Permit2 yang ter-deploy, bukan lewat pemulihan tanda tangan lokal.
Pemulihan lokal selalu sepakat dengan enkoding lokal yang menghasilkannya, jadi
ia tidak membuktikan apa pun tentang kecocokan dengan rantai.

---

## 3D. Uji ketahanan fork, hasil 21 September 2026

§3B menguji jam dan kalender. Bagian ini menguji infrastruktur di bawahnya,
karena fork adalah fondasi yang menopang coordinator, solver, indexer, dan
seluruh layar. Enam pertanyaan, dan semuanya bisa dijalankan ulang lewat
`make check-fork`.

### D1. Apakah blok patokan masih hidup di hari submission

| | |
|---|---|
| Head saat diukur | 68.103.430 |
| Blok patokan | 67.798.044 |
| Kedalaman | 305.386 blok |
| Laju blok **terukur** | 10,00 blok per detik, yaitu 100 ms |
| Kedalaman di tenggat 1 Oktober | sekitar 9,77 juta blok |
| Lantai arsip terukur | 30 juta blok |
| **Margin** | **3,1 kali** |

Patokan itu tetap terlayani sehari setelah dipasang, dan proyeksinya bertahan
melewati tenggat dengan margin tiga kali. Laju blok diukur langsung, bukan
diambil dari angka 100 ms di dokumen, karena seluruh proyeksi itu adalah
pembagian terhadapnya.

Kalau margin ini turun di bawah dua, `check-fork` memberi peringatan dan
patokan perlu digeser lebih dekat ke hari H.

### D2. Apakah tiga laptop dan tiap restart mendapat alamat yang sama

**Ya, secara konstruksi.** Kesembilan alamat kontrak adalah keluaran
`CREATE(deployer, nonce)` persis, dari nonce 0 sampai 8.

Satu satunya hal yang bisa merusaknya adalah deployer yang pernah mengirim
transaksi di mainnet asli, karena nonce awalnya tidak lagi nol. Ketujuh akun
demo diperiksa dan **semuanya nonce 0**.

Artinya koleksi Postman, konfigurasi Nabil, dan alamat di catatan mana pun tetap
sah setelah restart. Ini properti yang dulu saya kira perlu dipercaya, ternyata
bisa dibuktikan.

### D3. Seberapa banyak yang sudah dijawab tanpa menyentuh upstream

Setelah `make prewarm`, **keenam bacaan demo dijawab dari memori**, 2 sampai 6
milidetik. Tanpa prewarm, tiga di antaranya masih keluar ke drpc dan memakan 80
sampai 95 milidetik.

🔴 **Klaim yang saya cabut.** Saya sempat menyimpulkan ini membuktikan demo
selamat kalau drpc mati. **Tidak terbukti.** Upaya mensimulasikan outage lewat
`anvil_setRpcUrl` ke port mati **tidak bekerja**. Anvil menerima panggilannya,
tapi tetap mengembalikan bytecode lengkap dan benar untuk dua kontrak yang belum
pernah dibaca sama sekali, yaitu ArcusSettlement dan RobinHoodSettler. Jadi
backend fork menyimpan koneksinya sendiri dan panggilan itu tidak memutus apa
pun.

Yang terukur adalah kehangatan cache, dan itu **proksi**, bukan bukti. Uji
jujurnya adalah mencabut jaringan mesin lalu menjalankan `make check-fork` lagi.

### D4. Apakah fork tahan beban seluruh tumpukan sekaligus

120 bacaan paralel selesai dalam 77 milidetik, yaitu sekitar **1.565 bacaan per
detik**, nol yang jatuh. Empat puluh permintaan API bersamaan, nol yang gagal.

Coordinator, solver, indexer, dan frontend bersama sama tidak akan mendekati
angka itu, jadi beban bukan risiko.

### D5. Apakah tumpukan selamat melewati batas sesi tanpa restart

Diuji hidup, dengan API berjalan, melintasi batas Senin 04:00 UTC di lima titik.
Durasi batch benar benar berubah dari **60 ke 45 detik**, dan API tetap menjawab
`batchId` yang sejajar di kedua sisi tanpa disentuh.

Ini yang membuktikan helper di `packages/shared/batch.ts` bekerja di jalur hidup,
bukan cuma di uji diferensial.

### D6. Berapa ongkos sebuah restart

Yang **bertahan** adalah alamat, karena D2. Yang **hilang** adalah saldo token,
approve Permit2, bond solver, dan seluruh id snapshot.

Pemulihannya tiga perintah, yaitu `make deploy`, `make fund`, `make postman`.

⚠️ Tapi jangan restart di tengah demo. Cache fork ikut dingin, dan bacaan pertama
tiap pool kembali memakan ratusan milidetik.

### Aturan yang lahir dari enam uji ini

1. **Jalankan `make prewarm` sebelum demo.** Tanpa itu tiga dari enam bacaan
   masih keluar ke jaringan.
2. **Jangan matikan anvil selama demo.** Alamat memang kembali, tapi cache tidak.
3. **Jalankan `make check-fork` sebelum submission.** D1 akan memberi tahu kalau
   patokan sudah terlalu dalam.
4. **Jangan percaya klaim selamat dari outage sampai diuji tanpa jaringan.**

---

## 3E. Integrasi dengan kerjaan Wangsit, 21 September 2026

Backend sudah memanggil kontraknya sejak hari pertama. Yang belum ada adalah
berhenti menduplikasi apa yang sudah dia terbitkan, dan memeriksa bahwa keduanya
tidak berpisah diam diam.

### Yang saya langgar sendiri, dan sudah diperbaiki

`api/src/chain.ts` memuat **empat puluh fragmen ABI tulisan tangan**. Aturannya
sudah tertulis di `CLAUDE.md` dan di skill saya sendiri, yaitu ABI digenerate
`forge build` dan tidak pernah ditulis tangan.

Akibatnya terukur. Fragmen itu menutupi 11 dari 36 fungsi `Settlement`, dan 6
dari 8 error `UniswapV3Adapter`. Dua error yang terlewat, `NotGovernor` dan
`SafeERC20FailedOperation`, akan kembali sebagai selector telanjang tanpa nama.

Sekarang semuanya dari `packages/shared/abi`, dibaca saat boot lewat
`api/src/abi.ts`. Dua pengecualian tersisa dan keduanya sah. ERC20 bukan kontrak
milik protokol ini sehingga tidak ada di `src`, dan `invalidateUnorderedNonces`
nyata di Permit2 yang ter-deploy tapi tidak dideklarasikan `IPermit2.sol`, karena
`Settlement` memang tidak pernah memanggilnya.

### Dua pemeriksaan lintas bagian yang baru

**D7, `addresses.ts` lawan `Addresses.sol`.** Kontrak adalah sumbernya,
`addresses.ts` salinan terbitan, dan salinan tanpa pemeriksaan akan menyimpang.
Ia sudah menyimpang. Terdeteksi sekarang, yaitu **token dan pool GME hilang**
dari `addresses.ts`.

Berkas itu milik Wangsit, jadi pemeriksanya memberi peringatan dan menyebut
namanya, bukan menyuntingnya sendiri.

**D8, ABI lawan bytecode yang ter-deploy.** Tiap selector yang dideklarasikan ABI
harus ada di runtime code kontraknya. Sembilan puluh enam selector diperiksa di
lima kontrak, semuanya hadir.

Ini gerbang yang menangkap ABI basi, yaitu kegagalan yang menghasilkan selector
telanjang alih alih revert bernama, dan tidak ada yang merah saat itu terjadi.

⚠️ Uji pertamanya menuduh `Settlement` kehilangan tiga selector, dan itu **bug di
pemeriksanya**, bukan drift. Argumen bertipe tuple bukan string `"tuple"` di
dalam selector, melainkan daftar komponennya sendiri. Diperbaiki, lalu ketiganya
hadir.

### CI

`.github/workflows/backend.yml` dibelah seperti `contracts.yml`. Yang tidak butuh
rantai berjalan di tiap pull request, yaitu typecheck dan keberadaan ketujuh ABI
yang dibaca API. Yang butuh fork berjalan tiap malam, yaitu `check-batch`,
`check-permit2`, `check-fork`, dan ketiga koleksi Postman.

Alasan pembelahannya sama dengan alasan Wangsit, yaitu endpoint publik sudah
pernah berubah perilaku dalam tiga hari, dan endpoint yang rewel tidak boleh
memblokir merge.

### Yang perlu disampaikan ke Wangsit

1. `packages/shared/addresses.ts` kehilangan GME, token dan pool. D7 akan terus
   memberi peringatan sampai diperbarui.
2. `docs/interfaces.md` §3 mendaftarkan `invalidateNonce` di `ISettlement`, dan
   kontraknya tidak punya. Pembatalan sesungguhnya lewat
   `Permit2.invalidateUnorderedNonces`, persis seperti yang ditulis komentar di
   `IPermit2.sol`.
3. `contracts/tools/export-abi.sh` butuh `jq`, yang tidak ada di laptop saya.
   Bukan penghalang, tapi berarti saya tidak bisa meregenerate ABI sendiri.

---

## 4. Daftar fitur yang harus dibangun

Tiga puluh dua butir, dikelompokkan per direktori. Kolom selesai kalau adalah definisi
selesainya, dan tidak ada butir yang dianggap selesai tanpa itu.

### 4.1 `infra/`, enam butir

| # | Fitur | Selesai kalau |
|---|---|---|
| F1 | Fork mainnet 4663 di blok yang dipatok, lewat anvil | `make fork` menyala di laptop ketiganya dengan satu perintah, dan bloknya sama di ketiganya |
| F2 | Snapshot state, `--dump-state` setelah prewarming pool, token, feed, dan Permit2 | Fork bisa jalan tanpa endpoint hidup, dibuktikan dengan mematikan jaringan. **Diganti 28 September 2026, diputuskan Dharu.** Anvil tidak bisa memenuhinya, karena `--dump-state` tidak menyimpan slot yang diambil lazily, sehingga fork yang dimuat ulang menjawab `slot0` lalu nol untuk likuiditas (diukur 20 September 2026). Penggantinya `make snapshot` dan `make revert` di atas fork yang hidup, ditambah RPC archive di `NOKTURN_RPC_MAINNET`. Fork tetap butuh endpoint saat pertama menyala |
| F3 | Impersonation dan pendanaan akun uji dari pemegang nyata | Lima akun lokal memegang NVDA, AAPL, TSLA, GOOGL, GME, dan USDG dalam jumlah yang muat di exposure cap |
| F4 | Deploy Nokturn ke fork lokal lewat skrip Wangsit | `deployments/31337.json` terisi dan `Bootstrap` lolos gerbang `StockTokenGate` terhadap token mainnet asli |
| F5 | `docker-compose` untuk anvil, postgres, coordinator, indexer, dua solver | `make up` lalu `make demo` menghasilkan satu struk batch tanpa langkah manual. **Selesai 28 September 2026.** Tujuh service, urutannya dijaga `service_healthy` dan `service_completed_successfully`, tanpa satu pun tidur. `make demo` menghasilkan batch 1789893480 settled, netting 100 persen, savings 150145992818052994, dan perintah `cast` di struknya dijalankan ulang dengan hasil sama persis. Tiga hal yang menggigit dan sudah diperbaiki, yaitu `data/` tidak ter-mount ke container `deploy` sehingga `Bootstrap` tidak bisa membaca kalender NYSE, `data/backtest` tidak ikut ke image api sehingga route F30 gagal saat boot, dan `NOKTURN_SOLVER_STATE=/state` membuat profil b menulis ke `/state-b` di root image |
| F6 | Lapisan RPC dengan retry, failover, dan anggaran permintaan | Satu endpoint mati tidak menjatuhkan coordinator, dan lognya menyebut endpoint mana yang dipakai. **Selesai 29 September 2026.** `NOKTURN_API_RPC` menerima beberapa URL dipisah koma, dan yang pertama utama. Diuji dengan endpoint utama mati di `127.0.0.1:9`. API tetap start, dilayani anvil sebagai cadangan, log menyebut host yang melayani, dan health melapor rpc `degraded`. Anggaran per menit hanya memperingatkan, tidak menolak. Perintah `cast` di struk kini memakai `NOKTURN_API_PUBLIC_RPC`, dan API menolak start kalau URL baca membawa path tanpa URL publik, karena path itu adalah key |

Catatan F1. Fork memakai `--fork-block-number` dengan nomor blok **chain ini**, bukan
`block.number`. Di Arbitrum `block.number` mengembalikan nomor blok chain induk, dan
selisihnya puluhan juta. Ambil dari `eth_blockNumber` atau dari precompile `ArbSys` di
`0x...64`. Kesalahan ini pernah membuat seluruh fork test membaca state 2 Agustus
selama enam minggu, tercatat di `ForkFixture.sol`.

### 4.2 `api/`, delapan butir

| # | Fitur | Selesai kalau |
|---|---|---|
| F7 | Penerimaan intent dan verifikasi tanda tangan Permit2 witness | Tanda tangan palsu ditolak di API, bukan di revert kontrak. Jalur EIP-1271 untuk `MandateAccount` ikut diuji |
| F8 | Validasi pra-terbang yang mencerminkan pemeriksaan kontrak | Semua penolakan §2 keluar sebagai error API yang bisa dibaca, memakai nama error kontrak yang sama |
| F9 | Penjadwal batch, penyelarasan `batchId`, penanganan guard band dan fase lelang | Batch terbuka dan tertutup sendiri melintasi pergantian sesi, dan tidak ada batch yang lahir di guard band. Terpasang 22 September 2026, grup torture `f9` lulus sepuluh dari sepuluh |
| F10 | Umpan solver, REST dan WebSocket | Dua solver menerima isi batch yang sama pada detik yang sama. Terpasang 22 September 2026, grup torture `f10` lulus sepuluh dari sepuluh, dengan selisih terima `collect_closed` antara dua klien 0 ms |
| F11 | API struk batch, disajikan dari indexer | Nabil bisa merender layar utama dan layar gagal sepenuhnya dari API. **Selesai 25 September 2026.** `GET /v1/batches` dan `GET /v1/batches/:batchId` nyata. Struk `settled` (M2), `passthrough` (I6), dan `expired` (I7) semuanya lahir dari chain. Database mati berarti 503 `COORDINATOR_UPSTREAM_DOWN` di dua rute itu, sementara health tetap 200 (I4). `postman-api` 105 dari 105 |
| F12 | API baca sesi dan allowlist untuk frontend | Layar sesi dan layar gerbang allowlist tidak memanggil chain sendiri |
| F13 | `packages/shared/api-types.ts` | Skema dibekukan dan Nabil coding terhadapnya sebelum implementasinya selesai |
| F14 | Jalur kabur anti-sensor, `submitIntentOnchain` | API menerbitkan payload yang bisa dikirim pengguna sendiri kalau coordinator menolaknya |

Catatan F13. **Skema dibekukan lebih dulu dari implementasinya.** Ini yang membuat
Nabil tidak menganggur. Keterlambatan implementasi coordinator hanya boleh menunda
datanya, tidak boleh menunda bentuknya.

Catatan F14. Mempool tunggal adalah titik sentralisasi, dan `spek-teknis.md` §9.3 sudah
memutuskan untuk mengakuinya terbuka. F14 adalah wujud teknis dari pengakuan itu, jadi
ia bukan fitur opsional.

### 4.3 `solver/`, sembilan butir

| # | Fitur | Selesai kalau |
|---|---|---|
| F15 | Klien baseline, kuotasi per intent ke `UniswapV3Adapter` | Nol selisih terhadap `quoteFromState` di blok yang sama, dibuktikan ulang tiap PR. Terpasang 22 September 2026, 40 dari 40 kuotasi sama persis di blok fork 67798434. Belum tiap PR, karena test fork solver belum masuk CI |
| F16 | Pencarian harga kliring per pasangan | Hierarki `desain-kliring.md` §2 dipatuhi, yaitu maksimalkan volume, lalu minimalkan imbalance, lalu terdekat ke referensi. Terpasang 22 September 2026, `volumeAt` sama dengan `evaluateVolume` di 200 harga |
| F17 | Penjatahan pro-rata dengan prioritas harga, pembulatan ke bawah | Uji properti membuktikan jumlah yang diterima tidak pernah melampaui yang tersedia. Terpasang 22 September 2026, lulus di 500 buku acak dengan seed tetap |
| F18 | Netting internal dan perutean sisa jadi `VenueCall` | Batch dengan dua sisi berlawanan menghasilkan nol `venueCalls`. Terpasang 22 September 2026, lulus di 500 buku acak dan di skenario netted pada fork |
| F19 | Perakitan `Solution` dan penghitungan ulang `savings` | Angka solver sama persis dengan keluaran `ClearingVerifier.verify`. Terpasang 22 September 2026, 10 dari 10 solusi sama sampai satu wei |
| F20 | Simulasi kering lewat `eth_call` ke `submitSolution` sebelum mengirim | Tidak ada transaksi terkirim yang akan revert. Terpasang 22 September 2026, simulasi kering lolos untuk routed dan netted, 35 sampai 71 ms dari tutup collect. Pengiriman belum ada, itu F21 |
| F21 | Siklus hidup kirim dan finalisasi, jendela 10 detik dan tenggat 300 detik | **Selesai 23 September 2026.** Run satu jam, 60 batch diproses, 60 `finalized`, nol `abandoned`, nol `finalize_reverted`. Diverifikasi dari chain (`f21-check.mjs`, bukan ringkasan solver): 60 `SolutionSubmitted`, 60 `BatchSettled`, nol batch menang yang belum final lewat tenggat. Latensi collect-tutup ke receipt submit p50 907 ms, p99 1150 ms (run 10 menit) dan p99 8260 ms (run satu jam, satu batch tertunda karena kontensi RPC lokal, tetap sebelum tenggat) |
| F22 | Operasi bonding, 500 USDG di `SolverRegistry` | **Selesai 23 September 2026.** `solver/src/preflight.ts`. `isActive` benar untuk solverA dan solverB, keduanya bond 500 USDG. Akun yang tidak di-bond ditolak dengan pesan yang menyebut `make fund` |
| F23 | Profil solver kedua untuk demo kompetisi | Dua solver mengajukan, yang savings-nya lebih tinggi menang, keduanya terbit di event. **Dijalankan di fork 28 September 2026 di atas stack compose,** dan terbukti dari chain, bukan dari log solver. Batch 1789893480 memuat dua `SolutionSubmitted` di blok 67798418 dari dua alamat berbeda, yaitu solverB `0xa153d1d2` di `logIndex` 0 dan solverA `0x86d9065c` di `logIndex` 1. SolverA menang dengan savings 150145992818052994, solverB ditolak dengan alasan replaced by a better solution, dan hanya ada satu `SolverScoreUpdated` di seluruh rentang blok itu, untuk solverA. Struk `receipt-demo.json` memuat keduanya di `solutions[]`. `--profile a` adalah solverA yang men-netting dulu. `--profile b` adalah solverB yang merutekan setiap arah dari setiap pasangan ke venue, dengan store sendiri. `make demo-compete` dan `solver/test/fork/compete.test.ts` tertulis, dan penolakan "not the best" hanya diperiksa kalau yang kalah datang belakangan (N16) |

Catatan F15, dan ini rekomendasi yang perlu persetujuan tim karena menyentuh titik
sinkronisasi 4 di `pembagian-tugas.md`. **Jalur produksi sebaiknya memanggil
`quoteFromState` lewat `eth_call`, bukan mengimplementasikan ulang matematikanya di
TypeScript.** Alasannya sederhana. Gerbangnya menuntut nol selisih, dan memanggil
kontrak yang sama membuat selisihnya nol secara konstruksi, bukan lewat pengujian.
Implementasi ulang justru menciptakan persis risiko yang aturan itu hendak cegah, dan
`desain-baseline.md` §9.1 sudah mendaftar lima jebakan yang menggigit, termasuk tanda
negatif pada `amountRemaining` yang **tidak akan revert** kalau salah.

Port TypeScript tetap berguna untuk replay offline dan analitik, di mana memanggil node
untuk tiap kuotasi terlalu lambat. Kalau sempat, port itu dikerjakan **setelah** jalur
produksi hidup, dan gerbang differential berlaku penuh atas port itu.

### 4.4 `indexer/`, lima butir

| # | Fitur | Selesai kalau |
|---|---|---|
| F24 | Konsumsi event, keberhasilan dan **kegagalan** | `SolutionRejected`, `BatchPassthrough`, `ClosingPrintWithheld`, `AuctionAborted`, `CommitmentDropped`, `OracleStale`, `OracleDisagreement` semuanya masuk tabel. **Selesai 25 September 2026.** Semua event itu, ditambah `IntentCollectionFailed`, ter-decode di unit test dari ABI asli. Di fork, I6 mengisi `collection_failures` dan I7 mengisi `SolverSlashed` di `solvers`. Satu keterbatasan tertulis di `project.ts`. `SolutionRejected("savings mismatch")` terbit lalu langsung di-revert, jadi tidak pernah sampai ke chain dan tidak pernah muncul di struk |
| F25 | Skema tabel sesuai `interfaces.md` §10 | Sembilan tabel terisi dari event, tidak ada kolom yang diisi tebakan. **Selesai 25 September 2026.** `indexer/sql/001_init.sql` memuat sembilan tabel §10 dan tiga tabel pendukung. Semuanya membawa `chain_id`, `block_number`, `tx_hash`, dan `log_index`. Nilai uint256 disimpan sebagai `numeric(78,0)`. I1 menghitung 143 log, sama persis dengan `getLogs` langsung ke anvil |
| F26 | Kolom provenansi di setiap baris struk | Chain id, nomor blok chain ini, hash transaksi, log index, alamat pool, dan payload `eth_call` untuk menghitung ulang baseline. **Selesai 25 September 2026.** Di M2, tiga dari tiga `castCommand` dijalankan lewat `cast` dan hasilnya sama persis dengan `baselineBuy`. Di I8, tiga fill dihitung ulang dengan `quoteFromState`, dan selisihnya nol |
| F27 | Metrik turunan | `savings_bps`, `netting_ratio`, `improvement_vs_venue`, `uptime`, dihitung dari event dan bukan dari klaim solver. **Selesai 25 September 2026.** `indexer/src/metrics.ts`, keempatnya dihitung dari tabel dan diuji terhadap contoh yang dihitung tangan. `uptime` versi ini tidak menghitung batch kosong, dan alasannya tertulis di kode |
| F28 | Kedalaman konfirmasi dan rekonsiliasi | Angka indexer cocok dengan pembacaan langsung kontrak pada blok yang sama. **Dijalankan di fork 28 September 2026 di atas stack compose,** 19 pemeriksaan, 19 cocok, 0 beda, 0 tidak terbaca, termasuk kedua arah baseline per direction pada blok solusi yang menang. `--confirmations` menolak nol di chain yang bukan fork. `--reconcile` membandingkan hasil batch, pemenang, jumlah fill, total savings, skor kedua solver, allowlist, dan 10 baseline sampel, lalu keluar 1 kalau ada satu saja yang beda. Ambang selisih savings 0 wei, karena kontrak membagi per suku dengan cara yang sama di kedua jalur. SQL-nya sudah diuji ke Postgres sungguhan dengan baris sintetis. I10 sampai I12 tertulis, tapi belum berjalan (N13) |

Catatan F26. Ini yang membuat layar Nabil lolos audit provenansi §11. Tanpa payload
verifikasi yang bisa disalin, tombol salin panggilan verifikasi di `demo.md` §2 tidak
punya isi, dan angkanya jadi angka yang harus dipercaya.

### 4.5 `analytics/`, tiga butir

| # | Fitur | Selesai kalau |
|---|---|---|
| F29 | Ekstraksi arus Agustus 2026 jadi fixture replay | Intent replay lahir dari kueri Dune per trade `data/dune-queries/13-replay-flow-august.sql`, dengan nomor kuerinya tercatat di file keluarannya. `8595251` dan `8595303` menjadi pembanding agregat, bukan sumber trade (N15, diputuskan Dharu 26 September 2026). **Kode selesai 26 September 2026.** Ekstraktor dan harness replay ada, beserta unit test-nya. **Fixture selesai 27 September 2026.** Kueri 13 tersimpan publik sebagai `8846173`. Jam yang terpilih adalah 5 Agustus 2026 00:00 sampai 01:00 UTC, median dari 378 jam off-hours hari kerja, berisi 728 trade dari 78 taker senilai $110.143. Ekspornya `data/replay/query-8846173.csv`, fixture-nya `data/replay/august-2026.json`. Cap dan panjang batch dibaca dari fork. Blok patokan jatuh di hari Minggu, jadi sesi 6 memberi cap batch $2.500 dan batch 60 detik, dan skalanya 0,2539 (N19). Replay penuh dijalankan 28 September 2026 |
| F30 | Kurva netting lawan pangsa, berlabel BACKTEST **di data** | Kolom label ikut di CSV dan di respons API, bukan hanya di narasi UI. **Backend selesai 29 September 2026.** `data/backtest/netting-vs-share-august-2026.json` adalah ekspor eksekusi terakhir kueri `8595303`, tiga sesi dan sepuluh pangsa. `GET /v1/backtest/netting-curve` menaruh `BACKTEST` di setiap baris dan menolak berkas tanpa label. Layar netting Nabil masih menulis kurvanya tetap di kode, dan perlu dipindah ke route ini |
| F31 | Rekonsiliasi setelah demo | Angka yang tampil di layar bisa dilacak balik ke event dan ke kueri, satu per satu. **Bagian backend dijalankan 29 September 2026** sebagai `docs/audit-provenansi-backend.md`. Setiap field struk dan setiap route yang dibaca layar dipetakan ke sumber dan jalur verifikasinya, dengan vonis. `--reconcile` tetap alat untuk angka struk terhadap chain |

### 4.6 CI, satu butir

| # | Fitur | Selesai kalau |
|---|---|---|
| F32 | `.github/workflows/backend.yml` | ✅ Terpasang 21 September 2026. Typecheck dan keberadaan ABI di tiap PR, fork gate tiap malam. Lihat §3E |

Gerbang prosa `tools/prose-gate.py` sudah berjalan global dan akan memindai file `.ts`
milikmu sejak commit pertama. Em dash di komentar kode akan menjatuhkan CI.

---

## 5. Urutan eksekusi, sebelas hari

Prinsip urutannya satu kalimat. **Nyalakan satu jalur tipis dari ujung ke ujung sebelum
menebalkan bagian mana pun.** Satu intent, satu solver, satu batch, satu struk. Baru
setelah itu netting, replay, solver kedua, dan analitik.

### Hari 1, 20 September. Infra dan skema

Ini hari yang memblokir dua orang lain, jadi tidak ada yang lain dikerjakan hari ini.

Langkah 1, verifikasi ulang temuan §3 sendiri. Jangan percaya tabel di atas.

```bash
curl -s -X POST https://robinhood.drpc.org -H "content-type: application/json" --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}"
```

Ambil hasilnya, kurangi 25.000.000, lalu uji apakah state di blok itu terbaca lewat
`eth_call` ke `slot0()` pool NVDA `0xD4EB21209C4D6093f80B5b84f5C45cc093EA14a3` dengan
selektor `0x3850c7bd`. Kalau menjawab angka yang masuk akal, blok bisa dipatok. Kalau
menjawab error historical state, jatuh ke rencana head dikurangi 300 seperti
`ForkFixture.sol`.

Langkah 2, buat `infra/` dan nyalakan fork. Patok bloknya di satu file yang di-commit,
karena nomor blok fork adalah titik sinkronisasi 6 di `pembagian-tugas.md` dan itu
milikmu.

```bash
anvil --fork-url https://robinhood.drpc.org --fork-block-number BLOK --chain-id 4663 --port 8545 --state infra/.anvil-state.json
```

Langkah 3, prewarming. Jalankan satu skrip yang menyentuh kelima pool, kelima token,
feed oracle, dan Permit2, supaya snapshot memuat state yang dipakai. Lalu matikan
anvil, hidupkan lagi dari `--load-state` saja, dan buktikan ia masih menjawab.

Langkah 4, deploy Nokturn ke fork memakai skrip Wangsit. Jangan tulis skrip deploy
sendiri.

Langkah 5, dan ini yang paling penting hari ini, **bekukan skema API**. Tulis
`packages/shared/api-types.ts`, umumkan di standup, kirim ke Nabil. Implementasinya
boleh kosong hari ini. Bentuknya tidak boleh.

Selesai hari 1 kalau `make fork` jalan, alamat Nokturn di fork tercatat, dan Nabil
sudah pegang skema.

### Hari 2, 21 September. Coordinator jalur tipis

F7, F8, F9, F10 dalam bentuk paling sederhana yang bisa berjalan. Penyimpanan boleh di
memori dulu, postgres menyusul.

Yang harus dibuktikan hari ini satu hal. Sebuah intent yang ditandatangani dengan viem,
dengan witness Permit2 yang benar, **lolos verifikasi offchain milikmu dan juga lolos
`permitWitnessTransferFrom` sungguhan di fork**. Buktikan dengan satu skrip kecil yang
memanggil Permit2 langsung, bukan lewat Settlement. Kalau digest-nya salah, kamu ingin
tahu hari ini, bukan hari keenam.

### Hari 3, 22 September. Solver inti

F15 lewat `eth_call`, lalu F16, F17, F18, F19, F20.

Bangun dari belakang. Tulis F19 dan F20 duluan, yaitu perakit `Solution` dan simulasi
kering, lalu isi dengan solusi paling bodoh yang mungkin, yaitu satu intent tanpa
netting dan seluruh volume dirutekan ke venue. Kalau `eth_call` ke `submitSolution`
lolos untuk solusi bodoh itu, seluruh bentuk struktur datamu sudah benar, dan sisanya
tinggal mengganti algoritma di tengah.

Urutan ini penting. Kesalahan yang paling mahal di bagian ini bukan algoritma kliring,
melainkan pengkodean `Solution`, urutan `tokens`, indeks yang tidak cocok, dan satuan
harga di §2.3.

### Hari 4, 23 September. Ujung ke ujung, M1 yang tertunda

F21, F22, lalu jalankan rantainya utuh. Tanda tangan dari skrip, coordinator, solver,
`submitSolution`, `finalize`, dan event `BatchSettled` terbit di fork.

Netting boleh nol hari ini. Itu sudah tertulis di definisi M1.

Selesai hari 4 kalau ada satu hash transaksi `finalize` di fork yang bisa kamu tunjuk.

**Hasil M1, 23 September 2026.** Ini fork mainnet 4663 dengan penanda tangan lokal,
bukan mainnet dan bukan arus asli. Blok patokan fork 67798044, Settlement di
`0xeF70f91c4bF752a197bc454399d8E501Ed5CdCB1`, di-deploy dari `main` `cb5c3a8`.
Dijalankan sekali dengan `node infra/scripts/m1.mjs`, dan semuanya dibaca dari chain,
bukan dari log solver.

| | Netted | Routed |
|---|---|---|
| Batch | 1789893780 | 1789893840 |
| Transaksi `finalize` | `0x7bd4d475addae6a5bbdbbcb1d0876c6cf12536c68e4ee8fd14ef94b41841e041` | `0x1acf4f7602f8c1ed271cc8a474d68b57f719d767cbd8ae3745845ac2b235b4bc` |
| Blok | 67798721 | 67798781 |
| Event | `IntentSettled` dua kali, `BatchSettled` | `VenueRouted`, `BatchPassthrough("savings below threshold")`, `IntentSettled` dua kali, `BatchSettled` |
| Savings | 401534494244194383 (sekitar 0,40 USD) | 0 |

Intent netted. `users[0]` menjual 399999999 unit USDG dan menerima
1811304369852297889 unit NVDA, dengan baseline 1810395396188000690. `users[1]` menjual
1811304369852297889 unit NVDA dan menerima 399999998 unit USDG, dengan baseline
399799166. Saldo keduanya bergeser tepat sebesar `executedSell` dan `executedBuy` di
blok `finalize`, dan nonce Permit2 keduanya berubah dari belum terpakai menjadi
terpakai di blok yang sama. Latensi dari `collect_closed` sampai receipt submit
550 ms untuk netted dan 802 ms untuk routed.

**Temuan untuk indexer.** Batch routed yang tidak menghasilkan savings menerbitkan
`BatchPassthrough` dengan alasan "savings below threshold" **dan** `BatchSettled`
dalam satu transaksi `finalize`, dan kedua intent tetap tereksekusi. Catatan
`ForkDemo` bahwa routed berakhir sebagai passthrough hanya separuh benar. Indexer di
Hari 5 harus memperlakukan `BatchSettled` sebagai penentu, bukan event yang terbit
lebih dulu. Belum dibicarakan dengan Wangsit apakah ini disengaja.

**Kondisi buruk F21, 23 September 2026.** `solver/test/fork/lifecycle.test.ts`, setiap
kasus dijalankan sekali. E5 dan E6 berjalan di dalam `evm_snapshot` dan di-revert.

| ID | Hasil |
|---|---|
| E1 | Lulus. Proses dibunuh setelah receipt submit dengan status tersimpan `best`. Restart memulihkannya dan memfinalisasi batch 1789894080 dengan `BatchSettled`, di transaksi `0xf9edc69e0a24780a4b0961d85b4dec50ac4fc93c315d99c249142742c649cb2d`. Di Windows, SIGKILL tercatat sebagai exit code 1, bukan sinyal |
| E2 | Lulus. solverB memfinalisasi lebih dulu dengan solusi yang dibaca dari calldata submit. solverA mencatat `finalized_by_other` dari `AlreadyFinalized` dan tidak mengirim transaksi apa pun |
| E3 | Lulus. `window_missed` satu detik setelah `solveEnd`. Nonce solverA tetap 9, dan store kosong |
| E4 | **Tidak tuntas.** Percobaan pertama menemukan bug nyata. `untilBlock` menyerah pada satu poll yang gagal, jadi watcher durasi menghentikan layanan dengan nol batch diproses. Diperbaiki di `6d00e3a`, yaitu menyerah setelah 40 kegagalan berturut-turut. Percobaan kedua gagal karena race di harness. Proxy mulai menyuntik error sebelum startup solver selesai, dan `eth_chainId` saat startup membuat solver keluar dengan pesan jelas (exit 1). Tidak ada percobaan ketiga |
| E5 | **W5 terbukti.** Solusi routed 150 USDG ke NVDA, lalu swap 5 USDG searah di pool yang sama di antara submit dan finalize. `finalize` revert `LiquidityExhausted(0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3, 33241480166)` di kedua percobaan, dan statusnya `finalize_reverted`. Batch tetap belum final, jadi di mainnet `expireBatch` akan men-slash solver yang jujur |
| E6 | Perilaku baru sejak `0067794`. `users[1]` memindahkan seluruh NVDA-nya setelah submit. `finalize` **tidak** revert, tapi menerbitkan `IntentCollectionFailed` untuk intent 1 dan `BatchPassthrough("intent could not be collected")`. Solver mencatat `finalized`, tanpa slash |

### Hari 5, 24 September. Indexer dan struk, M2

F24, F25, F26, F27, lalu F11. Target M2 adalah struk yang menampilkan netting dan
selisih baseline, jadi hari ini juga masukkan dua intent berlawanan arah supaya
netting-nya tidak nol.

Indexer menunjuk ke anvil lokal, karena rentang `eth_getLogs` ditolak di endpoint
publik (§3).

**Hasil M2, 23 September 2026.** Fork mainnet 4663 dengan penanda tangan lokal,
bukan mainnet dan bukan arus asli. `solve.ts` menetapkan atau merutekan satu
pasangan sebagai satu kesatuan, tidak pernah campuran, jadi dua intent berlawanan
di satu pasangan saja menghasilkan netting 100% tanpa apa pun yang dirutekan.
Struk M2 karena itu memakai **dua pasangan dalam satu batch**: NVDA (dua intent
berlawanan arah, netted penuh) dan AAPL (satu intent tanpa lawan, dirutekan).

| | |
|---|---|
| Batch | 1789894020 |
| Transaksi `finalize` | `0x40212b8338607774d81a0d3cc6ce707da8ae0af931d16b49e5623fb59abd7455` |
| Blok | 67798959 |
| `nettingRatioBps` | 7894 (78,94%, di antara 0 dan 10000 sesuai syarat) |
| `nettedVolumeUsd` / `routedVolumeUsd` | 299854453656046388304 / 79993823200000000000 |
| `totalSavingsUsd` | 150145992818052994 |

Tiga belas pemeriksaan lulus, termasuk `totals` sama persis dengan field
`BatchSettled` on-chain, provenansi struk menunjuk ke log `BatchSettled` yang
benar, dan **tiga dari tiga** `verifyBaseline.castCommand` dijalankan sungguhan
lewat `cast` dan hasilnya sama persis dengan `baselineBuy` di event. Struk
disimpan di `infra/.torture/m2-receipt.json` (gitignored) untuk Nabil.

**Diulang 25 September 2026 di fork yang di-deploy ulang.** Alamat Settlement sama,
`0xeF70f91c4bF752a197bc454399d8E501Ed5CdCB1`. Batch 1789897680, `finalize`
`0x6322d630119d8e0c034ee2c86d714725b922061372e27045f8ff80ad78497ce1` di blok
67802589. Angkanya identik dengan run pertama (`nettingRatioBps` 7894, savings
150145992818052994), dan tiga belas pemeriksaan lulus lagi.

**Test fork indexer, 25 September 2026.** `pnpm -C indexer test:fork`, setiap kasus
sekali.

| ID | Hasil |
|---|---|
| I1 | Lulus. 143 log, sama dengan `getLogs` langsung, dan jumlah baris identik setelah rentang diindeks ulang |
| I2 | Lulus. Indexer dibunuh setelah langkah pertama, dijalankan ulang, dan tidak ada lubang atau baris ganda |
| I3 | Lulus. Log dari blok yang di-revert hilang setelah `evm_revert` |
| I4 | Lulus. Database mati 30 detik, enam kali backoff, rute struk 503, health 200, lalu indexer menyusul |
| I5 | Lulus setelah N10 diperbaiki. 20 error disuntikkan, 143 log dari 143, selesai dalam 12 detik |
| I6 | Lulus. Batch 1789898040, solver mencatat `finalized_passthrough`, struk `passthrough` dengan kode `IntentCollectionFailed` dan pemilik `0x14e9...a0ab` disebut |
| I7 | Lulus. Batch 1789897320, `expireBatch` dari akun lain, struk `expired`, slash 50 USDG "failed finalize" tercatat |
| I8 | Lulus. Tiga fill, selisih `verifyBaseline` nol |
| I9 | Dilewati sebagian (N11). Dua batch demo terindeks sebagai `settled`, tapi `fork-demo.sh` tidak menerbitkan event lelang maupun closing print |

Gerbang lain di run yang sama juga hijau. Torture `c3` 9 dari 9, `check-permit2` 3 dari 3,
`check-batch` 41 dari 41, `postman-api` 105 dari 105.

**Temuan baru.**

- **N10, diperbaiki di `88b71b2`.** Satu langkah ingest memanggil `getBlock` sekali
  untuk setiap blok yang memuat log, tanpa retry per panggilan. Dengan error 30 persen,
  peluang satu langkah selesai adalah 0,7 pangkat k, dan I5 tidak mengindeks satu log
  pun selama 51 menit. Sekarang setiap bacaan dicoba empat kali, kecuali penolakan
  rentang `getLogs` yang langsung final.
- **N11, belum ditangani.** `tools/fork-demo.sh` hanya menjalankan satu batch netted
  dan satu batch routed. Tabel `auctions`, `indicative`, dan `closing_prints` belum
  pernah terisi dari event asli. Butuh skrip lelang dari Wangsit, paling lambat
  Hari 7 saat keeper lelang dikerjakan.
- **N12, diamati.** drpc sesekali menjawab "Unknown state. First available state is 1"
  untuk blok patokan, padahal panggilan langsung ke blok yang sama berhasil. `make
  deploy` gagal dua kali lalu berhasil di percobaan ketiga. `make fund` dan satu quote
  di `postman-api` juga sempat gagal sekali saat anvil mengambil state yang belum
  ada di fork. Ini menguatkan alasan membeli RPC berbayar.
- **Catatan lingkungan.** Port 5433 bisa bentrok dengan Postgres proyek lain di
  Docker. `NOKTURN_DB_PORT` dan `NOKTURN_DATABASE_URL` sudah cukup untuk
  memindahkannya. Run ini memakai 5440.

### Hari 6, 25 September. Replay dan batch gagal

F29, lalu harness replay. Dan **F28 ditambah satu skenario wajib**, yaitu batch yang
gagal secara deterministik untuk layar kedua `demo.md` §3.

Batch gagal tidak muncul sendiri. Cara memicunya yang paling jujur adalah mengirim
solusi yang `executedBuy` salah satu intent-nya di bawah baseline-nya, yang
menghasilkan `WorseThanBaseline`, atau membiarkan seluruh batch tanpa solusi sehingga
`expireBatch` yang bicara. Keduanya menerbitkan event, dan itu inti adegannya.

### Hari 7, 26 September. Solver kedua dan lelang

F23, lalu keeper lelang kalau waktunya cukup. Keeper lelang memanggil `openAuction`,
`publishIndicative` tiap blok, `freeze`, dan `executeCross`. Ini kandidat potong
pertama, lihat §9.

**Hasil Hari 6 dan Hari 7, dikerjakan 26 September 2026.** Rencananya di
`docs/rencana-hari6-7.md`. Semua kode ditulis, lulus typecheck, dan lulus test unit.
Tidak ada satu pun yang sudah berjalan di fork, karena fork tidak bisa dinyalakan
(N13). Jadi tidak ada angka terukur di bagian ini, dan tidak ada yang boleh disebut
selesai sebelum test fork-nya hijau.

| Bagian | Keadaan |
|---|---|
| A1 `--confirmations` | Selesai dan diuji unit. Blok ditahan sampai cukup dalam, dan nol ditolak di luar fork |
| A2 `--reconcile` | Selesai. SQL diuji ke Postgres sungguhan, dan satu ubahan 1 wei tertangkap dengan nama kolomnya |
| A3 I10 sampai I12 | **Hijau 28 September 2026.** I10 sampai I12 lulus setelah N21 diperbaiki. Setelah replay 5 menit, rekonsiliasi 118 dari 118 cocok. Baseline kini direkonsiliasi per arah, sesuai `parameter.md` §4C |
| B `make demo-fail` | **Hijau 28 September 2026.** `failure.test.ts` 3 dari 3 dalam satu run, tanpa restart manual. Struknya ada di `infra/.torture/` |
| C fixture F29 | Selesai 27 September 2026. Kueri `8846173`, 728 trade, `data/replay/august-2026.json` |
| D `make replay` | **Hijau 28 September 2026.** Replay 5 menit setelah perbaikan N20. 72 dari 72 diterima, nol harness fault, 6 dari 6 batch berstruk, 3 batch netting, netting 1,94 persen, nol `BaselineBelowVenue`. **Replay satu jam diukur ulang 29 September 2026.** 728 dari 728 diterima, nol harness fault, 61 dari 61 batch berstruk, 34 batch netting, netting 9,26 persen ($2.179 netted, $21.331 dirutekan). Sebelum perbaikan N20, 11 batch revert dan netting 6,91 persen dari 50 batch. Kedua angka replay ini diukur di fork dengan empat kunci lokal, bukan backtest |
| F `make demo-compete` | **Hijau 28 September 2026.** `compete.test.ts` 2 dari 2. Profil A menang di tiga batch berturut-turut, dan dengan dua intent searah yang pertama masuk menang |
| G keeper lelang | **Dihentikan setelah G1**, tanpa kode keeper (N17) |
| E dan H penutup | **Hijau 28 September 2026.** Test unit indexer 18, solver 55, analytics 11. Suite fork indexer 8 dari 8, dengan I9 di-skip karena `fork-demo.sh` tidak menerbitkan event lelang (N17). Suite fork solver 13 dari 13, termasuk E4 yang dulu tidak tuntas. `check-permit2` 3 dari 3, `check-batch` 41 dari 41, `postman-api` 105 dari 105 |

**Satu keputusan yang mengubah bentuk struk.** Batch yang dirutekan penuh dan
menghemat nol menerbitkan `BatchPassthrough("savings below threshold")` dan
`BatchSettled` di satu `finalize`. Tradenya tetap terjadi. Struknya kini tetap
`settled`, tapi `failure` diisi kode `SavingsBelowThreshold` dengan `feeCharged` nol,
supaya layar gagal Nabil bisa memicu dari bentuk yang sama. Diputuskan Dharu
26 September 2026.

**Diganti 1 Oktober 2026.** Audit frontend Nabil membaca bentuk itu sebagai
"nothing settled" di atas fill yang jelas terjadi. Batch ini sekarang ber-outcome
`settled_at_venue` dengan `failure` null, di struk, di daftar batch, dan di frame
`batch.settled` pada stream. Tabel `batches` tetap menyimpan `settled` beserta
reason-nya, dan nama publiknya dipetakan saat dibaca oleh `publicOutcome` di
`indexer/src/receipt.ts`. Karena itu tidak ada migrasi, dan metrik uptime serta
netting tetap menghitungnya sebagai batch yang settle.

**Catatan G1, aturan `AuctionHouse` yang dibaca dari kontraknya.**

- `openAuction` boleh dipanggil siapa saja, hanya saat `sessionAt(now)` sama dengan
  `AUCTION_OPEN` atau `AUCTION_CLOSE` sesuai jenisnya. Fungsi ini tidak memeriksa
  `auctionTokenAllowed`, yang hanya diperiksa `commitAuctionIntent`.
- `crossAt` adalah transisi sesi berikutnya dari sesi lelang. `freezeAt` sama dengan
  `crossAt` dikurangi 300 detik. `referenceAt` sama dengan `crossAt` ditambah 300 detik
  untuk pembukaan, dan sama dengan `crossAt` untuk penutupan.
- `freeze` boleh dipanggil siapa saja di antara `freezeAt` dan `crossAt`, lalu menarik
  escrow.
- `submitCross` hanya untuk solver aktif, setelah `referenceAt`, dengan harga di dalam
  collar dan bond 500 USDG.
- `challenge` terbuka 120 detik setelah cross masuk. `executeCross` boleh dipanggil
  siapa saja setelah jendela itu lewat.
- `extend` paling banyak 3 kali, masing-masing 300 detik setelah `referenceAt` dan
  perpanjangan sebelumnya, dan collar melebar 50 bps tiap kali.
- `abortAuction` boleh dipanggil siapa saja. Alasannya "multiplier moved", "market did
  not open", atau "no cross in time" setelah `referenceAt` ditambah 1.200 detik.

**Temuan baru, tidak diperbaiki.**

- **N13, memblokir semua test fork.** Sejak 26 September 2026, `robinhood.drpc.org`
  menjawab "Unknown state. First available state is 1" untuk `eth_getBalance` di blok
  mana pun selain `latest`. Blok patokan 67.798.044 ditolak, begitu juga 72.351.744
  yang hanya sekitar 54 ribu blok di belakang head. `make fork` gagal membuat genesis
  dua kali. Job fork nightly di CI juga akan gagal dengan cara yang sama, karena anvil
  meminta state di blok yang dipatok, bukan di `latest`. Jalan keluarnya RPC archive
  berbayar di `NOKTURN_RPC_MAINNET`.
  **Teratasi 27 September 2026.** Alchemy tier gratis menyajikan state di blok patokan.
  `make fork`, `deploy`, `fund`, dan `status` lulus. Jaringan harus diaktifkan per app
  di dashboard Alchemy, dan selama sekitar dua menit setelahnya sebagian panggilan
  masih dijawab 403.
- **N14, handle Dune saling bertentangan.** `data/dune-queries/README.md` menulis tim
  `passchick` sudah diarsipkan pada 2 Agustus dan kuerinya pindah ke `wngstnrs7119`.
  `CLAUDE.md` §6 menulis dashboard Agustus terbit di `passchick`. Salah satunya basi.
  Kode baru sengaja tidak menautkan handle mana pun sampai ini dicek.
  **Terjawab 28 September 2026, dicek lewat API Dune.** Kueri Agustus, misalnya
  `8595251`, ada di `team_id 65014` (`passchick`), publik dan tidak diarsipkan, jadi
  `CLAUDE.md` §6 benar dan README itu yang basi. Kueri replay `8846173` ada di akun
  Dune milik Dharu, `team_id 1012046`, publik dan permanen. Keduanya bisa dibuka juri
  tanpa akses akun.
- **N15, sudah diputuskan.** `8595251` dan `8595303` hanya berisi agregat per sesi dan
  per titik kurva, sehingga tidak bisa menjadi fixture. Kueri 13 memakai kaki trade
  yang sama dan mengambil satu jam off-hours hari kerja di Agustus, yaitu jam dengan
  jumlah trade median. Jam tersibuk sengaja tidak dipilih, karena akan membuat netting
  replay tampak lebih baik dari kenyataan.
- **N16, `solutions[].accepted` bisa menyesatkan.** Solusi yang kalah tapi datang lebih
  dulu sempat menjadi best, lalu diganti tanpa event penolakan. Proyeksi `solutions`
  menandainya `accepted` benar, jadi struk memuat dua solusi berstatus diterima padahal
  hanya satu yang menang. Pemenang yang benar tetap terbaca dari `solver` di struk.
- **N17, keeper lelang tidak bisa diuji di fork demo.** Daftar aksi keeper tidak memuat
  `submitCross`, padahal K1 mensyaratkan `CrossExecuted`, dan backend belum punya logika
  merakit cross. Lebih mendasar lagi, header `ForkAuction.s.sol` milik Wangsit mencatat
  bahwa cross penutupan butuh fork sendiri di blok 66.491.729, karena warp dari fork
  akhir pekan ke jam penutupan membuat semua feed basi. Fase G dihentikan setelah G1
  sesuai aturan rencana.
- **N18, health API masih melapor indexer mati.** `api/src/routes/config.ts` masih
  mengembalikan `indexerLagBlocks` "0" dan status `indexer` serta `database` "down",
  dengan komentar "No indexer yet". Indexer dan database sudah ada sejak Hari 5.
- **N19, fixture replay diskalakan ke cap yang salah.** Replay pertama, 27 September
  2026, `--duration 5`, mengirim 72 trade ke 6 batch. Semuanya diterima, dengan nol
  harness fault, dan 5 batch settle. Netting terukur 6,27 persen. Batch 1789893840
  berisi 24 intent ditolak preflight solver, karena nilainya $2.508 sedangkan batasnya
  $2.500. Ekstraktor menskalakan jendela 45 detik tersibuk ke 90 persen dari cap penuh
  $5.000. Padahal blok patokan jatuh di hari Minggu, sehingga fork berjalan di sesi 6
  dan `_capScale` membagi dua cap menjadi $2.500. Batch di fork juga panjangnya 60 detik,
  bukan 45. Warp ke hari kerja bukan jalan keluar, karena membuat feed basi (N17).
  **Diperbaiki 28 September 2026.** Ekstraktor kini membaca `sessionAt`,
  `batchDuration`, dan `capPerBatchUsd` dari fork, lalu mencatat sesi dan cap penuh
  di fixture. Replay menolak jalan kalau satu batch chain tidak sama dengan satu
  jendela fixture, karena `--speed 12` memasukkan dua belas jendela ke satu batch.
  Replay penuh di speed 1 memutar 728 dari 728 trade ke 61 batch. Semuanya diterima,
  dengan nol harness fault. 50 batch settle, 23 di antaranya netting, dan netting
  terukur **6,91 persen** ($1.360 netted, $18.300 dirutekan). Angka ini hasil replay
  di fork dengan empat kunci lokal, bukan backtest 27 sampai 33 persen.
- **N20, belum ditangani. Baseline solver sedikit di bawah venue.** Di replay yang
  sama, 11 dari 61 batch gagal di simulasi dengan `BaselineBelowVenue`, lalu tidak
  dikirim. Selisihnya 0,04 sampai 3,5 ppm dari kuotasi venue, di NVDA, AAPL, GOOGL,
  dan di sisi USDG. Polanya cocok dengan baseline yang dihitung di blok yang berbeda
  dari blok yang dibaca kontrak, atau pembulatan yang berpihak ke arah yang salah.
  Intent di batch itu tidak dieksekusi sama sekali, jadi netting di atas dihitung
  dari 50 batch saja. API mencatat peringatan "recomputed baseline" dengan selisih
  sekecil itu untuk batch yang sama, jadi API dan solver pun tidak sepakat.
- **N21, belum ditangani. I12 tidak pernah melihat eventnya.** Dua kali berturut-turut,
  `IntentSubmittedOnchain` dengan nonce 12 tidak terindeks, bahkan setelah dua blok
  tambahan. `eth_call` yang sama tidak revert, `0xdEaD` punya saldo tanpa kode, dan
  indexer menyimpan event Settlement secara generik. Penyebabnya belum ditemukan.
- **N22, belum ditangani. `evm_revert` di dalam suite fork merusak kasus berikutnya.**
  `failure.test.ts` dan `compete.test.ts` membungkus tiap kasus dengan snapshot dan
  revert. Revert memundurkan waktu chain, tapi API dan indexer yang sedang berjalan
  tidak ikut mundur. Kasus berikutnya lalu gagal dengan `BlockOutOfRangeError` atau
  menunggu batch yang sudah lewat. Kasus yang sama lulus kalau dijalankan sendiri
  lewat `make demo-fail` atau `make demo-compete` setelah API dan indexer dinyalakan
  ulang. Pola yang sama membuat solver melewati batch setelah `make revert`, karena
  store-nya masih memuat ID batch yang dipakai ulang.

**Diperbaiki 28 September 2026, di branch `dharu/day6-7-green`.**

- **N20.** Solver menaikkan baseline netted sampai lantai per arah, dan kekurangannya
  ditaruh di fill yang masih punya ruang di bawah `executedBuy`. Koreksi klaim terkait
  ada di `desain-baseline.md` §9.3.
- **N21.** viem menyimpan nomor blok di cache selama empat detik, sehingga `safeHead`
  menghitung kedalaman dari head yang basi. Indexer kini membacanya tanpa cache.
- **N22.** Dua sebab. Cache nomor blok yang sama di client indexer, solver, dan API
  menunjuk ke blok yang sudah hilang setelah `evm_revert`. Dan `watchBlockNumber` di
  lifecycle API hanya menerbitkan nomor yang naik, sehingga setelah revert tidak ada
  batch yang tutup. Lifecycle kini mem-polling sendiri dan ikut turun.
- **I5.** `isFork` menganggap error apa pun dari `anvil_nodeInfo` sebagai bukan fork.
  Kini hanya jawaban "method tidak dikenal" yang berarti bukan fork, dalam tiga bentuk
  yang diukur di Alchemy, drpc, dan kode standar. Bacaan blok pertama saat boot juga
  diberi retry.
- **Replay.** Nonce kini ditanyakan ke API untuk setiap intent, karena bitmap Permit2
  berlubang dan coordinator memegang nonce intent yang masih menunggu.

**Temuan baru.**

- **N23, untuk audit M4 dan Nabil.** `verifyBaseline` di struk masih per intent. Di batch
  rute penuh, baseline satu fill adalah bagian pro rata dari satu kuotasi gabungan, jadi
  perintah `cast` di struk memberi angka yang berbeda dari `baselineBuy` padahal tidak
  ada yang salah. Juri yang menjalankannya akan melihat selisih. Perbaikannya menyentuh
  skema `api-types.ts`, yaitu verifikasi per arah, dan harus disepakati dengan Nabil.
- **N24, diamati.** `anvil_mine` seribu blok lalu `evm_revert` meninggalkan nomor blok
  yang menjawab null, dan indexer lalu gagal dengan `BlockNotFoundError`. Tidak bisa
  direproduksi di percobaan berikutnya. Test tidak lagi memakai `anvil_mine`.
- **Catatan keamanan.** Error anvil memuat URL fork lengkap dengan key RPC. I9 kini
  memotong path URL sebelum hasilnya dicetak, karena hasil test sampai ke log CI.
- **N25, dicatat 28 September 2026, tidak diperbaiki.** `pnpm lint` di root memanggil
  `biome check .`, tapi biome tidak pernah jadi dependensi repo ini, jadi perintahnya
  selalu gagal dengan command not found. Gerbang lint di §6 sebenarnya dijaga
  `tsc --noEmit` dan `tools/prose-gate.py`, dan keduanya hijau. Ini script yang
  menyesatkan, bukan gerbang yang bolong. Diserahkan ke setelah submit, karena feature
  freeze dan karena menambah biome sekarang berarti memformat ulang seluruh repo.
- **N26, dicatat 28 September 2026, tidak diperbaiki oleh saya.** Commit `e8f2ec4`,
  yang sudah ada di `main` dan sudah di-push, menyebut nama berkas instruksi AI di
  badan pesannya. Aturan §11.6 melarang jejak itu di permukaan repo, dan berkasnya
  sendiri di-gitignore sehingga pembaca melihat rujukan ke berkas yang tidak ada.
  Memperbaikinya berarti menulis ulang riwayat yang sudah terbit, jadi keputusannya
  ada di Dharu, bukan di saya.

**Diperbaiki 28 dan 29 September 2026.**

- **N23.** Struk kini memuat `baselineFloors`, satu entri per arah dengan jumlah
  `executedSell` dan `baselineBuy`, satu perintah `cast` untuk lantainya, dan `holds`.
  Itulah yang harus dicocokkan juri. `verifyBaseline` per fill tetap ada, dengan komentar
  skema yang menjelaskan bahwa ia bisa lebih tinggi dari `baselineBuy`. Field ini
  ditambahkan, bukan menggantikan, jadi layar Nabil tetap jalan. I8 dan `postman-api`
  memeriksanya. **Nabil perlu menampilkan `baselineFloors`**, supaya tombol salin di
  layar memberi juri perintah yang hasilnya cocok.
- **N16.** Struk hanya menerima hash pemenang. Solusi yang kalah tanpa event penolakan
  diberi alasan "replaced by a better solution".
- **N18.** Health mengukur keempat komponennya. Lag dari checkpoint indexer, database
  dengan batas dua detik, scheduler dari tick lifecycle terakhir, dan rpc dari endpoint
  yang melayani.
- **Key RPC di permukaan publik.** `pin-block.sh` menulis URL RPC lengkap ke
  `infra/pinned-block.json` yang di-commit, dan `fork.sh` mencetaknya ke log. Keduanya
  kini hanya menampilkan host. Di API, URL baca terpisah dari URL publik untuk perintah
  `cast` (F6).
- **CI fork nightly** membaca `NOKTURN_RPC_MAINNET` dari secret repo dan berhenti dengan
  pesan jelas kalau secret belum dipasang. **Dharu perlu menambahkan secret itu.**
- **Diperbaiki di `537da15`.** `make` di root gagal untuk semua target di laptop Dharu,
  karena `make.exe` ada di path yang mengandung spasi. Delegasinya juga belum memuat
  `solver`, `indexer`, target database, `torture`, dan tidak meneruskan `CASE`,
  `BATCH`, atau `GROUP`.

**Yang harus dijalankan begitu RPC ada**, masing-masing sekali, berurutan.

```bash
make fork
```

```bash
make deploy fund
```

```bash
make db-up api
```

```bash
node infra/scripts/m2.mjs
```

```bash
pnpm -C indexer test:fork
```

```bash
pnpm -C solver test:fork
```

Setelah itu `make demo-fail` untuk ketiga kasus, `make demo-compete ARGS="--batches 3"`,
dan terakhir `make replay ARGS="--duration 5"` setelah fixture ada. Speed di atas 1 ditolak, lihat N19.

### Hari 8, 27 September. M3, feature freeze

F32 hijau, F6, dan pengerasan. Setelah hari ini hanya perbaikan bug, uji, dan dokumen.

**M3 tercapai 28 September 2026.** Sejak commit itu satu-satunya perubahan yang masuk
adalah perbaikan bug packaging F5, dokumen, dan catatan hasil uji. Tidak ada fitur baru.

### Hari 9, 28 September. M4, audit provenansi

Telusuri setiap field API dan setiap angka yang kamu hasilkan dengan satu pertanyaan
`rencana-uji.md` §11.1. Yang tidak lolos **dipotong**, bukan diberi disclaimer.

F30 dan F31 dikerjakan hari ini, karena keduanya adalah alat audit itu sendiri.

### Hari 10, 29 September. M5 dan runbook

Runbook operasi backend, yaitu cara menyalakan, cara membaca log, apa yang dilakukan
kalau solver diam, dan siapa memanggil apa. Satu perintah demo yang berjalan dari mesin
bersih.

**M5 tercapai 28 September 2026.** Dibuktikan dengan gladi bersih dari clone kosong,
bukan dengan membaca runbook. Sebelas menit dari `git clone` sampai struk pertama, nol
langkah manual di antara `make up` dan `make demo`, perintah `cast` di struk cocok
sampai wei terakhir, dan `make down` tidak menyisakan apa pun. Di clone yang sama,
`make check-permit2` 3 dari 3, `make check-batch` 41 dari 41, dan `make postman-api`
108 dari 108. Dua salah arah di `infra/README.md` yang ditemukan gladi ini sudah
diperbaiki, yaitu klaim bahwa `.env` tidak perlu diisi dan `pnpm install --dir infra`
yang tidak cukup untuk `make demo`.

### Hari 11, 30 September. Buffer

Dukungan deck dan video. Tidak ada kode baru.

**Yang terjadi, 29 dan 30 September 2026.** Rencana di atas berubah atas permintaan
Dharu. Butir yang tidak menunggu kontrak dikerjakan, yaitu D4, N3, keeper lelang, dan
port baseline TypeScript. N25 dan N26 tidak disentuh.

Deploy mainnet Wangsit mematahkan tiga hal di backend, dan ketiganya sudah diperbaiki.

- `deploy.sh` menolak setiap deploy fork karena `contracts/deployments/4663.json` kini
  ter-commit. Di container `deploy` yang tidak punya `.git`, pemeriksaan yang sama
  malah menghapus catatan mainnet di host. Kini catatan itu disisihkan ke
  `infra/.mainnet-record.json` dan dikembalikan saat keluar.
- Indexer memilih catatan deployment dari berkas yang ada, bukan dari node. Di mainnet,
  blok awalnya dicari lewat `eth_getCode`, dan hasilnya blok 75.694.415.
- ABI `Settlement` di `packages/shared/abi` belum memuat `ExposureCapOutOfRange`.

| Butir | Keadaan |
|---|---|
| D4 | Coordinator menghitung saldo yang masih dipegang intent sebelumnya per pemilik per token, dan menolak intent yang tidak tertutup sisanya. Unit test lulus. C2-20 kini asersi, belum dijalankan di fork |
| N3 | Feed dan route status menyaring ulang batch terhadap nonce, saldo, allowance, dan total berjalan. Feed beku disaring sekali di blok paling lambat `solveEnd` dan dibagi ke semua solver. Field `withdrawn` ditambahkan ke `BatchIntentsResponse`. C2-21 kini asersi, belum dijalankan di fork |
| Keeper lelang | `solver/src/keeper.ts`, `make keeper-fork`, `make keeper`. K1 sampai K3 tertulis di `solver/test/fork/keeper.test.ts`, belum dijalankan |
| Port baseline | `solver/src/v3math.ts`. Batas `TickMath` dan 300 round trip lulus di unit test. Gerbang nol selisih terhadap `quoteWithStats` tertulis di `solver/test/fork/v3math.test.ts`, belum dijalankan. Sampai gerbang itu hijau, port ini tidak boleh dipakai untuk angka apa pun |

Suite fork indexer terhenti di tengah pada 29 September karena memori laptop habis,
bukan karena test gagal. Suite fork solver, `demo-fail`, `demo-compete`, dan replay
belum dijalankan ulang sejak perubahan di atas.

**Temuan baru.**

- **N27, untuk Wangsit.** Di `AuctionHouse`, cross yang pembelinya membawa lebih banyak
  dari yang dipegang penjual hampir tidak pernah bisa dirakit pada harga yang dipilih
  `indicative()`. Penjual terisi penuh, dan `_applyCross` menuntut token pembeli berada
  dalam satu unit per fill dari token penjual. Padahal token satu pembeli bergerak
  dalam langkah 1e18 dibagi harga, sekitar 5,5 miliar unit untuk NVDA terhadap USDG.
  Keeper karena itu menaikkan harga ke titik terkecil di dalam collar tempat permintaan
  tidak lagi melebihi suplai. Kontrak menerima harga itu, tapi `challenge` bisa
  menggulirkannya kembali dengan harga `indicative()` yang volumenya lebih besar, dan
  harga itu tidak bisa di-cross siapa pun. Hasil akhirnya perpanjangan lalu abort,
  bukan kehilangan dana.

**Yang terjadi, 30 September dan 1 Oktober 2026.** Semua yang tertulis "belum
dijalankan" di atas kini dijalankan di fork, dan route terakhir yang masih stub diganti
dengan implementasi nyata. Yang menunggu `SetFeeds` mainnet, yang baru bisa dieksekusi
1 Oktober 2026 pukul 13.45.39 UTC, sengaja tidak disentuh.

| Butir | Keadaan |
|---|---|
| D4 | C2-20 lulus di fork |
| N3 | C2-21 lulus di fork |
| Keeper lelang | K1 sampai K3 lulus 3 dari 3 di `make keeper-fork`, blok 66.491.729. Lelang NVDA di-cross dan dieksekusi oleh keeper, dari chain |
| Port baseline | Gerbang nol selisih `v3math.test.ts` lulus 5 dari 5 token di dua fork, blok 66.491.729 dan 67.798.050. Tiap token minimal 20 ukuran sama persis dengan `quoteWithStats`, dua arah |
| `GET /v1/auctions/:auctionId` | Nyata, dibaca dari view `AuctionHouse` pada satu blok. Dicocokkan ke chain di fork keeper sepanjang satu siklus. Harga 223,559534 USD, volume, dan 4 peserta sama dengan `auctionResult`. `sufficient` false karena volumenya di bawah $1.000 dan pesertanya di bawah 5 |
| Stream lelang | `auction.indicative` dan `auction.crossed` kini dilayani, dari log `IndicativePublished` dan `CrossExecuted`. Di fork keeper satu klien menerima satu indikatif untuk tiap lelang yang dibuka keeper, dan satu `auction.crossed` NVDA yang hasilnya sama dengan `auctionResult`, dibangun di blok yang memancarkan log-nya |
| Tabel lelang indexer | `indexer/test/fork/auction.test.ts`, di fork keeper. A1 men-cross dan mengeksekusi lelang NVDA, lalu `auctions`, `indicative`, dan `closing_prints_withheld` cocok dengan kontrak. Print ditahan dengan alasan "volume below minimum", karena volumenya 454,85 USDG. A2 memperpanjang tiga kali lalu abort "no cross in time". Keduanya lulus. Ini yang tidak pernah bisa diisi I9 |
| Demo dan alat | `make demo` settled dengan netting 100 persen, dan perintah `cast` lantainya dijalankan ulang, hasilnya sama sampai wei terakhir. `make demo-compete ARGS="--batches 3"` dan `--same-side` lulus. `check-permit2` 3 dari 3, `check-batch` 41 dari 41, `postman-api` 168 dari 168 assertion di 34 request. Replay lima menit memutar 72 dari 72 trade ke 6 batch, semuanya punya struk, nol harness fault, netting irisan itu 2,06 persen |
| Torture | Semua grup lulus. c0 5, c1 10, c2 24, c3 9, c4 6, h 5, r 7, l 5, f9 11, f10 10. C1-6c, C1-7, dan C2-9 dijalankan ulang sendiri setelah diperbaiki, sisanya lulus dalam satu run grup |
| Suite fork indexer | 14 lulus, 1 dilewati. I10 sampai I12 (N13) kini berjalan dan lulus. I9 dilewati karena fork batch berdiri di akhir pekan dan tidak punya lelang |
| Suite fork solver | Lulus, termasuk E1 sampai E6. K1 sampai K3 dilewati di fork batch dan lulus di fork keeper. `compete.test.ts` kini lulus dua kali berturut-turut, setelah dua perbaikan di bawah |

Stub terakhir hilang, sehingga `api/src/routes/stubs.ts` dan `notImplemented` ikut
dihapus. Harga lelang keluar sebagai USD 18 desimal per token utuh, dikonversi dengan
cara yang sama seperti `_publishPrint`, dan `sufficient` adalah predikat yang sama
dengan yang dipakai kontrak untuk menerbitkan closing print. Fase `accumulating` tidak
pernah dikirim, karena `AuctionHouse` sudah mengungkap sejak blok pertama.

**Diperbaiki, karena semua itu muncul begitu gerbang benar-benar dijalankan.**

- **`make keeper-fork` tidak pernah melewati `Deploy`.** forge meminta `eth_feeHistory`
  sepuluh blok terakhir, rentang itu jatuh di bawah blok fork, anvil meneruskannya ke
  upstream, dan Alchemy menjawab "metadata is not found". Fork keeper kini menambang
  12 blok sebelum deploy. Anvil juga ikut mati kalau deploy gagal.
- **Keeper tidak bisa membaca revert kontrak.** `eth_call` mentah mengembalikan custom
  error sebagai selector, jadi `TooEarly` dan `AuctionStillLive` tidak dikenali sebagai
  "tunggu", dan keeper menyerah selamanya atas `extend` dan `abortAuction` untuk lelang
  itu. Kini di-decode dengan ABI `AuctionHouse`.
- **Provenansi fork menyebut blok yang salah.** API dan indexer membaca blok fork dari
  `infra/pinned-block.json`, padahal `make keeper-fork` berdiri 1,3 juta blok lebih awal.
  Setiap struk dari fork itu mengutip blok yang tidak pernah dibacanya, dan indexer
  mulai di atas head lalu tidak mengindeks apa pun. Keduanya kini bertanya ke node
  lewat `anvil_nodeInfo`.
- **C1-7 mengukur hal yang salah.** RSS dari luar proses naik sekitar 15 MB sepanjang
  run, sementara heap setelah GC paksa tetap 28 sampai 36 MB. Pertumbuhan itu allocator
  yang menahan halaman, bukan retensi. C1-7 kini menilai lantai heap dari dalam proses
  lewat preload di harness, hasilnya 26 byte per intent. Unit test baru menahan heap
  mempool di bawah 64 byte per intent, dan terbukti gagal kalau penghapusan `byHash`
  dimatikan. Intent C1-7 juga kini kedaluwarsa semenit setelah `solveEnd`, karena
  `validUntil` 30 hari membuat penahanan nonce D5 ikut terukur sebagai kebocoran.
- **Test yang tertinggal dari perubahan lain.** C2-9 (D4 memegang saldo), C1-6c (API kini
  menolak `validUntil <= solveEnd`), C4-4 dan C4-4b (koleksi Postman yang dijalankan di
  luar jendela validitasnya), F9-8 (`waitTick` menerima baris tick lama setelah
  `evm_revert`), dan event keeper yang dihitung untuk kelima lelang sekaligus.
- **Demo memakai ulang batch yang sudah berisi intent.** Mempool tidak ikut mundur
  bersama `evm_revert`, jadi batch yang dipakai lagi setelah run yang di-revert masih
  memuat intent run itu, dan solver menyelesaikan intent lama. `freshBatch` kini hanya
  menerima batch kosong. Di `compete.test.ts` intent kasus pertama juga masih pending di
  batch yang belum dicapai chain setelah revert, sehingga D4 memegang saldo pemilik
  yang sama untuk kasus kedua. Setelah revert, jam chain kini dimajukan melewati akhir
  kasus ditambah 310 detik.
- **Saran `make replay ARGS="--duration 5 --speed 12"` sudah basi sejak N19.** Replay
  menolak speed di atas 1 untuk fixture yang dipotong per batch. Komentar Makefile,
  header `replay.ts`, dan contoh di dokumen ini diperbaiki.

**Backend terhadap mainnet 4663, 1 Oktober 2026.** Jam blok mainnet saat dikerjakan
masih 30 September sekitar 20.00 UTC, dan oracle menjawab `FeedNotSet` sampai `SetFeeds`
dieksekusi. Jadi yang dikerjakan adalah semua jalur baca, ke kontrak Wangsit yang asli.
Menjalankannya di mainnet langsung membuka masalah yang tidak pernah terlihat di fork.

- **Key RPC berbayar bocor di setiap 502.** Pesan error viem memuat URL request lengkap.
  Badan respons kini hanya memuat pesan pendek, dan URL di badan maupun log dipotong ke
  host.
- **API diam menghabiskan Alchemy free tier.** 1.052 permintaan per menit, dijawab 429.
  Lifecycle kini tick sekali per detik chain di chain nyata, bacaan per token paralel
  dan di-batch lewat Multicall3, hasilnya 624 per menit tanpa error. Fork tetap tick per
  blok, dan torture c2, c3, f9, f10, r lulus sesudahnya.
- **`eth_getLogs` dibatasi 10 blok di free tier.** Log lelang kini dibaca per potongan
  yang bisa diatur, kursornya tidak pernah melompati rentang, dan kegagalannya tidak lagi
  menggagalkan tick.
- **Solver dan keeper menandatangani dengan mnemonic repo di chain mana pun.** Di mainnet
  itu berarti bond di balik kunci publik. Kini ditolak di luar fork.
- **Papan skor tidak pernah bisa menampilkan solver mainnet**, karena daftarnya dari
  `infra/accounts.json`. Kini dari tabel `solvers` indexer.
- **Lag indexer dihitung dalam blok**, dan 20 konfirmasi di mainnet sudah terbaca
  `degraded`. Kini dalam detik chain.

Cara menjalankannya dan angka yang terukur ada di `runbook-backend.md` §7.

**Empat topik stream terakhir, 1 Oktober 2026.** `batch.solution_submitted`,
`batch.solution_rejected`, `batch.settled`, dan `batch.failed` kini dilayani, dari log
Settlement dan struk indexer. Dibuktikan di fork, dari chain.

| Topik | Bukti |
|---|---|
| `solution_submitted` | `make demo` dan `make demo-compete`, satu frame per solusi, `accepted` dari `bestSolution` di blok log |
| `solution_rejected` | `demo-compete --same-side`, solverB tiba kedua, alasan `not the best` |
| `settled` | `make demo` kini gagal kalau frame ini tidak datang atau isinya beda dengan `GET /v1/batches/:batchId` |
| `failed` | `demo-fail CASE=expired`, outcome `expired`, kode `WinnerNeverFinalized` |

Batch di bawah ambang savings memancarkan `BatchPassthrough` dan `BatchSettled` di
finalize yang sama. Sejak 1 Oktober 2026 struknya `settled_at_venue` dengan `failure`
null, dan frame-nya `batch.settled`, karena tradenya memang terjadi. Sebelumnya struk itu
`settled` dengan kode kegagalan. Jenis frame karena itu
mengikuti `outcome` struk, bukan event mana yang terakhir dibaca. Solusi terbaik yang
digantikan tidak punya event penolakan di kontrak, jadi ia hanya muncul sebagai
`solution_submitted` dengan `accepted` false, sama seperti di struk.

**Catatan.** E5 lulus di run ini. Temuan W5, `finalize` yang revert `LiquidityExhausted`
ketika pool bergeser sedikit antara submit dan finalize, tetap temuan untuk kontrak
sampai Wangsit memutuskan. Satu run yang lulus tidak membuktikan risikonya hilang.

**1 dan 2 Oktober 2026, setelah backend mainnet berjalan.** Temuan di bawah semuanya
muncul begitu backend diukur di mainnet, tidak satu pun terlihat di fork, karena
anvil lokal menjawab dalam milidetik. Angka rinci ada di `runbook-backend.md` §7.

- **N28, diperbaiki. Indexer Railway crash berulang.** RPC resmi menjawab `getLogs`
  empat sampai delapan puluh blok dengan "Too Many Requests", dan pola penolakan
  rentang di `ingest.ts` cocok dengan "too many", sehingga indexer berhenti seolah
  tidak ada percobaan ulang yang bisa lolos. Rate limit kini dikenali lebih dulu.
- **N29, diperbaiki. Tidak ada solver yang bisa submit di mainnet.**
  `batch.collect_closed` tiba 16 sampai 43 detik sesudah collect tutup, selalu lewat
  jendela solusi sepuluh detik. Penutupan menunggu di belakang semua bacaan tick.
  Kini diputuskan lebih dulu, dan tiba 2,5 sampai 3,1 detik sesudahnya.
- **N30, diperbaiki. Setiap route yang membaca chain butuh 3 sampai 11 detik.**
  Bacaan berurutan, fallback ke Alchemy yang sudah kena batas bulanan, dan rentang
  log 10 blok. Kini 0,2 sampai 0,6 detik. Perkiraan awal bahwa RPC resmi lambat dari
  Railway ternyata salah. Diukur langsung, p50-nya 76 ms dari Railway, dan yang
  lambat adalah jalur dari laptop di Indonesia.
- **N31, terbuka. Perintah `cast --block` di mainnet hanya bisa dicek sekitar sepuluh
  menit.** RPC publik bukan archive. Keputusannya di tim, `audit-provenansi-backend.md`
  §5c.
- **N32, diperbaiki. Di detik yang tepat sama dengan `collectEnd`, `batch.opened` untuk
  batch berikutnya bisa terbit sebelum `batch.collect_closed` batch itu.** Kontrak
  masih menganggap batch itu collecting di detik tersebut, sementara `openWindow`
  sudah menunjuk batch berikutnya. Sudah ada sejak sebelum N29 dan tersamar oleh tick
  yang lambat. Kini pembukaan menunggu penutupan sedetik kemudian, dan `at` di frame
  pembukaan tidak pernah lebih awal dari frame penutupan sebelumnya. Diperiksa di
  mainnet, sepuluh pasangan berurutan, nol terbalik.
- **N33, diperbaiki. `solvableBatchId` kehilangan detik terakhir jendela solusi pada
  batch 10 detik.** `check-batch` terhadap mainnet, dijalankan dari dalam container
  Railway 3 Oktober 2026, berakhir 39 lolos dan 2 gagal di sesi OPEN. Helper
  membulatkan `now` ke batas, sehingga di detik yang tepat sama dengan batas ia
  menjawab tutup, padahal kontrak masih menerima solusi batch sebelumnya. Dan rumus
  harapan di skrip uji hanya benar kalau batch lebih panjang dari jendela. Kini helper
  memakai batas terakhir sebelum `now`, dan skrip uji membandingkannya dengan
  `batchWindow` kontrak. Diperiksa di mainnet setiap detik sepanjang dua batch, 21
  dari 21 cocok, sementara helper lama berbeda tepat di ketiga batasnya. Solver tidak
  memakai helper ini. Fork berdiri di akhir pekan dengan batch 45 detik, jadi tidak
  pernah menjangkau kasus ini.
- **Job fork malam di CI hijau sekali, 2 Oktober 2026**, setelah memakai blok patokan
  tim alih-alih blok baru tiap malam. Blok baru menaruh fork di sesi yang ditentukan
  jam, dan generator koleksi resilience berputar tanpa akhir di sesi 30 detik,
  sehingga runner menggantung enam jam. Malam berikutnya merah lagi karena batas
  bulanan Alchemy.
- **Belum teruji di fork.** Torture F9, F10, C2, dan C3 untuk perubahan lifecycle dan
  feed di atas, karena fork butuh RPC archive. Dijalankan begitu archive pulih.

---

## 6. Gerbang yang mengikat backend

| Gerbang | Ambang | Kapan | Sumber |
|---|---|---|---|
| Differential baseline | **Nol selisih** terhadap `quoteFromState` | Tiap PR sejak hari 3 | `pembagian-tugas.md` §3 |
| Lint dan typecheck | Bersih | Tiap PR | F32 |
| Unit test solver | 100% lulus | Tiap PR | F32 |
| Gerbang prosa | Nol em dash, nol emoji di `.ts` | Tiap PR | `tools/prose-gate.py` |
| Audit provenansi | Nol temuan mock di permukaan | H-3, yaitu 28 September | `rencana-uji.md` §11 |
| Atribusi commit | Nol jejak AI di author dan pesan | Tiap PR | `CLAUDE.md` §11.1 |

Kalimat yang mengikatmu, disalin dari `pembagian-tugas.md` §3 karena ia layak dibaca
dua kali. Kalau baseline solver dan baseline kontrak berbeda satu wei pun, seluruh
klaim juri bisa verifikasi sendiri batal. Perlakukan uji differential itu sebagai
gerbang rilis, bukan uji tambahan.

---

## 7. Tiga keputusan yang harus diambil hari ini

### 7.1 Blok fork dipatok atau mengikuti head

Temuan §3 membuka opsi yang sebelumnya dianggap tertutup. Patok blok memberi demo yang
reproducible dan replay Agustus di state Agustus. Mengikuti head lebih aman terhadap
perubahan perilaku endpoint.

Rekomendasi. **Patok, lalu ambil snapshot.** Snapshot membuat demo berdiri sendiri
bahkan kalau endpoint berubah lagi besok. Bicarakan dengan Wangsit sebelum mengubah
`ForkFixture.sol`, karena itu file miliknya dan keputusan itu miliknya.

### 7.2 Baseline lewat `eth_call` atau port TypeScript

Sudah dibahas di catatan F15. Rekomendasi adalah `eth_call` untuk jalur produksi. Ini
menyentuh titik sinkronisasi 4, jadi butuh persetujuan ketiganya, bukan hanya
keputusanmu.

### 7.3 Siapa yang menandatangani intent di harness replay

Kamu tidak memegang kunci privat pemegang nyata di mainnet, dan Permit2 menuntut tanda
tangan pemilik. Jadi replay tidak bisa memakai alamat asli sebagai penanda tangan.

Yang boleh, dan ini sudah disahkan `demo.md` §5 sebagai lelang berjalan di fork dengan
arus historis. Bentuk arusnya nyata, yaitu ukuran, arah, waktu, dan pasangan diambil
dari trade Agustus sungguhan lewat Dune. Pool, token, dan harga nyata, karena fork-nya
state mainnet. Penanda tangannya kunci lokal, karena kunci aslinya bukan milik kita.

**Kalimat itu harus disebut di layar dan di naskah, sekali, di awal.** Menyamarkannya
menciptakan persis risiko yang aturan 9 hendak cegah. Yang haram bukan fork-nya,
melainkan mengklaimnya sebagai settlement live.

---

## 8. Jebakan yang sudah terpetakan

| Jebakan | Gejalanya | Penangkalnya |
|---|---|---|
| Menandatangani Intent, bukan witness Permit2 | `InvalidSigner` dari Permit2 saat `finalize` | §2.1, uji digest langsung ke Permit2 di hari 2 |
| Harga per token utuh | `NonUniformPrice` pada pasangan yang jelas benar | §2.3 |
| Menjumlahkan savings lalu membagi sekali | `SavingsMismatch` beberapa wei | §2.5, bagi per suku |
| `block.number` dipakai sebagai nomor blok fork | Fork diam-diam membaca state berminggu-minggu lalu | Pakai `eth_blockNumber` atau `ArbSys` |
| Baseline dari TWAP atau harga rata-rata | `BaselineBelowVenue` | §2.4, kuotasi per intent |
| `minOut` longgar | `ValueNotConserved` | §2.6 |
| Batch lahir di guard band | `BatchInGuardBand` | §2.2, cek sebelum membuka batch |
| Batch di fase lelang | `BatchMisaligned` dengan durasi 0 | §2.2, rutekan ke `AuctionHouse` |
| Solver mulai berpikir setelah batch tutup | `SolutionWindowClosed` | §2.2, hitung sepanjang jendela pengumpulan |
| Menang lalu tidak `finalize` | Bond ter-slash lewat `expireBatch` | F21 |
| `eth_getLogs` rentang ke endpoint publik | Error menyebut 10.000 padahal rentangmu 1.000 | §3, indexer menunjuk anvil |
| Em dash di komentar TypeScript | CI prosa merah | `CLAUDE.md` §11.4 |
| Docstring di tiap fungsi | Repo terbaca sebagai keluaran mesin | `CLAUDE.md` §11.2 |

---

## 9. Kalau tertinggal, ini urutan potongnya

Aturan M2 di `pembagian-tugas.md` §5 sudah menetapkan arahnya. Potong layar prioritas
rendah, jangan pernah potong kedalaman verifikasi. Diterjemahkan ke backend, urutan
potongnya dari atas.

1. Keeper lelang dan publikasi imbalance, tambahan hari 7
2. Port baseline TypeScript, sisakan `eth_call` saja
3. Kurva netting lawan pangsa, F30
4. Solver kedua, F23, tapi ini mengorbankan adegan kompetisi yang kuat
5. Postgres, ganti sementara dengan SQLite atau penyimpanan berkas

**Yang tidak pernah boleh dipotong.** F15 dan gerbang nol selisihnya, F24 pada bagian
event kegagalan, F26 kolom provenansi, dan audit §11 di hari 9. Keempatnya adalah
alasan proyek ini bisa berdiri di depan juri, dan memotongnya berarti memotong
klaimnya, bukan hanya fiturnya.

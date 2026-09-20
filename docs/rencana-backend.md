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

## 4. Daftar fitur yang harus dibangun

Tiga puluh dua butir, dikelompokkan per direktori. Kolom selesai kalau adalah definisi
selesainya, dan tidak ada butir yang dianggap selesai tanpa itu.

### 4.1 `infra/`, enam butir

| # | Fitur | Selesai kalau |
|---|---|---|
| F1 | Fork mainnet 4663 di blok yang dipatok, lewat anvil | `make fork` menyala di laptop ketiganya dengan satu perintah, dan bloknya sama di ketiganya |
| F2 | Snapshot state, `--dump-state` setelah prewarming pool, token, feed, dan Permit2 | Fork bisa jalan tanpa endpoint hidup, dibuktikan dengan mematikan jaringan |
| F3 | Impersonation dan pendanaan akun uji dari pemegang nyata | Lima akun lokal memegang NVDA, AAPL, TSLA, GOOGL, GME, dan USDG dalam jumlah yang muat di exposure cap |
| F4 | Deploy Nokturn ke fork lokal lewat skrip Wangsit | `deployments/31337.json` terisi dan `Bootstrap` lolos gerbang `StockTokenGate` terhadap token mainnet asli |
| F5 | `docker-compose` untuk anvil, postgres, coordinator, indexer, dua solver | `make up` lalu `make demo` menghasilkan satu struk batch tanpa langkah manual |
| F6 | Lapisan RPC dengan retry, failover, dan anggaran permintaan | Satu endpoint mati tidak menjatuhkan coordinator, dan lognya menyebut endpoint mana yang dipakai |

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
| F9 | Penjadwal batch, penyelarasan `batchId`, penanganan guard band dan fase lelang | Batch terbuka dan tertutup sendiri melintasi pergantian sesi, dan tidak ada batch yang lahir di guard band |
| F10 | Umpan solver, REST dan WebSocket | Dua solver menerima isi batch yang sama pada detik yang sama |
| F11 | API struk batch, disajikan dari indexer | Nabil bisa merender layar utama dan layar gagal sepenuhnya dari API |
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
| F15 | Klien baseline, kuotasi per intent ke `UniswapV3Adapter` | Nol selisih terhadap `quoteFromState` di blok yang sama, dibuktikan ulang tiap PR |
| F16 | Pencarian harga kliring per pasangan | Hierarki `desain-kliring.md` §2 dipatuhi, yaitu maksimalkan volume, lalu minimalkan imbalance, lalu terdekat ke referensi |
| F17 | Penjatahan pro-rata dengan prioritas harga, pembulatan ke bawah | Uji properti membuktikan jumlah yang diterima tidak pernah melampaui yang tersedia |
| F18 | Netting internal dan perutean sisa jadi `VenueCall` | Batch dengan dua sisi berlawanan menghasilkan nol `venueCalls` |
| F19 | Perakitan `Solution` dan penghitungan ulang `savings` | Angka solver sama persis dengan keluaran `ClearingVerifier.verify` |
| F20 | Simulasi kering lewat `eth_call` ke `submitSolution` sebelum mengirim | Tidak ada transaksi terkirim yang akan revert |
| F21 | Siklus hidup kirim dan finalisasi, jendela 10 detik dan tenggat 300 detik | Nol `expireBatch` selama satu jam operasi berkelanjutan |
| F22 | Operasi bonding, 500 USDG di `SolverRegistry` | `isActive` benar untuk kedua solver |
| F23 | Profil solver kedua untuk demo kompetisi | Dua solver mengajukan, yang savings-nya lebih tinggi menang, keduanya terbit di event |

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
| F24 | Konsumsi event, keberhasilan dan **kegagalan** | `SolutionRejected`, `BatchPassthrough`, `ClosingPrintWithheld`, `AuctionAborted`, `CommitmentDropped`, `OracleStale`, `OracleDisagreement` semuanya masuk tabel |
| F25 | Skema tabel sesuai `interfaces.md` §10 | Sembilan tabel terisi dari event, tidak ada kolom yang diisi tebakan |
| F26 | Kolom provenansi di setiap baris struk | Chain id, nomor blok chain ini, hash transaksi, log index, alamat pool, dan payload `eth_call` untuk menghitung ulang baseline |
| F27 | Metrik turunan | `savings_bps`, `netting_ratio`, `improvement_vs_venue`, `uptime`, dihitung dari event dan bukan dari klaim solver |
| F28 | Kedalaman konfirmasi dan rekonsiliasi | Angka indexer cocok dengan pembacaan langsung kontrak pada blok yang sama |

Catatan F26. Ini yang membuat layar Nabil lolos audit provenansi §11. Tanpa payload
verifikasi yang bisa disalin, tombol salin panggilan verifikasi di `demo.md` §2 tidak
punya isi, dan angkanya jadi angka yang harus dipercaya.

### 4.5 `analytics/`, tiga butir

| # | Fitur | Selesai kalau |
|---|---|---|
| F29 | Ekstraksi arus Agustus 2026 jadi fixture replay | Intent replay lahir dari kueri Dune `8595251` dan `8595303`, dengan nomor kueri tercatat di file keluarannya |
| F30 | Kurva netting lawan pangsa, berlabel BACKTEST **di data** | Kolom label ikut di CSV dan di respons API, bukan hanya di narasi UI |
| F31 | Rekonsiliasi setelah demo | Angka yang tampil di layar bisa dilacak balik ke event dan ke kueri, satu per satu |

### 4.6 CI, satu butir

| # | Fitur | Selesai kalau |
|---|---|---|
| F32 | `.github/workflows/backend.yml` | Lint, typecheck, unit test, dan gerbang differential baseline hijau di tiap PR. Build docker hijau |

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

### Hari 5, 24 September. Indexer dan struk, M2

F24, F25, F26, F27, lalu F11. Target M2 adalah struk yang menampilkan netting dan
selisih baseline, jadi hari ini juga masukkan dua intent berlawanan arah supaya
netting-nya tidak nol.

Indexer menunjuk ke anvil lokal, karena rentang `eth_getLogs` ditolak di endpoint
publik (§3).

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

### Hari 8, 27 September. M3, feature freeze

F32 hijau, F6, dan pengerasan. Setelah hari ini hanya perbaikan bug, uji, dan dokumen.

### Hari 9, 28 September. M4, audit provenansi

Telusuri setiap field API dan setiap angka yang kamu hasilkan dengan satu pertanyaan
`rencana-uji.md` §11.1. Yang tidak lolos **dipotong**, bukan diberi disclaimer.

F30 dan F31 dikerjakan hari ini, karena keduanya adalah alat audit itu sendiri.

### Hari 10, 29 September. M5 dan runbook

Runbook operasi backend, yaitu cara menyalakan, cara membaca log, apa yang dilakukan
kalau solver diam, dan siapa memanggil apa. Satu perintah demo yang berjalan dari mesin
bersih.

### Hari 11, 30 September. Buffer

Dukungan deck dan video. Tidak ada kode baru.

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

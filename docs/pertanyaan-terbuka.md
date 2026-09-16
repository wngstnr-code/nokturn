# Nokturn — Pertanyaan Terbuka

> Semua hal yang belum diketahui, dikumpulkan di satu tempat, **diurutkan menurut
> seberapa besar ia mengubah desain kalau jawabannya buruk.**
>
> Aturan: jangan menulis kode yang bergantung pada P0 sebelum P0 terjawab.

---

## P0 — Memblokir. Jawab di hari pertama.

### P0-1 · Bisakah transfer Stock Token gagal karena gate KYC/yurisdiksi?

**Kenapa memblokir.** Kalau transfer bisa di-revert oleh compliance hook, maka
satu intent yang gagal akan menjatuhkan **seluruh batch** — dan itu mengubah
desain `finalize()` secara mendasar.

**Cara menjawab:**
```
1. Deploy kontrak uji di testnet Robinhood Chain (46630)
2. Transfer Stock Token: EOA→EOA, EOA→kontrak, kontrak→EOA, kontrak→kontrak
3. Coba dari alamat tanpa riwayat apa pun (proksi "belum KYC")
4. Baca kode implementasi di balik beacon proxy — cari hook _beforeTokenTransfer
5. Ulangi di mainnet (4663) dengan jumlah sangat kecil — perilaku bisa berbeda
```

**Kalau jawabannya "ya, bisa gagal":**
- `finalize()` harus **isolasi kegagalan per intent**, bukan revert menyeluruh
- Tapi mengeluarkan satu intent **mengubah harga kliring bagi yang lain** —
  melanggar keseragaman harga
- Solusi: pra-verifikasi kelayakan transfer **sebelum** kliring (staticcall probe),
  dan keluarkan intent yang tidak layak **sebelum** harga dihitung. Kliring lalu
  hanya berjalan atas intent yang dijamin bisa settle
- Konsekuensi: solver wajib menjalankan probe kelayakan; tambahan gas; dan intent
  yang tidak layak harus dapat pesan error yang jelas di UI

**Kalau "tidak, transfer selalu berhasil":** desain saat ini berlaku apa adanya.

---

### P0-2 · Apakah Permit2 ter-deploy di Robinhood Chain?

**Kenapa memblokir.** Menentukan UX seluruh alur intent.

**Cara menjawab:** cek alamat kanonik Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`
di chain 4663 dan 46630 lewat block explorer / `eth_getCode`.

**Kalau tidak ada:** pakai approval biasa ke `Settlement`. UX lebih berat (satu
approval per token) tapi tidak memblokir. Alternatif: EIP-2612 `permit` kalau
Stock Token mendukungnya — **periksa ini sekalian.**

---

### P0-3 · Feed oracle apa yang benar-benar tersedia di mainnet?

**Kenapa memblokir.** Price band, session gating, dan baseline semuanya bergantung
pada ini.

**Yang harus dikumpulkan:**

| Item | Untuk apa |
|---|---|
| Alamat feed Chainlink per token di chain 4663 | Harga referensi |
| Heartbeat & deviation threshold tiap feed | Kalibrasi `STALENESS_OPEN` / `STALENESS_CLOSED` |
| Apakah feed menyediakan **flag status pasar** | Deteksi halt (`desain-session-engine.md` §7) |
| Apakah ada harga **pembukaan/penutupan resmi** terpisah | Wajib untuk ROO dan settlement lelang |
| Ketersediaan & alamat RedStone | Oracle kedua untuk deteksi ketidaksepakatan |
| Perilaku feed saat akhir pekan | Beku atau tetap jalan? |

**Kalau harga pembukaan resmi tidak tersedia onchain:** intent ROO tidak bisa
diselesaikan sesuai desain. Alternatif: pakai harga kliring lelang pembukaan itu
sendiri sebagai referensi — **tapi itu melingkar**, jadi harus dipikirkan ulang
dengan serius. Ini risiko desain terbesar kedua setelah P0-1.

---

### P0-4 · Bagaimana perilaku `uiMultiplier` (ERC-8056) sesungguhnya?

**Cara menjawab:** baca implementasi Stock Token; cari riwayat event
`UIMultiplierUpdated` di mainnet lewat Dune; cari tahu kapan multiplier berubah
relatif terhadap jam bursa.

**Yang perlu diketahui:**
- Apakah perubahan terjadi tepat pada waktu tertentu (mis. sebelum pembukaan)?
- Apakah `balanceOf` benar-benar tidak berubah, seperti dijanjikan spesifikasi?
- Apakah ada peringatan sebelum perubahan berlaku?

**Kalau multiplier bisa berubah kapan saja tanpa peringatan:** setiap batch wajib
memeriksa multiplier di awal dan saat settle, lalu revert kalau berubah. Sudah ada
di desain — tapi frekuensinya menentukan apakah ini gangguan kecil atau masalah
operasional nyata.

---

## P1 — Penting. Jawab di minggu pertama.

| # | Pertanyaan | Kalau jawabannya buruk |
|---|---|---|
| P1-1 | Alamat kontrak Uniswap/Arcus/Rialto di chain 4663, dan apakah ada fungsi kuotasi yang bisa di-`staticcall` | Baseline tidak bisa diverifikasi onchain → model fee harus dirombak |
| P1-2 | Berapa gas nyata `verify()` di Stylus untuk N = 10/50/100/200/500 | Menentukan ukuran batch maksimum yang ekonomis |
| P1-3 | Apakah Stylus benar-benar aktif di mainnet 4663 (bukan hanya testnet) | Verifier harus turun ke Solidity; ukuran batch mengecil drastis |
| P1-4 | Perilaku sequencer: apakah ada mempool privat atau urutan yang bisa diprediksi | Memengaruhi keparahan penyalinan solusi |
| P1-5 | Likuiditas nyata per stock token di tiap venue | Menentukan token allowlist awal dan exposure cap |
| P1-6 | Apakah Stock Token punya `permit` (EIP-2612) | UX approval |

---

## P2 — Bisa ditunda, tapi jangan dilupakan

| # | Pertanyaan |
|---|---|
| P2-1 | Ambang laju arus untuk durasi batch adaptif — butuh data mainnet nyata dulu |
| P2-2 | Apakah ada protokol yang bersedia mengonsumsi closing print. **⚠️ Sebagian terjawab 10 September 2026:** pertanyaan *interface* sudah tidak terbuka — **seluruh** konsumen harga ekuitas di chain ini memakai `AggregatorV3Interface`, jadi itu yang kita terbitkan (`desain-auction.md` §3.3). Yang masih terbuka: **siapa** yang mau — tapi kandidat pertamanya sekarang bernama: **Ripe Protocol** (`Teller` + `sGREEN`, live di chain ini, produknya persis meminjam dengan agunan saham tokenized), dan `PriceDesk.vy` mereka memang dirancang menerima sumber harga berprioritas. Dan calon terbesarnya bukan Morpho — irisan lending cuma 20–38 pengguna, sementara mayoritas permintaan datang dari **produk taruhan atas harga saham** (§3.3b). Pertanyaannya berubah jadi: *apakah produk penyelesaian-harga mau memakai print yang bisa menolak terbit?* |
| P2-3 | Apakah Karma / framework agent tertarik integrasi, dan apa syarat teknis mereka |
| P2-4 | Posisi regulasi lelang non-kustodial atas sekuritas tokenized di Singapura — siapkan satu slide |
| P2-5 | Apakah Robinhood berencana meluncurkan venue batching sendiri |

---

## RONDE 2 — verifikasi menyeluruh sebelum mulai membangun (1 Agu 2026)

### ✅ P1-3 — Stylus aktif di mainnet

| Item | Mainnet 4663 | Testnet 46630 |
|---|---|---|
| `ArbWasm.stylusVersion()` | **3** | **3** |
| `ArbSys.arbOSVersion()` | 116 | 116 |
| `inkPrice()` | 10.000 | — |
| `pageLimit()` | 128 halaman (8 MB) | — |

**Testnet identik dengan mainnet — untuk lapisan eksekusi Stylus/ArbOS saja.**
⚠️ Kesetaraan itu **tidak berlaku untuk aset dan venue**; lihat P2-6 di bawah.

---

### 🔴 P2-6 — Testnet TIDAK punya infrastruktur ekuitas sama sekali (2 Agu 2026)

Diverifikasi lewat `eth_getCode` langsung ke kedua RPC, dengan alamat yang sama
sebagai kontrol.

| Kontrak | Mainnet 4663 | Testnet 46630 |
|---|---|---|
| StockFactory `0xee351e53…` | 4.926 byte | **0** |
| Stock Token beacon `0xe10b6f6b…` | 2.332 byte | **0** |
| NVDA `0xd0601CE1…` | 283 byte | **0** |
| TSLA `0x322F0929…` | — | **0** |
| USDG kanonik `0x5fc5360d…` | 170 byte | **0** |
| Uniswap V3 factory `0x1F98431c…` | 2.109 byte | **0** |
| Permit2 `0x00000000…78BA3` | 9.152 byte | **9.152 byte** |

Kontrolnya penting: alamat kanonik Uniswap V3 **memang terpakai** di mainnet, jadi
nol di testnet bukan artefak alamat yang salah. Permit2 ada di dua-duanya karena
di-deploy deterministik lewat CREATE2 di semua chain.

**Konsekuensi — demo tidak bisa memakai pasar sungguhan.**

Tidak ada Stock Token, tidak ada USDG kanonik, tidak ada pool V3 di testnet. Apa pun
yang berjalan di 46630 memakai token dan pool yang **kita deploy dan isi sendiri**.
Itu sah untuk membuktikan mekanisme, tapi baseline yang tampil di sana **bukan
baseline pasar nyata** — dan itu harus disebut duluan, bukan ditunggu ditanya juri.

Tiga jalur, dan ketiganya bisa dipakai bersamaan:

1. **Fork test terhadap state mainnet** (`rencana-uji.md` §6) — satu-satunya tempat
   `quoteFromState` diadu dengan Uniswap V3 sungguhan. Gerbang **nol selisih** sudah
   ditetapkan dan tidak berubah. Ini yang membuat klaim baseline tetap sahih meski
   demo berjalan di testnet.
2. **Demo di atas fork mainnet** (Anvil/Foundry) — memakai pool, token, dan harga
   nyata. Paling meyakinkan secara visual, tanpa mempertaruhkan dana.
3. **Testnet 46630** — untuk alur end-to-end, gasless, dan UI. Jujur sebut bahwa
   tokennya token uji.

⚠️ **Belum diuji:** apakah ada Stock Token di testnet pada alamat yang sama sekali
berbeda (deployer lain). Peluangnya kecil — beacon dan factory pun tidak ada — tapi
pemeriksaan ini berbasis alamat, bukan sapuan penuh isi chain. Tidak ada explorer
testnet yang ditemukan (lima hostname dicoba, semuanya gagal), jadi sapuan penuh
butuh indexer sendiri.

#### ⚠️ Tidak ada cache manager terdaftar

`ArbWasmCache.allCacheManagers()` mengembalikan **array kosong** (offset 0x20,
length 0). Terverifikasi ulang 1 Agustus 2026.

---

### ✅ P1-3 lanjutan — biaya init Stylus TERUKUR (1 Agustus 2026)

Sebelumnya ini cuma kekhawatiran teoretis. Sekarang ada angkanya, diukur dari
**program Stylus sungguhan di mainnet 4663**.

#### Menemukan programnya

⚠️ **`robinhood.creation_traces` Dune TIDAK merekam deploy Stylus sama sekali.**
Dari 1.861.577 kontrak yang tercatat, **nol** berawalan `0xEF` — padahal ada tiga
program Stylus nyata di chain ini. Ini **kasus kedua** dari pelajaran yang sama:
*ketiadaan data dalam satu view bukan bukti ketiadaan aktivitas.*

Jalur yang berhasil: telusuri trace ke precompile **`ArbWasm` `0x…0071`**, cari
selector `activateProgram(address)` = **`0x58c780c2`**, ambil alamat dari calldata.

| Program | Aktivasi | Gas aktivasi | dataFee |
|---|---|---|---|
| `0xABCE50D4038D9CFA6BC85FF8768D7B1E8149B2E5` | 25 Jul 2026 | 7.732.596 | ~0,000198 ETH |
| `0x5E6EDA74CC2ABEA0DE3A322337993B9BF1DE9654` | 29 Jul 2026 | 7.779.040 | ~0,000200 ETH |
| `0xCC049D1DEDE2AA33C18312CC37AF914E954D6EDA` | 30 Jul 2026 | 8.175.905 | ~0,000211 ETH |

Semua di-deploy oleh `0xB00BEED006746831C8E789809A7EB3881F42CF9C` lewat deployer
`0xE1E9053F2CAB95752F7C1196FD286A178F3F34D4`.

#### ⭐ Angka intinya — `programInitGas()`

| Program | **initGas (uncached)** | initGas (cached) | Rasio | Footprint | asmSize |
|---|---|---|---|---|---|
| `0xABCE50D4…` | **46.440** | 5.919 | 7,8× | 17 halaman | 2.162.688 B |
| `0x5E6EDA74…` | **46.822** | 5.990 | 7,8× | 17 halaman | 2.181.120 B |
| `0xCC049D1D…` | **49.203** | 6.209 | 7,9× | 17 halaman | 2.289.664 B |

Parameter chain pendukung: `minInitGas()` = **8.832 uncached / 352 cached** (lantai
untuk program paling sepele) · `initCostScalar` 100 · `pageGas` 1.000 ·
`freePages` 2 · `expiryDays` 365 · `keepaliveDays` 31 · **`blockCacheSize` 32**.

#### Cara membaca angka ini

**Denda tetapnya ~46–49rb gas per panggilan, dan itu untuk program 2,2 MB.**
Lantainya 8.832. Verifier kliring kita aritmetika murni tanpa dependensi berat,
jadi kemungkinan besar jauh lebih ramping dari 17 halaman — **perkiraan wajar
15rb–25rb**, tapi itu interpolasi, bukan ukuran.

**Konteks:** program ketiga hidup dengan trafik nyata — 4.109 panggilan, 900 tx,
**126 pemanggil berbeda**, median gas per panggilan **229.045**. Jadi init ≈ **21%**
dari panggilan median. Signifikan, tapi **jauh dari prohibitif**.

⚠️ **Nuansa yang mengubah gambaran:** gas minimum yang teramati pada program itu
**23.587** — di bawah cold init 49.203. Penjelasan paling mungkin: **`blockCacheSize`
= 32 memberi cache LRU per blok**, sehingga panggilan berulang di blok yang sama
membayar jalur cached (~6,2rb), bukan cold. Belum dipastikan; bisa juga akuntansi
gas di level trace. **Uji ini saat implementasi.**

#### Putusan sementara

Framing lama *"Stylus mungkin kalah total di chain ini"* **terlalu pesimistis.**
Denda tetapnya nyata, terbatas, dan tidak menghalangi. Yang **masih** belum
terukur — dan tidak bisa diukur tanpa dua implementasi — adalah biaya per-intent
Stylus versus Solidity, yang menentukan titik impas sesungguhnya.

**Yang berubah:** ini turun dari *blocker arsitektur* menjadi *benchmark rutin di
Fase 2*. Rencana "tulis verifier Solidity dulu, port ke Rust, differential test"
tetap benar apa adanya — dan versi Solidity-nya memang tetap dibutuhkan sebagai
oracle pembanding.

**Catatan tambahan yang harus masuk pitch:** kalau Nokturn memakai Stylus, ia jadi
**program Stylus ke-4 di chain ini** — dan satu-satunya yang bukan uji coba.
Dua dari tiga program yang ada masing-masing cuma dipanggil 1–2 kali.

---

### ✅ TWAP Uniswap V3 tersedia — oracle kedua aman

`observationCardinality` (butuh > 1 agar TWAP bisa dihitung):

| Pool | Cardinality | Liquidity |
|---|---|---|
| NVDA-USDG | **6.000** | 7,9e18 |
| GME-USDG (1) | 1.500 | 1,2e18 |
| GME-USDG (2) | 1.500 | 1,3e18 |
| SPCX-USDG | 1.500 | 1,3e17 |

Jendela TWAP 30 menit tercakup dengan sangat longgar. Desain dual-source aman.

---

### ✅ P1-6 — Stock Token mendukung EIP-2612 `permit`

`DOMAIN_SEPARATOR()`, `nonces(address)`, dan `eip712Domain()` (ERC-5267) semuanya
merespons. Salah satu pemegang bahkan sudah memakai permit (`nonces` = 1).

**Artinya ada DUA jalur approval gasless:** Permit2 **dan** EIP-2612 native.
Lebih fleksibel dari asumsi awal.

---

### ✅ Identitas kontrak venue — TUNTAS

| Alamat | Identitas | Bukti |
|---|---|---|
| `0x65050A9B7E5075A2BA5CED7B1B64EE66262C40DC` | **Router agregator dominan** ⭐ | `TransparentUpgradeableProxy` → `0x73a160aa…`. Selector utama `0x4d819a2a` = `swap((uint8,address,address,address,uint24,int24,address,bytes,address,bytes32)[],address,uint256,uint256,uint256)` — multi-hop dengan diskriminator tipe pool. **1.131.568 panggilan dari 25.316 alamat berbeda** dalam 3 hari. Juga menerima selector SwapRouter UniV3 (`exactInput`, `exactInputSingle`) |
| `0x1D4B86491EC211257CBEDD77A4380A7494624EFF` | **RobinHoodSettler** (terverifikasi) | `execute((address,address,uint256),bytes[],bytes32)`. 2 pemanggil — kontrak settlement internal Robinhood, **bukan venue** |
| `0x006102B16A04C20306A28B652745D3973D7D24FA` | **ArcusSettlement** (terverifikasi) | `ERC1967Proxy` → `0xf31022dD…` |
| `0x2F4579CA81717D3D61BF8B6F06571877BBE54A07` | **Kontrak operasional, bukan venue** | Selector tunggal `transferToken(address,uint256)`, 1 pemanggil. Volumenya perpindahan, bukan perdagangan |
| `0x9F736F87E6293AC1BD9142E257DBFAC8B7ACF1AE` | Kemungkinan pool | Nol transaksi langsung — hanya dipanggil internal |

#### ⭐ Temuan terpenting ronde ini

**`0x65050A9B…` adalah pintu masuk order flow ritel yang sebenarnya** —
25.316 alamat berbeda dalam 3 hari. Hampir pasti router yang dipakai Robinhood Wallet.

**Dampak lintas dokumen:**
1. **Distribusi** — ini kanal berleverage tertinggi, jauh di atas dugaan awal.
   Dirutekan oleh router ini > membangun aplikasi sendiri
2. **Baseline** — pembanding yang paling jujur bukan "harga di pool Uniswap",
   melainkan **apa yang router ini berikan**, karena itulah yang benar-benar
   dipakai pengguna
3. **Adapter** — router ini sudah mengagregasi lintas tipe pool. Memakainya sebagai
   satu adapter mungkin lebih efisien daripada membangun adapter per-venue

---

### 🔴 KRITIS — feed Chainlink MEMBEKU saat akhir pekan

Interpretasi awal *"feed hidup 24 jam"* **tidak lengkap**. Feed hidup 24 jam
**pada hari kerja**. Di akhir pekan, `max_gap` hampir setiap feed adalah
**173.000–202.000 detik (48–56 jam)** — yaitu benar-benar diam dari Jumat sore
sampai Senin.

**Dua konsekuensi desain yang harus ditangani:**

**1. Price band akhir pekan tidak boleh berbasis "harga wajar saat ini".**
Yang tersedia hanyalah harga penutupan Jumat. Band 150 bps terhadap harga berumur
2 hari terlalu ketat kalau ada berita besar, dan tidak bermakna sebagai pagar.

**2. Pemeriksaan ketidaksepakatan dual-oracle AKAN SELALU MENYALA di akhir pekan.**
Chainlink beku di harga Jumat; TWAP UniV3 hidup mengikuti pasar onchain. Selisih
50 bps pasti terlampaui → **semua token masuk `PROTECTIVE` sepanjang akhir pekan**,
yaitu justru sesi yang paling ingin kita layani.

**Perbaikan yang diperlukan:**

| Sesi | Peran Chainlink | Peran TWAP | Pemeriksaan ketidaksepakatan |
|---|---|---|---|
| `OPEN`, `PRE`, `POST` | Referensi harga wajar | Pembanding | ✅ Aktif, 50 bps |
| `CLOSED_OVERNIGHT` | Referensi (masih update) | Pembanding | ✅ Aktif, ambang dilonggarkan |
| **`CLOSED_WEEKEND` / `HOLIDAY`** | **Jangkar penutupan terakhir** — bukan harga wajar | **Sumber harga utama** | ❌ **Nonaktif.** Ganti dengan batas drift terhadap penutupan Jumat |

Ini harus masuk `desain-session-engine.md` dan `parameter.md` sebelum menulis
`PriceOracle.sol`.

---

### 🔴 Cadence feed sangat timpang — memengaruhi allowlist

Jeda antar-update terukur (24–31 Juli):

| Aset | Feed | p50 buka | p95 buka | p50 tutup | Catatan |
|---|---|---|---|---|---|
| NVDA | `0xC9D16E4F…` | 596 dtk | 5.281 | 4.162 | Layak |
| TSLA | `0x7A6B81BA…` | 606 dtk | 5.281 | 2.941 | Layak |
| AAPL | `0xBB11A212…` | 1.200 dtk | 8.965 | 1.102 | Layak |
| META | `0xC190B616…` | 771 dtk | 4.891 | 637 | Layak |
| MSFT | `0xC3B117F5…` | 822 dtk | 9.452 | 537 | Layak |
| **GME** | `0xF83CDE62…` | **3.841 dtk** | **64.297** | 15.292 | ⚠️ **Sangat jarang** — hanya 32 update saat bursa buka dalam seminggu |
| **SPY** | `0x78BCB218…` | **8.853 dtk** | **86.417** | 21.877 | ⚠️ **Paling jarang** — hanya 16 update |
| SGOV | `0x0E96B770…` | — | — | 86.426 | Harian |

**Masalahnya serius:** **GME adalah token volume nomor dua** ($31,6jt + $24,9jt di
dua pool) tapi feed-nya salah satu yang paling jarang. **SPY** juga.

**Dampak:** allowlist awal tidak bisa dipilih berdasarkan volume saja — harus
**volume DAN kualitas feed**. GME dan SPY butuh `STALENESS_MULTIPLIER` yang jauh
lebih longgar, atau ditunda.

> ⚠️ Kandidat yang sempat ditulis di sini (NVDA, TSLA, META, MSFT) **sudah usang** —
> itu dinilai dari kualitas feed saja. Setelah volume per-token dan likuiditas akhir
> pekan ikut diukur, META dan MSFT gugur karena volumenya tipis.
> **Allowlist final: NVDA, AAPL, TSLA, GOOGL** — sumber kebenarannya
> [`parameter.md`](parameter.md) §7.4.

---

---

## RONDE 4 — pertanyaan BARU dari refresh data Agustus 2026 (3 September 2026)

> Riset onchain dijalankan ulang 3 September 2026 dan pasarnya bergerak jauh lebih
> cepat dari yang diasumsikan: volume stock token naik **3,6×** dan dompet aktif
> **2,3×** dalam satu bulan. Tiga pertanyaan baru lahir dari situ. Ketiganya
> **tidak memblokir penulisan kode**, tapi dua di antaranya menyentuh keputusan
> yang sudah terkunci. Angka lengkap: `parameter.md` §1B dan `CLAUDE.md` §6.

### 🔴 P4-1 · Apakah cadence feed Chainlink SPY sudah membaik?

**Kenapa mendesak.** SPY melonjak dari $5,1jt (Juli) ke **$211,6jt** (Agustus),
naik **42×**, dan sekarang jadi stock token **nomor dua** dengan 67.064 dompet.
Volumenya **3,3× gabungan AAPL + TSLA + GOOGL**. SPY ditunda dari allowlist v1.0
semata karena cadence feed-nya terlalu jarang (P0-3, diukur 1 Agustus 2026).

**Yang berubah bukan alasannya, melainkan ongkosnya.** Menunda SPY hari ini berarti
melepas separuh arus yang bisa dinetting. Alasan teknisnya mungkin masih berdiri —
cadence feed **tidak bisa** diukur dari `dex.trades` dan **belum diperiksa ulang**.

**Cara menjawab:** hitung jarak antar-`AnswerUpdated` pada feed SPY
`0x78BCB218FA04B9B3A278EBC865ED320BF8DEFBAC` sepanjang Agustus 2026, pisahkan per
sesi, lalu bandingkan dengan ambang staleness di `parameter.md` §3.

**Konsekuensi tiap cabang.** Membaik → SPY masuk lewat time-lock allowlist, bukan
deploy ulang, dan arus yang bisa dinetting hampir dua kali lipat. Tetap jarang →
keputusan menundanya berdiri, **tapi volumenya tetap disebut apa adanya di pitch**,
bukan disembunyikan karena tidak nyaman.

⚠️ SPCX ($212,9jt, nomor tiga) **tidak** ikut pertanyaan ini: ia tidak punya feed
sama sekali, dan itu tidak berubah karena volume.

### ✅ P4-2 · TERJAWAB 16 September 2026 — `BATCH_WEEKEND` turun ke 60 detik

**Premis lamanya sudah runtuh.** Alasan tertulis untuk 120 dtk adalah *"arus paling
jarang, butuh jendela terpanjang."* Data Agustus membatalkannya:

| | Juli 2026 | Agustus 2026 |
|---|---|---|
| Pangsa akhir pekan dari seluruh trade | 12,9% | **33,2%** |
| Pedagang berbeda per batch 45 dtk, akhir pekan | 4,14 | **8,01** |
| Pedagang berbeda per batch 45 dtk, off-hours hari kerja | 5,30 | 7,47 |

Akhir pekan **bukan lagi sesi paling tipis** — batch-nya justru lebih ramai daripada
off-hours hari kerja. Dan imbal hasil menunggu lebih lama tipis: 60 dtk memberi
netting antar-counterparty 51,77%, 120 dtk memberi 54,11%. **+2,34 pp ditukar dengan
tambahan 60 detik latensi**, untuk sepertiga dari seluruh arus.

**Diterapkan 16 September 2026, keputusan pemilik proyek: 120 dtk turun ke 60 dtk.**

Dasar angkanya adalah ambang imbal hasil marginal yang sudah dipakai untuk berhenti
di 45 dtk pada `BATCH_OVERNIGHT`, yaitu 0,079 pp/dtk. Di akhir pekan, langkah 45 ke
60 dtk bernilai 0,101 pp/dtk sehingga masih layak dibayar, sedangkan langkah 60 ke
90 dtk hanya 0,051 pp/dtk. Nilai lama 120 dtk membayar dengan imbal 0,027 pp/dtk.
Rincian dan alasan kenapa tidak disamakan 45 dtk ada di `parameter.md` §1B.

`BATCH_HOLIDAY` sengaja tidak ikut turun karena hari libur bursa belum pernah diukur
sama sekali.

**Terkait:** `WEEKEND_DRIFT_CAP_BPS` = 1.500 dikalibrasi dari drift TSLA 781 bps.
Pergerakan antar-trade TSLA akhir pekan turun dari p90 950,4 bps (Juli) ke 67,8 bps
(Agustus). **Itu bukan metrik yang sama** — drift terhadap penutupan Jumat berbeda
dari pergerakan antar-trade — jadi cap-nya **tidak otomatis batal**, tapi perlu
diukur ulang dengan definisi yang benar sebelum peluncuran.

### ✅ P4-3 · Kueri Dune sudah bisa diverifikasi juri — SELESAI 3 September 2026

Sembilan kueri Agustus 2026 (`8595234` · `8595239` · `8595244` · `8595247` ·
`8595251` · `8595303` · `8595357` · `8595365` · `8595386`) sudah dibalik ke
`is_temp: false` dan `is_private: false`, diberi nama bernomor, deskripsi
metodologi berbahasa Inggris, tag, dan visualisasi, lalu dirakit jadi satu
dashboard bernarasi:

**[Nokturn — Robinhood Chain equity market structure (August 2026)](https://dune.com/passchick/nokturn-robinhood-chain-equity-market-structure-august-2026)**

Dashboard-nya memuat empat bagian bernarasi, indeks kueri yang bisa diklik, dan
— secara sengaja — bagian yang mengumumkan bahwa klaim p90 3,3× kami sendiri
gugur, plus daftar angka yang belum diukur ulang.

⚠️ **Catatan penting:** dashboard terbit di bawah handle **`passchick`**, bukan
`wngstnrs7119` seperti dashboard Juli. Keduanya akun berbeda, dan itu pula sebabnya
kueri Juli tidak bisa diambil kembali dari sesi ini. Pastikan tautan yang dikirim
ke juri adalah tautan `passchick` di atas.

Dan pelajarannya sudah mahal sekali: SQL kueri Juli (8194489–8194525) **tidak bisa
diambil kembali** karena disimpan temporer. Itulah sebabnya angka Juli tidak bisa
direproduksi persis dan blok Juli harus diganti seluruhnya, bukan disajikan sebagai
pertumbuhan. **Jangan ulangi kesalahan yang sama untuk Agustus.**

---

## RONDE 3 — sapuan terakhir sebelum menulis kode

### ✅ Batas gas & biaya calldata — sangat menguntungkan

| Item | Nilai |
|---|---|
| `gasLimit` blok | 1.125.899.906.842.624 (2⁵⁰) — praktis tak terbatas |
| `gasUsed` blok terkini | 2.469.462 — chain jauh dari padat |
| `baseFeePerGas` | 20.814.000 wei (~0,021 gwei) |
| `getMinimumGasPrice()` | 20.000.000 wei |
| **`getL1BaseFeeEstimate()`** | **0** |

> ⭐ **Biaya data L1 = NOL.** Ini besar untuk kita: settlement batch itu
> calldata-berat (N intent + tanda tangan). Di kebanyakan L2, biaya calldata
> mendominasi dan membatasi ukuran batch. **Di sini praktis gratis**, sehingga
> batch besar layak secara ekonomi.
>
> ⚠️ **Risiko:** ini bisa berubah kalau Robinhood mengaktifkan pass-through biaya
> L1. Desain sebaiknya tidak *bergantung* pada calldata gratis — jaga agar tetap
> efisien, dan pantau nilai ini.

### ❌ Router `0x65050A9B…` TIDAK bisa dikuotasi onchain

Semua selector kuotasi umum revert: `quote`, `getAmountsOut`, `quoteExactInput`,
`quoteExactInputSingle`.

**Ini membatalkan sebagian keputusan yang baru kutulis di `desain-ekonomi.md`.**
Baseline **tidak bisa** diverifikasi kontrak terhadap router.

**Resolusi — pisahkan dua hal dengan tegas:**

| | Sumber | Sifat |
|---|---|---|
| **Baseline onchain** (dasar fee) | Perhitungan dari state pool Uniswap **V3** | ✅ Terverifikasi kontrak, trustless |
| **Metrik publikasi** (vs router) | Simulasi offchain terhadap router | ⚠️ **Tidak** dapat diverifikasi kontrak — metodologi harus dipublikasikan |

Jangan pernah mengklaim perbandingan-terhadap-router itu trustless. Itu metrik
pemasaran dengan metodologi terbuka, bukan jaminan protokol.

### 🔴 Pool Uniswap V4 dominan MEMAKAI HOOKS dengan fee dinamis

| Hook | Fee | tickSpacing | Pool stock |
|---|---|---|---|
| `0x4E3468951D49F2EEA976ED0D6E75FFCB44A9A544` | **8388608** = `0x800000` = **DYNAMIC_FEE_FLAG** | 200 | **5.540** |
| `0x4E3468951D49F2EEA976ED0D6E75FFCB44A9A544` | dinamis | 8 | **4.515** |
| `0x8AA375F7186F86BBAC7B13AB01DB189EBE50C0C4` | 0 | 60 | 996 |
| `0x778B0C4EEA7D35D66513B587BA87FC9084B0EACC` | 0 | 200 | 342 |
| `0x0000…0000` (tanpa hook) | 10000 | 200 | 175 |

**Dampak — ini mematahkan asumsi inti baseline:**

Rencana "hitung baseline dari state pool" **berlaku untuk Uniswap V3** (fee statis,
matematika standar) tapi **TIDAK untuk pool V4 berhook dengan fee dinamis**:

1. Fee ditentukan hook **saat swap**, tidak bisa dibaca dari `slot0`
2. Hook `beforeSwap`/`afterSwap` bisa mengubah jumlah keluaran sepenuhnya
3. Tanpa membaca kode hook (belum terverifikasi di Blockscout), keluarannya
   **tidak bisa diprediksi**

**Resolusi untuk v1.0:**

> **Adapter v1.0 = Uniswap V3 saja.** Baseline hanya diverifikasi terhadap pool V3.
> Dukungan V4 ditunda sampai perilaku hook `0x4E346895…` dipahami.

Ini masuk akal secara volume: **V3 $193,8jt versus V4 $106,1jt** — V3 tetap
mayoritas. Dan lebih penting: v1.0 jadi punya baseline yang **benar-benar
terverifikasi kontrak**, bukan yang setengah dipercaya.

⚠️ Hook `0x4E346895…` juga muncul di daftar counterparty (480.917 leg) — ini
komponen aktif, bukan eksperimen. Memahaminya adalah pekerjaan v1.1 yang nyata.

---

### Alat verifikasi yang terbukti bekerja

**Blockscout API** (untuk membaca source terverifikasi), lewat bypass DNS:
```bash
IP=104.26.0.65   # robinhoodchain.blockscout.com
curl --resolve "robinhoodchain.blockscout.com:443:$IP" \
  "https://robinhoodchain.blockscout.com/api/v2/smart-contracts/<ADDR>"
curl --resolve "robinhoodchain.blockscout.com:443:$IP" \
  "https://robinhoodchain.blockscout.com/api/v2/addresses/<ADDR>"
```

**Lookup selector:** `https://api.openchain.xyz/signature-database/v1/lookup?function=<0x…>&filter=true`

Explorer lain: `robinscan.io`, `explorer.chain.robinhood.com`

---

## Cara memakai dokumen ini

1. **Jangan tulis kode yang bergantung pada P0 sebelum P0 terjawab.** Bekerja di
   sekitarnya boleh — scaffold, CI, analitik, Session Engine (tidak bergantung
   pada P0 mana pun)
2. Catat jawabannya **di sini**, bersama tanggal dan bukti (tx hash, tautan
   explorer, potongan kode)
3. Kalau jawabannya mengubah desain, perbarui dokumen terkait **di hari yang sama**
   — jangan biarkan dokumen dan kenyataan berpisah

---

## Catatan jawaban

### ⚠️ Prasyarat: DNS ISP Indonesia mencegat domain Robinhood Chain

`rpc.mainnet.chain.robinhood.com` dan `rpc.testnet.chain.robinhood.com` **resolve
ke `internetpositif.id` (36.86.63.185)** dari jaringan Indonesia — termasuk saat
memakai resolver 1.1.1.1 dan 8.8.8.8, karena pencegatannya di level jaringan.
Gejalanya: `SSL certificate has expired` dan kegagalan berselang-seling.

**IP asli** (via DNS-over-HTTPS): `rpc.mainnet.chain.robinhood.com` →
CNAME `customer-origin.offchainlabs.com` → **172.66.147.70** / 104.20.46.209

**Workaround yang terbukti bekerja:**
```bash
curl --resolve rpc.mainnet.chain.robinhood.com:443:172.66.147.70 \
  -X POST https://rpc.mainnet.chain.robinhood.com \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```
Untuk Foundry: pakai VPN, DNS-over-HTTPS di level sistem, atau endpoint provider
berbayar (Alchemy/QuickNode/Chainstack) di domain berbeda.
`https://robinhood.drpc.org` bisa diakses tapi **hanya mendukung `eth_chainId`**.

---

### ✅ P0-1 — Bisakah transfer Stock Token gagal karena gate KYC/yurisdiksi?

**Jawaban: TIDAK.** Diuji 31 Juli 2026 di mainnet (4663).

Simulasi `eth_call` dari pemegang nyata:

| Uji | Hasil |
|---|---|
| `transfer` → alamat belum pernah dipakai (`0x…DeaDBeef`) | ✅ `true` |
| `transfer` → alamat acak lain | ✅ `true` |
| `transfer` → pemegang lain | ✅ `true` |
| **`transferFrom` via Permit2 → alamat baru** | ✅ **OK** |
| Dari alamat bersaldo nol | ❌ revert — *insufficient balance*, bukan pembatasan |

**Probe antarmuka pembatasan — semuanya revert (tidak ada):**
`detectTransferRestriction` (ERC-1404) · `canTransfer` · `isTransferAllowed` ·
`isBlocked` · `blocked` · `isFrozen` · `frozen` · `isBlacklisted` · `blacklisted`

**Berlaku untuk SEMUA Stock Token:** NVDA, TSLA, AAPL, SPY, MSFT, META semuanya
berbagi beacon yang sama → **logika transfer identik**.
Beacon: `0xe10b6f6b275de231345c20d14ab812db62151b00`

**Dampak desain:** ✅ **Desain `finalize()` saat ini berlaku apa adanya.**
Tidak perlu isolasi kegagalan per intent, tidak perlu probe kelayakan pra-kliring.

**Sisa ketidakpastian yang tetap harus ditangani:**
1. Token **Pausable** — `paused()` ada dan bernilai `false`. Pause global mungkin
   terjadi → tangani sebagai kegagalan batch, dan pertimbangkan cek `paused()`
   sebelum kliring
2. Blocklist khusus alamat tersanksi **tidak bisa dibuktikan tidak ada** — alamat
   uji kita kebetulan tidak diblokir. Balance-delta assertion tetap wajib

---

### ✅ P0-2 — Apakah Permit2 ter-deploy?

**Jawaban: YA, di mainnet dan testnet.**
`0x000000000022D473030F116dDEE9F6B43aC78BA3` — 18.307 char kode.

**Bonus penting:** ditemukan approval Permit2 **aktif dipakai** untuk NVDA di
mainnet oleh pengguna nyata (allowance `type(uint256).max`). Artinya UX berbasis
Permit2 yang kita rencanakan **sudah cocok dengan perilaku pengguna yang ada.**

Kontrak kanonik lain yang terkonfirmasi ada:
Multicall3 · EntryPoint v0.6 · EntryPoint v0.7 · CreateX

---

### ✅ P0-4 — Bagaimana perilaku `uiMultiplier` (ERC-8056)?

**Jawaban 1 Agustus 2026: fungsi ada, semua token saat itu bernilai `1e18`.**

Selector `uiMultiplier()` = `0xa60bf13d`. Terverifikasi pada NVDA, TSLA, AAPL,
SPY, MSFT, META — semuanya `1000000000000000000`.

> ### Diperbarui 16 September 2026, dan bagian "semuanya 1e18" sudah tidak benar
>
> Empat token sudah bergeser. Frekuensinya sekarang **terukur**, bukan lagi
> "belum pernah terjadi". Tabel lengkap dan konsekuensi implementasinya ada di
> `parameter.md` §10.1.
>
> | Token | Nilai sekarang | Berubah | Waktu New York |
> |---|---|---|---|
> | NVDA | 1,000775e18 | 10 Sep | 20:00, bursa tutup |
> | AAPL | 1,000566e18 | 14 Agu | 11:12, bursa buka |
> | MSFT | 1,000413e18 | 11 Sep | 11:10, bursa buka |
> | GOOGL | 1,000194e18 | 15 Sep | 11:10, bursa buka |
>
> **Jawaban atas pertanyaan aslinya**, yaitu kapan multiplier berubah relatif
> terhadap jam bursa. Tiga dari empat perubahan jatuh di tengah sesi `OPEN`
> sekitar pukul 11:10 waktu New York, dan hanya satu di luar jam bursa. Jadi
> jebakan ini menyala di sesi paling ramai.
>
> **Yang berubah di desain.** Gerbang allowlist tidak boleh lagi menuntut nilai
> tepat `1e18`, karena gerbang seperti itu menolak NVDA, AAPL, GOOGL, dan MSFT.
> Gerbang yang benar adalah fungsinya ada, tidak revert, dan nilainya >= 1e18.
> Pemeriksaan awal lawan settle tetap wajib dan tetap murah, karena
> perubahannya satu lompatan diskret dan jarang.

**Dampak desain:** desain saat ini berlaku. Pemeriksaan multiplier di awal dan
saat settle tetap wajib.

---

### 🟡 P1-1 (dinaikkan ke P0) — Bisakah baseline diverifikasi onchain?

**Jawaban: YA, tapi mekanismenya harus diperbaiki dari yang tertulis di dokumen.**

**Koreksi penting.** Dokumen menyebut baseline diverifikasi lewat **`staticcall`**
ke adapter. **Itu salah** untuk Uniswap V3/V4: Quoter bekerja dengan menjalankan
swap lalu revert, sehingga ia mencoba `SSTORE` — dan `STATICCALL` menolak setiap
upaya modifikasi state.

**Dua jalur yang benar:**

| Jalur | Isi | Penilaian |
|---|---|---|
| **A — Hitung dari state pool** ✅ | Baca `slot0`, `liquidity`, `fee`, `token0/1`, lalu hitung sendiri dengan matematika Uniswap | **Direkomendasikan.** Murni view, gas jauh lebih murah, tanpa ketergantungan pada deployment Quoter. Terverifikasi: semua field bisa dibaca |
| B — `CALL` biasa ke Quoter | Bukan `staticcall`; dipanggil di dalam `finalize()` yang memang state-changing | Berfungsi, tapi mahal (~50–100rb gas per kuotasi) dan menambah ketergantungan |

Terverifikasi terbaca pada pool NVDA-USDG V3 (`0xD4EB…14A3`, $83jt volume):
`token0`=USDG · `token1`=NVDA · `fee`=500 (0,05%) · `liquidity` ✓ · `slot0` ✓

**Dampak desain:** `desain-ekonomi.md` §2.3, `interfaces.md` §3, dan
`spek-teknis.md` harus mengganti "staticcall ke adapter" menjadi **"hitung dari
state pool"**. Interface adapter perlu `quoteFromState(...)` yang `view`.

---

### 🟡 P0-3 — Feed oracle & harga pembukaan resmi

**Sebagian baik, sebagian buruk.** Diuji 31 Juli 2026 di mainnet.

#### ✅ Yang ada

**30 feed Chainlink aktif**, kontrak `DualAggregator 1.0.0`, 8 desimal,
antarmuka `AggregatorV3` standar (`latestRoundData`, `getRoundData`, `description`).

| Aset | Alamat feed |
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
| MSTR | `0x55BD01F666C99E4590E084FDEFF88041BB50CCD1` |
| COIN | `0x30398B0B0DF82A009BB2D507BC7FE1DC6D3CA294` |
| PLTR | `0x315AFD0F71D5407B99AD19AB001A67AF40FBAAF4` |

*(18 feed lain: ORCL, DELL, AMD, INTC, MU, SNDK, NBIS, CLSK, CRWV, RKLB, IONQ,
RGTI, CRCL, USAR, EWY, SLV, USO, SGOV)*

**Feed hidup 24 jam.** Update lebih sering saat bursa buka (2.725 transmit di
13 UTC) dibanding jam sepi (274 di 10 UTC), tapi **tidak pernah berhenti**.
Bagus untuk price band off-hours.

#### ❌ Yang tidak ada — dan ini mematahkan desain ROO

`DualAggregator` **punya** dua jalur transmisi: `transmit` (primary) dan
`transmitSecondary`, plus `setCutoffTime` — persis mekanisme sesi yang kita harapkan.

**Tapi `transmitSecondary` TIDAK PERNAH DIPAKAI — nol panggilan di semua jam.**
Semua update lewat jalur primary. Dan `cutoffTime()` tidak punya getter publik
(selector-nya revert).

**Artinya: tidak ada harga pembukaan/penutupan resmi yang terekspos onchain.**

**Dampak desain — ROO harus didefinisikan ulang.**
Klaim *"limit relatif terhadap harga pembukaan resmi"* di `desain-auction.md` §2.5
**tidak bisa dipenuhi**. Tiga opsi:

| Opsi | Isi | Penilaian |
|---|---|---|
| **A — Redefinisi ROO** ✅ | Referensi = **TWAP pendek dari feed tepat setelah pembukaan** (mis. 5 menit pertama menurut kalender SessionManager kita sendiri) | **Direkomendasikan.** Jujur, bisa diimplementasi, dan tetap menyelesaikan masalah aslinya: pengguna menyatakan toleransi terhadap harga wajar, bukan tebakan angka absolut |
| B — Pakai harga kliring lelang sendiri | Melingkar — lelang tidak bisa memakai hasilnya sendiri sebagai pagar | ❌ Tolak |
| C — Hapus ROO | Kehilangan fitur yang membedakan | Cadangan |

**Wajib:** ganti istilah "harga pembukaan resmi" jadi **"harga referensi pembukaan"**
di seluruh dokumen, supaya tidak mengklaim sesuatu yang tidak kita punya.

#### ❌ SPCX tidak punya feed sama sekali

SpaceX ($38,8jt volume, salah satu pasangan terbesar) **tidak ada di daftar 30 feed**.
Aset pra-IPO tidak punya bursa induk, jadi tidak ada harga referensi.

**Dampak:** SPCX **tidak bisa masuk allowlist** dengan desain saat ini — tanpa
referensi, price band dan sanity check baseline tidak bisa ditegakkan. Perlu
penanganan terpisah, atau dikecualikan secara eksplisit.

#### ⚠️ Parameter staleness harus dikalibrasi ulang

Nilai di `parameter.md` (`STALENESS_OPEN` 120 dtk, `STALENESS_CLOSED` 900 dtk)
**terlalu ketat** — semua token akan masuk `PROTECTIVE` terus-menerus.

Jeda antar-update terukur: feed teraktif ~564 dtk rata-rata; feed paling lambat
sampai **105.610 dtk** (SGOV). Sangat bervariasi per aset.

**Perbaikan: staleness limit per-feed**, diturunkan dari cadence terukur, bukan
satu angka global. Kalibrasi dari data sebelum menetapkan nilai.

#### ❌ RedStone TIDAK ADA di Robinhood Chain — dan penggantinya lebih baik

**Terverifikasi:** nol tabel RedStone di Dune untuk chain robinhood; tidak ada
alamat deployment di dokumentasi RedStone maupun hasil pencarian; dan dokumentasi
Robinhood Chain sendiri menyebut **Chainlink** sebagai penyedia data harga onchain.

**Desain dual-oracle di `threat-model.md` §3.5 harus diganti.**

**Pengganti yang direkomendasikan — dan ini justru lebih kuat:**

> **Chainlink (referensi off-chain) versus TWAP Uniswap V3 (pasar onchain).**

Dua sumber ini **benar-benar independen dan punya mode kegagalan berbeda**:
Chainlink berasal dari agregasi data bursa off-chain; TWAP berasal dari transaksi
nyata onchain. Memakai dua oracle dari kategori yang sama hanya melindungi dari
kegagalan operasional. Memakai satu oracle dan satu pasar melindungi dari
**keduanya** — dan ketidaksepakatannya bermakna:

| Kondisi | Artinya |
|---|---|
| Chainlink ≈ TWAP | Sehat |
| Chainlink ≠ TWAP | **Salah satu:** feed rusak/basi, **atau** pasar onchain terdislokasi. Keduanya alasan sah masuk `PROTECTIVE` |

Bonus: sumber TWAP sudah tersedia gratis — kita **sudah** membaca state pool
Uniswap V3 untuk perhitungan baseline (P1-1). Pool NVDA-USDG punya $83jt volume,
cukup dalam untuk TWAP yang bermakna.

---

### ✅ Arcus MEMANG menangani arus stock token — koreksi temuan sebelumnya

Klaim sebelumnya *"Arcus/Rialto/Pleiades nol volume"* **SALAH**. Itu memang
celah decoder Dune, persis seperti yang dikhawatirkan.

**`ArcusSettlement` = `0x006102B16A04C20306A28B652745D3973D7D24FA`**
(proxy EIP-1967 → impl `0xf31022dd374221b220b619c6d8eddb3d4ee968b4`)
**224.987 leg transfer · 700.728 token** dalam 7 hari. Nyata dan signifikan.

`BridgeVault` Arcus = `0x14B107CF534239C59571B066CB6497A321DA897C`

**Dan ada beberapa kontrak besar lain yang belum teridentifikasi**, semuanya
tidak muncul di `dex.trades`:

| Alamat | Leg (7 hari) | Volume token | Catatan |
|---|---|---|---|
| `0x65050A9B7E5075A2BA5CED7B1B64EE66262C40DC` | 630.719 | 1.316.919 | Proxy → `0x73a160aa…3a4d`. **Lebih besar dari Arcus** |
| `0x2F4579CA81717D3D61BF8B6F06571877BBE54A07` | 165.108 | 626.952 | 5.914 byte |
| `0x1D4B86491EC211257CBEDD77A4380A7494624EFF` | 126.691 | 492.003 | 16.951 byte |
| `0x9F736F87E6293AC1BD9142E257DBFAC8B7ACF1AE` | 104.686 | 338.571 | — |

**Dampak desain — penting:**

1. **`dex.trades` Dune secara sistematis mengecilkan lanskap venue.** Semua analisis
   pangsa venue yang memakainya harus diberi catatan kaki
2. **Rencana adapter tidak boleh dikunci sekarang.** Identifikasi kontrak-kontrak di
   atas dulu lewat source terverifikasi di Blockscout / Robinscan sebelum memutuskan
   adapter mana yang dibangun
3. Yang **tidak** berubah: Uniswap V3 + V4 tetap venue terbesar dan tetap prioritas
   adapter pertama

**Cara menuntaskan** *(belum dikerjakan — bukan blocker)*: buka tiap alamat di
`robinscan.io` atau Blockscout, baca source terverifikasinya.

**Referensi berguna yang ditemukan:**
- `docs.robinhood.com/chain/oracles-and-price-feeds/` — dokumentasi oracle resmi
- `docs.robinhood.com/chain/contracts/` — registry kontrak resmi
- `robinscan.io` — explorer alternatif

---

## Temuan lain yang mengubah dokumen

### 1. ⚠️ Median ukuran transaksi jauh lebih kecil dari yang dipublikasikan

Angka **$240** yang dipakai di seluruh dokumen berasal dari query dengan filter
`amount_usd > 100` — filter itu **menggeser median ke atas**.

**Angka sebenarnya tanpa filter: median $44–63.**
(Uniswap V3: $63 · Uniswap V4: $44)

Ini harus dikoreksi di `README.md`, `ide-utama.md`, `CLAUDE.md`, dan `distribusi.md`.
Implikasinya dua arah: tiket makin kecil berarti spread makin menyakitkan secara
proporsional, **tapi** penghematan absolut per transaksi juga makin kecil —
5 bps dari $50 hanya 2,5 sen. Makin menegaskan bahwa nilainya ada di **ekor dan
agregat**, bukan per-transaksi.

### 2. ~~Arcus, Rialto, dan Pleiades tidak menangani arus stock token~~ ❌ **KLAIM INI SALAH — DICABUT**

> **Dicabut 1 Agustus 2026.** Lihat bagian "Arcus MEMANG menangani arus stock token"
> di atas. Tabel di bawah **hanya menunjukkan cakupan `dex.trades` Dune**, bukan
> lanskap venue sebenarnya. Disimpan sebagai catatan kegagalan metodologi:
> **ketiadaan data dalam satu view bukan bukti ketiadaan aktivitas.**

Volume stock token Juli 2026 menurut `dex.trades`:

| Venue | Volume | Trade | Pool |
|---|---|---|---|
| **Uniswap V3** | **$193,8 jt** | 990.372 | 458 |
| **Uniswap V4** | **$106,1 jt** | 3.090.689 | 1 (PoolManager singleton) |
| Uniswap V2 | $53 rb | 18.639 | 32 |
| Arcus / Rialto / Pleiades | *tidak terindeks* | — | — |

⚠️ *Kemungkinan lain: Dune belum menambahkan decoder untuk protokol baru itu.
**Harus diverifikasi langsung ke kontraknya sebelum menghapus adapter mereka.***

**Dampak desain:** rencana "tiga adapter (Uniswap, Arcus, Rialto)" perlu ditinjau.
Prioritas sebenarnya kemungkinan **Uniswap V3 + Uniswap V4**, bukan tiga venue
berbeda. V3 dan V4 arsitekturnya sangat berbeda, jadi tetap dua adapter — tapi
keduanya Uniswap.

### 3. SPCX (SpaceX) adalah pasangan besar

$15,8jt + $14,5jt + $8,5jt lintas pool. Aset pra-IPO, tidak punya harga pembukaan
bursa. **Ini memperumit P0-3 dan desain ROO** — token tanpa bursa induk tidak punya
"harga pembukaan resmi". Perlu penanganan terpisah.

### Alamat yang sudah terverifikasi

| Item | Alamat |
|---|---|
| Beacon Stock Token | `0xe10b6f6b275de231345c20d14ab812db62151b00` |
| Pool NVDA-USDG V3 (terbesar, $83jt) | `0xD4EB21209C4D6093F80B5B84F5C45CC093EA14A3` |
| Pool GME-USDG V3 | `0xE9713F453ADB9245B19559790C96F470A18F2FDF` |
| Uniswap V4 PoolManager | `0x8366A39CC670B4001A1121B8F6A443A643E40951` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

---

## RONDE 5 — peta venue lengkap (10 September 2026)

Lahir dari pengukuran 4,9% volume allowlist yang selama ini tidak terpetakan
(kueri `8664785`). Angka Agustus tereproduksi persis, jadi metodenya sebanding.

### ✅ P5-1 · TERJAWAB 10 September 2026 — dua kompatibel, satu varian

> **Hasil:** `gigadex v3` dan `ramsesxyz vcl` **byte-identik** dengan Uniswap V3
> (`slot0` 7 word, `ticks` 8 word, `tickBitmap` 1, `observe` 6) dan `fee()` statis.
> `uponrh v3` adalah **varian** — `slot0` 6 word (tanpa `unlocked`), `ticks` 10 word
> — jadi butuh jalur decode sendiri dan satu verifikasi lagi (urutan field `ticks()`).
> **Tidak satu pun gugur karena fee dinamis.** Keputusan dan angka cakupan:
> `parameter.md` §10.1 · `spek-teknis.md` §9.1. Metode dan pool yang diuji ada di
> blok pertanyaan di bawah, disimpan sebagai jejak.

#### Pertanyaan aslinya

**Kenapa ini penting sekarang.** Pangsa Uniswap V3 atas volume allowlist **turun
82,53% → 72,63% dalam sepuluh hari**, sementara `uponrh v3` naik 2,73% → **9,27%**
dan `ramsesxyz vcl` 0,39% → **3,48%**. Kalau ketiganya kompatibel V3, adapter yang
**agnostik terhadap factory** mengembalikan cakupan ke ~~82,93%~~ tanpa menambah
kelas venue baru — menambah pool jadi satu transaksi time-lock, bukan deploy ulang. *(⚠️ Angka 82,93% adalah dugaan saat pertanyaan ini ditulis, mengelompokkan `uponrh` sebagai kompatibel. Jawabannya menggugurkan itu: yang benar **77,14%** drop-in, **86,41%** dengan decoder `uponrh`.)*
Kalau tidak kompatibel, cakupan v1.0 memang 72,63% dan **menurun**, dan itu harus
dikatakan apa adanya di pitch.

**Cara menjawab — murah, bisa dikerjakan tanpa menulis kontrak:**
```
1. Temukan alamat pool allowlist di tiap venue (dari dex.trades project_contract_address)
2. staticcall ke tiap pool:
   slot0()        0x3850c7bd    → sqrtPriceX96, tick tersedia?
   liquidity()    0x1a686502
   tickSpacing()  0xd0c93a7c
   ticks(int24)   0xf30dba93    → liquidityNet bertipe sama?
   fee()          0xddca3f43    → nilai statis, atau penanda dinamis?
3. Bandingkan hasilnya dengan pool Uniswap V3 NVDA-USDG 0xD4EB…14A3 sebagai kontrol
4. Cek ada/tidaknya hook: kalau fee() mengembalikan penanda dinamis (mis. 0x800000),
   venue itu GUGUR dengan alasan yang sama seperti V4
```

**Kalau jawabannya "kompatibel":** `UniswapV3Adapter` ditulis menerima alamat pool
dari `adapterAllowlist`, **tanpa** konstanta factory Uniswap. Itu bukan penambahan
scope — itu menghindari hardcode, dan sudah sejalan dengan prinsip §9.1
`spek-teknis.md`.

**Kalau "tidak kompatibel":** keputusan v1.0 tidak berubah, tapi **angka pitch
berubah** — kutip 72,63% dan menurun, jangan 82,5%.

⚠️ **Jangan tulis kode yang bergantung pada jawaban ini sebelum diukur** (aturan 7
`CLAUDE.md`). Ini persis kelas kesalahan yang menggugurkan asumsi V4.

### 🟡 P5-2 · Berapa sebenarnya volume Uniswap V4, mengingat 2,9 juta trade tanpa harga?

Tabel venue mencatat **1,49 juta trade V4 tanpa `amount_usd` di Agustus** dan
**2,92 juta di September** — versus hanya 29rb dan 26rb di V3. Pangsa V4 (12,6%)
kemungkinan **understated**, dan besarnya understatement tidak diketahui.

Tidak memblokir apa pun: V4 sudah gugur untuk v1.0 karena hook fee dinamis, bukan
karena pangsanya. Tapi **jangan pakai 12,6% sebagai angka presisi**, dan kalau V4
dipertimbangkan ulang di v1.1, ukur volumenya dari event `Swap` langsung, bukan dari
`dex.trades`.

### 🟡 P5-3 · Apakah pertumbuhan 4× volume allowlist bertahan?

Volume allowlist Sep 1–10 sudah **$671,3jt** — laju bulanan ~4× Agustus ($501,0jt).
Kalau bertahan, seluruh kalibrasi netting di §1B (yang memakai ketebalan arus
Agustus) menjadi **konservatif**, dan `BATCH_ADAPTIVE_MIN` akan lebih sering
tersentuh. Ukur ulang di akhir September sebelum mengunci angka pitch.

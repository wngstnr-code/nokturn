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
| P1-2 | ✅ **TERJAWAB 20 September 2026.** Titik impas **12 intent per batch**, dan batch peluncuran memuat 2,5 sampai 3,3. Lihat di bawah | Menentukan ukuran batch maksimum yang ekonomis |
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

> **Koreksi 18 September 2026.** Kalimat "trafik nyata" dan "126 pemanggil berbeda"
> di atas menyesatkan dan tidak boleh dikutip lagi. Angka itu menghitung pemanggil
> di level trace, yaitu kontrak. Pengirim transaksinya **satu EOA**, dan program itu
> berhenti dipanggil 2 Agustus 2026. Rinciannya di RONDE 7.

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

> **Diukur ulang 16 September 2026 pada pool allowlist v1.0**, karena tabel di atas
> memuat GME dan SPCX yang tidak masuk allowlist. Pool AAPL fee 500, TSLA fee 3000,
> dan GOOGL fee 500 semuanya bercardinality **1.801**, sedangkan NVDA fee 500 tetap
> 6.000. Alamat pool lengkap ada di `parameter.md` §10.

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
> ### Verifikasi kontrak, diukur ulang 19 September 2026
>
> Catatan di dokumen ini dan di `CLAUDE.md` berbunyi *"Blockscout masih butuh
> `--resolve`"*. Itu **tidak lagi cukup**. Origin di balik workaround itu sekarang
> menjawab tantangan Cloudflare, bukan API-nya, dan lewat DNS biasa ia menjawab
> 403. Artinya `forge verify-contract` ke Blockscout tidak bisa dipakai dari sini
> sama sekali, bukan sekadar merepotkan.
>
> **Jalannya Sourcify.** Chain 4663 dan 46630 keduanya terdaftar `supported: true`
> di `https://sourcify.dev/server/chains`, endpoint-nya tembus dari jaringan ini
> tanpa workaround apa pun, dan Blockscout membaca Sourcify. Script-nya ada di
> `contracts/tools/verify.sh`.
>
> Satu hal yang harus disebut, bukan disembunyikan. `foundry.toml` menyetel
> `bytecode_hash = "none"` dan mematikan CBOR metadata, jadi bytecode yang
> ter-deploy tidak membawa trailer metadata. Verifier yang mengompilasi ulang dari
> standard json menghasilkan byte yang sama, dan itu kecocokan yang penting, tapi
> tidak ada hash metadata untuk dibandingkan. Sourcify mencatatnya sebagai
> `match`, bukan `exact_match`. Itu sifat setelan kompiler, bukan sifat
> verifikasinya.
>
> RPC `https://robinhood.drpc.org` sendiri tetap sehat, menjawab `0x1237`.

> ### Terpecahkan 16 September 2026, dan klaim lama di bawahnya salah
>
> Catatan lama berbunyi *"`https://robinhood.drpc.org` bisa diakses tapi hanya
> mendukung `eth_chainId`"*. Diuji ulang hari ini, endpoint itu melayani
> `eth_call`, `eth_getCode`, `eth_getStorageAt`, dan **state historis**.
>
> ```
> anvil --fork-url https://robinhood.drpc.org --fork-block-number 64420000
> ```
>
> Fork mainnet berjalan tanpa `--resolve`, tanpa entri `/etc/hosts`, tanpa sudo,
> dan tanpa VPN. Seluruh pengukuran onchain 16 September 2026 di dokumen ini dan
> di `parameter.md` §10 dikerjakan lewat jalur itu.
>
> #### Koreksi di hari yang sama, dan kali ini koreksi atas kalimat kami sendiri
>
> Kalimat *"nodenya archive"* di versi pertama catatan ini **salah**, dan salahnya
> karena satu pengamatan diperluas terlalu jauh. Blok 64420000 memang menjawab
> saat diuji, tapi itu bukan blok lampau, melainkan blok yang saat itu masih
> berada di dalam jendela state yang disimpan node.
>
> Diukur ulang sore itu juga, dengan head di 64658016.
>
> | Blok | `eth_call` ke Permit2 |
> |---|---|
> | 64640000 | menjawab |
> | 64620000 | `Unknown state. First available state is 1` |
> | 64000000 | `Unknown state` |
> | 1 | `Unknown state` |
>
> Jadi endpoint itu **full node dengan jendela state sekitar 20 sampai 40 ribu blok
> terakhir**, kira-kira 35 sampai 65 menit pada blok 100ms. Pesan error-nya sendiri
> menyesatkan, karena ia menyebut "first available state is 1" untuk state yang
> justru tidak tersedia.
>
> **Konsekuensinya pada kode, dan ini yang membuat koreksinya penting.** Nomor blok
> yang dipatok di dalam fork test akan berhenti resolve dalam hitungan jam, bukan
> bulan. Fork test karena itu mengikuti head lalu mundur 300 blok, lihat
> `contracts/test/fixtures/ForkFixture.sol`. Mundur sedikit itu perlu karena head
> bergerak lebih cepat daripada test bisa menarik state darinya, dan endpoint
> menjawab `Unknown block` untuk blok yang baru saja ia layani sendiri.
>
> ⚠️ Kalau nanti butuh state yang benar-benar lampau, misalnya untuk backtest
> ulang, endpoint ini **tidak bisa dipakai**. Itu kembali ke `curl --resolve` ke
> endpoint resmi, atau ke penyedia berbayar.

> **Koreksi ketiga, 21 September 2026, dan yang digugurkan kali ini adalah koreksi
> di atas.** Endpoint itu melayani state lampau. Tabel dan kesimpulan di blok ini
> dibiarkan apa adanya karena keduanya bagian dari catatan, tapi jangan dipakai
> sebagai dasar keputusan. Rinciannya di pelajaran metodologi kesebelas.

**Pelajaran metodologi yang keenam, dan bentuknya persis sama dengan lima yang
sudah tercatat.** Satu pengamatan positif, yaitu satu blok yang menjawab, dibaca
sebagai sifat umum node. Kontrolnya baru dijalankan setengah hari kemudian, dan
kontrol itulah yang menggugurkannya. Uji batasnya, jangan cuma titik tengahnya.
>
> **Yang belum terpecahkan**, dan tetap butuh `curl --resolve`, adalah Blockscout
> dan domain `rpc.mainnet.chain.robinhood.com` sendiri. Pencegatan DNS-nya masih
> hidup, hanya saja sekarang resolve ke `block.gmedia.id` (`103.217.209.188`),
> bukan lagi `internetpositif.id`. Gejalanya tetap menyesatkan.

### Pelajaran metodologi ketujuh, 19 September 2026. Fork test enam minggu basi

Ditemukan saat mengkalibrasi `MAX_TICK_CROSSINGS`. Dua fork test adapter merah, dan
dugaan pertama adalah drift likuiditas pool. Salah.

**Di chain Arbitrum, `block.number` mengembalikan nomor blok chain induk, bukan
chain ini.** Terukur hari itu, `block.number` menjawab **26.011.883** sementara
`eth_blockNumber` dan `ArbSys.arbBlockNumber()` sama-sama menjawab **67.121.275**.
Keduanya benar untuk penomoran masing-masing.

`ForkFixture.selectMainnet()` membaca yang pertama lalu menyuapkannya ke `rollFork`
yang menerima yang kedua. Hasilnya fork mendarat di blok 25.668.122, yang bertanggal
**2 Agustus 2026**. Tiga kali dijalankan, tiga kali blok yang sama, jadi ia stabil
dan karena itu tidak pernah terlihat mencurigakan.

Konsekuensinya, **setiap fork test di repo ini berjalan atas state 2 Agustus selama
enam minggu**, dan jaraknya melebar tiap hari karena kedua penomoran bergerak dengan
laju berbeda. Klaim "nol selisih terhadap mainnet nyata" selama periode itu berarti
nol selisih terhadap fork 2 Agustus.

Perbaikannya satu baris, yaitu mundur dari `ArbSys.arbBlockNumber()` bukan dari
`block.number`. Setelah itu `rollFork` mendarat tepat 300 blok ke belakang dengan
timestamp tepat 30 detik lebih awal, persis seperti yang dirancang, dan **kedelapan
belas fork test hijau termasuk dua yang merah**.

**Bentuk kesalahannya baru.** Enam pelajaran sebelumnya semuanya tentang satu
pengamatan positif yang dibaca sebagai sifat umum. Yang ini kebalikannya, yaitu dua
angka yang sama-sama benar dan sama-sama masuk akal, dipakai bergantian karena
namanya mirip. Yang menangkapnya bukan kecurigaan, melainkan memaksa diri
memverifikasi ke rantai apa yang sudah terbaca di fork. Angka yang cocok dengan
harapan tetap harus dicek terhadap sumber kedua.

### Pelajaran metodologi kedelapan, 19 September 2026. Jendela ukur yang terlalu pendek

Ditemukan saat menutup P6-1. `parameter.md` §7.1 mencatat p95 jeda feed NVDA di
sesi `OPEN` sebesar **63.394 detik**, diukur atas 1 sampai 16 September 2026.
Diukur ulang atas seluruh riwayat feed, 88 hari sejak 22 Juni, angkanya
**8.686 detik**. Tujuh kali lebih rapat.

Dua sebabnya. Jendela enam belas hari hanya memuat dua sampai tiga akhir pekan,
sehingga satu pembekuan panjang cukup untuk menggeser p95 sendirian. Dan jeda
yang membentang dari Jumat sore sampai Senin masuk ke ember sesi tempat ia
berakhir, bukan tempat ia bermula, jadi pembekuan akhir pekan ikut terhitung
sebagai jeda sesi kerja.

Akibatnya bukan sekadar angka meleset. Angka itu hampir membuat GOOGL dicoret
dari allowlist lewat P6-2, dan hampir membuat keluarga feed berumur empat hari
dipilih sebagai referensi harga seluruh protokol justru karena ia tampak lebih
rapat. Yang membuatnya tampak rapat adalah riwayatnya yang pendek, bukan
kualitasnya.

**Bentuknya mirip pelajaran pertama sampai keenam,** yaitu satu pengamatan atas
jendela sempit dibaca sebagai sifat umum. Bedanya kali ini sumbernya pengukuran
sendiri, bukan artikel orang lain. Aturan yang dipakai sekarang, **setiap angka
cadence diukur atas seluruh riwayat feed dan jeda yang membentang akhir pekan
dikeluarkan secara eksplisit**, bukan diserahkan ke ember sesi.

---

Untuk Foundry: pakai `https://robinhood.drpc.org` yang terbukti bekerja di atas.
VPN, DNS-over-HTTPS di level sistem, atau endpoint provider berbayar tetap jadi
cadangan kalau endpoint itu jatuh.

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

### ✅ P0-3 — Feed oracle & harga pembukaan resmi

> **Ditutup 19 September 2026.** Tiga hal yang membuatnya kuning sudah selesai.
> ROO didefinisikan ulang lewat opsi A dan istilahnya sudah diganti di seluruh
> dokumen. RedStone diganti TWAP Uniswap V3. Dan yang terakhir, kalibrasi
> staleness, ditutup lewat P6-1, yaitu keluarga `RH` dengan ambang p99 per feed
> atas seluruh riwayat 88 hari. Nilainya di `parameter.md` §7.1.
>
> Satu kalimat di bawah ini **sudah tidak berlaku**, yaitu klaim feed hidup 24 jam
> dan tidak pernah berhenti. Terukur kemudian, feed `RH` membeku total 48 sampai
> 56 jam setiap akhir pekan, nol update. Penanganannya di §7.3, dan sinyal baru
> soal itu ada di P6-3.

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

## RONDE 7. Adopsi Stylus, diukur ulang 18 September 2026

Pengukuran 1 Agustus menemukan tiga program Stylus di chain 4663. Angka itu sudah
usang. Diukur ulang lewat jalur yang sama, yaitu trace ke precompile `ArbWasm`
`0x...0071` dengan selector `activateProgram(address)` = `0x58c780c2`.

### Deploy tumbuh, pemakaian tidak

| | 1 Agustus 2026 | 18 September 2026 |
|---|---|---|
| Program pernah diaktifkan | 3 | **10** |
| Deployer berbeda | 1 | **6** |
| Gas aktivasi | 7,7-8,2 juta | **3,0-3,9 juta** |
| Total panggilan ke seluruh program Stylus | ~4.100 | **6.254** |
| Program dengan lebih dari satu pengirim tx | belum diukur | **nol** |
| Program tanpa panggilan sama sekali | belum diukur | **4 dari 10** |

Tujuh program baru lahir di September dari lima deployer yang sebelumnya tidak
pernah terlihat, dan program-programnya jauh lebih ramping. Gas aktivasi turun
separuh lebih. Itu pertumbuhan eksperimen yang nyata, jangan dibingkai sebagai
kategori sepi.

Yang tidak tumbuh adalah pemakaiannya. Dari 6.254 panggilan, **6.235 milik satu
program yang berhenti dipanggil 2 Agustus 2026**. Sisanya tersebar di lima program
dengan satu sampai sebelas panggilan, dan empat program tidak pernah dipanggil
sama sekali. Tidak ada satu pun program Stylus di chain ini yang pernah dipanggil
oleh lebih dari satu dompet.

### Koreksi angka yang menyesatkan

Catatan 1 Agustus menulis program teraktif punya "126 pemanggil berbeda". Angka itu
menghitung pemanggil di level trace, yaitu kontrak, dan per hari ini jadi 152.
**Pengirim transaksinya satu EOA.** Satu dompet menjalankan 1.500 transaksi lewat
152 kontrak perantara, yang merupakan harness uji dan bukan trafik pengguna.

Pelajarannya sejalan dengan dua kasus sebelumnya di dokumen ini, tapi bentuknya
berbeda. Dua kasus itu soal data yang tidak muncul di satu view. Yang ini soal
angka yang benar secara teknis namun terbaca sebagai hal lain, dan yang menentukan
adalah unit mana yang sedang dihitung.

### Cache manager masih tidak ada

Precompile `ArbWasmCache` `0x...0072` menerima nol panggilan sepanjang 2026. Denda
init 7,8 kali yang tercatat di P1-3 berlaku tanpa perubahan.

### Apa artinya untuk keputusan

**Tidak mengubah rencana menulis verifier Rust.** Gerbang differential
`rencana-uji.md` §3 adalah gerbang v1.0 dan butuh implementasi kedua apa pun
keputusan Stylus-nya.

**Mengubah prior untuk deploy-nya.** `pitch.md` sudah menaruh port Stylus di v1.1
bersyarat benchmark, dan data ini memperkuat posisi itu. Sepuluh program, nol yang
pernah punya lebih dari satu pengguna, yang tersibuk sudah diam enam minggu, dan
tetap tanpa cache manager.

**Satu hal yang harus disebut di roadmap dan belum.** Verifier tersimpan
`immutable` di `Settlement.sol` dan tidak punya setter, jadi port Stylus di v1.1
berarti Settlement baru. Itu bukan perubahan allowlist lewat time-lock seperti
adapter V4 di baris yang sama.

Kueri Dune 18 September 2026, **permanen dan publik sejak 19 September 2026**:
[`8768270`](https://dune.com/queries/8768270) (aktivasi) ·
[`8768280`](https://dune.com/queries/8768280) (pemakaian per program) ·
[`8768291`](https://dune.com/queries/8768291) (pemanggil program teraktif) ·
[`8768299`](https://dune.com/queries/8768299) (cache).

---

## RONDE 7 — baseline yang tidak pernah diperiksa kontrak (20 September 2026)

### ✅ P7-1 · TERJAWAB 20 September 2026 — lantai agregat, opsi 2

> **Hasil.** `Settlement` sekarang menghitung lantai di bawah `baselineQuotes`, satu
> kuotasi per arah pasangan atas volume kotor arah itu, lewat `baselineAdapter` yang
> diset governance. Total di bawah lantai ditolak dengan `BaselineBelowVenue`. Kalau
> lantainya tidak bisa dihitung sama sekali, `savings` dipaksa nol dan batch jadi
> pass-through, bukan batch yang dipercaya begitu saja. Spesifikasi dan angkanya di
> `parameter.md` §4C, skenario adversarialnya A16 di `rencana-uji.md` §7.1.

**Ditemukan saat menyiapkan serah terima `quoteFromState` ke Dharu**, yaitu ketika
mencari tahu angka mana yang harus cocok persis antara kontrak dan kalkulator
offchain. Jawabannya ternyata **tidak ada**, karena kontrak tidak pernah menghitung
baseline sama sekali.

`Solution.baselineQuotes` datang dari solver. `ClearingVerifier` hanya memeriksa satu
arah, yaitu `executedBuy >= baselineQuotes[k]`. Baseline yang **dilebihkan** ditolak.
Baseline yang **dikurangi** lolos tanpa perlawanan, dan dari situ `savings` dihitung.

**Diukur, bukan diduga.** Dua solusi pada batch yang sama, eksekusi identik sampai
wei, hanya baselinenya berbeda.

| | Baseline jujur | Baseline dinolkan |
|---|---|---|
| `savings` terhitung | 0,04e18 | 399,88e18 |
| Plafon fee | 0,032e18 | 0,12e18, yaitu 3 bps notional |
| Fee yang ditahan | 0,12e18 | 0,12e18 |
| Hasil `finalize` | **revert `FeeExceedsCap`** | **berhasil** |
| Yang diterima pengguna | batch gagal | 0,9997e18 NVDA |
| Yang diambil solver | tidak ada | 0,000225e18 NVDA plus 45.000 USDG |

Bacaannya begini. Pada batch yang surplus sebenarnya kecil, solver jujur **tidak bisa
menyelesaikan batch sama sekali** karena fee yang ia tahan melampaui plafon yang
diturunkan dari surplus. Solver yang mengaku baselinenya nol menyelesaikannya dan
mengambil penuh tiga basis poin. Selisihnya diambil dari pengguna, di dalam pita
harga seragam yang memang mengizinkan tiga bps.

**Tiga akibat, dan yang ketiga yang paling mahal.**

1. **Lelang solver jadi kontes klaim, bukan kontes hasil.** `submitSolution` memilih
   `savings` tertinggi. Solver yang mengarang selalu mengalahkan yang jujur.
2. **Ambang pass-through bisa dilewati.** Batch yang seharusnya lewat tanpa fee
   karena surplusnya di bawah satu bps bisa dibalik jadi batch berbayar.
3. **Angka price improvement yang diterbitkan jadi tidak bisa dipercaya.** Itu angka
   di pitch, di dashboard, dan yang jadi calon KPI tranche mainnet.

**Batasnya juga harus disebut, supaya tidak dibesar-besarkan.** Fee tetap dibatasi
tiga basis poin notional dan solver tidak bisa menciptakan token. Pada cap peluncuran
$5.000 selisih maksimumnya sekitar $1,50 per batch. Pada plafon governance $500.000
ia jadi $150 per batch.

**Kenapa ini tidak bisa ditunda.** `Settlement` immutable dan tanpa proxy, aturan 6
`CLAUDE.md`. Kalau diperbaiki, perbaikannya harus masuk sebelum deploy mainnet.
Setelah itu satu-satunya jalan adalah `Settlement` baru.

**Mitigasi yang dirancang ternyata kode mati.** `SolverRegistry.reportInvalidSurplus`
ada dan menyita bond, tapi tidak dipanggil dari mana pun. Itu sudah tercatat di
`rencana-uji.md` §7.1 sebagai temuan, dengan alasan bahwa klaim palsu ditolak lewat
revert. **Alasan itu hanya benar untuk baseline yang dilebihkan.** Untuk yang
dikurangi tidak ada revert, jadi tidak ada yang bisa disita, dan tidak ada yang
menyadari.

**Pilihan yang terbuka, belum diputuskan.**

1. Kontrak menghitung ulang baseline lewat adapter dan memakai angkanya sendiri.
   Paling kuat. Biayanya gas, dan baseline per intent bergantung ukuran sehingga satu
   kuotasi per pasangan tidak cukup untuk mengisi `baselineBuy` per intent yang
   dibawa `IntentSettled`. Lihat catatan di `types/Types.sol`.
2. Kontrak memeriksa batas bawah saja, yaitu total baseline per pasangan tidak boleh
   di bawah `quoteFromState` atas volume agregat pasangan itu. Beberapa panggilan
   adapter per batch, bukan N. Menutup arah kebohongan yang berbahaya tanpa
   menghitung per intent.
3. Menghidupkan jalur tantangan, yaitu siapa pun boleh membuktikan baseline palsu
   dalam jendela tertentu dan menyita bond. Butuh state tambahan dan jendela sengketa
   di kontrak immutable.
4. Menerima apa adanya dan mendokumentasikannya sebagai risiko sisa kesebelas.

**Opsi 2 diukur, 20 September 2026.** Dua angka yang menentukan apakah ia layak,
keduanya dari fork mainnet lewat `test/fork/BaselineBoundFork.t.sol`.

**Celah sisa.** Batas bawah agregat lebih longgar daripada kebenaran, tepat sebesar
dampak harga antara satu perdagangan gabungan dan volume yang sama dipecah jadi
beberapa intent. Tabel di bawah adalah seberapa jauh di bawah jumlah jujur sebuah
total masih bisa digeser dan tetap lolos, dalam bps.

| Token | $172 | $1.000 | $5.000, cap | $50.000 |
|---|---|---|---|---|
| NVDA | 0 | 0 | 0 | 1 |
| GOOGL | 0 | 0 | 0 | 3 sampai 6 |
| AAPL | 0 | 0 | 0 sampai 1 | 10 sampai 16 |
| TSLA | 0 | 0 | 1 sampai 3 | 19 sampai 34 |
| GME | 0 | 0 sampai 1 | 1 sampai 3 | 69 sampai 85 |

Rentangnya adalah pecahan 2, 3, 5, dan 10 intent. Kolom $172 adalah tiket median
Agustus $57,44 dikali tiga, yaitu bentuk batch yang sebenarnya pada pangsa awal,
bukan ukuran yang dikarang. **Pada bentuk itu celahnya nol di kelima token.**

Terjemahannya ke uang. Plafon fee mengambil 20% dari surplus, jadi celah baseline
3 bps menaikkan plafon paling banyak **0,6 bps notional**, dengan langit langit keras
tetap 3 bps notional. Hari ini celahnya tidak terbatas sampai langit langit itu. Jadi
opsi 2 memperkecil jendela yang bisa dieksploitasi dari 3 bps menjadi 0,6 bps di cap
peluncuran, dan menjadi **nol pada ukuran batch yang nyata**.

**Biaya gas.** Satu kuotasi per arah pasangan per batch, bukan per intent.

| Token | $172 | $5.000, cap | $50.000 |
|---|---|---|---|
| TSLA | 24.572 | 25.493 | 53.394 |
| GOOGL | 25.589 | 25.557 | 39.948 |
| GME | 25.713 | 40.233 | 287.296 |
| AAPL | 26.073 | 40.945 | 85.546 |
| NVDA | 26.416 | 26.416 | 26.348 |

Batch nyata menyentuh satu sampai tiga pasangan, jadi dua sampai enam arah.
Tambahannya sekitar **50 sampai 160 ribu gas per batch** pada ukuran nyata. Pada
harga gas 0,01 gwei yang terukur saat gladi resik, itu 0,0000016 ETH. Biaya data L1
di chain ini nol.

Satu hal yang harus ikut diputuskan. Pada $50.000 GME menghabiskan 287 ribu gas
karena empat belas penyeberangan. Itu masih jauh di bawah batas blok, tapi ia
menunjukkan biaya kuotasi tumbuh dengan ukuran, jadi keputusan menaikkan
`CAP_PER_BATCH` nanti ikut menaikkan biaya ini.

**Opsi 2 dipilih dan sudah masuk kode, 20 September 2026.** Opsi 1 membalik keputusan
`desain-ekonomi.md` §2.3 yang menetapkan kuotasi per pasangan dan bukan per intent,
dan mengembalikan biaya yang keputusan itu sengaja hindari. Opsi 3 menambah state dan
jendela sengketa ke kontrak immutable, menghukum setelah kejadian, dan bentuknya persis
seperti `reportInvalidSurplus` yang sudah terbukti jadi kode mati. Opsi 4 berarti
menerbitkan angka price improvement yang kita sendiri tahu bisa dikarang.

---

## RONDE 6 — feed oracle, diukur ulang 16 September 2026

### ✅ P6-1 · TERJAWAB 19 September 2026 — keluarga `RH` saja, ambang dari p99

> **Hasil.** `PriceOracle` v1.0 membaca **keluarga `RH`** dan hanya itu.
> `STALENESS_OPEN` dan `STALENESS_CLOSED` diturunkan dari **p99 atas seluruh
> riwayat feed**, bukan p95 atas satu jendela. Nilai per token, alamat proxy, dan
> seluruh tabel pengukuran ada di `parameter.md` §7.1. Kueri `8776936`,
> `8776938`, `8776946`, `8776980`.

**Kenapa keluarga polos gugur, dan bukan karena selera.** Ketiga feednya
memancarkan `AnswerUpdated` pertamanya 15 September 2026 pukul 09.03 UTC, dalam
rentang sepuluh detik satu sama lain. Umurnya empat hari saat diputuskan. Ia
mengukur saham biasa, bukan token Robinhood yang diperdagangkan di sini, dan
tidak ada satu konsumen pun di chain ini yang membacanya. Feed yang dibaca banyak
pihak ketahuan rusak dalam hitungan menit. Feed yang hanya dibaca kita ketahuan
rusak setelah kita rugi.

**Kenapa ia juga tidak dipasang sebagai pemeriksa kedua.** Kedua keluarga berbeda
harga pada kondisi normal, bukan hanya saat rusak, karena yang satu mengukur token
dan yang lain mengukur saham. p95 selisihnya 208 bps untuk GOOGL dan 162 bps untuk
NVDA, sementara `ORACLE_DISAGREE_BPS` sesi `OPEN` adalah 50 bps. Alarm yang
berbunyi rutin pada kondisi normal akan diabaikan, dan alarm yang diabaikan lebih
berbahaya daripada tidak ada alarm.

**Kenapa ambangnya p99 dan bukan p95.** p95 berarti satu dari dua puluh batch di
sesi teramai jatuh ke `PROTECTIVE` tanpa ada yang rusak. Staleness bukan alat
penahan kerugian, itu tugas exposure cap dan price band. Tugas staleness adalah
menolak harga yang sudah tidak berarti, dan p99 sudah cukup untuk itu.

**Yang berubah dari premis pertanyaan ini.** Premisnya berdiri di atas pengukuran
16 September yang tidak tereproduksi. Lihat pelajaran metodologi kedelapan.

### P6-3 · Apakah keluarga feed polos benar-benar hidup di akhir pekan?

**Kenapa ini layak dipantau meski keluarganya sudah ditolak untuk v1.0.** Feed
`RH` membeku 48 sampai 56 jam dari Jumat sore sampai Senin, dan itu memaksa §7.3
memberi TWAP Uniswap V3 peran sumber harga utama di akhir pekan. Tambalan itu sah
tapi lebih lemah, karena sumbernya pasar itu sendiri dan bukan pengukur
independen. Akhir pekan juga sesi yang paling ingin dilayani, 33,2% trade ada di
sana.

**Yang terlihat, Sabtu 19 September 2026.** Keluarga `RH` berhenti Jumat 18
September pukul 20.11 UTC. Keluarga polos mencatat 69 update pada hari Sabtu yang
sama, terakhir pukul 15.18 UTC. Ia tidak ikut libur.

| Hari | Keluarga polos | Keluarga `RH` |
|---|---|---|
| Selasa 15 Sep | 42 | 28 |
| Rabu 16 Sep | 111 | 40 |
| Kamis 17 Sep | 111 | 37 |
| Jumat 18 Sep | 115 | 45 |
| **Sabtu 19 Sep** | **69** | **0** |

**Kenapa belum diapa-apakan.** Buktinya satu akhir pekan, dan itu akhir pekan yang
sedang berlangsung saat catatan ini ditulis. Mengubah keputusan desain terbesar
proyek di atas satu pengamatan adalah bentuk kesalahan yang sudah delapan kali
tercatat di dokumen ini.

**Cara menutupnya.** Amati **dua akhir pekan**, yaitu 19 sampai 20 September dan
26 sampai 27 September, lalu putuskan sebelum audit provenansi 28 September.
Jalankan ulang kueri `8776942` dengan batas tanggal digeser. Yang dicari tiga hal.
Apakah ia memperbarui di kedua hari akhir pekan, apakah heartbeat-nya tetap sama
seperti hari kerja, dan apakah harganya bergerak atau hanya mengulang nilai Jumat.
Yang ketiga yang paling menentukan, karena feed yang memancarkan update tapi
mengulang angka lama tidak lebih berguna daripada feed yang diam.

**Kalau ia bertahan,** ini argumen untuk v1.1, bukan v1.0, dan bentuknya bukan
mengganti referensi harga melainkan menambah jangkar akhir pekan di samping TWAP.
§7.3 tidak berubah sebelum itu terjadi.

### ✅ P6-2 · TERJAWAB 20 September 2026 — GOOGL dipertahankan, allowlist lima token

GOOGL masuk allowlist karena kualitas feed, sementara GME dan SPY ditunda persis
karena alasan itu.

⚠️ **Premis pertanyaan ini sudah dikoreksi, 19 September 2026.** Angka yang
melahirkannya, p95 GOOGL di sesi `OPEN` sebesar **191.721 detik**, tidak
tereproduksi. Ia diukur atas jendela 1 sampai 16 September. Diukur atas seluruh
88 hari riwayat feed, p95-nya **15.227 detik** dan p99-nya **54.617 detik**. Lihat
pelajaran metodologi kedelapan dan `parameter.md` §7.1.

GOOGL memang tetap yang terburuk kedua di antara keempatnya setelah AAPL, tapi ia
tidak lagi berada di kelas yang sama dengan GME dan SPY. Ditambah pengukuran
kedalaman pool 19 September yang mencatat GOOGL pada 5,2e18, lebih tebal daripada
TSLA dan bisa dikuotasi sampai $358rb. Keputusan §7.4 tetap perlu dinyatakan
secara eksplisit, tapi bukti yang ada sekarang mengarah ke mempertahankan GOOGL,
bukan mencoretnya.

**Dan pertanyaan ini melahirkan pertanyaan yang lebih besar, 19 September 2026.**
Metode yang sama diterapkan ke seluruh kandidat, kueri `8777019`. Jeda sesi `OPEN`
atas seluruh riwayat feed, akhir pekan dikeluarkan.

| Token | n | p50 | p95 | p99 | Status §7.4 |
|---|---|---|---|---|---|
| TSLA | 878 | 783 | 7.153 | 14.885 | Allowlist |
| NVDA | 642 | 1.107 | 8.686 | 18.785 | Allowlist, jangkar |
| META | 776 | 750 | 9.291 | 19.868 | Dicoret, volume tipis |
| MSFT | 454 | 1.366 | 15.638 | 46.724 | Dicoret, volume tipis |
| GOOGL | 480 | 1.359 | 15.227 | 54.617 | Allowlist |
| AAPL | 449 | 1.477 | 19.441 | 63.260 | Allowlist |
| **GME** | 555 | 1.499 | 46.370 | **64.479** | **Ditunda karena feed** |
| SPY | 76 | 25.748 | 86.425 | 86.428 | Ditunda karena feed |

**GME berada di kelas yang sama dengan AAPL.** p99 64.479 lawan 63.260, dan AAPL ada
di allowlist. Angka lama yang menundanya, p95 64.297 detik dari jendela Juli, tidak
tereproduksi. p95 sebenarnya 46.370. Artinya **alasan yang dipakai untuk menunda GME
tidak berdiri lagi**, dan GME adalah token volume nomor dua.

SPY sebaliknya terbukti memang buruk dan penundaannya benar. Hanya 76 jeda sesi
`OPEN` dalam 88 hari, p50-nya 25.748 detik, dan p99-nya mentok di 86.428 detik yang
berarti ia feed harian, bukan feed intraday. Volumenya naik 42 kali lipat tapi
feednya tidak ikut.

**Yang belum diukur untuk GME, dan harus diukur sebelum apa pun diputuskan.**
Kedalaman pool Uniswap V3 GME terhadap USDG, dengan metode yang sama seperti
`PoolDepthFork.t.sol` memakai keempat token allowlist. Dan pemisahan volume GME asli
dari memecoin penyamarnya, karena `CLAUDE.md` §5 mencatat angka gabungan meleset 30
persen. Gerbang beacon sudah menangani penyamarnya di jalur kode, tapi tidak di
jalur angka yang dipakai untuk memutuskan.

Menambah token ke allowlist adalah satu proposal timelock, bukan deploy ulang, jadi
keputusan ini tidak harus selesai sebelum peluncuran.

### Putusan, 20 September 2026

**GOOGL dipertahankan.** Diukur ulang lawan keenam syarat `parameter.md` §7.4, bukan
hanya yang dulu mempertanyakannya, karena incumbent tidak pantas dapat kelonggaran
yang tidak diberikan ke pendatang. Keenamnya lolos.

Dua angka baru membalik gambarannya sama sekali.

**Volume GOOGL $294,2jt dalam 30 hari, nomor dua dari lima**, bukan nomor empat.
Angka lama di §7.4 menulis "Sedang (11.613)", yang ternyata hitungan trade dari
cakupan lama yang jauh lebih sempit. Membacanya sebagai ukuran volume menempatkan
GOOGL jauh di bawah posisinya yang sebenarnya.

**Kedalaman poolnya paling tebal dari semua yang diukur.** Tujuh bps dampak harga di
sepuluh kali cap, satu crossing di cap, bisa dikuotasi sampai $286.886. Bandingkan
GME yang baru diterima kemarin di 67 bps dan $71.376.

Satu syarat yang sempit, dan perbandingannya yang menyelesaikan pertanyaan. Pangsa
Uniswap V3 GOOGL 44,8%, terendah dari kelima token. Tapi TSLA ada di 46,2% dan tidak
pernah dipertanyakan, sementara META yang gugur karena venue ada di 5,2%. GOOGL ada
di kelas TSLA, bukan di kelas META. Kueri `8779088`.

Feednya memang terburuk kedua, p99 54.617 detik lawan AAPL 63.260. Tapi AAPL ada di
allowlist sejak awal, jadi ambang syarat tiga yaitu setara token allowlist terburuk
yang sudah diterima justru menempatkan GOOGL di atas garis, bukan di bawahnya.

**Allowlist v1.0 final, lima token, NVDA sebagai jangkar ditambah AAPL, TSLA, GOOGL,
dan GME.** SPY dan SPCX tetap di luar karena feed. META masuk v1.1 bersama adapter V4.
AMC dan GLD belum pernah diukur sama sekali, dan itu tetap benar untuk dikatakan.

Menambah token adalah satu proposal timelock 48 jam, bukan deploy ulang, jadi daftar
ini bisa tumbuh tanpa menyentuh kontraknya.

**Kedalaman pool GME, terukur 19 September 2026.** Token aslinya
`0x1b0E319c6A659F002271B69dB8A7df2F911c153E`, lolos gerbang beacon dan
`uiMultiplier()` tepat 1e18. Pool utamanya terhadap USDG adalah
`0xE2b46c905E12Ab8E2f864e4821a4325884C1B126`, fee 500, $145,5jt volume September.
Diukur dengan `CandidateDepthFork.t.sol`, metode yang sama seperti keempat pool
allowlist.

| Ukuran | Crossing | GME keluar |
|---|---|---|
| $5.000, cap peluncuran | 1 | 221 |
| $10.000 | 2 | 443 |
| $50.000, sepuluh kali cap | 14 | 2.203 |
| $250.000 | ditolak | |

Terbesar yang bisa dikuotasi **$70.650**. Likuiditas dalam rentang 9,12e17.

**GME lolos kedua gerbang yang berlaku, tapi dengan ruang paling sempit.** Gerbang
pertama menuntut paling banyak empat crossing di cap peluncuran, dan GME satu.
Gerbang kedua menuntut pool tetap menjawab di sepuluh kali cap, dan GME menjawab.
Yang tipis adalah jaraknya. $70.650 berbanding $50.000 hanya 1,4 kali, sementara
NVDA 36 kali, GOOGL 7,2 kali, dan AAPL 4,3 kali.

**Satu kesalahan yang hampir masuk catatan ini, ditulis supaya tidak terulang.**
Pengukuran pertama memakai dua pool GME sekaligus. `setPool` memetakan pasangan
token ke satu pool, jadi pendaftaran kedua menimpa yang pertama tanpa error, dan
angka yang keluar menggambarkan pool 1% yang tipis. Bentuknya persis pelajaran
kedelapan, yaitu angka yang stabil dan masuk akal tapi mengukur benda yang salah.

### Seberapa lebar pasar stock token sebenarnya, 19 September 2026

Diukur karena keputusan allowlist selama ini berdiri di atas daftar delapan token,
bukan di atas populasi sesungguhnya. Kueri `8777029` dan `8777040`, tiga puluh hari
terakhir, hanya token yang lolos sebagai Stock Token asli lewat tabel
`robinhood_robinhood.stocktoken_evt_transfer`.

**192 token berbeda diperdagangkan**, bukan delapan. Tapi arusnya sangat terpusat.

| Kelompok | Pangsa volume |
|---|---|
| 4 teratas | 50,6% |
| 10 teratas | 70,9% |
| 20 teratas | 85,1% |
| **Allowlist v1.0** | **28,2%** |

Sepuluh teratas menurut volume adalah NVDA, SPY, SPCX, AMC, GOOGL, GLD, GME, AAPL,
DJT, META. Empat nama di situ tidak pernah muncul di dokumen mana pun sebelumnya,
yaitu AMC, GLD, DJT, dan QQQ tepat di bawahnya. TSLA berada di urutan dua belas.

**Konsekuensinya untuk allowlist.** Allowlist v1.0 memegang 28,2% volume stock
token, bukan mayoritas. Menambah GME menaikkannya ke 31,9%. Yang menahan tiga nama
di atas GME tetap sama, yaitu SPY feednya harian, SPCX tidak punya feed, dan AMC
belum diperiksa sama sekali.

⚠️ **Angka total jangan dibandingkan dengan angka Agustus.** Pengukuran ini memuat
seluruh 192 token dan seluruh pasangan, sementara angka Agustus di `CLAUDE.md` §6
memakai cakupan yang lebih sempit. Selisihnya besar dan **belum direkonsiliasi**,
jadi jangan dipakai sebagai klaim pertumbuhan. Yang sah dipakai dari pengukuran ini
adalah pangsanya, karena pangsa dihitung di dalam satu pengukuran yang sama.

### Netting per token, dan kenapa ia membalik dasar pemilihan allowlist

Netting terjadi **di dalam satu token**. Pembeli NVDA tidak bisa dipertemukan dengan
penjual GLD. Jadi yang membatasi bukan jumlah token di allowlist, melainkan berapa
banyak pedagang berlawanan arah pada token yang sama di jendela batch yang sama.
Angka itu belum pernah diukur per token. Kueri `8777088`, empat belas hari terakhir,
batch 45 detik, seluruh arus.

| Token | Pedagang per batch | Netting antar-counterparty | Volume 14 hari |
|---|---|---|---|
| **GME** | 11,2 | **48,9%** | $102,2jt |
| **META** | 11,9 | **45,4%** | $116,8jt |
| AMC | 6,4 | 43,4% | $124,2jt |
| **AAPL** | 10,5 | 40,2% | $127,0jt |
| SPY | 26,0 | 37,9% | $510,2jt |
| SPCX | 23,3 | 37,7% | $434,5jt |
| **NVDA** | 38,1 | 34,0% | $635,1jt |
| **GOOGL** | 16,6 | 30,3% | $255,2jt |
| HIMS | 5,7 | 26,7% | $54,1jt |
| MSTR | 5,5 | 26,0% | $63,2jt |
| GLD | 8,2 | 25,9% | $153,6jt |
| **TSLA** | 6,7 | **23,7%** | $75,3jt |

Tebal adalah allowlist v1.0. Tertimbang volume, keempatnya menghasilkan **33,2%**.

**Tiga hal yang dibalik tabel ini.**

Pertama, **lebih banyak pedagang tidak berarti lebih banyak netting**. NVDA punya
38,1 pedagang per batch dan hanya 34,0% netting, sementara GME punya 11,2 pedagang
dan 48,9%. Yang menentukan keseimbangan arah, bukan keramaian. Arus NVDA searah.

Kedua, **TSLA adalah penetting terburuk dari kedua belas token yang diukur**, sekaligus
urutan dua belas menurut volume, likuiditas pool paling tipis, dan pemegang rekor
drift akhir pekan 781 bps yang memaksa `WEEKEND_DRIFT_CAP_BPS` dinaikkan ke 1.500.

Ketiga, **kedua alasan pengecualian yang tercatat di §7.4 berdiri di atas angka yang
sudah tidak berlaku**. GME ditunda karena feed, dan feednya sekelas AAPL. META
dicoret karena volume di bawah 500, dan volumenya sekarang $116,8jt dengan netting
kedua terbaik dan cadence feed ketiga terbaik.

⚠️ **Dua peringatan atas angka ini.**

Pengukuran pertama memakai kolom `taker` dan **hasilnya harus dibuang**. Router
agregator dominan `0x65050A9B…` muncul sebagai satu pedagang dengan 696.550 trade
pada NVDA saja, sehingga arus banyak pengguna runtuh jadi satu alamat dan
netting antar-counterparty tampak jauh lebih kecil. Kolom yang benar `tx_from`,
karena untuk panggilan lewat router ia adalah penggunanya. Ini bentuk kesalahan yang
sama dengan pelajaran kedelapan, yaitu angka yang stabil tapi mengukur benda lain.

Tingkat absolutnya **tidak sebanding** dengan 50,05% di §1B. Yang itu diukur atas
Agustus, sesi off-hours saja, dengan definisi pedagang yang mungkin berbeda. Yang
sah dipakai dari tabel ini adalah **peringkat antar token**, karena seluruh barisnya
diukur dengan satu metode yang sama.

### Kandidat GME dan META, diperiksa tuntas 20 September 2026

Keduanya lolos gerbang Stock Token. Slot beacon benar, `uiMultiplier()` tepat 1e18,
delapan belas desimal.

| | GME | META |
|---|---|---|
| Token | `0x1b0E319c6A659F002271B69dB8A7df2F911c153E` | `0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35` |
| Proxy feed | `0x27C71df6A64fB476468EdF256CF72c038baB5B67` | `0x7C38C00C30BEe9378381E7B6135d7283356D71b1` |
| `description()` | `Robinhood GME / USD` | `Robinhood META / USD` |
| Harga feed saat diukur | $22,55 | $666,76 |
| Jeda `OPEN` p99 | 64.479 dtk | 19.868 dtk |
| Netting per batch | 48,9% | 45,4% |

Proxy keduanya ditemukan dengan menelusuri deployer yang sama dengan empat proxy
allowlist, `0xfe3c266c…`, lalu diverifikasi lewat `aggregator()` dan
`description()`. Bukan ditebak dari pola urutan deploy, meski polanya memang ada.

**GME lolos, dan pool utamanya ada di venue yang benar.**

| Ukuran | Crossing | Harga efektif | Dampak |
|---|---|---|---|
| $5.000, cap peluncuran | 1 | $22,54 | 0 bps |
| $10.000 | 1 | $22,55 | 4 bps |
| $50.000, sepuluh kali cap | 14 | $22,71 | 75 bps |
| $250.000 | ditolak | | |

Harga efektif di cap peluncuran $22,54 berbanding feed $22,55, selisih di bawah satu
bps. Pool utamanya Uniswap V3 dengan $145,5jt volume September, lawan $2,6jt di V4.

**META gugur, dan bukan karena kedalaman.** Pasar META ada di **Uniswap V4**.

| Venue | Volume September |
|---|---|
| Uniswap V4 | $97,5jt |
| ramsesxyz cl | $11,2jt |
| **Uniswap V3** | **$5,4jt** |

Adapter v1.0 hanya Uniswap V3, karena pool V4 dominan memakai hook fee dinamis
sehingga baseline tidak bisa dihitung dari state. Artinya **95% arus META berada di
venue yang tidak bisa dikuotasi v1.0**. Pool V3 yang tersisa tipis, likuiditas
1,77e17 atau sepuluh kali lebih tipis daripada GME, dan harganya 109 bps di atas
feed pada saat yang sama. Itu tanda pool yang ditinggalkan arus, bukan pool yang
sehat.

Menempatkan META di allowlist berarti mengiklankan harga pembanding dari pool yang
memegang seperdua puluh arusnya. Klaim price improvement terhadap baseline seperti
itu tidak akan bertahan diperiksa.

**META masuk lagi di v1.1 bersama adapter V4**, bukan lewat proposal allowlist.

### Pelajaran metodologi kesembilan, 20 September 2026. Ukuran yang bisa dikuotasi bukan kedalaman

`PoolDepthFork.t.sol` mencetak `largest quotable usd`, dicari dengan binary search
atas ukuran yang tidak ditolak adapter. Diterapkan ke META, angkanya **$3.999.999**,
yaitu batas atas pencariannya sendiri. Terdengar seperti pool paling dalam di repo.

Harga efektifnya di angka itu **76 kali lipat** harga di cap peluncuran.

Adapter memang benar. Ia menolak hasil parsial dan menolak melewati
`MAX_TICK_CROSSINGS`, dan META tidak melanggar keduanya. Ia melewati dua puluh
crossing lalu tetap menemukan likuiditas, hanya pada harga yang tidak berarti apa
apa. **Kuotasi yang berhasil bukan kuotasi yang layak**, dan metrik yang hanya
menanyakan berhasil atau tidak tidak bisa membedakannya.

Metriknya diganti menjadi **dampak harga dalam bps terhadap harga di cap
peluncuran**. Untuk keempat pool allowlist angkanya tidak berubah, karena ketiganya
memang menolak jauh sebelum harga jadi absurd. Yang berubah adalah ia sekarang bisa
menangkap kasus seperti META.

Bentuknya sama dengan pelajaran kedelapan, yaitu angka yang stabil, bisa diulang,
dan menjawab pertanyaan yang salah.

### ✅ P1-2 · TERJAWAB 20 September 2026 — Stylus belum menguntungkan di ukuran batch kita

Kedua implementasi didirikan di chain 46630 dan diukur lewat `eth_estimateGas` dengan
calldata yang sama persis. Bukan harness, bukan simulator. Tabel penuh dan modelnya ada
di `spek-teknis.md` §6, dan `verifier/tools/gas-table.py` menjalankannya ulang.

Ringkasnya, Stylus membayar **36.794 gas lebih mahal di muka** dan menghemat **3.124
gas per intent**. Titik impasnya **12 intent per batch**.

**Yang membuat jawabannya berbalik dari yang diharapkan** adalah membandingkannya
dengan ukuran batch yang benar benar akan terjadi. Batch 45 detik pada pangsa awal
realistis memuat **2,5 sampai 3,3 intent**, dan bahkan kalau seluruh arus chain lewat
Nokturn ia cuma **7,47**. Keduanya di bawah 12.

Jadi pada ukuran batch peluncuran, port Stylus membuat verifier **lebih mahal**.

Untuk sampai ke sisi yang menguntungkan dibutuhkan batch 90 detik dengan seluruh arus
chain, dan batch 90 detik sudah ditolak lebih dulu atas dasar netting karena lututnya
ada di antara 20 dan 30 detik. Dua keputusan yang diambil terpisah ternyata saling
mengunci, dan itu baru terlihat setelah keduanya diukur.

**Ini menunda port Stylus, bukan menggugurkannya**, dan syarat baliknya terukur. Kalau
chain ini mendapat cache manager, denda aktivasi turun 7,8 kali dan titik impasnya
pindah ke sekitar 1,5 intent. Atau kalau pangsa Nokturn tumbuh sampai batch rutin
memuat belasan intent.

Satu hal kecil yang ikut terbukti tanpa direncanakan. Ukuran batch ganjil membuat buku
tidak seimbang, dan **kedua implementasi revert dengan payload yang sama persis**. Itu
properti differential yang biasanya dikejar lewat jutaan input, muncul sendiri di dua
kontrak yang berdiri di rantai yang sama.

### Pelajaran metodologi kesepuluh, 20 September 2026. Pesan error yang menyebut angka yang salah

Pemantau butuh membaca log, jadi kedalaman log endpoint diukur dulu sebelum
kodenya ditulis, sesuai aturan 7. Hasil pertama melegakan. Log dijawab **60 juta
blok ke belakang**, padahal catatan 16 September menyebut endpoint ini menyimpan
state cuma 20 sampai 40 ribu blok.

Itu benar, dan koreksinya penting. Kalimat "bukan archive node" berlaku untuk
**state**, tidak untuk **log**.

Yang hampir menyesatkan datang sesudahnya. Kueri yang lebih lebar ditolak dengan
pesan *ranges over 10000 blocks are not supported on free plan*. Angka sepuluh ribu
itu spesifik, terdengar seperti dokumentasi, dan langsung dipakai sebagai konstanta.

Lalu kueri **1.000 blok** ditolak dengan pesan yang sama persis. Begitu juga 200.
Bisektnya berhenti di **101 blok** lolos, 102 ditolak. Ditegaskan dengan event
langka yang tidak cocok dengan satu log pun, jadi ini bukan soal ukuran respons.

**Batas sebenarnya 101 blok, dan pesan errornya menyebut angka yang 99 kali lipat.**

Bentuknya baru. Sembilan pelajaran sebelumnya adalah kesalahan pengukuran kami
sendiri, yaitu jendela yang terlalu pendek, view yang salah, metrik yang menjawab
pertanyaan lain. Yang ini adalah **sumber eksternal yang menyatakan batasnya
sendiri dengan salah**, dan satu satunya yang menangkapnya adalah tetap mengukur
setelah dapat jawaban yang kedengaran resmi.

Konsekuensinya nyata, bukan sekadar catatan. Sehari log adalah 8.554 panggilan
alih alih 87, jadi rancangan mengisi mundur sehari saat pemantau dinyalakan gugur
dan diganti jurnal berjalan. `parameter.md` §8.3.

---

### Pelajaran metodologi kesebelas, 21 September 2026. Satu endpoint bukan satu node

Ditemukan Dharu pada 20 September saat mengukur kedalaman log untuk pemantau, dan
ditulisnya di `rencana-backend.md` §3 sebagai temuan yang harus dibicarakan dulu,
bukan sebagai perubahan sepihak. Diukur ulang secara terpisah hari ini, dan dia
benar.

`https://robinhood.drpc.org` melayani state lampau. Bukan sekitar jendela 20 sampai
40 ribu blok seperti yang tertulis di catatan 16 September, melainkan setidaknya
sampai 1 Juli 2026.

Diukur 21 September 2026 dengan head di 68.946.737. Kolom terakhir adalah
`totalSupply()` USDG, dipanggil dengan `--block` di tiap kedalaman.

| Mundur | Blok | Tanggal | `totalSupply()` USDG |
|---|---|---|---|
| 300 | 68.946.437 | 21 Sep 2026 | 698.583.674.769.608 |
| 40.000 | 68.906.737 | 21 Sep 2026 | 698.597.528.808.070 |
| 1.000.000 | 67.946.737 | 20 Sep 2026 | 683.482.046.081.050 |
| 10.000.000 | 58.946.737 | 9 Sep 2026 | 684.315.186.846.140 |
| 25.000.000 | 43.946.737 | 23 Agu 2026 | 398.735.215.608.948 |
| 40.000.000 | 28.946.737 | 5 Agu 2026 | 357.916.669.299.090 |
| 55.000.000 | 13.946.737 | 19 Jul 2026 | 291.843.111.557.003 |
| 68.000.000 | 946.737 | 1 Jul 2026 | 101.253.278.669.169 |

Angka di kolom terakhir adalah buktinya, bukan sekadar hiasan. Kalau endpoint
diam diam menjawab dari head, kedelapan barisnya akan identik. Yang keluar justru
supply yang naik sesuai umur chain, jadi state yang dibaca memang state blok itu.

**Kenapa pengukuran 16 September salah, dan ini bentuk kesalahan yang baru.**
Sembilan pelajaran pertama adalah kesalahan pengukuran kami sendiri, dan yang
kesepuluh adalah sumber eksternal yang salah menyebut batasnya sendiri. Yang ini
lain lagi. Pengukuran 16 September menjalankan kontrolnya dengan benar, mencatat
`Unknown state` di tiga kedalaman, dan menyimpulkan sifat endpoint dari situ.

Yang tidak terpikirkan adalah bahwa satu URL di belakang penyeimbang beban bukan
satu node. Jawaban negatif dari sebuah URL semacam itu adalah sifat dari satu
sampel, bukan sifat dari layanan. Kami tidak bisa memastikan mana yang terjadi,
apakah armadanya berubah dalam lima hari atau permintaan 16 September kebetulan
mendarat di node tanpa state lampau, dan ketidakpastian itu justru inti
pelajarannya. **Jawaban negatif tunggal dari endpoint bersama tidak menggugurkan
apa pun. Ia harus diulang, dan diulang di hari yang berbeda.**

Yang berubah di kode karena ini.

| Tempat | Sebelum | Sesudah |
|---|---|---|
| `contracts/test/fixtures/ForkFixture.sol` | mengikuti head lalu mundur 300 blok | membaca `infra/pinned-block.json` |
| `contracts/foundry.toml` | komentar `[rpc_endpoints]` menyebut jendela 20 sampai 40 ribu blok | menyebut hasil ukur sembilan kedalaman |
| `docs/desain-baseline.md` §7 | blok tidak bisa dipatok | blok dipatok, dan nomornya disebut |
| `tools/fork-demo.sh` | fork sendiri, mengikuti head | menumpang fork `infra/Makefile` di blok yang sama |

Yang paling penting bukan salah satu barisnya, melainkan akibat gabungannya. Fork
test, backend, dan demo sekarang berdiri di **satu blok yang sama**, yaitu blok di
`infra/pinned-block.json`. Sebelumnya masing masing mengambil head sendiri sendiri,
dan tiga struk untuk intent yang sama bisa berbeda tanpa ada yang keliru.

### Pelajaran metodologi kedua belas, 21 September 2026. Mock yang menerima panggilan dari siapa pun

Ditemukan saat menjalankan cross penutupan pertama di fork. Semua stage lolos,
buku terisi lima intent, escrow tertarik, harga ketemu, cross masuk. Lalu langkah
terakhir revert.

```
Error: script failed: NotSettlement()
```

`AuctionHouse.executeCross` memanggil `SolverRegistry.recordWin` untuk mencatat
skor solver. Registry hanya menerima panggilan itu dari `Settlement`, dan alamat
settlement dipasang sekali lewat `setSettlement`. Jadi **setiap cross penutupan
dan pembukaan revert di langkah terakhirnya**, di sistem yang ter-deploy dengan
benar, sejak commit pertama.

Lelang adalah salah satu fitur utama proyek ini, dan ia tidak pernah bisa selesai
sekali pun.

**Kenapa 422 test hijau tidak menangkapnya.** Semua test lelang memakai
`MockSolverRegistry`, dan mock itu menerima `recordWin` dari siapa pun. Aturan
yang dilanggar hidup di kontrak asli, dan kontrak asli tidak pernah bertemu
`AuctionHouse` di satu test pun. Fork test pun tidak, karena fork test menguji
deploy dan bootstrap, bukan menjalankan lelang sampai habis.

Bentuknya baru lagi. Sebelas pelajaran sebelumnya adalah salah mengukur atau salah
membaca sumber. Yang ini adalah **test yang menguji kontrak palsu di tempat
kontrak aslinya bekerja tanpa masalah**. `rencana-uji.md` §6 sudah menulis
kalimatnya, yaitu *"Mock berbohong. Protokol eksternal harus diuji apa adanya"*,
tapi kalimat itu ditujukan ke protokol eksternal. Yang kena justru kontrak kami
sendiri.

Aturan yang lebih tajam, dan ini yang dipakai mulai sekarang. **Mock hanya untuk
yang tidak bisa dibuat asli.** Token rusak, token fee on transfer, desimal aneh,
adapter yang gagal. Kontrak sendiri tidak pernah di-mock, karena kontrak sendiri
selalu bisa di-deploy di dalam test.

Yang berubah.

| Tempat | Perubahan |
|---|---|
| `src/SolverRegistry.sol` | `auctionHouse` sebagai pelapor kedua, dipasang sekali, hanya boleh menambah skor |
| `script/Bootstrap.s.sol` | `setAuctionHouse` ikut di batch yang sama dengan `setSettlement` |
| `test/fixtures/AuctionFixture.sol` | registry asli menggantikan mock, dan solver jadi aktif dengan mem-bond |
| `test/fork/Bootstrap.fork.t.sol` | registry harus tahu auction house, dan menolak diberi tahu dua kali |

Pemisahan pelapornya disengaja. `Settlement` boleh memotong bond. `AuctionHouse`
hanya boleh menambah angka. Menyatukan keduanya jadi satu alamat tepercaya akan
memperbaiki bug ini sambil memberi lelang wewenang yang tidak ia butuhkan.


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

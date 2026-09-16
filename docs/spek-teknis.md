# Nokturn — Spek Teknis
### Lapisan settlement berbasis intent · Robinhood Chain

> Dokumen ini mengunci kontrak antar-bagian sebelum implementasi dimulai.
>
> ⚠️ **Untuk tipe, event, dan error yang kanonik, pakai [`interfaces.md`](interfaces.md).**
> Kalau file ini dan `interfaces.md` berbeda, `interfaces.md` yang menang.
> Konstanta: [`parameter.md`](parameter.md).

---

## 1. Alur ujung ke ujung

```
1. User tanda tangan Intent (EIP-712, offchain, gasless)
   └─ tidak ada transaksi, tidak ada dana berpindah

2. Intent masuk ke mempool intent (offchain, publik)

3. SessionManager menentukan: sesi apa sekarang?
   ├─ NYSE OPEN      → batch pendek (10 dtk) atau pass-through
   ├─ OFF_HOURS      → batch 30–60 dtk   ← fokus produk
   └─ WEEKEND        → batch 60 dtk

4. Jendela solusi dibuka (±10 dtk)
   └─ Solver bersaing mengajukan Solution ke Settlement

5. Settlement memverifikasi tiap Solution (lewat ClearingVerifier di Stylus)
   └─ menyimpan solusi valid dengan surplus tertinggi

6. finalize() → solusi pemenang dieksekusi atomik:
   ├─ tarik token dari user (Permit2)
   ├─ netting internal di harga kliring seragam
   ├─ sisa imbalance → venue adapter (Uniswap / Arcus / Rialto)
   └─ kirim token ke user
```

**Prinsip keamanan inti:** kontrak tidak pernah menyimpan dana pengguna dalam
keadaan diam. Dana hanya bergerak di dalam satu transaksi `finalize()` yang atomik.
Kalau ada satu saja pemeriksaan gagal, seluruhnya di-revert.

---

## 2. Struktur data

### 2.1 Intent (EIP-712)

```solidity
struct Intent {
    address owner;          // penanda tangan
    address receiver;       // penerima hasil (biasanya = owner)
    address sellToken;
    address buyToken;
    uint256 sellAmount;     // jumlah maksimum yang dijual
    uint256 minBuyAmount;   // limit price = minBuyAmount / sellAmount
    uint32  validAfter;     // unix ts
    uint32  validUntil;
    uint8   flags;          // bit0: partial fill diizinkan
    uint256 nonce;
}
```

```solidity
bytes32 constant INTENT_TYPEHASH = keccak256(
    "Intent(address owner,address receiver,address sellToken,address buyToken,"
    "uint256 sellAmount,uint256 minBuyAmount,uint32 validAfter,uint32 validUntil,"
    "uint8 flags,uint256 nonce)"
);
```

**Catatan desain:**
- Limit price disimpan sebagai rasio (`minBuyAmount / sellAmount`), bukan harga
  eksplisit. Menghindari asumsi desimal dan lebih tahan corporate action.
- `partial fill` penting untuk batch: intent ~$50 sering hanya sebagian yang
  ketemu pasangan internal.
- Nonce dikelola di bitmap (`mapping(address => mapping(uint256 => uint256))`)
  supaya pembatalan murah dan tidak berurutan.

### 2.2 Solution (diajukan solver)

```solidity
struct Execution {
    uint256 intentIndex;
    uint256 executedSell;   // <= intent.sellAmount
    uint256 executedBuy;    // harus >= limit pro-rata
}

struct VenueCall {
    address adapter;        // harus terdaftar di allowlist
    bytes   data;           // dienkode adapter
}

struct Solution {
    Intent[]      intents;
    bytes[]       signatures;
    address[]     tokens;    // daftar token unik dalam batch
    uint256[]     prices;    // harga kliring seragam, dinyatakan dalam USDG (1e18)
    Execution[]   executions;
    VenueCall[]   venueCalls;
    uint256       claimedSurplus;  // dalam USDG, 1e18
    address       solver;
}
```

**Kunci: `prices` panjangnya sama dengan `tokens`, satu harga per token per batch.**
Di sinilah "harga kliring seragam" dipaksakan secara struktural — tidak mungkin
memberi dua pengguna harga berbeda untuk token yang sama, karena hanya ada satu
angka harga per token.

---

## 3. Kontrak

### 3.1 `SessionManager.sol`

```solidity
enum Session {
    CLOSED_OVERNIGHT, PRE_MARKET, AUCTION_OPEN, OPEN,
    AUCTION_CLOSE, POST_MARKET, CLOSED_WEEKEND, HOLIDAY, PROTECTIVE
}
```

Interface lengkap ada di [`interfaces.md`](interfaces.md) §4 — termasuk
`sessionAt(uint64)` yang murni, `inGuardBand()`, dan `tokenSession()` untuk
`PROTECTIVE` per-token. Jangan menyalin ulang di sini.

- Kalender bursa & tabel batas DST disimpan onchain, diisi **2 tahun ke depan**,
  diperbarui lewat time-lock 48 jam. Tabel eksplisit, bukan aturan DST yang dihitung
  — alasannya di [`desain-session-engine.md`](desain-session-engine.md) §5
- `sessionAt(t)` adalah **fungsi murni** terhadap tabel: tidak ada input owner saat
  runtime. Ini yang memungkinkan pembuktian Halmos dan verifikasi mandiri
- Price band per sesi ada di [`parameter.md`](parameter.md) §2, bukan di sini
- `PROTECTIVE` **menimpa** keadaan waktu dan berlaku **per-token**, bukan per-chain

### 3.2 `Settlement.sol` — inti

```solidity
interface ISettlement {
    function submitSolution(Solution calldata s) external;
    function finalize(uint64 batchId) external;
    function invalidateNonce(uint256 nonce) external;
    function bestSolution(uint64 batchId) external view returns (bytes32 hash, uint256 surplus);
}
```

**`submitSolution`** — dipanggil selama jendela solusi:
1. cek solver terdaftar & bonded
2. cek `batchId` masih dalam jendela solusi
3. panggil `ClearingVerifier.verify(...)` (Stylus) → mengembalikan surplus terhitung
4. cek `computedSurplus == s.claimedSurplus`
5. kalau `surplus > bestSurplus[batchId]` → simpan hash solusi + surplus + solver

**`finalize`** — dipanggil siapa pun setelah jendela tutup:
1. ambil solusi pemenang (solver menyertakan kembali payload penuh; hash dicocokkan)
2. tarik semua `sellToken` dari owner via Permit2
3. jalankan `venueCalls` terhadap adapter yang ter-allowlist
4. kirim `executedBuy` ke tiap `receiver`
5. cek invarian saldo akhir (lihat §5)
6. bayar fee protokol + reward solver dari surplus

### 3.3 `SolverRegistry.sol`

```solidity
interface ISolverRegistry {
    function bond(uint256 amount) external;           // USDG
    function requestUnbond() external;                // + cooldown 7 hari
    function slash(address solver, uint256 amount, bytes32 reason) external;
    function isActive(address solver) external view returns (bool);
}
```

Slashing dipicu bila: solusi pemenang gagal saat `finalize` (menang lalu tidak
bisa dieksekusi = menghalangi batch), atau surplus yang diklaim terbukti palsu.

### 3.4 Venue adapters

```solidity
interface IVenueAdapter {
    /// Eksekusi swap. Dipanggil dari finalize(); state-changing.
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        external returns (uint256 amountOut);

    /// Hitung baseline dari state pool — MURNI view, tanpa panggilan ke Quoter.
    /// Inilah dasar verifikasi savings (lihat desain-ekonomi.md §2.3).
    /// Adapter WAJIB revert kalau venue-nya tidak bisa dihitung dari state
    /// (mis. pool V4 berhook dengan fee dinamis) — jangan pernah menebak.
    function quoteFromState(address tokenIn, address tokenOut, uint256 amountIn)
        external view returns (uint256 amountOut);

    /// TWAP untuk pemeriksaan silang oracle (lihat parameter.md §7.2).
    function twap(address tokenIn, address tokenOut, uint32 window)
        external view returns (uint256 price);

    /// Apakah venue ini mendukung baseline yang dapat diverifikasi kontrak.
    function isQuotable() external view returns (bool);
}
```

**Implementasi v1.0: `UniswapV3Adapter` saja.**

`quoteFromState` adalah alasan V4 ditunda: pool V4 dominan memakai hook fee dinamis
(`0x800000`), sehingga keluarannya tidak dapat dihitung dari state. Adapter V4 nanti
harus mengembalikan `isQuotable() == false` sampai perilaku hook `0x4E346895…`
dipahami — dan `Settlement` hanya boleh memakai adapter yang `isQuotable()`
untuk perhitungan baseline.

> ### ⚠️ Koreksi 1 Agustus 2026 — rencana adapter
> Rencana awal "tiga adapter: Uniswap, Arcus, Rialto" dibuat dari `dex.trades` Dune,
> yang **secara sistematis mengecilkan lanskap venue** di chain ini.
>
> Fakta terverifikasi: `ArcusSettlement` (`0x006102B1…`) menangani **224.987 leg
> transfer stock token dalam 7 hari** — nyata dan signifikan, tapi tidak muncul di
> `dex.trades`. Dan ada kontrak yang **lebih besar dari Arcus** yang belum
> teridentifikasi (`0x65050A9B…`, 630.719 leg) plus tiga lagi berukuran ratusan
> ribu leg.
>
> **Jangan kunci rencana adapter sebelum keempat kontrak itu teridentifikasi**
> lewat source terverifikasi di Robinscan/Blockscout.
>
> Yang tidak berubah: Uniswap V3 ($193,8jt) dan V4 ($106,1jt) tetap terbesar dan
> tetap dua adapter pertama. Arsitekturnya sangat berbeda — V3 pool per-pasangan,
> V4 PoolManager singleton — jadi tetap butuh dua implementasi terpisah.
Adapter berada di allowlist yang di-time-lock. Settlement memberi allowance
tepat sejumlah yang dipakai dan mencabutnya di akhir transaksi.

---

## 4. Modul Stylus (Rust) — `ClearingVerifier`

```rust
sol_interface! {
    interface IClearingVerifier {
        function verify(
            bytes calldata packedIntents,
            bytes calldata packedExecutions,
            address[] calldata tokens,
            uint256[] calldata prices,
            int256[] calldata venueDeltas,   // perubahan saldo dari venue calls
            uint256[] calldata oraclePrices,
            uint16 maxDeviationBps
        ) external pure returns (uint256 surplus);
    }
}
```

### Yang diverifikasi

1. **Harga seragam** — tersirat dari struktur (satu harga per token), tapi tetap
   dicek bahwa setiap `Execution` konsisten dengan `prices`:
   ```
   executedBuy * prices[buyToken] >= executedSell * prices[sellToken]
   ```
2. **Limit dihormati (pro-rata untuk partial fill)**:
   ```
   executedBuy * intent.sellAmount >= intent.minBuyAmount * executedSell
   ```
   Ditulis sebagai perkalian silang — tidak ada pembagian, tidak ada kehilangan presisi.
3. **Konservasi nilai per token**:
   ```
   Σ executedSell(token) + venueDelta_in(token)
     >= Σ executedBuy(token) + venueDelta_out(token)
   ```
4. **Price band**: `|prices[i] − oraclePrices[i]| * 10000 <= oraclePrices[i] * maxDeviationBps`
5. **Surplus** = `Σ (executedBuy − limitBuyProRata) * prices[buyToken]`, dalam USDG.

### Kenapa ini di Rust, bukan Solidity

Setiap intent butuh 4–6 operasi `mulDiv` pada uint256 plus pencarian indeks token.
Di Solidity, batch 200 intent berarti ~1.200 mulDiv + overhead memori yang mahal.
Di Stylus, memori dan compute jauh lebih murah, sehingga **ukuran batch yang
ekonomis naik berkali lipat** — dan ukuran batch adalah yang menentukan seberapa
sering intent saling bertemu.

**Yang harus diukur dan masuk pitch:** tabel gas `verify()` untuk N = 10, 50, 100,
200, 500 intent, Solidity versus Stylus. Ini bukti keras untuk kriteria juri.

> ### ⚠️ Verifikasi 1 Agustus 2026 — Stylus aktif, TAPI tanpa cache manager
> `ArbWasm.stylusVersion()` = **3** di mainnet dan testnet (identik), ArbOS 116,
> `pageLimit` 128 halaman (8 MB), `inkPrice` 10.000. **Stylus berfungsi.**
>
> **Tapi `ArbWasmCache.allCacheManagers()` mengembalikan array kosong** — tidak ada
> cache manager terdaftar. Artinya kontrak Stylus **tidak bisa di-cache**, sehingga
> setiap panggilan membayar **biaya aktivasi penuh** (dekompresi + instansiasi WASM),
> bukan hanya biaya eksekusi.
>
> ### ✅ TERUKUR 1 Agustus 2026 — dendanya nyata tapi tidak menghalangi
> Diukur lewat `programInitGas()` pada **tiga program Stylus sungguhan di mainnet**
> (ditemukan lewat trace `activateProgram` ke precompile `0x…71`; Dune
> `creation_traces` melewatkan semuanya):
>
> | | uncached | cached | rasio |
> |---|---|---|---|
> | initGas, program 2,2 MB / 17 halaman | **46.440 – 49.203** | 5.919 – 6.209 | **7,8×** |
> | `minInitGas()` — lantai program sepele | **8.832** | 352 | 25× |
>
> Konteks: program Stylus teraktif di chain ini punya median gas per panggilan
> **229.045** — jadi init ≈ **21%** dari panggilan median. Aktivasi satu kali:
> **7,7–8,2 juta gas**.
>
> **Putusan:** verifier kita aritmetika murni tanpa dependensi berat, jadi harusnya
> jauh lebih ramping dari 17 halaman — perkiraan 15rb–25rb (interpolasi, bukan
> ukuran). Ini **turun dari blocker arsitektur menjadi benchmark rutin Fase 2.**
> Rencana di bawah tidak berubah: tulis Solidity dulu, port ke Rust, differential
> test. Versi Solidity tetap dibutuhkan sebagai oracle pembanding.
>
> **Yang masih harus diukur di Fase 2:** biaya per-intent Stylus vs Solidity, yang
> menentukan titik impas sesungguhnya. Dan uji apakah `blockCacheSize` = 32 memberi
> keringanan nyata — gas minimum teramati (23.587) di bawah cold init, yang
> mengisyaratkan cache LRU per-blok bekerja. Detail: `pertanyaan-terbuka.md` P1-3.

---

## 5. Invarian keamanan (target Foundry fuzz + invariant testing)

> Delapan di bawah ini adalah inti settlement. **Daftar lengkapnya 14** — enam
> tambahan menutupi debu, escrow lelang, kekuasaan guardian, determinisme sesi,
> ambang closing print, dan mandat agent. Sumber kanonik:
> [`rencana-uji.md`](rencana-uji.md) §1.

| # | Invarian | Kenapa penting |
|---|---|---|
| 1 | Tidak ada intent dieksekusi di bawah limit-nya | Jaminan inti ke pengguna |
| 2 | Dua intent pada pasangan yang sama dalam satu batch mendapat harga identik | Definisi "kliring seragam" |
| 3 | Saldo token kontrak setelah `finalize` >= sebelum | Tidak ada kebocoran dana |
| 4 | Nonce tidak bisa dipakai dua kali | Anti replay |
| 5 | `finalize` atomik — semua atau tidak sama sekali | Tidak ada pengguna terjebak setengah jalan |
| 6 | Solver tidak bisa mengambil nilai di luar fee yang dideklarasikan | Anti rug oleh solver |
| 7 | Harga kliring selalu dalam price band oracle | Anti manipulasi meski semua limit longgar |
| 8 | Intent kedaluwarsa tidak pernah tereksekusi | Kebersihan waktu |

**Skenario adversarial yang wajib diuji:**
- Solver mengajukan solusi dengan surplus palsu
- Solver menang lalu gagal saat `finalize` (grief) → harus ter-slash
- Oracle dimanipulasi sesaat → price band harus menahan
- Batch berisi satu intent (edge case netting)
- Token dengan `uiMultiplier` berubah di tengah batch (corporate action)
- Reentrancy lewat adapter jahat → adapter allowlist + ReentrancyGuard

---

## 6. Pembagian modul

| Modul | Bahasa | Alasan |
|---|---|---|
| `Settlement` | Solidity | orkestrasi, transfer token, interaksi Permit2 |
| `SessionManager` | Solidity | logika kalender sederhana, sering dibaca |
| `SolverRegistry` | Solidity | bonding/slashing, state sederhana |
| Venue adapters | Solidity | interop dengan protokol Solidity |
| **`ClearingVerifier`** | **Rust / Stylus** | **matematika berat O(N), penentu ukuran batch** |
| Solver referensi | TypeScript | iterasi cepat; port ke Rust kalau sempat |
| Frontend | Next.js + wagmi/viem | standar yang direkomendasikan Arbitrum |

---

## 7. Algoritma solver (referensi)

Untuk MVP, tidak perlu optimal — cukup **lebih baik dari baseline**:

```
1. Kelompokkan intent per pasangan token
2. Untuk tiap pasangan, cari harga kliring p yang memaksimalkan volume
   tereksekusi (kurva supply–demand klasik):
   - urutkan buy menurun berdasarkan limit, sell menaik
   - titik potong = harga kliring
   - jepit p ke dalam price band oracle
3. Eksekusi bagian yang saling menutup di p (netting internal, nol venue)
4. Sisa imbalance → quote dari state pool Uniswap V3 (satu-satunya adapter v1.0)
5. Hitung surplus, ajukan
```

Baseline pembanding untuk demo: eksekusi tiap intent satu per satu langsung ke
Uniswap. Selisihnya = angka yang kamu tunjukkan ke juri.

---

## 8. Stack & struktur repo

```
nokturn/
├── contracts/           # Foundry
│   ├── src/
│   │   ├── Settlement.sol
│   │   ├── SessionManager.sol
│   │   ├── SolverRegistry.sol
│   │   ├── AuctionHouse.sol
│   │   ├── AgentMandate.sol
│   │   ├── PriceOracle.sol
│   │   ├── adapters/    # UniswapV3Adapter.sol (v1.0)
│   │   └── interfaces/
│   └── test/            # unit + invariant + fork test
├── verifier/            # Stylus (Rust), cargo-stylus
│   ├── src/lib.rs
│   └── benches/         # benchmark aktivasi vs eksekusi, dan vs Solidity
├── solver/              # TypeScript
├── app/                 # Next.js
└── analytics/           # query Dune + skrip backtest
```

Peta kontrak lengkap: [`interfaces.md`](interfaces.md) §1.

**Versi:** Solidity 0.8.28 · Foundry · stylus-sdk-rs · OpenZeppelin (Solidity & Rust)
· Permit2 · viem/wagmi · Next.js

**Jaringan:** testnet Robinhood Chain (46630, `https://rpc.testnet.chain.robinhood.com`)
→ mainnet (4663). Verifikasi kontrak lewat Blockscout.

### 8.1 Strategi deploy tiga lapis — konsekuensi dari aturan tanpa mock

Testnet 46630 **kosong dari infrastruktur ekuitas**: tidak ada Stock Token, USDG
kanonik, maupun pool Uniswap V3 (terverifikasi, `pertanyaan-terbuka.md` P2-6). Karena
itu testnet **tidak boleh dipakai untuk membuktikan angka** — apa pun yang berjalan di
sana berdiri di atas token dan pool yang kita isi sendiri, dan baseline dari pool isian
sendiri adalah angka yang kita tentukan sendiri. Itu persis bentuk pelanggaran aturan
`CLAUDE.md` §2 nomor 9.

Ketiganya dipakai bersamaan, dengan pembagian peran yang tegas:

| Lapis | Jaringan | Perannya | Yang **tidak** boleh diklaim di sini |
|---|---|---|---|
| **Pengembangan** | Testnet 46630 | Iterasi cepat, alur ujung ke ujung, gasless, UI | Angka apa pun — kualitas eksekusi, baseline, netting |
| **Pembuktian** | Fork mainnet (Anvil) | Fork test nol selisih; demo netting dengan intent Juli 2026 diputar ulang lewat impersonation | Bahwa ini settlement live |
| **Bukti keberadaan** | Mainnet 4663 | Kontrak final terverifikasi di Blockscout + **satu settlement nyata memakai dana sendiri** | Bahwa sudah ada pengguna |

**Kenapa fork, bukan testnet, yang jadi lapis pembuktian.** Netting butuh banyak pihak
berlawanan arah. Di mainnet yang baru di-deploy, netting-nya nol — bukan karena rusak,
tapi karena belum ada pengguna. Fork mainnet dengan arus historis memberi pool nyata,
token nyata, dan **lawan transaksi nyata**. Itu satu-satunya cara menunjukkan mekanisme
bekerja atas arus sungguhan tanpa mengarang siapa pun.

**Gerbang sebelum menyentuh mainnet.** Deploy mainnet dilakukan **paling akhir**, dan
hanya kalau seluruh gerbang §8 CI hijau: Slither + Aderyn nol temuan tinggi, coverage
≥95%, invariant lulus, dan fork test **nol selisih**. Kalau ada satu saja yang tidak
hijau menjelang tenggat, **jangan deploy mainnet** — submit dengan testnet + fork, yang
tetap memenuhi T&C §3.1 sepenuhnya. Keputusan ini diambil dari hasil CI, **bukan dari
tekanan waktu**. Ini penting karena settlement core immutable: bug yang lolos tidak bisa
ditambal, hanya bisa di-deploy ulang.

**Selama buildathon, jangan undang pengguna.** Kontrak hidup di mainnet dengan allowlist
menunjuk NVDA/AAPL/TSLA/GOOGL yang asli, tapi tanpa dana pihak ketiga, tanpa fee, tanpa
solicitation. Deploy mainnet tanpa pengguna adalah **pra-peluncuran, bukan mock** —
sedangkan deploy testnet dengan token karangan justru berbentuk mock. Lihat juga risiko
sisa #10 di `threat-model.md` §5 soal dimensi regulasi.

### 8.2 Biaya deploy mainnet — terukur, bukan estimasi kasar

Diukur 2 Agustus 2026 langsung dari RPC mainnet:

| | |
|---|---|
| `eth_gasPrice` | **20.056.000 wei** = 0,020056 gwei |
| `eth_maxPriorityFeePerGas` | **0** |
| Harga ETH | **$1.865,61** *(median 22,7jt trade di chain ini, Juli 2026)* |
| **Biaya per 1 juta gas** | **$0,0374** |

| Komponen | Perkiraan gas | USD |
|---|---|---|
| SettlementCore + SessionEngine + registry (~50KB) | 12.000.000 | $0,45 |
| ClearingVerifier versi Solidity (~20KB) | 5.000.000 | $0,19 |
| UniswapV3Adapter + library (~15KB) | 4.000.000 | $0,15 |
| Aktivasi Stylus 1 program *(terukur 7,7–8,2jt)* | 8.200.000 | $0,31 |
| Konfigurasi awal: allowlist 4 token + parameter | 800.000 | $0,03 |
| **TOTAL** | **30.000.000** | **$1,12** |

Bahkan kalau estimasi ukuran kode meleset **empat kali lipat**, biayanya $3,74. Satu
settlement batch nyata sekitar 1 juta gas = **$0,04**.

⚠️ Angka gas per komponen adalah **perkiraan dari ukuran kode**, bukan pengukuran —
kontraknya belum ditulis. Yang terukur adalah gas price, harga ETH, dan gas aktivasi
Stylus. Perbarui tabel ini setelah `forge build` pertama memberi ukuran bytecode nyata.

**Kesimpulan: biaya bukan variabel keputusan.** Yang menentukan apakah deploy mainnet
dilakukan adalah gerbang CI di §8.1, bukan ongkosnya. Biaya data L1 nol di chain ini,
jadi ukuran kontrak pun tidak menghukum.

---

## 9. Standar produksi — bukan MVP

Target: **produk sempit yang benar-benar selesai dan berjalan di mainnet**,
bukan prototipe luas. Prinsipnya:

> Kualitas produksi dicapai dengan **memperkecil permukaan** dan **memperdalam
> verifikasi**, bukan dengan menambah fitur.

### 9.1 Scope penuh, dengan generalitas yang digerbangi allowlist

Scope **tidak** dipotong. Kodenya umum dan lengkap. Yang dikontrol adalah
**eksposur**, bukan kemampuan.

| Dimensi | v1.0 |
|---|---|
| Sesi | **Penuh** — OPEN, PRE/POST_MARKET, OFF_HOURS, WEEKEND, HOLIDAY. Tiap sesi punya durasi batch & lebar price band sendiri |
| Pasangan | **Umum** — kode tidak mengasumsikan token tertentu. Eksposur digerbangi `tokenAllowlist` yang bisa tumbuh lewat time-lock |
| Venue | **Uniswap V3 SAJA di v1.0.** Pool V4 dominan memakai hook dengan fee dinamis (`0x800000`) sehingga baseline tidak bisa dihitung dari state — V4 ditunda ke v1.1 sampai perilaku hook `0x4E346895…` dipahami. ⭐ **Diperkuat data Agustus 2026:** pangsa V3 atas volume allowlist v1.0 naik dari **58,6% ke 82,5%**, sementara V4 turun dari **38,5% ke 12,6%**. Keputusan adapter tunggal yang dulu terasa seperti kompromi kini menutupi mayoritas pasar yang jauh lebih besar — lihat `parameter.md` §1B dan `CLAUDE.md` §6 |
| Partial fill | Ya |
| Topologi | Pasangan langsung; ring trade multi-aset tetap v1.1 *(sudah di luar scope sejak awal, bukan pemotongan baru)* |
| Upgradeability | **Settlement core immutable.** Tanpa proxy. Yang bisa berubah hanya allowlist token/adapter & parameter sesi, semuanya lewat time-lock 48 jam |
| Admin power | **Tidak ada kunci yang bisa memindahkan dana pengguna.** Pause hanya menghentikan batch baru, tidak menyentuh dana |

> **Prinsipnya:** `tokenAllowlist` dan `adapterAllowlist` membuat kamu bisa rilis
> kode umum dengan kerugian maksimum yang terhitung. Menambah token = satu
> transaksi time-lock, bukan deploy ulang. Ini yang membedakan protokol yang
> dirancang untuk tumbuh dari protokol yang di-hardcode.


> 🔴🔴 **Diperbarui 10 September 2026 — keputusan "V3 saja" perlu satu penajaman.**
> Peta venue allowlist sudah lengkap (`parameter.md` §10.1, kueri `8664785`), dan
> dua hal berubah:
>
> 1. **Pangsa Uniswap V3 turun 82,53% → 72,63% dalam sepuluh hari.** Argumen
>    "menutupi mayoritas pasar" masih berdiri, tapi trennya melawan — jangan kutip
>    82,5% tanpa arahnya.
> 2. ⭐ **Sisa yang hilang ternyata sebagian besar berkonsentrasi likuiditas gaya
>    V3 juga:** `uponrh v3` (2,73% → **9,27%**), `gigadex v3` (1,45%),
>    `ramsesxyz vcl` (0,39% → **3,48%**).
>
> ✅ **Sudah diverifikasi — P5-1 terjawab 10 Sep 2026** (`eth_call` langsung ke
> mainnet, kontrol pool `0xD4EB…14A3`; rincian `parameter.md` §10.1):
>
> | Venue | `slot0()` | `ticks()` | `fee()` | Vonis |
> |---|---|---|---|---|
> | `gigadex v3` | 7 word | 8 word | 100 statis | ✅ **identik V3** |
> | `ramsesxyz vcl` | 7 word | 8 word | 250 statis | ✅ **identik V3** |
> | `uponrh v3` | **6 word** | **10 word** | 500 statis | 🟡 **varian → v1.1** |
>
> **Tidak satu pun gugur karena alasan V4** — semua `fee()` statis, tidak ada
> penanda dinamis `0x800000`.
>
> **Keputusan:** tulis `UniswapV3Adapter` **agnostik terhadap factory** — alamat
> pool datang dari `adapterAllowlist`, bukan konstanta factory Uniswap. Itu bukan
> penambahan scope, melainkan menghindari hardcode, persis prinsip §9.1 di atas.
> Cakupan September **72,63% → 77,14%** lewat time-lock, tanpa kode baru.
>
> ⚠️ `uponrh` **tidak masuk v1.0**: `slot0` tanpa field `unlocked` membuat ABI-decode
> tuple-7 gagal, dan dua field tambahan di `ticks()` berarti posisi `liquidityNet`
> belum terverifikasi. Kandidat v1.1, dan bernilai — ia sendirian **9,27%**, tumbuh
> 3,4× dalam sebulan.
>
> ⚠️ Uji ini memindahkan `gigadex`/`ramses` dari "tidak diketahui" ke **"layak
> diuji"**, bukan ke "terbukti". Gerbang `rencana-uji.md` tetap mengikat: **fork test
> nol selisih** per pool sebelum masuk allowlist produksi.


**Konsekuensi yang harus disadari:** tiga hal ini menaikkan beban verifikasi
secara signifikan, dan semuanya sudah diperhitungkan di §9.2.

| Yang melebar | Risiko yang muncul | Penanganan |
|---|---|---|
| Pasangan umum | Token aneh: fee-on-transfer, rebasing, desimal non-standar, `uiMultiplier` berubah | Balance-delta assertion sebelum & sesudah tiap transfer (jangan pernah percaya nilai yang dikembalikan); uji properti per-token sebelum masuk allowlist |
| Semua sesi | State machine sesi punya banyak transisi | FSM-nya kecil dan bisa dienumerasi — target sempurna untuk symbolic execution (§9.2 #4) |
| Multi-adapter | Tiap adapter menambah permukaan panggilan eksternal; adapter jahat/rusak | Interface adapter ketat, allowance tepat-jumlah lalu dicabut, ReentrancyGuard, fork test terhadap state mainnet nyata per adapter |

### 9.2 Lapisan verifikasi — jauh di atas standar hackathon

Karena scope penuh, verifikasinya harus berlapis. Tujuh lapis di bawah ini
saling menangkap kelas bug yang berbeda; tidak ada satu pun yang menggantikan
yang lain.

| # | Lapis | Menangkap apa | Alat |
|---|---|---|---|
| 1 | **Threat model tertulis** | Kesalahan desain — kelas bug termahal, tidak terdeteksi alat apa pun | Dokumen: aktor, aset, jalur serangan, mitigasi. Ditulis minggu 1, bukan di akhir |
| 2 | **Differential testing Rust ↔ Solidity** | Kesalahan implementasi di matematika inti | Kita tetap butuh versi Solidity untuk benchmark gas — pakai sebagai **oracle pembanding**. Fuzz jutaan input ke keduanya, assert identik. Dua implementasi independen yang sepakat = bukti kuat, dan ini gratis karena sudah di jalur kerja |
| 3 | **Dua fuzzer berbeda** | Bug yang lolos satu engine | **Foundry** (property + invariant, multi-actor handler) **dan Echidna**. Mesin eksplorasinya berbeda, temuannya berbeda. Menjalankan keduanya adalah praktik audit, bukan praktik hackathon |
| 4 | **Symbolic execution** | Edge case di seluruh rentang input, bukan sampel acak | **Halmos** (gratis) pada fungsi matematika inti **dan pada FSM sesi** — FSM-nya kecil dan bisa dienumerasi penuh, jadi transisi sesi bisa dibuktikan benar, bukan sekadar diuji |
| 5 | **Mutation testing** | **Kualitas test suite-nya sendiri** | Suntikkan mutasi ke kode; kalau test tetap hijau, berarti test-nya bolong. Ini membalik pertanyaan dari "apakah kode benar" jadi "apakah test saya benar-benar menguji". **Sangat jarang dilakukan di luar protokol yang diaudit** |
| 6 | **Fork testing terhadap mainnet nyata** | Asumsi salah tentang protokol eksternal | Tiap adapter diuji terhadap state mainnet Robinhood Chain sungguhan — pool Uniswap nyata, Arcus nyata, Rialto nyata. Bukan mock |
| 7 | **Static analysis di CI** | Pola berbahaya yang lolos mata | **Slither** + **Aderyn** wajib hijau tiap commit; snapshot gas & storage layout ikut di-commit supaya perubahan tak sengaja terlihat di diff |

### Pengaman operasional (di luar pengujian)

| Pengaman | Isi |
|---|---|
| **Exposure caps** | Batas notional per batch, per token, dan per hari. Mulai kecil (mis. $5.000/batch), naik bertahap seiring jam terbang. **Ini yang membuat mainnet awal aman meski belum diaudit** — kerugian maksimum jadi angka yang bisa dihitung, bukan harapan |
| **Balance-delta assertion** | Jangan pernah percaya nilai kembalian token. Ukur saldo sebelum & sesudah tiap transfer. Ini yang membuat token fee-on-transfer atau `uiMultiplier` yang berubah tidak bisa merusak akuntansi |
| **Time-lock 48 jam** | Semua perubahan allowlist token/adapter & parameter sesi |
| **Monitoring & runbook** | Watcher memantau tiap batch, alert kalau invarian menyimpang. Runbook tertulis: siapa pause, kapan, bagaimana komunikasinya |
| **Review eksternal** | Kode publik sejak awal + bug bounty mandiri berhadiah + **manfaatkan sesi feedback Buildathon sebagai review gratis dari tim teknis Arbitrum** — akses yang tidak dipakai kebanyakan peserta |
| **Jam terbang mainnet** | Target **≥2 minggu operasi mainnet** sebelum submission, sesi berjalan tiap malam |

> **Kenapa lapisan ini yang dipilih:** #2, #3, #5 semuanya menyerang pertanyaan
> "apakah aku yakin ini benar" dari sudut berbeda — implementasi ganda, mesin
> pencari ganda, dan uji terhadap test-nya sendiri. Digabung dengan #4 yang
> membuktikan (bukan menguji) bagian yang bisa dibuktikan, ini profil verifikasi
> setara protokol yang sudah diaudit. Sebutkan ini eksplisit di pitch — juri
> menilai *smart contract quality*, dan sedikit sekali tim yang bisa menunjukkan
> mutation testing dan differential testing.

### 9.3 Yang jujur tidak bisa dicapai dalam 60 hari

Tulis ini di pitch, jangan sembunyikan. Tim yang menyajikan threat model dan
batas eksposur terlihat jauh lebih profesional daripada tim yang mengklaim
"sudah sempurna".

- ❌ Audit eksternal berbayar (biaya & antrean tidak muat)
- ❌ Mempool intent terdesentralisasi — koordinator tunggal dulu, dan **katakan
  bahwa ini titik sentralisasi yang disadari**
- ❌ Commit–reveal solusi solver *(risiko penyalinan solusi antar-solver;
  mitigasi v1: jendela solusi pendek + bonding)*
- ❌ Kalender bursa terdesentralisasi — owner + time-lock dulu

**Cara membingkainya ke juri:** "Ini yang sudah terverifikasi. Ini batas eksposur
kami dan alasannya. Ini yang belum selesai dan kapan selesainya." Itu bahasa
founder, bukan bahasa peserta hackathon.

---

## 10. Rencana 63 hari versi produksi

| Fase | Hari | Target | Definisi selesai |
|---|---|---|---|
| **0 · Fondasi** | 1–7 | Analitik, threat model, jawab 4 pertanyaan §11, scaffold repo, **CI berjalan sejak commit pertama** (Slither + Aderyn + gas snapshot) | Grafik spread per jam per venue; **risiko transfer-hook Stock Token terjawab**; threat model tertulis |
| **1 · Referensi** | 8–19 | Solidity penuh: Intent, Settlement, **SessionManager semua sesi**, verifier versi Solidity | Batch netting internal berhasil di testnet; FSM sesi lengkap; harness fuzz jalan |
| **2 · Stylus** | 20–30 | Port verifier ke Rust + **differential testing** vs Solidity | Jutaan input, kedua implementasi identik; tabel gas N=10…500 selesai |
| **3 · Integrasi** | 31–40 | **Adapter Uniswap V3 saja** (V4 = v1.1, lihat §9.1), routing sisa, AuctionHouse + escrow + tantangan, SolverRegistry + kompetisi | Fork test adapter V3 hijau terhadap state mainnet nyata; lelang buka/tutup jalan; dua solver bersaing |
| **4 · Verifikasi** | 41–48 | Foundry invariant + **Echidna** + **Halmos** + **mutation testing**, skenario adversarial, monitoring + runbook | **14 invarian** hijau di dua fuzzer; Halmos lolos pada matematika inti & FSM sesi; skor mutasi ≥ 90% inti; kalender diuji habis 2020–2035 |
| **5 · Mainnet** | 49–52 | **Deploy mainnet dengan caps ketat**, kode publik, buka bug bounty | Sesi berjalan tiap malam dengan batas notional kecil |
| **6 · Operasi** | 53–60 | Jalankan, pantau, naikkan caps bertahap, perbaiki temuan | **≥12 hari jam terbang mainnet**; data price improvement nyata terkumpul |
| **7 · Submission** | 61–63 | Demo, dokumentasi, SDK, deck | Angka mainnet nyata, benchmark gas, skor mutasi, threat model, batas yang diakui |

**Catatan urutan:** mainnet di hari 49, bukan hari 60. Yang membuat proyek terlihat
seperti startup adalah **jam terbang produksi**, bukan tanggal deploy yang mepet.

### Tiga aturan kerja untuk scope penuh

1. **CI dari hari pertama.** Static analysis, gas snapshot, dan coverage gate jalan
   sejak commit pertama — bukan ditambahkan belakangan.
2. **Frontend & analitik paralel**, bukan berurutan. Juri menilai kontrak.
3. **Lapisan verifikasi tidak pernah jadi variabel penyesuaian.** Kalau ada yang
   perlu digeser, geser urutan adapter — jangan pernah kedalaman verifikasi.

### Yang membuatnya bersaing dengan startup

Bukan volume kode. Empat ini:

1. **Berjalan di mainnet dengan pengguna nyata**, bukan demo testnet
2. **Hasil terukur** — price improvement versus baseline, dengan metodologi yang
   bisa diverifikasi orang lain
3. **Mitra integrasi** — surat minat dari Rialto/Arcus/Lighter. Kamu sumber order
   flow mereka, bukan pesaing; ini percakapan yang masuk akal untuk mereka
4. **Posisi kategori** yang jelas dan kosong: settlement layer di Robinhood Chain

---

## 11. Pertanyaan terbuka

> **Bagian ini sudah usang dan digantikan.**
> Keempat pertanyaan yang dulu tercantum di sini **semuanya sudah terjawab** lewat
> verifikasi onchain 1 Agustus 2026.
>
> **Sumber kebenaran tunggal: [`pertanyaan-terbuka.md`](pertanyaan-terbuka.md).**

Ringkas hasilnya:

| Dulu | Sekarang |
|---|---|
| Permit2 ter-deploy? | ✅ Ada di mainnet & testnet, sudah dipakai pengguna nyata |
| Transfer hook bisa gagal? | ✅ **Tidak.** `transfer` & `transferFrom` ke alamat baru berhasil |
| Feed Chainlink mana? | ✅ 30 feed `DualAggregator`, alamat & cadence terpetakan |
| Perilaku `uiMultiplier`? | ✅ Ada di semua token, semuanya `1e18` |

Yang masih terbuka sekarang bersifat **tidak memblokir** — butuh kode (benchmark
gas), percakapan (mitra, regulasi), atau waktu (kalibrasi dari data mainnet).
Semuanya punya nilai default yang berfungsi atau mitigasi yang sudah dirancang.
Detail lengkap di `pertanyaan-terbuka.md`.

# Nokturn — Referensi Interface, Event & Error

> Referensi kanonik untuk implementasi. Fungsi, event, dan error kustom lengkap.
>
> **Event adalah warga kelas satu di sini**, bukan pikiran belakangan — dasbor
> penghematan, indexer, monitoring, dan seluruh bukti untuk juri bergantung
> sepenuhnya padanya.
>
> Konstanta: lihat [`parameter.md`](parameter.md) · Istilah: [`glosarium.md`](glosarium.md)

---

## 1. Peta kontrak

```
Settlement.sol          ← inti; orkestrasi, immutable
├── SessionManager.sol  ← keadaan pasar (fungsi murni + tabel kalender)
├── SolverRegistry.sol  ← bond, slashing, papan skor
├── AuctionHouse.sol    ← lelang buka/tutup, escrow, tantangan
├── AgentMandate.sol    ← wewenang agent yang dibatasi
├── PriceOracle.sol     ← Chainlink + TWAP UniV3, deteksi ketidaksepakatan
├── adapters/
│   └── UniswapV3Adapter.sol   ← v1.0, SATU-SATUNYA adapter
│       (UniswapV4Adapter = v1.1: hook fee dinamis 0x800000 tidak
│        dapat dihitung dari state → isQuotable() harus false)
└── verifier/           ← ClearingVerifier
    (Stylus/Rust ATAU Solidity — belum final, tergantung benchmark
     aktivasi vs eksekusi; lihat pertanyaan-terbuka.md P1-3)
```

---

## 2. Tipe bersama

```solidity
enum Session {
    CLOSED_OVERNIGHT, PRE_MARKET, AUCTION_OPEN, OPEN,
    AUCTION_CLOSE, POST_MARKET, CLOSED_WEEKEND, HOLIDAY, PROTECTIVE
}

enum IntentKind { SPOT, MOO, LOO, ROO }

struct Intent {
    address owner;
    address receiver;
    address sellToken;
    address buyToken;
    uint256 sellAmount;
    uint256 minBuyAmount;
    uint32  validAfter;
    uint32  validUntil;
    uint8   flags;          // bit0 partial fill · bit1 agent-signed · bit2 auction
    uint8   kind;           // IntentKind
    uint16  maxDevFromRefBps; // hanya untuk ROO
    uint8   allowedSessions;  // bitmask
    uint16  batchSpan;        // >1 = Batch-TWAP, sebar ke N batch
    uint256 nonce;
}

struct Execution { uint256 intentIndex; uint256 executedSell; uint256 executedBuy; }
struct VenueCall { address adapter; bytes data; }

struct Solution {
    uint64      batchId;
    Intent[]    intents;
    bytes[]     signatures;
    address[]   tokens;
    uint256[]   prices;        // per token, dalam USDG, 1e18
    Execution[] executions;
    VenueCall[] venueCalls;
    uint256[]   baselineQuotes; // SATU per Execution, sejajar dengan array executions.
                               // Diverifikasi dengan menghitung ulang dari state pool.
                               // Dikoreksi 16 September 2026, sebelumnya tertulis
                               // "per pasangan". Baseline bergantung pada UKURAN
                               // karena slippage, jadi satu angka per pasangan tidak
                               // bisa menghasilkan baselineBuy per intent yang
                               // dituntut event IntentSettled.
    uint256     claimedSavings;
    address     solver;
}
```

**EIP-712**

```solidity
bytes32 constant INTENT_TYPEHASH = keccak256(
  "Intent(address owner,address receiver,address sellToken,address buyToken,"
  "uint256 sellAmount,uint256 minBuyAmount,uint32 validAfter,uint32 validUntil,"
  "uint8 flags,uint8 kind,uint16 maxDevFromRefBps,uint8 allowedSessions,"
  "uint16 batchSpan,uint256 nonce)"
);
// domain: name="Nokturn", version="1", chainId, verifyingContract
```

---

## 3. `Settlement`

```solidity
interface ISettlement {
    // --- jalur utama ---
    function submitSolution(Solution calldata s) external;
    function finalize(uint64 batchId, Solution calldata winning) external;

    // --- escape hatch anti-sensor ---
    function submitIntentOnchain(Intent calldata i, bytes calldata sig) external;

    // --- pengguna ---
    function invalidateNonce(uint256 nonce) external;
    function invalidateNonceRange(uint256 wordPos, uint256 mask) external;

    // --- baca ---
    function bestSolution(uint64 batchId)
        external view returns (bytes32 hash, uint256 savings, address solver);
    function batchWindow(uint64 batchId)
        external view returns (uint64 collectStart, uint64 collectEnd, uint64 solveEnd);
    function nonceUsed(address owner, uint256 nonce) external view returns (bool);
}
```

### Event

```solidity
event IntentSettled(
    uint64  indexed batchId,
    address indexed owner,
    bytes32 indexed intentHash,
    address sellToken,
    address buyToken,
    uint256 executedSell,
    uint256 executedBuy,
    uint256 baselineBuy,     // yang akan didapat kalau eksekusi sendiri
    uint256 savingsUsd       // ← metrik inti; SAMA dengan dasar fee
);

event BatchSettled(
    uint64  indexed batchId,
    address indexed solver,
    uint8   session,
    uint256 intentCount,
    uint256 nettedVolumeUsd,   // ← bagian yang saling menutup internal
    uint256 routedVolumeUsd,   // ← sisa yang ke venue
    uint256 totalSavingsUsd,
    uint256 solverFeeUsd,
    uint256 protocolFeeUsd
);

event BatchPassthrough(uint64 indexed batchId, uint256 intentCount, string reason);
event SolutionSubmitted(uint64 indexed batchId, address indexed solver, bytes32 hash, uint256 claimedSavings);
event SolutionRejected(uint64 indexed batchId, address indexed solver, bytes32 reason);
event ClearingPrice(uint64 indexed batchId, address indexed token, uint256 price, uint256 refPrice);
event IntentSubmittedOnchain(address indexed owner, bytes32 indexed intentHash);
event DustSwept(address indexed token, uint256 amount);
```

> `nettedVolumeUsd` versus `routedVolumeUsd` adalah pasangan event terpenting
> setelah `savingsUsd`. Rasio keduanya **mengukur langsung apakah efek jaringan
> mulai bekerja** — dan itu metrik yang ditunggu mitra integrasi.

### Error

```solidity
error BatchNotOpen(uint64 batchId);
error SolutionWindowClosed(uint64 batchId);
error LimitViolated(uint256 intentIndex);
error NonUniformPrice(address token);
error ValueNotConserved(address token, int256 delta);
error PriceOutsideBand(address token, uint256 price, uint256 ref, uint16 maxBps);
error SavingsMismatch(uint256 claimed, uint256 computed);
error ExposureCapExceeded(bytes32 capKind, uint256 attempted, uint256 cap);
error IntentExpired(uint256 intentIndex);
error NonceAlreadyUsed(address owner, uint256 nonce);
error SessionNotAllowed(uint256 intentIndex, uint8 session);
error AdapterNotAllowed(address adapter);
error TokenNotAllowed(address token);
error MultiplierChanged(address token, uint256 atStart, uint256 atSettle);
error MandateViolated(uint256 intentIndex, bytes32 rule);
```

---

## 4. `SessionManager`

```solidity
interface ISessionManager {
    function sessionAt(uint64 timestamp) external view returns (Session);   // MURNI
    function currentSession() external view returns (Session);
    function batchDuration(Session s) external view returns (uint32);
    function maxDeviationBps(Session s) external view returns (uint16);
    function inGuardBand(uint64 timestamp) external view returns (bool);
    function tokenSession(address token) external view returns (Session);   // PROTECTIVE per-token
    function nextTransition(uint64 from) external view returns (uint64);
}
```

```solidity
event SessionChanged(uint8 indexed from, uint8 indexed to, uint64 timestamp);
event TokenProtective(address indexed token, bytes32 reason);
event TokenProtectiveCleared(address indexed token, uint8 healthyUpdates);
event CalendarUpdated(uint32 indexed date, uint8 kind, uint32 closeTime);
event DstTableUpdated(uint64[] boundaries);
```

> `sessionAt` **wajib `pure` terhadap tabel** — tanpa input owner saat runtime.
> Ini yang memungkinkan pembuktian Halmos dan verifikasi mandiri oleh siapa pun.

---

## 5. `AuctionHouse`

```solidity
interface IAuctionHouse {
    function openAuction(address token, uint8 kind) external returns (uint64 auctionId);
    function commitAuctionIntent(Intent calldata i, bytes calldata sig) external;
    function cancelBeforeFreeze(bytes32 intentHash) external;
    function publishIndicative(uint64 auctionId) external;
    function freeze(uint64 auctionId) external;           // escrow ditarik di sini
    function extend(uint64 auctionId) external;
    function submitCross(uint64 auctionId, uint256 price, Execution[] calldata e) external;
    function challenge(uint64 auctionId, uint256 betterPrice) external;
    function executeCross(uint64 auctionId) external;
    function abortAuction(uint64 auctionId) external;
    function refundEscrow(bytes32 intentHash) external;   // selalu bisa dipanggil siapa pun

    function closingPrice(address token, uint32 day)
        external view returns (uint256 price, uint256 volume, uint32 participants, bool sufficient);
    function lastClose(address token) external view returns (uint256 price, uint64 ts, bool sufficient);

    // Dibaca ClosingPrintFeed, satu instance per token, untuk permukaan §5.1.
    function printRound(address token, uint32 day)
        external view returns (int256 answer, uint64 startedAt, uint64 updatedAt);
    function latestPrintDay(address token) external view returns (uint32 day);
}
```

> **Diperbarui 16 September 2026, saat kontraknya ditulis.** Empat fungsi
> lifecycle ditambahkan karena memang dipanggil, yaitu `openAuction`, `freeze`,
> `extend`, dan `abortAuction`. `challenge` kehilangan penanda `payable` karena
> `parameter.md` §3 menetapkan bond-nya 500 USDG, dan bond dalam USDG tidak bisa
> datang sebagai `msg.value`.
>
> `day` di permukaan ini adalah tanggal kalender `YYYYMMDD`, bukan indeks hari.
> `parameter.md` §3.1 mengunci `PRINT_ROUND_ID` begitu supaya
> `getRoundData(20260910)` menjawab sendirian. Kontrak lain menghitung hari sejak
> epoch, dan konversinya terjadi hanya di batas ini.
>
> `CommitmentDropped(auctionId, intentHash, reason)` menyusul di daftar event,
> untuk intent yang escrow-nya gagal ditarik saat pembekuan.

```solidity
event AuctionOpened(uint64 indexed auctionId, address indexed token, uint8 kind, uint64 crossAt);
event IndicativePublished(
    uint64 indexed auctionId, address indexed token,
    uint256 indicativePrice, int256 imbalance, uint256 matchedVolume  // ← undangan likuiditas
);
event AuctionFrozen(uint64 indexed auctionId, uint256 committedIntents, uint256 escrowedValue);
event CrossSubmitted(uint64 indexed auctionId, address indexed solver, uint256 price, uint256 volume);
event CrossChallenged(uint64 indexed auctionId, address indexed challenger, uint256 oldPrice, uint256 newPrice, bool successful);
event AuctionExtended(uint64 indexed auctionId, uint8 extensionCount, uint16 newCollarBps);
event CrossExecuted(uint64 indexed auctionId, address indexed token, uint256 price, uint256 volume, uint32 participants);
event ClosingPrintPublished(address indexed token, uint32 indexed day, uint256 price, uint256 volume, uint32 participants, bool sufficient);
event ClosingPrintWithheld(address indexed token, uint32 indexed day, bytes32 reason, uint256 volume, uint32 participants); // gerbang PRINT_MIN_VOLUME/PRINT_MIN_PARTICIPANTS tidak terpenuhi — tidak ada ronde baru, latestRoundData tetap kembalikan print lama
event AuctionAborted(uint64 indexed auctionId, bytes32 reason);
event EscrowRefunded(bytes32 indexed intentHash, address indexed owner, uint256 amount);
event CommitmentDropped(uint64 indexed auctionId, bytes32 indexed intentHash, bytes32 reason);
```

> `IndicativePublished` adalah **event paling penting di seluruh protokol untuk
> menarik likuiditas**. Ia harus mudah dilanggan dan murah dibaca — inilah
> mekanisme yang mengubah risiko tak diketahui menjadi peluang terukur.

### 5.1 Permukaan baca kedua — kompatibel Chainlink

> Ditambahkan **10 September 2026**. Alasan lengkap: `desain-auction.md` §3.3 ·
> konstanta terkunci: `parameter.md` §3.1. `closingPrice` / `lastClose` di atas
> tetap ada sebagai permukaan asli (metadata kualitas: `participants`,
> `sufficient`); interface di bawah ini adalah **permukaan drop-in kedua** untuk
> konsumen yang sudah menulis kode terhadap `AggregatorV3Interface`.

```solidity
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);          // PRINT_DECIMALS = 8
    function description() external view returns (string memory);
    function latestRoundData() external view returns (
        uint80 roundId,       // PRINT_ROUND_ID: session day, YYYYMMDD
        int256 answer,        // closing print price
        uint256 startedAt,    // closing auction open time
        uint256 updatedAt,    // actual cross timestamp — NEVER block.timestamp.
                               // The print is stale by design (up to 23h); faking
                               // freshness would make consumer staleness checks
                               // fail silently. See parameter.md §3.1.
        uint80 answeredInRound
    );
    function getRoundData(uint80 roundId) external view returns (
        uint80 roundId_,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,     // same rule as above — never fabricated
        uint80 answeredInRound
    );
}
```

> **Tidak ada ronde baru saat gerbang tidak terpenuhi.** Kalau `PRINT_MIN_VOLUME`
> atau `PRINT_MIN_PARTICIPANTS` tidak tercapai untuk suatu hari sesi,
> `latestRoundData`/`getRoundData` **tidak pernah mengarang angka** — keduanya
> tetap mengembalikan print valid terakhir dengan `updatedAt` aslinya yang lebih
> tua, sehingga pemeriksaan staleness milik konsumen menolaknya dengan benar atas
> kemauan mereka sendiri. Lihat `ClosingPrintWithheld` di bawah untuk kasus ini.

---

## 6. `SolverRegistry`

```solidity
interface ISolverRegistry {
    function bond(uint256 amount) external;
    function requestUnbond() external;
    function withdrawBond() external;
    function slash(address solver, uint256 amount, bytes32 reason) external;
    function isActive(address solver) external view returns (bool);
    function stats(address solver) external view returns (
        uint256 batchesWon, uint256 savingsGeneratedUsd,
        uint256 failedFinalizes, uint256 slashCount
    );
}
```

```solidity
event SolverBonded(address indexed solver, uint256 amount, uint256 total);
event SolverUnbondRequested(address indexed solver, uint64 availableAt);
event SolverSlashed(address indexed solver, uint256 amount, bytes32 reason);
event SolverScoreUpdated(address indexed solver, uint256 batchesWon, uint256 savingsGeneratedUsd);
```

> Papan skor diturunkan **sepenuhnya dari fakta settlement**, bukan ulasan yang
> dilaporkan sendiri. Sybil tidak berguna: satu-satunya cara menaikkan skor adalah
> benar-benar menghasilkan penghematan untuk pengguna nyata.

---

## 7. `AgentMandate`

```solidity
interface IAgentMandate {
    function createMandate(Mandate calldata m) external returns (bytes32 id);
    function revokeMandate(bytes32 id) external;
    function validate(bytes32 id, Intent calldata i) external view returns (bool, bytes32 reason);
    function spentToday(bytes32 id) external view returns (uint256);
}
```

```solidity
event MandateCreated(bytes32 indexed id, address indexed owner, address indexed agent, uint64 expiry);
event MandateRevoked(bytes32 indexed id);
event MandateUsed(bytes32 indexed id, bytes32 indexed intentHash, uint256 notionalUsd);
event MandateRejected(bytes32 indexed id, bytes32 rule);
```

---

## 8. `PriceOracle`

```solidity
interface IPriceOracle {
    function refPrice(address token) external view returns (uint256 price, uint64 ts, bool healthy);

    // Sumber kedua = TWAP Uniswap V3, BUKAN RedStone (tidak ada di chain ini)
    function dualCheck(address token)
        external view returns (uint256 chainlink, uint256 uniTwap, bool agree);

    // Harga REFERENSI pembukaan = TWAP feed 300 dtk pertama sesi OPEN.
    // BUKAN harga pembukaan resmi bursa — itu tidak tersedia onchain.
    function openReference(address token, uint32 day)
        external view returns (uint256 price, bool available);

    function stalenessLimit(address token) external view returns (uint32);  // per-feed
}
```

> ⚠️ Tidak ada `officialOpen` / `officialClose`. `DualAggregator` Chainlink punya
> `transmitSecondary` dan `setCutoffTime`, tapi **`transmitSecondary` tidak pernah
> dipakai** dan `cutoffTime()` tidak punya getter publik. Jangan merancang apa pun
> yang bergantung pada harga bursa resmi onchain.

```solidity
event OracleDisagreement(address indexed token, uint256 primary, uint256 secondary, uint16 deviationBps);
event OracleStale(address indexed token, uint64 lastUpdate, uint32 limit);
event OracleHealthy(address indexed token);
```

---

## 8B. `IVenueAdapter`

```solidity
interface IVenueAdapter {
    /// Eksekusi swap. Dipanggil dari finalize(); state-changing.
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        external returns (uint256 amountOut);

    /// Baseline dari state pool — MURNI view. Dasar verifikasi savings.
    /// WAJIB revert kalau venue tidak dapat dihitung dari state.
    function quoteFromState(address tokenIn, address tokenOut, uint256 amountIn)
        external view returns (uint256 amountOut);

    /// TWAP untuk pemeriksaan silang oracle.
    function twap(address tokenIn, address tokenOut, uint32 window)
        external view returns (uint256 price);

    /// Apakah venue mendukung baseline yang dapat diverifikasi kontrak.
    function isQuotable() external view returns (bool);
}
```

```solidity
event AdapterAllowlisted(address indexed adapter, bool quotable);
event AdapterRemoved(address indexed adapter);
event VenueRouted(uint64 indexed batchId, address indexed adapter, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);
```

> **v1.0 hanya `UniswapV3Adapter`.** Pool Uniswap V4 dominan memakai hook fee
> dinamis (`0x800000`) sehingga tidak dapat dihitung dari state — adapter V4 nanti
> harus mengembalikan `isQuotable() == false`, dan `Settlement` hanya boleh memakai
> adapter yang `isQuotable()` untuk perhitungan baseline.
>
> **Quoter Uniswap tidak bisa dipanggil `staticcall`** (ia mencoba `SSTORE`), jadi
> `quoteFromState` wajib menghitung sendiri dari `slot0` + `liquidity` + `fee`.
>
> ### 📐 Spek implementasi lengkap: [`desain-baseline.md`](desain-baseline.md)
> Algoritma penyeberangan tick, arah pembulatan, batas gas, dan matriks uji.
> **Tiga hal yang paling gampang salah:**
> 1. **Urutan token tidak konsisten antar pool** — NVDA punya USDG di `token0`,
>    GME punya USDG di `token1`. Turunkan `zeroForOne` dari `token0()`
> 2. **`baselineReceived` dibulatkan KE ATAS**, kebalikan konvensi umum — baseline
>    menentukan fee, jadi membulatkannya ke bawah = mengenakan fee berlebih
> 3. **Batas kata bitmap bukan penyeberangan tick** — hitung dua counter terpisah

Error tambahan untuk adapter:

```solidity
error PoolNotInitialized(address pool);
error TokenNotInPool(address pool, address token);
error LiquidityExhausted(address pool, uint256 amountRemaining);
error TooManyTickCrossings(address pool, uint16 crossings);
error DynamicFeeUnsupported(address pool);
```

---

## 9. `ClearingVerifier` (Stylus / Rust)

```solidity
interface IClearingVerifier {
    function verify(
        bytes    calldata packedIntents,
        bytes    calldata packedExecutions,
        address[] calldata tokens,
        uint256[] calldata prices,
        int256[]  calldata venueDeltas,
        uint256[] calldata oraclePrices,
        uint256[] calldata baselineQuotes,
        uint16    maxDeviationBps
    ) external pure returns (uint256 savings);

    // evaluasi V(p) pada SATU harga — O(N), tanpa pengurutan.
    // Inilah yang membuat verifikasi tantangan lelang murah.
    function evaluateVolume(
        bytes calldata packedIntents,
        uint256 price
    ) external pure returns (uint256 demand, uint256 supply, uint256 executable);
}
```

`verify` memeriksa: harga seragam · limit dihormati (perkalian silang) · konservasi
nilai per token · price band · kebenaran savings. Gagal → revert dengan error §3.

---

## 10. Model data indexer

Skema minimum untuk dasbor penghematan dan bukti ke juri.

| Tabel | Sumber event | Kolom kunci |
|---|---|---|
| `batches` | `BatchSettled`, `BatchPassthrough` | batchId, session, intentCount, nettedUsd, routedUsd, savingsUsd, solver |
| `fills` | `IntentSettled` | batchId, owner, pair, executedSell, executedBuy, baselineBuy, savingsUsd |
| `prices` | `ClearingPrice` | batchId, token, price, refPrice, deviationBps |
| `auctions` | `AuctionOpened` → `CrossExecuted` | auctionId, token, kind, price, volume, participants, extensions |
| `indicative` | `IndicativePublished` | auctionId, token, ts, price, imbalance |
| `closing_prints` | `ClosingPrintPublished` | token, day, price, volume, participants, sufficient |
| `closing_prints_withheld` | `ClosingPrintWithheld` | token, day, reason, volume, participants |
| `solvers` | `SolverScoreUpdated`, `SolverSlashed` | solver, batchesWon, savingsUsd, slashes |
| `sessions` | `SessionChanged`, `TokenProtective` | ts, from, to, token |

**Metrik turunan untuk dasbor publik:**

```
savings_total          = Σ fills.savingsUsd
savings_bps            = savings_total / Σ notional × 10000
netting_ratio          = Σ batches.nettedUsd / (nettedUsd + routedUsd)
improvement_vs_venue   = Σ (executedBuy − baselineBuy) / Σ baselineBuy
uptime                 = batch berhasil / batch dijadwalkan
```

> `improvement_vs_venue` adalah **angka yang dipublikasikan, angka yang dipakai
> membayar solver, dan angka yang ditunjukkan ke juri.** Satu metrik, tanpa cerita
> ganda — dan metodologinya sama dengan analisis Dune yang dipakai membuktikan
> masalahnya sejak awal.

---

## 11. Aturan penulisan event

1. `indexed` pada apa pun yang akan difilter: batchId, token, owner, solver
2. **Selalu sertakan baseline** di samping hasil eksekusi — tanpa baseline, savings
   tidak bisa diverifikasi ulang oleh pihak ketiga
3. Terbitkan event untuk **kegagalan juga**, bukan hanya keberhasilan
   (`SolutionRejected`, `AuctionAborted`, `BatchPassthrough`) — monitoring butuh
   sinyal negatif, dan kejujuran operasional adalah bagian dari pitch
4. Nilai USD memakai harga oracle pada saat settle; simpan harga acuannya juga
   supaya angkanya bisa direproduksi di kemudian hari

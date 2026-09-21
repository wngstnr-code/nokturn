# Nokturn — Spek `quoteFromState`

> **Kode tersulit di v1.0, dan yang paling menentukan.** Seluruh model fee, invarian
> I8 ("tidak ada yang dirugikan"), dan setiap klaim penghematan bertumpu pada satu
> angka yang dihasilkan fungsi ini.
>
> Pendamping: `desain-ekonomi.md` §2 (kenapa baseline ini yang benar) ·
> `interfaces.md` §8B (signature) · `rencana-uji.md` (matriks uji)

> ⚠️ **Status kompetitif (audit 11 Agustus 2026 — `ide-utama.md` §D1d).**
> Gagasan baseline **bukan milik kita sendiri**: Atlas (FastLane) sudah memakainya
> sebagai harga cadangan, live di Polygon, dan solver di sana harus mengalahkannya.
> Yang membedakan Nokturn ada dua, dan keduanya menyentuh spek ini langsung:
>
> 1. **Baseline diterbitkan sebagai event** bersama hasil eksekusi, **termasuk saat
>    gagal**. Kontrak Atlas nol event; kegagalannya revert. Ini bukan detail —
>    ini satu-satunya pembeda yang bertahan, jadi jangan sampai hilang saat
>    implementasi mengejar gas.
> 2. **Dihitung dari state pool di dalam kontrak**, bukan viewcall ke router yang
>    dipasok frontend seperti Atlas. Di chain ini itu keharusan, bukan pilihan:
>    `staticcall` ke Quoter tidak bisa dipakai (P1-1).
>
> Untuk cara menyampaikannya ke luar: `pitch.md` §2–§3b.
>
> Disusun 1 Agustus 2026.

---

## 1. Kontrak fungsi

```solidity
/// Berapa yang BENAR-BENAR akan diterima pengguna kalau mengeksekusi sendiri
/// di venue ini, pada ukuran ini, di blok ini juga.
/// MURNI view. WAJIB revert kalau tidak dapat dihitung dari state.
function quoteFromState(address tokenIn, address tokenOut, uint256 amountIn)
    external view returns (uint256 amountOut);
```

**Kenapa dihitung ulang, bukan dikuotasi.** Quoter Uniswap bekerja dengan
menjalankan swap lalu revert — ia mencoba `SSTORE`, dan `STATICCALL` menolak setiap
upaya modifikasi state. Terverifikasi, lihat `pertanyaan-terbuka.md` P1-1.

---

## 2. ⭐ Properti keamanan yang menentukan arah pembulatan

Ini keputusan terpenting di dokumen ini, dan arahnya **berlawanan** dengan konvensi
umum proyek.

```
savings = received − baselineReceived
fee     = f(savings)
```

| Kalau baseline… | Maka savings… | Maka fee… | Akibat |
|---|---|---|---|
| Terlalu **rendah** | Terlalu tinggi | Terlalu tinggi | ❌ **Pengguna dikenai fee berlebih** |
| Terlalu **tinggi** | Terlalu rendah | Terlalu rendah | ✅ Protokol rugi sedikit fee |

> **Aturan: `baselineReceived` dibulatkan KE ATAS.**
>
> Konvensi umum proyek ("kuantitas diterima pengguna dibulatkan ke bawah") **tidak
> berlaku di sini**, karena baseline bukan jumlah yang dibayarkan ke siapa pun —
> ia **nilai pembanding** yang menentukan fee. Membulatkannya ke bawah berarti
> mengklaim penghematan yang tidak terjadi.

> ### Koreksi 16 September 2026, setelah implementasi dan fork test
>
> Aturan di atas dan gerbang **nol selisih** di §7.3 tidak bisa benar bersamaan
> pada keluaran `quoteFromState`, dan yang menang adalah nol selisih.
>
> Matematika Uniswap seluruhnya bilangan bulat, jadi `amountOut` sudah eksak.
> Tidak ada sisa pecahan yang tersisa untuk dibulatkan. Menambahkan pembulatan ke
> atas berarti baseline selalu satu wei di atas kenyataan, yaitu margin sistematis
> yang paragraf di atas sendiri melarang, dan fork test nol selisih akan gagal.
>
> **Yang berlaku sekarang.** `quoteFromState` mengembalikan angka yang sama persis
> dengan yang dibayar pool sungguhan, diverifikasi terhadap swap nyata di blok yang
> sama. Empat kasus sudah hijau pada 16 September 2026, termasuk NVDA dua arah,
> TSLA dua arah dengan USDG di sisi `token1`, dan satu trade 250.000 USDG yang
> menyeberangi tick.
>
> **Niat §2 tetap terjaga lewat jalur yang berbeda.** Kalau adapter tidak bisa
> menghitung, ia revert dan batch jatuh ke pass-through dengan fee nol. Ambiguitas
> tetap berpihak ke pengguna, hanya saja titik penerapannya di kegagalan, bukan di
> pembulatan. Arah ke atas tetap dipakai kalau kelak baseline diagregasi per
> pasangan dan agregasi itu melahirkan sisa pecahan.

Konsisten dengan invarian **I8**: baseline yang dibulatkan ke atas membuat
pemeriksaan `received ≥ baseline` lebih ketat, sehingga batch **lebih mudah** jatuh
ke pass-through. Ambiguitas selalu berpihak ke pengguna.

**Target implementasi:** replikasi **persis** matematika Uniswap, diverifikasi lewat
fork test terhadap swap sungguhan (§7). Pembulatan ke atas hanya dipakai untuk
memecah ketidakpastian, bukan sebagai margin sistematis.

---

## 3. State yang dibaca

| Panggilan | Selector | Isi |
|---|---|---|
| `slot0()` | `0x3850c7bd` | `sqrtPriceX96`, `tick`, cardinality, `feeProtocol`, `unlocked` |
| `liquidity()` | `0x1a686502` | Likuiditas aktif `L` pada rentang sekarang |
| `fee()` | `0xddca3f43` | Fee statis (pips, mis. 500 = 0,05%) |
| `tickSpacing()` | `0xd0c93a7c` | Jarak antar tick yang boleh diinisialisasi |
| `token0()` / `token1()` | `0x0dfe1681` / `0xd21220a7` | Urutan token |
| `tickBitmap(int16)` | `0x5339c296` | Kata bitmap untuk mencari tick berikutnya |
| `ticks(int24)` | `0xf30dba93` | `liquidityNet` untuk penyeberangan |

`feeProtocol` **tidak memengaruhi** `amountOut` yang diterima swapper — ia hanya
membagi fee antara LP dan protokol Uniswap. Jangan dikurangkan dari keluaran.

### 3.1 🔴 Urutan token TIDAK boleh diasumsikan

Terverifikasi di mainnet 1 Agustus 2026:

| Pool | token0 | token1 | fee | tickSpacing |
|---|---|---|---|---|
| NVDA-USDG `0xD4EB…14A3` | **USDG** | NVDA | 500 | **10** |
| GME-USDG `0xE971…2FDF` | **GME** | USDG | 10000 | **200** |

**Urutannya terbalik di antara dua pool.** Adapter wajib menurunkan arah swap dari
`token0()`, bukan dari asumsi bahwa USDG selalu di satu sisi.

```
zeroForOne = (tokenIn == token0)
```

`tickSpacing` juga berbeda 20×. Pool fee rendah punya tick rapat → **lebih banyak
penyeberangan** untuk pergerakan harga yang sama. Batas gas di §6 harus dihitung
untuk kasus terburuk `tickSpacing` kecil.

### 3.2 Desimal

USDG **6 desimal**, semua Stock Token **18**. `sqrtPriceX96` bekerja pada satuan
mentah, jadi konversi desimal **tidak** boleh disisipkan ke dalam matematika swap —
ia hanya relevan saat menyajikan harga ke manusia.

Sanity check dari state nyata:

| Pool | `sqrtPriceX96` | tick | Harga turunan | Wajar? |
|---|---|---|---|---|
| NVDA | 5614941285244478399843378254556428 | 223.383 | ~199 USDG/NVDA | ✅ |
| GME | 370998273452829036512850 | −245.446 | ~21,9 USDG/GME | ✅ |

Pakai keduanya sebagai fixture uji: kalau implementasimu tidak menghasilkan angka
di kisaran ini dari state mentah, konversi desimalmu salah.

---

## 4. Algoritma

Replikasi `UniswapV3Pool.swap` untuk `exactInput`, tanpa mengubah state.

```
input : tokenIn, tokenOut, amountIn
output: amountOut

zeroForOne   = (tokenIn == token0)
sqrtP        = slot0.sqrtPriceX96
tick         = slot0.tick
L            = liquidity()
feePips      = fee()
amountRemain = amountIn
amountOut    = 0
crossings    = 0

while amountRemain > 0:

    # ── 1. cari tick terinisialisasi berikutnya di arah swap
    (nextTick, initialized) = nextInitializedTickWithinOneWord(
        tick, tickSpacing, zeroForOne)

    nextTick = clamp(nextTick, MIN_TICK, MAX_TICK)
    sqrtTarget = getSqrtRatioAtTick(nextTick)

    # ── 2. hitung satu langkah swap dalam [sqrtP, sqrtTarget]
    (sqrtNext, amountIn_i, amountOut_i, fee_i) = computeSwapStep(
        sqrtP, sqrtTarget, L, amountRemain, feePips)

    amountRemain -= (amountIn_i + fee_i)
    amountOut    += amountOut_i

    # ── 3. kalau langkah berhenti TEPAT di target, tick diseberangi
    if sqrtNext == sqrtTarget:
        if initialized:
            liquidityNet = ticks(nextTick).liquidityNet
            L = zeroForOne ? L - liquidityNet : L + liquidityNet
            crossings += 1
            require(crossings <= MAX_TICK_CROSSINGS, TooManyTickCrossings)
        tick = zeroForOne ? nextTick - 1 : nextTick
        require(L > 0, LiquidityExhausted)
    else:
        tick = getTickAtSqrtRatio(sqrtNext)
        sqrtP = sqrtNext
        break

    sqrtP = sqrtNext

require(amountRemain == 0, LiquidityExhausted)
return amountOut   # dibulatkan KE ATAS, §2
```

### 4.1 Fungsi pendukung

Semuanya ada di `v3-core/libraries` — **pakai apa adanya, jangan tulis ulang.**

| Fungsi | Library | Catatan |
|---|---|---|
| `getSqrtRatioAtTick` / `getTickAtSqrtRatio` | `TickMath` | |
| `getAmount0Delta` / `getAmount1Delta` | `SqrtPriceMath` | Punya parameter `roundUp` — **pakai** |
| `getNextSqrtPriceFromInput` | `SqrtPriceMath` | |
| `computeSwapStep` | `SwapMath` | Menangani fee per langkah |
| `nextInitializedTickWithinOneWord` | `TickBitmap` | |

> ⚠️ **Jebakan `nextInitializedTickWithinOneWord`.** Ia berhenti di batas *kata*
> bitmap (256 tick) meski tidak ada tick terinisialisasi di sana. Iterasi semacam
> itu **bukan** penyeberangan likuiditas — `initialized == false`, `L` tidak berubah.
> Menghitungnya sebagai penyeberangan akan memicu `MAX_TICK_CROSSINGS` terlalu
> cepat. Hitung **dua counter terpisah**: langkah loop dan penyeberangan nyata.

---

## 5. Kegagalan — selalu revert, jangan pernah menebak

`IVenueAdapter` mewajibkan revert kalau venue tidak dapat dihitung dari state.
Konsekuensi revert: `Settlement` tidak punya baseline → batch jadi **pass-through**,
dan **fee nol**. Itu hasil yang aman.

| Kondisi | Error |
|---|---|
| Likuiditas habis sebelum `amountIn` terserap | `LiquidityExhausted` |
| Penyeberangan tick melewati batas gas | `TooManyTickCrossings` |
| `L == 0` setelah penyeberangan | `LiquidityExhausted` |
| Pool tidak ada / `sqrtPriceX96 == 0` | `PoolNotInitialized` |
| Fee dinamis (`fee() == 0x800000`) | `DynamicFeeUnsupported` — **wajib**, ini yang menunda V4 |
| `tokenIn`/`tokenOut` bukan token pool | `TokenNotInPool` |

**Jangan pernah mengembalikan hasil parsial.** Baseline yang salah lebih berbahaya
daripada tidak ada baseline: yang pertama membuat fee salah dan klaim penghematan
bohong; yang kedua cuma membuat batch jadi pass-through.

---

## 6. Batas gas

Loop penyeberangan tick tidak berbatas secara alami → permukaan DoS.

| Konstanta | Nilai awal | Alasan |
|---|---|---|
| `MAX_TICK_CROSSINGS` | **32** | Tebakan awal. **Wajib dikalibrasi** dari fork test (§7.3) |
| `MAX_LOOP_STEPS` | **128** | Termasuk langkah batas-kata yang bukan penyeberangan |

Kedua nilai masuk `parameter.md` sebelum dipakai di kode.

**Kenapa ini tidak semahal kelihatannya:** `desain-ekonomi.md` §2.3 sudah memutuskan
kuotasi diambil **per pasangan pada volume agregat**, bukan per intent. Jadi fungsi
ini dipanggil beberapa kali per batch, bukan N kali.

Dan `CAP_PER_BATCH` awal **$5.000** membuat sisa imbalance kecil relatif terhadap
likuiditas pool NVDA — penyeberangan seharusnya jarang di fase awal. Itu asumsi
yang **harus diverifikasi**, bukan diandalkan: ukur distribusi penyeberangan nyata
sebelum menaikkan cap.

---

## 7. Matriks uji

Masuk ke `rencana-uji.md` §6 (fork test) dan §4 (Halmos).

### 7.1 Unit — dalam rentang, tanpa penyeberangan

| # | Kasus | Harapan |
|---|---|---|
| Q1 | `amountIn` kecil, jauh dari batas tick | Cocok dengan swap nyata, selisih ≤ 1 wei |
| Q2 | `amountIn = 0` | Kembalikan 0, jangan revert |
| Q3 | `amountIn = 1` (debu) | Tidak revert, tidak underflow |
| Q4 | Kedua arah pada pool yang sama | Keduanya benar |
| Q5 | **Kedua urutan token** — NVDA (USDG=token0) dan GME (USDG=token1) | Keduanya benar |

### 7.2 Penyeberangan tick

| # | Kasus | Harapan |
|---|---|---|
| Q6 | Berhenti **tepat** di batas tick | Tidak ada penyeberangan ganda, `L` benar |
| Q7 | Menyeberang **satu** tick terinisialisasi | `L` berubah sekali |
| Q8 | Menyeberang **banyak** tick | Akumulasi `L` benar |
| Q9 | Melewati batas **kata** bitmap tanpa tick terinisialisasi | `L` **tidak** berubah; tidak dihitung sebagai penyeberangan |
| Q10 | Melebihi `MAX_TICK_CROSSINGS` | Revert `TooManyTickCrossings` |
| Q11 | Likuiditas habis | Revert `LiquidityExhausted` |

### 7.3 ⭐ Fork test diferensial — yang paling menentukan

```
Terhadap state mainnet Robinhood Chain yang di-fork:
  untuk ukuran amountIn = [$1, $10, $50, $100, $1rb, $5rb, $25rb, $100rb]
  untuk tiap pool allowlist, kedua arah:

    quoted = adapter.quoteFromState(tokenIn, tokenOut, amountIn)
    actual = <eksekusi swap sungguhan di fork>

    assert quoted == actual                     ← target: persis
    assert quoted >= actual                     ← minimum yang wajib (§2)
    catat: jumlah penyeberangan tick            ← kalibrasi MAX_TICK_CROSSINGS
```

**Definisi selesai:** nol selisih pada seluruh ukuran dan seluruh pool allowlist,
di beberapa blok berbeda (agar mengenai kondisi likuiditas yang berbeda).
Distribusi penyeberangan didokumentasikan, dan `MAX_TICK_CROSSINGS` diset ke
**p99 terukur + margin**, bukan ke tebakan 32.

### 7.4 Halmos

| Properti |
|---|
| `quoteFromState` tidak pernah overflow untuk seluruh rentang input valid |
| Hasil monoton: `amountIn₁ < amountIn₂` ⟹ `quote(amountIn₁) ≤ quote(amountIn₂)` |
| Hasil tidak pernah melampaui likuiditas pool yang tersedia |

Monotonisitas layak dibuktikan: pelanggarannya berarti solver bisa mendapat baseline
lebih menguntungkan dengan **memecah** kuotasi — celah manipulasi fee yang halus.

---

## 9. Implementasi terbangun — rujukan untuk kalkulator offchain

> Ditulis 20 September 2026 sebagai titik sinkronisasi 4 di `pembagian-tugas.md`.
> Bagian §4 di atas adalah rancangan. Bagian ini adalah **kode yang berjalan**, dan
> kalau keduanya berbeda, yang di sini yang benar. Uji diferensial nol selisih
> membandingkan kalkulator solver dengan kontrak, bukan dengan pseudocode.

Sumbernya `contracts/src/adapters/UniswapV3Adapter.sol`, fungsi `quoteWithStats`.
`quoteFromState` hanya membuang dua penghitungnya.

### 9.1 Lima beda dari pseudocode §4, dan semuanya menggigit

**1. Pustakanya `v4-core`, bukan `v3-core`.** Ini yang paling mudah salah karena
nama fungsinya berubah dan satu konvensinya terbalik.

| §4 menulis | Yang dipakai kode |
|---|---|
| `getSqrtRatioAtTick` | `TickMath.getSqrtPriceAtTick` |
| `getTickAtSqrtRatio` | `TickMath.getTickAtSqrtPrice` |
| `computeSwapStep(..., amountRemain, fee)` | `SwapMath.computeSwapStep(..., int256 amountRemaining, fee)` |

🔴 **`amountRemaining` bertanda, dan exact input adalah nilai NEGATIF.** Kode
menulis `-int256(remaining)`. Memberi nilai positif ke fungsi yang sama berarti
meminta exact **output**, dan hasilnya akan tampak masuk akal sambil salah. Ini satu
satunya tempat di seluruh jalur yang salah tandanya tidak akan revert.

**2. Tidak ada clamp ke `MIN_TICK` atau `MAX_TICK`.** §4 menulis
`nextTick = clamp(...)`. Kode tidak, dan `getSqrtPriceAtTick` yang akan revert kalau
ticknya di luar rentang. Akibatnya sama, yaitu tidak ada kuotasi, tapi errornya
datang dari `TickMath` dan bukan dari adapter.

**3. Batas langkah ada di kondisi loop, bukan di dalamnya.**
`for (; steps < MAX_LOOP_STEPS && remaining > 0; ++steps)`. Kalau loop habis dengan
`remaining > 0`, penjaga terakhir `if (remaining != 0) revert LiquidityExhausted`
yang menangkapnya. Tidak ada error khusus untuk kehabisan langkah.

**4. `L == 0` hanya diperiksa saat tick yang diseberangi terinisialisasi.** §4
memeriksanya setiap kali langkah berhenti di target. Hasilnya sama karena `L` hanya
berubah saat menyeberangi tick terinisialisasi, tapi jumlah pemeriksaannya berbeda.

**5. `TokenNotInPool` tidak ada.** Pasangan yang tidak dikenal keluar sebagai
`PoolNotSet(tokenIn, tokenOut)` dari `_pool`, sebelum satu pun state dibaca.

### 9.2 Dua detail bit yang gampang meleset

**`_position` memakai cast bertanda.**

```solidity
wordPos = int16(tick >> 8);
bitPos  = uint8(int8(tick % 256));
```

Cast `int8` di tengah itu bukan hiasan. Untuk tick negatif, `tick % 256` di Solidity
bertanda, dan memotongnya langsung ke `uint8` memberi kata bitmap yang salah. Pool
GME ada di tick **negatif** (`-245.446`), jadi kesalahan ini tidak akan terlihat di
NVDA dan akan terlihat di GME.

**Langkah batas kata bukan penyeberangan.** `_nextInitializedTick` berhenti di batas
kata 256 tick meski tidak ada tick terinisialisasi di sana. Kode menghitung dua
angka terpisah, `steps` dan `crossings`, dan hanya `crossings` yang dibandingkan
dengan `MAX_TICK_CROSSINGS`. Menggabungkan keduanya membuat kuotasi ditolak jauh
lebih cepat daripada yang seharusnya.

### 9.3 🔴 Kewajiban baru sejak 20 September 2026, lantai baseline

`Settlement` sekarang menolak solusi yang baseline totalnya di bawah kuotasi venue.
`parameter.md` §4C. **Solver wajib menghitung angka ini, bukan menebaknya.**

Per arah pasangan yang muncul di batch:

```
floor(sellToken, buyToken) = quoteFromState(
    sellToken,
    buyToken,
    Σ executedSell untuk seluruh intent pada arah itu
)

wajib: Σ baselineQuotes untuk arah itu >= floor(sellToken, buyToken)
```

Satu kuotasi per arah, atas **volume kotor arah itu**, bukan atas netnya dan bukan
per intent. Kalau totalnya di bawah lantai, `submitSolution` revert dengan
`BaselineBelowVenue(sellToken, buyToken, claimed, floor)`.

**Jangan mengisi `baselineQuotes` dengan kuotasi per intent lalu berharap lolos.**
Kuotasi pool cekung terhadap ukuran, jadi jumlah kuotasi per intent selalu **lebih
besar** daripada kuotasi atas totalnya. Arah itu aman dan memang lolos. Yang gagal
adalah kebalikannya, yaitu mengisi baseline dari harga rata rata atau dari TWAP,
karena keduanya bisa jatuh di bawah kuotasi nyata pada ukuran itu.

Selisih antara keduanya terukur dan kecil. Nol bps pada bentuk batch yang nyata,
paling besar tiga bps di cap peluncuran. Tabel penuhnya di `parameter.md` §4C.

⚠️ Ini juga menjawab kekhawatiran yang sudah ditulis §7.4 di atas, bahwa solver bisa
mendapat baseline lebih menguntungkan dengan memecah kuotasi. Sekarang memecah tidak
menolong, karena yang dibandingkan adalah totalnya terhadap kuotasi atas total.

### 9.4 Kalau adapter tidak bisa menjawab

Solver harus menyiapkan jalur ini, bukan menganggapnya kasus langka. Kalau lantai
tidak bisa dihitung untuk satu arah saja, `Settlement` memaksa `savings` jadi **nol**
untuk seluruh batch. Batch tetap selesai, pengguna tetap menerima penuh, dan solver
tidak boleh menahan apa pun. `claimedSavings` karena itu harus nol juga, atau
`submitSolution` revert dengan `SavingsMismatch`.

Penyebab yang mungkin, semuanya dari daftar §5 di atas. Pool belum terdaftar di
adapter, kuotasi melewati `MAX_TICK_CROSSINGS`, fee dinamis, atau
`baselineAdapter` belum diset governance.

### 9.5 Cara membuktikan kalkulatormu cocok

Jangan bandingkan dengan dokumen ini. Bandingkan dengan rantai.

```bash
cd contracts
forge test --match-path "test/fork/BaselineVectorsFork.t.sol" -vv
```

Test itu membaca state mentah tiap pool allowlist di head, mencetaknya, lalu
mencetak pasangan `amountIn` dan `amountOut` dari adapter yang sesungguhnya. Jalankan
implementasimu atas state mentah yang sama dan bandingkan keluarannya. **Target nol
selisih, bukan mendekati.**

Bloknya dipatok, dan nomornya ada di `infra/pinned-block.json`. Test ini membacanya
lewat `contracts/test/fixtures/ForkFixture.sol`, dan fork yang dipakai backend serta
demo berdiri di blok yang sama, jadi implementasimu bisa dibandingkan dengan angka
yang sama persis kapan pun dijalankan.

Kalimat di sini semula berbunyi bahwa blok tidak bisa dipatok karena endpointnya
bukan archive node. Itu salah, dan sudah diukur ulang 21 September 2026. Lihat
`pertanyaan-terbuka.md`, pelajaran metodologi kesebelas.

---

## 8. Yang sengaja di luar scope v1.0

| | Alasan |
|---|---|
| Uniswap **V4** | Hook fee dinamis (`0x800000`) → keluaran tidak dapat dihitung dari state. `isQuotable()` wajib `false` |
| Router agregator `0x65050A9B…` | Tidak punya fungsi kuotasi; semua selector umum revert. Perbandingan terhadapnya adalah **metrik publikasi offchain**, bukan baseline protokol — dan **jangan pernah disebut trustless** |
| Rute multi-hop | Baseline v1.0 hanya pasangan langsung |
| `exactOutput` | Tidak dibutuhkan; intent selalu menyatakan `sellAmount` |

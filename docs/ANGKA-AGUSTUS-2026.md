# Kontrak Angka Kanonik — Agustus 2026

> Dijalankan 3 September 2026 atas `dex.trades` chain `robinhood`, filter berbasis
> **alamat** (bukan simbol). Menggantikan seluruh blok angka Juli 2026.
> Sumber kebenaran tetap `parameter.md`; berkas ini adalah ringkasan kerja untuk
> pembaruan dokumen dan boleh dihapus setelah semua dokumen selaras.

## 1. Aktivitas (8 stock token asli)

| | Juli 2026 | Agustus 2026 |
|---|---|---|
| Trade | 3.663.223 (3,66 juta) | **8.584.773 (8,58 juta)** — 2,3× |
| Volume | $280,21 juta | **$1.005,61 juta** — 3,6× |
| Dompet aktif | 59.785 | **139.093** — 2,3× |
| Median tiket | $55,90 | **$57,44** |
| Trade saat NYSE tutup | 65,55% | **74,06%** (bulatkan 74,1%) |
| Volume saat NYSE tutup | 56,40% | **65,18%** (bulatkan 65,2%) |
| Trade akhir pekan | 12,90% | **33,20%** |

## 2. Chain

| | Juli | Agustus |
|---|---|---|
| Volume DEX chain (satu sisi) | $17,078 miliar | **$34,948 miliar** |
| Seluruh trade chain | 87.565.067 | **122.388.397** |
| Seluruh dompet chain | 1.762.358 | **2.050.839** |
| Share stock token (8 token) | 1,641% | **2,877%** |
| Share allowlist v1.0 | 0,92% | **1,43%** |

## 3. Kualitas eksekusi — pergerakan harga antar-trade (bps)

| Sesi | Juli p50/p90/p99 | Agustus p50/p90/p99 |
|---|---|---|
| NYSE buka | 8,6 / 77,6 / 699,2 | **6,5 / 45,1 / 209,3** |
| Off-hours hari kerja | 11,1 / 191,4 / 855,3 | **7,6 / 57,4 / 1.779,4** |
| Akhir pekan | 8,6 / 107,4 / 979,4 | **7,1 / 47,6 / 203,8** |

Rasio off-hours vs buka: p90 **2,47× → 1,27×**; p99 **1,22× → 8,50×**

## 4. Venue mix (volume allowlist v1.0)

| | Juli | Agustus |
|---|---|---|
| Uniswap V3 | 58,58% | **82,52%** |
| Uniswap V4 | 38,54% | **12,56%** |
| uponrh v3 | 1,68% | 2,73% |
| gigadex v3 | 0,31% | 1,45% |

## 5. Volume per token

| Token | Juli | Agustus | Dompet Agu |
|---|---|---|---|
| NVDA | $125,01jt | **$436,35jt** | 76.397 |
| SPCX | $40,77jt | **$212,86jt** | 56.537 |
| SPY | $5,05jt | **$211,62jt** (42×) | 67.064 |
| GME | $72,05jt | $72,01jt | 42.442 |
| AAPL | $16,12jt | $36,14jt | 34.176 |
| TSLA | $9,09jt | $17,29jt | 27.320 |
| GOOGL | $7,59jt | $11,26jt | 19.713 |
| MSFT | $4,53jt | $8,08jt | 19.436 |

Konsentrasi NVDA dalam allowlist v1.0: **87,1%** ($436,35jt dari $501,04jt),
naik dari 79,6%. Allowlist v1.0 mencakup **49,8%** volume stock token (dari 56,3%).

## 6. Netting — backtest Agustus 2026, allowlist v1.0

**Definisi.** Gross = `2 × min(beli, jual) / total`. **Antar-counterparty** =
posisi tiap alamat di-net dulu, baru dipertemukan antar alamat; round trip satu
alamat tidak dihitung. **Angka pitch memakai antar-counterparty.**

### Kurva pangsa (batch 45 dtk, off-hours)

| Pangsa | Antar-counterparty | Gross | Pedagang/batch |
|---|---|---|---|
| 5% | **21,43%** | 31,92% | 1,94 |
| 10% | **27,19%** | 37,99% | 2,47 |
| 20% | **33,39%** | 44,41% | 3,29 |
| 50% | 42,81% | 54,99% | 5,09 |
| 100% | **50,05%** | 63,76% | 7,47 |

### Kurva durasi (100% arus, off-hours)

| Durasi | Antar-counterparty | Gross |
|---|---|---|
| 10 dtk | 42,16% | 53,26% |
| 30 dtk | 48,43% | 61,22% |
| **45 dtk** | **50,05%** | **63,76%** |
| 60 dtk | 51,23% | 65,59% |
| 120 dtk | 53,46% | 70,24% |
| 300 dtk | 55,51% | 76,43% |

Akhir pekan 45 dtk: **50,26% / 65,94%**, 8,01 pedagang/batch.
NYSE buka 45 dtk: 46,68% / 58,99%, 11,68 pedagang/batch.

## 7. SUBSTITUSI WAJIB — angka lama → angka baru

| Lama | Baru |
|---|---|
| 51,2% aktivitas saat bursa tutup | **74,1% trade / 65,2% volume** |
| p90 230,5 bps vs 69,0 bps (3,3×) | 🔴 **GUGUR.** Ganti: p99 **1.779 bps vs 209 bps (8,5×)**. p90 sekarang 57,4 vs 45,1 (1,27×) |
| 47,6% netting | **63,8%** (gross) |
| 41,3% netting lawan berbeda | **50,1%** |
| 21–29% netting pangsa awal | **27–33%** |
| kurva netting 18,5% → 47,6% | **21,4% (pangsa 5%) → 50,1% (pangsa 100%)** |
| 5,33 pedagang per batch | **7,47** di 100% arus; **2,5–3,3** di pangsa 10–20% |
| 58.461 wallet menyentuh Stock Token | **139.093 dompet aktif** (bulanan aktif, bukan kumulatif) |
| 600rb+ trade per bulan | **8,58 juta** — ⚠️ cakupan berbeda, lihat catatan |
| median $44–63 | **$57,44** |
| 0,89% share volume DEX | **1,43%** (allowlist v1.0) / 2,88% (8 token) |
| ~$16,7 miliar/bulan volume DEX | **$34,9 miliar/bulan** |
| Query 8194489–8194525 | **8595234 · 8595239 · 8595244 · 8595247 · 8595251 · 8595303 · 8595357 · 8595365 · 8595386** |

## 8. Yang BELUM diukur ulang — jangan diklaim segar

- **477 pemegang ritel > $1k** — diukur 1 Agustus 2026
- **$27,2 juta total Stock Token dipegang** — diukur 1 Agustus 2026
- **22.068 `Fill` UniswapX** — audit 11 Agustus 2026
- **Cadence feed Chainlink per aset** — belum diperiksa untuk Agustus

## 9. Peringatan metodologi yang wajib ikut

1. Angka Juli di berkas ini adalah **hasil jalan ulang saya sendiri** dengan metode
   yang identik untuk kedua bulan. Sebagian **berbeda** dari angka Juli yang tercatat
   di dokumen lama (mis. netting off-hours 50,36% vs 47,6% yang tercatat) karena
   himpunan token dan batas sesi tidak identik. SQL kueri lama **tidak bisa diambil
   kembali**. Karena itu: **ganti blok Juli seluruhnya, jangan sajikan sebagai
   pertumbuhan** kecuali pasangan angkanya memang berasal dari berkas ini.
2. "600rb+ trade/bulan" yang lama memakai cakupan lebih sempit (kemungkinan hanya
   leg terhadap USDG) dan **tidak sebanding** dengan 8,58 juta. Pasangan yang
   sebanding: 3,66 juta → 8,58 juta.
3. Netting **selalu** berlabel **backtest**, tidak pernah "terukur".
4. ✅ **SELESAI 3 September 2026.** Kesembilan kueri sudah permanen (`is_temp:
   false`), publik, diberi nama bernomor + deskripsi metodologi + visualisasi, dan
   dirakit jadi dashboard bernarasi:
   https://dune.com/passchick/nokturn-robinhood-chain-equity-market-structure-august-2026
   ⚠️ Handle-nya **`passchick`**, bukan `wngstnrs7119`. Dashboard lama memuat angka
   Juli dan tidak boleh dikutip.

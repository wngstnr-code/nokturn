# Nokturn — Rancangan Permukaan Demo

> **Status: desain & wireframe. Tidak ada kode di dokumen ini, dan tidak boleh ada
> sebelum 14 September** (Code of Conduct — riset, desain, dan wireframing
> diperbolehkan; implementasi tidak).
>
> Kenapa dirancang sekarang: `pitch.md` §5 menempatkan **presentation quality**
> sebagai butir terlemah, dan aturan tanpa-mock (`CLAUDE.md` §2 nomor 9) membuat
> permukaan demo jauh lebih sulit dirakit belakangan daripada fitur biasa.
>
> Gerbang yang harus dilewati: `rencana-uji.md` §11. Dokumen ini dirancang supaya
> lolos **secara konstruksi**, bukan lewat perbaikan menit terakhir.
>
> Disusun 12 Agustus 2026.

---

## 1. Satu hal yang harus terjadi

> **Juri harus bisa memverifikasi satu angka sendiri, tanpa mempercayai kami,
> dalam waktu di bawah 90 detik.**

Itu keseluruhan tujuan permukaan demo. Bukan menunjukkan banyak fitur — menunjukkan
**satu klaim yang bisa dibantah**, lalu membiarkan juri mencoba membantahnya.

Alasannya dari pola pemenang (`hackathon.md`): hadiah utama jatuh ke rel yang bisa
dijelaskan sederhana, dan proyek paling mekanis mentok di posisi 2. Kita mekanis.
Penawarnya bukan menyederhanakan mekanisme, tapi **memindahkan beban pembuktian ke
juri** — mereka yang mengecek, bukan kita yang meyakinkan.

**Angka itu adalah baseline.** Ia satu-satunya pembeda yang bertahan setelah audit
Atlas (`ide-utama.md` §D1d), dan satu-satunya yang bisa diverifikasi dalam hitungan
detik lewat Blockscout.

---

## 2. Layar utama: struk batch

Satu layar. Ini produknya.

```
┌──────────────────────────────────────────────────────────────────┐
│  BATCH #1,247                          Sesi: WEEKEND  ·  120 dtk │
│  Blok 33.769.192  ·  fork mainnet 4663      [lihat di explorer ↗]│
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Anda menjual        18,4210 NVDA                               │
│   Anda menerima    3.664,82 USDG                                 │
│                                                                  │
│   ─────────────────────────────────────────────────────────      │
│                                                                  │
│   Harga pembanding  3.641,17 USDG    ← kalau lewat Uniswap V3    │
│   Selisih             +23,65 USDG    (+6,5 bps)                  │
│                                                                  │
│   Dihitung dari state pool 0xD4EB…14A3 pada blok yang sama.      │
│   [salin panggilan verifikasi ↗]   [buka pool di explorer ↗]     │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│  ASAL SELISIH                                                    │
│   ▸ 11,2 NVDA ketemu lawan langsung di batch   → tanpa spread    │
│   ▸  7,2 NVDA dirutekan ke Uniswap V3          → satu order      │
│                                                                  │
│  Netting batch ini: 60,8%          Peserta: 7 alamat berbeda     │
└──────────────────────────────────────────────────────────────────┘
```

**Aturan desain yang mengikat:**

| Aturan | Kenapa |
|---|---|
| Baseline **selalu** terlihat, sejajar hasil — bukan di tooltip, bukan di tab lain | Ini pembedanya. Menyembunyikannya sama dengan tidak punya |
| Tiap angka punya jalur verifikasi **satu klik** | §11.1: *"bisakah juri memverifikasi sendiri?"* |
| Nomor blok selalu tampil | Fork harus reproducible; tanpa blok, tidak bisa dicek |
| Tidak ada angka tanpa satuan dan tanpa sumber | Placeholder paling sering lolos justru di sini |

---

## 3. Layar kedua: batch yang GAGAL

**Ini adegan terpenting di seluruh demo, dan yang paling mudah dilewatkan.**

Tidak ada kompetitor yang bisa menampilkan layar ini. Atlas revert tanpa event
(terverifikasi, `ide-utama.md` §D1d) — kalau solusinya gagal, tidak ada jejak yang
bisa diaudit. Nokturn menerbitkan event untuk kegagalan juga (`CLAUDE.md` §7).

```
┌──────────────────────────────────────────────────────────────────┐
│  BATCH #1,248                     ⚠  PASS-THROUGH               │
│  Blok 33.769.301  ·  fork mainnet 4663      [lihat di explorer ↗]│
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Tidak ada solver yang mengalahkan harga pembanding.            │
│   Tiap intent dirutekan langsung. **Fee: 0.**                    │
│                                                                  │
│   Solusi terbaik yang masuk   3.640,04 USDG                      │
│   Harga pembanding            3.641,17 USDG                      │
│   Selisih                         −1,13 USDG   → ditolak kontrak │
│                                                                  │
│   Event `BatchFailed` diterbitkan di blok ini, lengkap dengan    │
│   baseline. [lihat log di explorer ↗]                            │
└──────────────────────────────────────────────────────────────────┘
```

**Cara menyampaikannya:**

> *"Ini batch yang gagal. Perhatikan bahwa kami tetap menerbitkan harga pembandingnya
> — jadi Anda bisa memeriksa bahwa kami memang benar menolaknya, bukan diam-diam
> mengeksekusi dengan harga buruk. Protokol yang tidak menerbitkan apa pun saat gagal
> meminta Anda memercayai bahwa kegagalan itu jujur."*

Adegan ini harus **direncanakan, bukan ditunggu.** Batch gagal tidak muncul sendiri
saat demo. Siapkan skenario fork yang memicunya secara deterministik.

---

## 3b. Layar tambahan — berurutan menurut nilai per risiko

Dua layar di atas wajib. Empat di bawah ini boleh ditambahkan, **berurutan** —
tambahkan dari atas, berhenti kapan pun. Tiap layar tambahan menambah satu baris
inventaris provenansi (§7) dan satu kandidat pemotongan di H-3.

**Aturan masuk:** sebuah layar hanya boleh ditambahkan kalau datanya sudah nyata
**saat layar itu dibuat**, bukan "akan nyata nanti".

### Prioritas 1 — Verifikasi Stock Token *(paling murah, paling meyakinkan)*

Datanya sudah ada hari ini. Tidak menunggu apa pun.

```
┌──────────────────────────────────────────────────────────────────┐
│  GERBANG ALLOWLIST — kenapa simbol tidak pernah dipercaya        │
├──────────────────────────────────────────────────────────────────┤
│  NVDA  0xd060…9EEC                                               │
│   ✅ slot beacon ERC-1967 = 0xe10b…1b00                          │
│   ✅ uiMultiplier() = 1e18                                       │
│   → LOLOS                                              [cek ↗]   │
│                                                                  │
│  "GME"  0xc236…2aff        volume Juli: $29,6jt / 250rb trade    │
│   ❌ slot beacon KOSONG                                          │
│   ❌ uiMultiplier() tidak ada                                    │
│   ❌ supply 100 miliar · kode 44 byte                            │
│   → DITOLAK — ini memecoin, bukan Stock Token         [cek ↗]    │
└──────────────────────────────────────────────────────────────────┘
```

**Kenapa ini kuat:** juri bisa mengklik keduanya di Blockscout dan melihat sendiri.
Ia membuktikan disiplin verifikasi, bukan menjanjikannya — dan angka $29,6jt itu
menunjukkan bahwa kalau salah, salahnya besar.

### Prioritas 2 — Keadaan sesi

```
┌──────────────────────────────────────────────────────────────────┐
│  SEKARANG: WEEKEND        NYSE tutup 61j 12m lagi buka           │
├──────────────────────────────────────────────────────────────────┤
│  Durasi batch      120 dtk    (vs 10 dtk saat OPEN)              │
│  Price band        ±150 bps   `WEEKEND_DRIFT_CAP_BPS` = 1.500    │
│  Sumber harga      TWAP UniV3 utama · Chainlink = jangkar Jumat  │
│  Cek ketidaksepakatan   NONAKTIF — feed beku 48–56 jam           │
│                                                    [state ↗]     │
└──────────────────────────────────────────────────────────────────┘
```

Ini wujud terlihat dari pembeda #2. Nilainya: menunjukkan parameter **benar-benar
berubah**, bukan sekadar dijanjikan di dokumen.

### Prioritas 3 — Lelang dengan publikasi imbalance

Jalan di fork dengan arus historis. **Haram**: peserta karangan (§11.3).

```
┌──────────────────────────────────────────────────────────────────┐
│  LELANG PEMBUKAAN — NVDA            T-12 menit sebelum bel       │
├──────────────────────────────────────────────────────────────────┤
│  Harga kliring indikatif   $178,42     ← diperbarui tiap blok    │
│  Imbalance                 JUAL 1.284 NVDA  (~$229rb)            │
│  Peserta                   23 alamat  ·  fork blok 33.7xx.xxx    │
│                                                                  │
│  ↑ Ini undangan terbuka kepada likuiditas, bukan permohonan.     │
└──────────────────────────────────────────────────────────────────┘
```

### Prioritas 4 — Kurva netting vs pangsa

Hanya kalau ada waktu. **Wajib berlabel BACKTEST di layar**, bukan cuma di narasi.

Nilainya bukan pameran: `distribusi.md` §7.1 memakainya sebagai **alat diagnostik** —
kalau netting mainnet jatuh jauh di bawah kurva pada pangsa saat itu, yang salah
solver atau durasi batch, bukan pasarnya.

### Yang tetap TIDAK boleh jadi layar

Dashboard agregat "total penghematan sepanjang masa". Di minggu pertama angkanya
kecil, dan membesarkannya butuh kebohongan. Kalau kecil, katakan kecil
(`CLAUDE.md` §3).

---

## 4. Pembagian panggung: fork mainnet vs testnet

Sudah ditetapkan `CLAUDE.md` §2 nomor 9 dan dikonfirmasi P2-6: testnet 46630 **tidak
punya** Stock Token, USDG kanonik, maupun pool Uniswap V3.

| Permukaan | Jalan di mana | Yang ditunjukkan |
|---|---|---|
| **Struk batch + batch gagal** | **Fork mainnet**, blok disebut eksplisit | Pool nyata, token nyata, harga nyata |
| Alur end-to-end tanda tangan → settlement | Testnet 46630 | UX, gasless, Permit2 |
| Angka riset (74,1% trade off-hours, p99 ekor 8,5×, netting backtest) | Dune, kueri `8595234`–`8595386`, [dashboard publik](https://dune.com/passchick/nokturn-robinhood-chain-equity-market-structure-august-2026) | ✅ **Lolos** — kueri permanen, publik, bervisualisasi, deskripsi metodologi terpasang |

⚠️ Saat menampilkan testnet, **sebut jujur bahwa tokennya token uji.** Sekali, di
awal, jangan di catatan kaki.

---

## 5. Yang TIDAK ditampilkan

Diturunkan dari `rencana-uji.md` §11.3 — keempatnya lahir dari niat baik.

| Jangan | Kenapa |
|---|---|
| **Agent memakai Nokturn** | Kalau tidak ada agent nyata terintegrasi, ini paling mudah dipalsukan dan paling sulit dibuat nyata. Boleh menjelaskan desainnya sebagai rencana |
| **Closing print sudah dikonsumsi protokol lain** | Butuh konsumen nyata. Belum ada |
| **Lelang dengan peserta karangan** | Boleh: lelang berjalan di fork dengan arus historis |
| **Kata "terukur" untuk netting** | 27–33% (Agustus 2026, backtest antar-counterparty pangsa 10–20%) adalah **backtest**, tidak pernah "terukur". Periksa sampai naskah lisan — dokumen sudah benar, mulut yang keseleo |

**Prinsipnya:** kalau sebuah fitur belum berjalan dengan data nyata, **jangan
tampilkan fiturnya.** Scope kecil yang sungguhan mengalahkan scope besar yang
separuh pura-pura.

---

## 6. Naskah 90 detik

Urutannya sengaja: masalah → struk → kegagalan → bukti. Kegagalan diletakkan
**sebelum** angka riset, karena itu bagian yang tidak bisa ditiru siapa pun.

| Detik | Isi |
|---|---|
| 0–15 | *"Saham tokenized di Robinhood Chain diperdagangkan 24/7 — tapi chain ini tidak punya satu pun harga pembukaan atau penutupan resmi. Kalau bursa AS tutup, 74% trade terjadi tanpa harga referensi sama sekali, dan di ekornya eksekusi bisa 8,5 kali lebih buruk."* ⚠️ *direvisi 10 September 2026 untuk membuka dengan rel harga penutupan (`pitch.md` §1 lapis 1), bukan langsung dengan statistik; angka p99 sendiri direvisi 3 September 2026, klaim lama "melebar tiga kali lipat, setengah aktivitas" sudah gugur — lihat `ide-utama.md` §B1.* Tunjukkan chart Dune. ✅ **Klik query-nya** — [dashboard Agustus 2026](https://dune.com/passchick/nokturn-robinhood-chain-equity-market-structure-august-2026) sudah publik |
| 15–45 | Kirim intent → struk muncul. *"Ini yang Anda dapat. Ini harga pembandingnya. Selisihnya segini."* **Klik ke Blockscout, tunjukkan angka yang sama di log** |
| 45–70 | Batch gagal. *"Kami tetap menerbitkan pembandingnya saat gagal."* Tunjukkan event-nya |
| 70–90 | Sebut sisi lemah duluan: *"82,1% nilai Stock Token yang dipegang onchain ada di kontrak — pool dan smart wallet — dompet pribadi baru pegang $13,56 juta dari total $75,62 juta."* Lalu netting: *"Netting di backtest Agustus: 27–33% pada pangsa awal realistis."* *"Query-nya publik — silakan buka dan jalankan ulang."* Tutup dengan lapis 1: *"Ini rel yang belum ada di chain ini — Nokturn membentuknya."* Sebut **backtest** (bukan "terukur") untuk netting; angka pemegang & kepemilikan **terukur 10 September 2026**, Dune 8663760 |

Sisakan waktu untuk **satu** hal saja kalau tertekan: detik 15–45. Sisanya bisa
dijelaskan; struk harus dilihat.

---

## 7. Inventaris provenansi — mulai diisi sekarang

Kerangka `rencana-uji.md` §11.2, dengan baris yang sudah bisa ditentukan hari ini.
**Kolom vonis diisi H-3, bukan sekarang.**

| Permukaan | Item | Sumber | Bisa diverifikasi juri? |
|---|---|---|---|
| UI struk | jumlah diterima | event settlement, fork blok X | ✅ Blockscout |
| UI struk | **baseline** | `quoteFromState` atas state pool blok yang sama | ✅ panggilan bisa disalin |
| UI struk | netting batch | event, dihitung dari isi batch | ✅ |
| UI struk | alamat pool | `0xD4EB…14A3` (NVDA-USDG, terverifikasi) | ✅ Blockscout |
| UI gagal | baseline saat gagal | event `BatchFailed` | ✅ log onchain |
| Deck | 74,1% trade / 65,2% volume off-hours (Agustus 2026) | Dune, kueri baru 8595234–8595386 (lihat `ide-utama.md` §B4) | ✅ kueri permanen & publik sejak 3 September 2026 |
| Deck | p99 1.779,4 / 209,3 bps (8,5×), p90 3,3× lama **gugur** | Dune, kueri baru — lihat catatan revisi 3 September 2026 `ide-utama.md` §B1 | ✅ [dashboard publik](https://dune.com/passchick/nokturn-robinhood-chain-equity-market-structure-august-2026) |
| Deck | netting 27–33% | **backtest** (Agustus 2026, antar-counterparty) — Dune kueri baru, lihat `ide-utama.md` §B3b–§B4 | ✅ [dashboard publik](https://dune.com/passchick/nokturn-robinhood-chain-equity-market-structure-august-2026); label **backtest** tetap wajib |
| Deck | 804 pemegang EOA Stock Token > $1k | Dune 8663760, terukur 10 September 2026 *(menggantikan 477, angka kumulatif 1 Agustus 2026)* | ✅ kueri permanen & publik |
| Deck | $75,62 juta total Stock Token dipegang onchain | Dune 8663760, terukur 10 September 2026 *(menggantikan $27,2 juta, 1 Agustus 2026)* | ✅ kueri permanen & publik |
| Deck | Fill UniswapX per bulan: 16.072 (Jul) → 20.898 (Agu) → 27.931 (Sep 1–10), rasio < 0,25% vs tx router dominan | Dune 8663798, terukur 10 September 2026 *(menggantikan angka kumulatif lama 22.068)* | ✅ kueri permanen & publik |
| Testnet | seluruh token | token uji — **sebut eksplisit** | ✅ kalau disebut |
| *(P1)* Allowlist | NVDA lolos / "GME" ditolak | slot beacon + `uiMultiplier()`, Blockscout | ✅ dua klik |
| *(P2)* Sesi | durasi batch, band, sumber harga | state kontrak SessionEngine | ✅ |
| *(P3)* Lelang | imbalance & harga indikatif | fork, blok disebut | ✅ reproducible |
| *(P4)* Kurva netting | 21,4% → 50,1% (backtest antar-counterparty, pangsa 5% → 100%, Agustus 2026) | **BACKTEST** — Dune kueri baru, lihat `ide-utama.md` §B3b–§B4 | ✅ [dashboard publik](https://dune.com/passchick/nokturn-robinhood-chain-equity-market-structure-august-2026) |

⚠️ **Revisi 3 September 2026.** Nomor kueri Dune lama (8194489–8194525, kecuali
8194496 yang tetap sama untuk pemegang token) diganti kueri Agustus baru
**8595234 · 8595239 · 8595244 · 8595247 · 8595251 · 8595303 · 8595357 · 8595365 ·
8595386** — lihat `ide-utama.md` §B4. SQL kueri Juli lama tidak bisa diambil kembali.

⚠️ **Revisi 10 September 2026.** `8194496` (pemegang token) resmi digantikan.
Kepemilikan Stock Token dan pangsa eksekusi berbasis intent sekarang diukur lewat
**8663760 · 8663787 · 8663798** — lihat `parameter.md` §10.3–§10.4 dan
`ide-utama.md` §B2, §D1b.

---

## 8. Kesiapan — yang boleh dikerjakan sebelum 14 September

✅ **Boleh:** wireframe, alur layar, naskah, daftar skenario fork, isi inventaris
provenansi, keputusan apa yang dipotong.

❌ **Tidak boleh:** menulis komponen, kontrak, atau skrip apa pun.

**Keputusan yang sebaiknya dikunci sekarang, karena mahal kalau berubah nanti:**

1. **Struk adalah layar pertama**, bukan dashboard. Dashboard adalah pola pecundang
   di sini — ia menunjukkan banyak hal dan membuktikan nol.
2. **Batch gagal masuk demo utama**, bukan sebagai bonus kalau sempat.
3. **Tiap angka lahir dengan jalur verifikasinya.** Angka tanpa tautan tidak boleh
   masuk komponen sejak awal — jauh lebih murah daripada menambalnya di H-3.

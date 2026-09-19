# Nokturn. Pembagian Tugas Tiga Orang

> Disusun 14 September 2026, hari pertama implementasi diizinkan (Code of Conduct).
> Tenggat submission **1 Oktober 2026, 23:59 SGT** (T&C). Halaman penyelenggara menyebut
> 4 Oktober. Sampai mereka menjawab, pakai 1 Oktober. Jendela kerja **17 hari**.
>
> Sumber: `spek-teknis.md` §8 (struktur repo) · `interfaces.md` §1–2 (peta kontrak)
> · `demo.md` (permukaan) · `rencana-uji.md` §9, §11 (gerbang).

| Orang | Domain | Direktori yang **dia miliki** |
|---|---|---|
| **Wangsit** | Smart contract | `contracts/**` · `verifier/**` · `script/**` · `.github/workflows/contracts.yml` |
| **Dharu** | Backend | `solver/**` · `api/**` · `indexer/**` · `analytics/**` · `infra/**` · `.github/workflows/backend.yml` |
| **Nabil** | Frontend | `app/**` · `.github/workflows/app.yml` |

**Aturan nomor satu: satu file, satu pemilik.** Tidak ada file yang diedit dua orang.
Kalau butuh sesuatu dari direktori orang lain, minta. Jangan edit.

---

## 1. Hari 0. Kunci kontrak antar-bagian SEBELUM menulis implementasi

Ini dikerjakan **bersama, hari ini, sebelum berpencar**. Tanpa ini, tiga orang akan
menghasilkan tiga definisi `Intent` yang berbeda dan hari ke-7 dihabiskan untuk merukunkan.

| # | Kontrak yang dikunci | Pemilik definisi | Dipakai siapa |
|---|---|---|---|
| 1 | `struct Intent` + `INTENT_TYPEHASH` + domain separator EIP-712 | Wangsit | ketiganya |
| 2 | Seluruh event & error kustom (`interfaces.md` §3–4) | Wangsit | Dharu (indexer), Nabil (layar) |
| 3 | Skema REST/WS coordinator → frontend | Dharu | Nabil |
| 4 | Rumus baseline `quoteFromState` (`desain-baseline.md`) | Wangsit | Dharu (solver pakai rumus yang **sama persis**) · **diserahkan 20 September 2026**, lihat `desain-baseline.md` §9 |
| 5 | Alamat & konstanta (`parameter.md` §10.1) | digenerate | ketiganya |
| 6 | Nomor blok fork yang di-pin | Dharu | ketiganya |
| 7 | Pemantau operasional dan jalur pause | Wangsit | **bukan pekerjaan indexer** · terpasang 20 September 2026 di `contracts/script/Monitor.s.sol` dan `contracts/tools/monitor.py` |

**Paket bersama**, satu-satunya tempat ketiganya bertemu.

```
packages/shared/
├── abi/            # DIGENERATE dari forge build. JANGAN pernah diedit tangan.
├── addresses.ts    # digenerate dari parameter.md §10.1
├── types.ts        # mirror dari Solidity
└── api-types.ts    # milik Dharu, skema respons coordinator
```

Definisi ganda = sumber bug paling mahal di proyek tiga orang. Kalau sebuah angka atau
tipe muncul di dua tempat, salah satunya harus digenerate dari yang lain.

**Aturan parameter tetap berlaku (`CLAUDE.md` §2 nomor 1):** angka berubah di
`parameter.md` dulu, di PR yang sama dengan perubahan kodenya. Berlaku untuk ketiganya.

---

## 2. Wangsit, Smart Contract

Urutannya **berurutan untuk dia sendiri** (tiap tahap menumpuk di atas sebelumnya),
tapi paralel penuh terhadap Dharu dan Nabil.

| Hari | Kerjaan | Selesai kalau |
|---|---|---|
| **1** | Scaffold Foundry · `src/interfaces/*.sol` lengkap: tipe, event, error, typehash · **CI hijau sejak commit pertama** (Slither + Aderyn + gas snapshot + storage layout) | ABI ter-publish ke `packages/shared/abi/`. Dua orang lain bisa mulai coding terhadapnya |
| **2–5** | `SessionManager.sol`, FSM sesi + tabel kalender, fungsi murni. `PriceOracle.sol`, Chainlink 24/5 + TWAP UniV3, **pergantian peran saat akhir pekan**, `WEEKEND_DRIFT_CAP_BPS`=1500 | Kalender diuji 2020–2035. Gap feed 48–56 jam tertangani, bukan bikin revert |
| **4–7** | `Settlement.sol`. Verifikasi intent, matematika kliring, price band, partial fill, pembulatan berpihak ke kontrak, **event untuk kegagalan juga** | Batch netting internal jalan. Nol pembagian di jalur pemeriksaan limit |
| **6–9** | `adapters/UniswapV3Adapter.sol`, **agnostik terhadap factory** (`gigadex` & `ramsesxyz vcl` byte-identik, `CLAUDE.md` §2 nomor 4). `quoteFromState`, bukan `staticcall` Quoter | **Fork test nol selisih** terhadap state pool mainnet nyata |
| **9–12** | `SolverRegistry.sol` (bond/slash) · `AuctionHouse.sol` (escrow + tantangan) · `AgentMandate.sol` | Dua solver bersaing di fork. Lelang buka/tutup jalan |
| **10–14** | Kedalaman verifikasi: 14 invarian, Echidna, Halmos pada matematika inti & FSM, mutation ≥90%, differential | Semua gerbang `rencana-uji.md` §9 hijau |
| **15–16** | `script/Deploy.s.sol` + verifikasi Blockscout | Gerbang §8.1 dievaluasi. Deploy mainnet **hanya kalau semuanya hijau** |

**Stylus:** jangan dikunci. Solidity adalah jalur default sehingga tidak ada yang
terblokir. Benchmark aktivasi-vs-eksekusi dikerjakan **hanya kalau verifier Solidity
mendarat lebih awal**. Keputusannya dari benchmark, bukan dari sisa waktu
(`CLAUDE.md` §2 nomor 2 & 7).

**Yang Wangsit hutang ke orang lain, dan kapan:**
- Hari 1: ABI + tipe (ke keduanya)
- Hari 7: `SessionManager` ter-deploy di fork (ke Nabil, untuk layar sesi)
- Hari 9: `quoteFromState` final (ke Dharu, untuk uji differential baseline) · **selesai 20 September 2026.** Spesifikasi terbangun di `desain-baseline.md` §9, vektor uji lewat `test/fork/BaselineVectorsFork.t.sol`. Termasuk kewajiban baru lantai baseline `parameter.md` §4C

---

## 3. Dharu, Backend

**Hari 1–2 Dharu adalah jalur kritis untuk seluruh tim.** Infrastruktur fork dipakai
Wangsit (fork test) dan Nabil (data nyata). Kerjakan ini duluan, sebelum solver.

| Hari | Kerjaan | Selesai kalau |
|---|---|---|
| **1–2** | 🔴 **Infra fork mainnet**. Anvil fork chain 4663 di blok yang di-pin, docker-compose, akun impersonation. Sertakan workaround DNS (`--resolve`, IP asli `172.66.147.70`) di skrip, jangan jadi folklore | `make fork` jalan di laptop ketiganya dalam satu perintah |
| **2–4** | Coordinator intent: kumpulkan tanda tangan EIP-712, mempool tunggal (**titik sentralisasi yang diakui terbuka**), rakit batch per durasi sesi. **Bekukan skema API di hari 2** | Nabil bisa coding terhadap skema, meski implementasinya belum selesai |
| **3–6** | Solver referensi TypeScript (`spek-teknis.md` §7): kelompokkan per pasangan → harga kliring → netting → sisa ke V3 → hitung surplus → ajukan | Solusi valid diterima `Settlement` di fork |
| **5–8** | Kalkulator baseline, **rumus identik dengan adapter Wangsit** | 🔴 **Uji differential vs `quoteFromState`, nol selisih.** Ini angka yang diverifikasi juri. Dua implementasi yang berbeda berarti klaim runtuh |
| **7–10** | Indexer: konsumsi event (**termasuk event kegagalan**) → API struk batch. Wajib memuat field provenansi: nomor blok, alamat pool, payload panggilan verifikasi | Nabil bisa render layar utama & layar gagal sepenuhnya dari API |
| **8–11** | Harness replay: arus intent nyata Agustus 2026 diputar ulang di fork (kueri Dune `8595251`/`8595303`) | Demo netting berdiri di atas lawan transaksi **nyata**, bukan karangan (`demo.md` §3b Prioritas 3) |
| **12** | Instance solver kedua untuk demo kompetisi | Dua solver mengajukan, yang bersurplus lebih tinggi menang |
| **14–15** | Analitik: kurva netting-vs-pangsa, **berlabel BACKTEST di data, bukan cuma di narasi** | Kueri Dune permanen & publik |

**Peringatan yang mengikat Dharu:** solver menghitung angka yang ditunjukkan ke juri.
Kalau baseline solver dan baseline kontrak berbeda satu wei pun, seluruh klaim
"juri bisa verifikasi sendiri" batal. Perlakukan uji differential itu sebagai gerbang
rilis, bukan uji tambahan.

---

## 4. Nabil, Frontend

Aturan tanpa-mock (`CLAUDE.md` §2 nomor 9) bikin frontend biasanya terblokir menunggu
backend. **Di sini tidak.** Dua layar pertama tidak butuh kontrak Nokturn sama sekali,
datanya sudah nyata di mainnet hari ini.

| Hari | Kerjaan | Sumber data | Bergantung siapa |
|---|---|---|---|
| **1–3** | **Layar verifikasi allowlist** (`demo.md` §3b Prioritas 1), slot beacon ERC-1967 + `uiMultiplier()`, NVDA LOLOS vs "GME" `0xc236…` DITOLAK | Baca langsung mainnet 4663 | **Tidak ada.** Mulai hari ini |
| **2–4** | Design system, wallet connect (EIP-7702/4337 + Permit2), **format angka**, Stock Token 18 desimal vs USDG 6 desimal | tidak ada | Tidak ada |
| **4–6** | **Layar keadaan sesi** (Prioritas 2), durasi batch, price band, sumber harga, cek ketidaksepakatan nonaktif saat akhir pekan | `currentSession()` dari kontrak di fork | Wangsit (H-7) |
| **5–9** | 🔴 **Layar utama, struk batch.** Jual/terima, harga pembanding, selisih bps, asal selisih, netting %, peserta, blok, [salin panggilan verifikasi], [buka pool di explorer] | API indexer Dharu | Dharu (H-10) |
| **7–11** | **Layar batch GAGAL** (`demo.md` §3), sama pentingnya dengan layar sukses | Event kegagalan via API | Dharu |
| **10–13** | Alur tanda tangan intent di testnet 46630. **Sebut jujur di awal bahwa tokennya token uji**, sekali, bukan di catatan kaki | Testnet | Dharu (coordinator) |
| **12–14** | Layar lelang + publikasi imbalance (Prioritas 3). **Haram peserta karangan** | Fork, arus historis | Dharu (replay) |
| **14–16** | Naskah 90 detik, polish | tidak ada | tidak ada |

**Aturan desain yang mengikat Nabil:**
- Satu layar = satu klaim yang bisa dibantah. Juri harus bisa memverifikasi satu angka
  sendiri **di bawah 90 detik** (`demo.md` §1).
- Tiap angka di layar punya tombol yang membawa juri ke sumbernya.
- **Jangan** bikin dashboard "total penghematan sepanjang masa" (`demo.md` §3b).
- Sesi adalah milik kontrak. Jangan tulis ulang logika kalender di frontend. Baca dari
  `SessionManager`. Dua implementasi kalender = dua jawaban berbeda di depan juri.
- Istilah: *intent*, bukan "order". Jangan pakai "MEV protection", "slippage protection",
  "APY" (`glosarium.md`).

---

## 5. Titik sinkronisasi

| Kode | Hari | Yang harus terbukti | Kalau meleset |
|---|---|---|---|
| **M1** | 7 (20 Sep) | **Ujung ke ujung di fork**: intent ditandatangani di UI → coordinator → solver → `Settlement` → struk tampil. Netting boleh 0 | Hentikan fitur baru, integrasi duluan |
| **M2** | 11 (24 Sep) | **Demo netting**: replay arus Agustus, struk menampilkan netting % dan selisih baseline | Potong layar Prioritas 3–4, bukan kedalaman verifikasi |
| **M3** | 14 (27 Sep) | **Feature freeze.** Setelah ini hanya perbaikan bug, uji, dan dokumen | tidak ada |
| **M4** | 15 (28 Sep) | **Audit provenansi** `rencana-uji.md` §11. Satu pertanyaan per item di layar, *dari mana datanya, dan bisakah juri verifikasi sendiri?* | Yang tidak lolos **dipotong**, bukan diberi disclaimer |
| **M5** | 16 (29 Sep) | Gerbang CI dievaluasi → deploy mainnet **atau** submit dengan testnet + fork. Keputusan dari hasil CI | Submit testnet+fork tetap memenuhi T&C §3.1 |
| **buffer** | 17 (30 Sep) | Deck, dokumentasi, video, submit. Buffer satu hari | tidak ada |

**Standup harian 15 menit**, boleh async. Tiga pertanyaan: apa yang selesai, apa yang
kamu tunggu dari siapa, apa yang berubah di kontrak antar-bagian.

---

## 6. Aturan anti-tabrakan

1. **Satu file, satu pemilik.** Butuh perubahan di wilayah orang lain → minta, jangan edit.
2. **ABI digenerate, tidak pernah diedit tangan.** Kalau ABI berubah, Wangsit
   mengumumkannya di standup hari itu juga.
3. **Branch:** `wangsit/*`, `dharu/*`, `nabil/*` → PR ke `main`. CI hijau wajib sebelum merge.
4. **Perubahan kontrak antar-bagian (§1) butuh persetujuan ketiganya**, bukan hanya
   pemiliknya. Ini enam hal itu saja, sisanya otonomi penuh.
5. **Angka berubah di `parameter.md` dulu**, di PR yang sama.
6. Dokumen menyimpang dari kenyataan, perbaiki **di hari yang sama** (`CLAUDE.md` §2 nomor 8).
7. **Aturan pengerjaan repo ada di `CLAUDE.md` §11** dan mengikat ketiganya, yaitu tanpa AI di
   daftar contributor, komentar kode seperlunya, commit dipecah, dan tanpa em dash di prosa.

---

## 7. Risiko koordinasi yang sudah terlihat

| Risiko | Kenapa berbahaya | Mitigasi |
|---|---|---|
| **Infra fork Dharu telat** | Wangsit tidak bisa fork test, Nabil tidak punya data nyata | Nabil hari 1–3 sengaja dipilih yang **nol dependensi**. Kalau fork telat >1 hari, Wangsit bikin fork minimal sendiri di `contracts/test/` dan Dharu menyusul |
| **Baseline dua implementasi menyimpang** | Klaim inti proyek runtuh | Uji differential jadi gerbang CI, bukan uji opsional. Dijalankan tiap PR sejak hari 8 |
| **Frontend menunggu API** | Nabil idle di paruh pertama | Skema API dibekukan hari 2, sebelum implementasinya selesai. Nabil coding terhadap skema |
| **Logika sesi dobel** | Kontrak dan UI menjawab berbeda di depan juri | Kontrak satu-satunya sumber. UI membaca, tidak menghitung |
| **DNS ISP Indonesia** | Gejalanya menyesatkan (`SSL certificate has expired`), bisa makan setengah hari | Workaround masuk skrip infra hari 1, dialami sekali oleh satu orang saja |

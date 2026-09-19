# Nokturn — Rencana Pengujian

> Tujuh lapis verifikasi di `spek-teknis.md` §9.2 diterjemahkan jadi **matriks
> pengujian konkret**: apa yang diuji, dengan alat apa, dan definisi selesai.
>
> Prinsip: tiap lapis menangkap kelas bug yang berbeda. Tidak ada yang menggantikan
> yang lain.

---

## 1. Invarian inti

**Empat belas invarian**, tiap satu jadi target invariant test Foundry **dan**
properti Echidna. Delapan pertama adalah inti settlement; enam sisanya muncul dari
desain lanjutan (lelang, sesi, agent).

| # | Invarian | Pernyataan formal |
|---|---|---|
| **I1** | Limit tidak pernah dilanggar | ∀ eksekusi: `executedBuy × sellAmount ≥ minBuyAmount × executedSell` |
| **I2** | Harga seragam | ∀ dua intent pada token sama di batch sama: harga identik |
| **I3** | Konservasi nilai | ∀ token: `Σ masuk + venueDelta ≥ Σ keluar` |
| **I4** | Nonce sekali pakai | ∀ (owner, nonce): tereksekusi paling banyak sekali |
| **I5** | Atomisitas | `finalize` sukses seluruhnya atau revert seluruhnya |
| **I6** | Solver terbatas | Nilai yang diambil solver ≤ `min(20% savings, 3bps notional)` |
| **I7** | Price band | ∀ token: `\|price − ref\| × 10000 ≤ ref × maxDevBps` |
| **I8** | Tidak ada yang dirugikan ⭐ | ∀ peserta: hasil ≥ baseline venue **atau** batch jadi pass-through |

**Invarian tambahan yang muncul dari desain lanjutan:**

| # | Invarian |
|---|---|
| I9 | Debu terakumulasi selalu ≥ 0, dan tidak pernah mengalir ke solver |
| I10 | Escrow lelang selalu bisa ditarik kembali kalau lelang batal — oleh siapa pun |
| I11 | Guardian tidak pernah bisa memindahkan dana |
| I12 | `sessionAt(t)` deterministik: pemanggilan berulang dengan `t` sama selalu identik |
| I13 | Closing print tidak pernah terbit `sufficient=true` di bawah ambang volume/peserta |
| I14 | Intent di luar mandat agent tidak pernah tereksekusi |

---

## 2. Desain handler untuk invariant testing

Invariant test hanya sebagus handler-nya. Handler yang terlalu sopan tidak akan
menemukan apa pun.

```solidity
contract NokturnHandler {
    // Aktor: banyak pengguna, banyak solver, satu guardian, satu owner
    // Tiap aksi dipanggil dengan input acak terbatas (bounded)

    function actUserSignIntent(uint256 seed) external;
    function actUserCancelNonce(uint256 seed) external;
    function actSolverSubmit(uint256 seed) external;        // termasuk solusi TIDAK VALID
    function actSolverSubmitMalicious(uint256 seed) external; // surplus palsu, limit dilanggar
    function actFinalize(uint256 seed) external;
    function actWarpTime(uint256 seed) external;            // lintasi batas sesi
    function actOracleUpdate(uint256 seed) external;        // termasuk basi & menyimpang
    function actTokenMultiplierChange(uint256 seed) external;
    function actGuardianPause() external;
    function actAuctionCommit(uint256 seed) external;
    function actAuctionChallenge(uint256 seed) external;
}
```

**Aturan handler:**
1. Sertakan aksi **jahat**, bukan hanya yang jujur — solver yang berbohong harus
   ada di dalam ruang pencarian
2. `actWarpTime` harus sering mendarat **tepat di batas sesi** (bias distribusi
   ke sana), bukan uniform
3. Token mock harus mencakup: normal, fee-on-transfer, desimal aneh, `uiMultiplier`
   berubah, dan yang **transfer-nya bisa revert** (uji P0-1 sejak awal)
4. Semua invarian dicek setelah **setiap** aksi

---

## 3. Differential testing: Rust ↔ Solidity

Bukti kebenaran terkuat yang tersedia, dan **gratis** karena versi Solidity tetap
dibutuhkan untuk benchmark gas.

```
Untuk N input acak:
    hasil_solidity = ClearingVerifierSol.verify(input)
    hasil_rust     = ClearingVerifierStylus.verify(input)
    assert(hasil_solidity == hasil_rust)          // termasuk revert yang sama
```

| Aspek | Target |
|---|---|
| Jumlah input | ≥ 1 juta |
| Distribusi | 40% acak, 30% nilai batas (0, 1, max), 20% kasus nyata dari mainnet, 10% adversarial |
| Yang dibandingkan | Nilai kembalian **dan** jenis revert |
| Definisi selesai | Nol perbedaan, dan laporannya di-commit ke repo |

**Kenapa ini kuat:** dua implementasi independen, ditulis dalam bahasa berbeda
dengan model aritmetika berbeda, yang sepakat pada sejuta input. Kesalahan yang
lolos harus muncul identik di keduanya — jauh lebih tidak mungkin daripada bug
di satu implementasi.

---

## 4. Symbolic execution (Halmos)

Untuk yang bisa **dibuktikan**, jangan cuma diuji.

| Target | Properti yang dibuktikan |
|---|---|
| Pemeriksaan limit (perkalian silang) | Tidak pernah overflow pada seluruh rentang input valid |
| Ekuivalensi perkalian silang | `b×S ≥ B×s` ⟺ `b/s ≥ B/S` untuk semua input valid |
| Pembulatan pro-rata | Total yang dijatah tidak pernah melampaui yang tersedia |
| Konservasi nilai | Tetap terjaga di bawah pembulatan terburuk |
| **`sessionAt()`** | FSM sesi benar untuk seluruh domain timestamp |
| Batas fee | `fee ≤ min(20% savings, 3bps notional)` selalu |
| Kekuasaan guardian | Tidak ada jalur eksekusi dari guardian ke transfer dana |

Dua terakhir menurutku paling bernilai: membuktikan **guardian tidak bisa mencuri**
dan **fee tidak bisa melampaui batas** adalah klaim yang bisa dinyatakan tanpa
syarat ke juri.

### 4.1 Status, diukur 19 September 2026

Dijalankan dengan halmos 0.3.3 dan z3, lewat `contracts/tools/halmos.sh`. Tiga file,
`ClearingMathProofs`, `AuctionMathProofs`, dan `SessionProofs`.

**Aturan penamaan.** Fungsi berawalan `testFuzz_` dijalankan simbolis oleh gerbang
dan merupakan bukti atas seluruh rentang yang dinyatakan. Fungsi berawalan
`testBound_` hanya dijalankan forge sebagai fuzz berbatas dan **bukan bukti**.
Fungsi `test_` tanpa argumen menelusuri domain tertutup secara tuntas, yang untuk
domain kecil sama lengkapnya dengan solver. Pemisahan ini ada supaya tidak ada
properti yang terbaca seperti terbukti padahal tidak.

| Baris §4 | Status |
|---|---|
| Pemeriksaan limit | Terbukti, uint128 penuh |
| Ekuivalensi perkalian silang | Terbukti, uint128 penuh |
| Batas fee | Terbukti, uint128 penuh |
| Pembulatan pro rata | **Sebagian.** Distributivitas terbukti di uint128. Lema pembulatan terbukti di uint64 saja |
| Konservasi nilai | **Sebagian.** Tanda dan luapan terbukti di uint128. Bentuk gabungannya fuzz |
| `sessionAt()` | **Sebagian.** Tiga properti parameter tuntas lewat enumerasi, tiga properti tanggal terbukti simbolis. Tabelnya tuntas lewat `CivilDate.t.sol` |
| Kekuasaan guardian | **Terbukti, dua paruh.** Lima properti simbolis atas `Guarded`, plus gerbang sumber di CI |

**Kenapa pembulatan pro rata berhenti di uint64.** Pembagian 256 bit adalah tembok
z3. Lema `floor(x/W) + floor(y/W) <= floor((x+y)/W)` tertutup dalam 2,2 detik di
uint64, dan timeout lewat 120 detik di uint96 maupun uint128, tanpa counterexample
di kedua kasus. Produk nyata protokol ini, yaitu jumlah di batas cap batch dikali
harga stock token, ada di sekitar 2 pangkat 139,5. Jadi tidak ada lebar yang
dijangkau solver yang mencakup rentang sebenarnya, dan menyatakan bukti uint64
seolah mencakup uint128 adalah persis jenis klaim yang repo ini ada untuk hindari.

Bentuk gabungannya tetap diuji forge sebagai fuzz di uint128 penuh, dan dipecah jadi
dua lema yang masing-masing terbukti. Yang hilang adalah langkah komposisinya, bukan
propertinya.

**Kenapa kekuasaan guardian bisa dibuktikan padahal pembulatan tidak.** Ia pernyataan
tentang keterjangkauan, bukan tentang aritmetika 256 bit, jadi ia tidak menyentuh tembok
yang menghentikan lema pembulatan. Lima properti tertutup simbolis, yaitu hanya guardian
yang bisa memanggil `pause` atas pemanggil simbolis, tenggatnya selalu tepat enam jam ke
depan pada titik waktu mana pun, ia selalu lepas, `pause` tidak pernah mengubah siapa
guardian-nya, dan rotasi mencabut kekuasaan alamat lama di transaksi yang sama.

Paruh keduanya tidak bisa dibuktikan solver. Bahwa `pause` **tetap** satu-satunya tempat
guardian diperiksa adalah pernyataan tentang kode yang belum ditulis. `tools/guardian-gate.py`
yang memegangnya, jalan di tiap push, dan sudah dibuktikan menangkap dengan merusaknya
sengaja dua kali.

**Kenapa `sessionAt` tidak dibuktikan utuh.** Ia membaca dua tabel storage, batas DST
dan kalender. Menjalankannya simbolis berarti membuktikan pernyataan tentang kalender
sembarang, bukan tentang kalender kita. Yang diperiksa sebagai gantinya adalah semua
yang ada di hilir jawabannya, dan itu terbagi dua menurut ukuran domainnya.

Tiga properti parameter **dienumerasi tuntas** atas kesembilan sesi, yaitu setiap sesi
punya band dan tahu apakah ia menjalankan batch, tidak ada band yang lebih lebar dari
collar lelang, dan `PROTECTIVE` adalah band tersempit sekaligus batch terlambat. Untuk
domain sembilan nilai, menelusuri semuanya sama lengkapnya dengan solver dan jauh lebih
murah. Ia juga melepaskan gas terukur dari undian fuzz, karena `maxDeviationBps` adalah
rantai perbandingan dan sesi yang difuzz mendarat di anak tangga berbeda tiap run. Itu
yang menggeser satu angka 177 gas antara laptop dan CI sebelum ditulis begini.

Tiga properti bentuk tanggal **dibuktikan simbolis** atas seluruh domain uint32 yang
dipakai, yaitu setiap indeks hari menghasilkan bulan, tanggal, dan tahun yang
benar-benar ada. Ketiganya dipecah satu properti per fungsi. Digabung jadi satu query
mereka tertutup di 388 detik pada satu run dan timeout di 447 detik pada run berikutnya,
di mesin yang sama. Dipecah, yang terberat 77 detik. Gerbang yang berkedip adalah
gerbang yang orang belajar abaikan.

Tabelnya sendiri ditelusuri tuntas 5.844 hari dua arah oleh `CivilDate.t.sol`.

**Dua catatan operasional.** Profil `halmos` mematikan `dynamic_test_linking`, karena
foundry menulis ulang `new Contract()` di dalam test jadi cheatcode `deployCode` yang
halmos tidak punya, sehingga `setUp` gagal sebelum jalur pertama. Dan `halmos.sh`
memaksa build ulang, karena kedua profil menulis ke `out/` yang sama dan build tanpa
AST membuat halmos melaporkan nol test ditemukan. CI selalu checkout bersih jadi tidak
pernah terkena keduanya.

---

## 5. Mutation testing

Membalik pertanyaan dari *"apakah kode saya benar"* jadi ***"apakah test saya
benar-benar menguji"***.

```
1. Suntikkan mutasi ke kontrak (ubah operator, batas, kondisi)
2. Jalankan test suite
3. Mutasi yang LOLOS = lubang di test suite
4. Tambal, ulangi
```

| Target | Nilai |
|---|---|
| Skor mutasi kontrak inti (`Settlement`, `SessionManager`) | **≥ 90%** |
| Skor mutasi keseluruhan | ≥ 80% |
| Mutasi yang lolos | Harus dijelaskan satu per satu, bukan diabaikan |

**Skor mutasi masuk ke pitch.** Sedikit sekali tim hackathon yang bisa menunjukkan
angka ini, dan artinya konkret: bukan "kami banyak menulis test", tapi "test kami
terbukti menangkap kesalahan".

---

## 6. Fork testing terhadap mainnet nyata

Mock berbohong. Protokol eksternal harus diuji apa adanya.

| Uji | Terhadap |
|---|---|
| `UniswapV3Adapter` melakukan swap benar | Pool **nyata** di chain 4663 — NVDA-USDG `0xD4EB…14A3` (fee 500, tickSpacing 10) |
| **`quoteFromState` cocok PERSIS dengan eksekusi nyata** ⭐ | Fork test diferensial lintas 8 ukuran × tiap pool allowlist × kedua arah. **Definisi selesai: nol selisih.** Sekalian mengkalibrasi `MAX_TICK_CROSSINGS` dari p99 terukur. Spek: [`desain-baseline.md`](desain-baseline.md) §7.3 |
| Kedua urutan token | NVDA (USDG = `token0`) **dan** GME (USDG = `token1`) — urutannya terbalik antar pool |
| Adapter tak-terkuotasi menolak dengan benar | Pool V4 berhook fee dinamis (`0x800000`) → `isQuotable()` **wajib** `false`, `quoteFromState` **wajib** revert |
| Perilaku transfer Stock Token | Kontrak token nyata (beacon `0xe10b…1b00`); termasuk `paused()` dan jalur Permit2 |
| Pembacaan feed oracle | Feed Chainlink `DualAggregator` nyata + TWAP UniV3 nyata |
| **Feed beku akhir pekan** | Fork ke blok akhir pekan nyata — pastikan token **tidak** masuk `PROTECTIVE` (aturan `parameter.md` §7.3) |
| `uiMultiplier` terbaca benar | Stock Token nyata |
| Batch penuh ujung ke ujung | State mainnet yang di-fork |

> **v1.0 hanya punya satu adapter.** Arcus/Rialto bukan target fork test v1.0 —
> keduanya di luar scope adapter (lihat `spek-teknis.md` §9.1). Baris ketiga
> justru menguji bahwa venue yang **tidak** bisa dijadikan baseline benar-benar
> ditolak, bukan ditebak.

---

## 7. Skenario adversarial (uji eksplisit, bukan fuzz)

Tiap baris jadi satu test bernama, karena masing-masing menyandikan pemahaman
tentang serangan nyata.

| # | Skenario | Harapan |
|---|---|---|
| A1 | Solver klaim savings palsu | Revert `SavingsMismatch`, bond disita |
| A2 | Solver menang lalu tidak `finalize` | Slash 10%; solusi lain atau pass-through mengambil alih |
| A3 | Adapter jahat mencoba reentrancy | Revert; delta saldo terjaga |
| A4 | Oracle dimanipulasi 500 bps sesaat | Ketidaksepakatan terdeteksi → `PROTECTIVE` |
| A5 | Kedua oracle basi saat OPEN | `PROTECTIVE`; tidak ada lelang |
| A6 | Intent lelang palsu untuk menggeser indikatif, lalu batal | Ditolak — escrow diwajibkan sejak freeze |
| A7 | Penantang mengajukan harga lebih buruk | Tantangan gagal; bond penantang disita |
| A8 | `uiMultiplier` berubah di tengah batch | Revert untuk token itu; sisanya lanjut |
| A9 | Token fee-on-transfer masuk allowlist | Delta saldo menangkap selisih; akuntansi tetap benar |
| A10 | Transfer Stock Token revert saat `finalize` | Batch revert bersih, tidak ada dana tersangkut. **P0-1 terjawab: tidak ada gate KYC**, jadi ini bukan jalur yang diharapkan — tapi tetap diuji karena token **Pausable** dan blocklist alamat tersanksi tidak bisa dibuktikan tidak ada |
| A11 | Guardian pause di tengah jendela solusi | Batch batal bersih; escrow kembali |
| A12 | Exposure cap terlampaui | Revert `ExposureCapExceeded` sebelum dana bergerak |
| A13 | Semua solver berkolusi mengajukan solusi buruk | Pass-through aktif; fee nol |
| A14 | Warp waktu tepat ke batas sesi | Guard band aktif; parameter konservatif dipakai |
| A15 | Intent agent melanggar mandat | Revert `MandateRuleBroken` di `AgentMandate.authorize`, dan Permit2 menolak penarikannya. `MandateViolated` dihapus, lihat `parameter.md` §5B |

### 7.1 Peta ke nama test

Ditulis 19 September 2026. Setiap baris di atas sekarang punya test bernama, supaya
tabel dan suite bisa dibaca bersisian tanpa menebak. Empat belas dari lima belas
sudah hijau.

| # | Test | File |
|---|---|---|
| A1 | `test_A1_solverClaimingSavingsItDidNotProduce` | `test/Adversarial.t.sol` |
| A2 | `test_A2_winnerNeverFinalizes` | `test/Adversarial.t.sol` |
| A3 | `test_A3_maliciousAdapterAttemptsReentrancy` | `test/Adversarial.t.sol` |
| A4 | `test_A4_oracleManipulatedForOneBlock` | `test/Adversarial.t.sol` |
| A5 | `test_A5_bothOraclesStaleDuringOpen` | `test/Adversarial.t.sol` |
| A6 | `test_A6_phantomAuctionIntentShiftsTheIndicativeThenLeaves`, `test_A6_cancellingBeforeFreezeLeavesNothingBehind` | `test/Adversarial.t.sol` |
| A7 | `test_A7_challengerNamesAWorsePrice` | `test/Adversarial.t.sol` |
| A8 | `test_A8_uiMultiplierMovesBetweenSubmitAndFinalize` | `test/Adversarial.t.sol` |
| A9 | `test_A9_feeOnTransferTokenAboveTheBandCannotClear`, `test_A9_feeOnTransferTokenWithinTheBandKeepsAccountingHonest` | `test/Adversarial.t.sol` |
| A10 | `test_A10_stockTokenTransferRevertsDuringFinalize` | `test/Adversarial.t.sol` |
| A11 | `test_A11_guardianPausesMidSolutionWindow` | `test/Adversarial.t.sol` |
| A12 | `test_A12_exposureCapExceeded` | `test/Adversarial.t.sol` |
| A13 | `test_A13_everySolverCollusesOnAWorthlessSolution` | `test/Adversarial.t.sol` |
| A14 | `test_A14_batchLandsExactlyOnASessionBoundary` | `test/Adversarial.t.sol` |
| A15 | `test_A15_agentIntentBreachingTheMandate` | `test/AgentMandate.t.sol` |

**A11 sudah punya subjek, 19 September 2026.** Ternyata bukan keputusan yang menunggu.
`parameter.md` §8 dan `threat-model.md` sudah menentukan guardian sejak awal, dan yang
tidak memuatnya adalah `interfaces.md`, dokumen yang jadi sumber penulisan kontrak. Jadi
pause lolos tanpa ada yang menolaknya. `Guarded` sekarang ada, `interfaces.md` §1.1
memuatnya, dan `parameter.md` §8.1 memperbaiki satu kontradiksi yang membuat spesifikasi
lama tidak bisa dieksekusi siapa pun.

Sisi lelangnya, yaitu escrow yang sudah berada di dalam kontrak saat protokol berhenti,
ada di `test/Guardian.t.sol`. Enam belas test di sana, dan separuhnya ada untuk
membuktikan guardian **tidak** bisa melakukan sesuatu.

**Dua temuan dari menulis test ini.**

Pertama, `SolverRegistry.reportInvalidSurplus` tidak pernah dipanggil dari mana pun.
`Settlement.submitSolution` menolak klaim palsu dengan revert, dan transaksi yang
revert tidak bisa menyita bond. Harapan "bond disita" di baris A1 karena itu tidak
tercapai onchain, dan fungsinya jadi kode mati di kontrak yang immutable. Yang benar
terjadi adalah solusinya ditolak dan tidak pernah jadi pemenang.

Kedua, token fee-on-transfer tidak bisa kliring sama sekali kalau feenya di atas tiga
basis poin, karena pita harga seragam di `ClearingVerifier` selebar itu. Di bawahnya
ia kliring normal dan akuntansi fee tetap benar, karena fee dibaca dari selisih saldo
kontrak sendiri, bukan dari angka yang ditulis solver. Keduanya diuji.

---

## 8. Pengujian habis pada kalender

Kasus deterministik — jangan disampel, **uji semuanya**.

```
Untuk setiap timestamp batas selama 2020–2035:
  · transisi DST (2× per tahun)
  · setiap hari libur NYSE
  · setiap early close
  · setiap pembukaan & penutupan harian
  · ±GUARD_BAND di sekitar tiap batas
assert sessionAt(t) == kalender_referensi(t)
```

Kalender referensi dibuat offchain dari sumber publik dan di-commit ke repo sebagai
fixture. **Ini klaim kuat untuk kriteria juri:** bukan "kami menguji kalendernya",
tapi "kami menguji **setiap batas kalender selama 15 tahun**".

> ### ✅ Fixture sudah ada — [`data/nyse-calendar/`](../data/nyse-calendar/)
> Dibuat 1 Agustus 2026, pra-Buildathon (data, bukan kode).
>
> | File | Isi |
> |---|---|
> | `nyse-sessions.csv` | 5.844 hari, 2020–2035, dengan epoch UTC buka/tutup |
> | `dst-boundaries.csv` | 32 batas transisi — yang masuk onchain |
> | `calendar-entries.json` | 155 hari libur + 33 early close sebagai `CalendarEntry` |
> | `gen_calendar.py` | Generator deterministik, validasi ikut di dalamnya |
>
> **Tervalidasi** terhadap kalender NYSE 2020–2026 yang diketahui independen —
> hari libur dan early close, keduanya cocok persis.
>
> ⚠️ **Tiga batasan yang harus dibaca sebelum memuat onchain** (detail di README-nya):
> tanggal setelah 2028 diturunkan dari aturan dan belum diumumkan NYSE · penutupan
> tak terjadwal (mis. **9 Jan 2025, pemakaman Carter**) tidak bisa diturunkan dari
> rumus apa pun dan wajib masuk lewat time-lock · aturan DST bisa berubah lewat
> undang-undang.
>
> Batasan kedua itu penting untuk uji: kalender onchain **bisa salah** pada hari
> semacam itu. Yang menangkapnya adalah `PROTECTIVE` — kalender bilang `OPEN` tapi
> feed diam sepanjang hari = bukti bertentangan. **Tambahkan itu sebagai kasus uji
> tersendiri**, bukan hanya menguji kalendernya benar.

---

## 9. CI — berjalan sejak commit pertama

| Gerbang | Ambang | Kapan |
|---|---|---|
| Slither | Nol temuan tingkat tinggi | Tiap commit |
| Aderyn | Nol temuan tingkat tinggi | Tiap commit |
| Unit test | 100% lulus | Tiap commit |
| Coverage | ≥ 95% baris pada kontrak inti | Tiap commit |
| Gas snapshot | Di-commit; perubahan terlihat di diff | Tiap commit |
| Storage layout | Di-commit; perubahan tak sengaja terdeteksi | Tiap commit |
| Invariant (jalan pendek) | Lulus | Tiap PR |
| Invariant (jalan panjang, jutaan run) | Lulus | Tiap malam |
| Echidna | Lulus | Tiap malam |
| Differential Rust↔Solidity | Nol perbedaan | Tiap malam |
| Halmos | Semua properti terbukti | Tiap malam |
| Mutation | Skor ≥ 90% inti | Mingguan |
| Fork test | Lulus | Tiap malam |

> **Menambahkan CI di minggu keenam berarti membayar utang teknis di saat paling
> sibuk.** Gerbang-gerbang ini murah di hari pertama dan mahal di hari keempat puluh.

---

## 10. Definisi "siap mainnet"

Semua harus hijau. Tanpa pengecualian, tanpa "nanti diperbaiki".

- [x] 14 invarian hijau di Foundry **dan** Echidna · lima target Echidna, nol falsifikasi, 19 September 2026
- [x] Differential ≥ 1 juta input, nol perbedaan · laporan `verifier/reports/differential-2026-09-18.md`
- [ ] Semua properti Halmos terbukti · 4 dari 7 penuh, 3 sebagian. Lihat §4.1
- [x] Skor mutasi ≥ 90% pada kontrak inti · 100% atas 156 mutan yang dihitung di `Settlement` dan `SessionManager`, 19 September 2026. Seluruh kontrak lain juga sudah diukur dan berada di 100%
- [x] Semua fork test lulus terhadap mainnet nyata · 18 hijau, 19 September 2026. Sebelum hari itu fork-nya membaca state 2 Agustus, lihat `pertanyaan-terbuka.md` pelajaran ketujuh
- [x] 15 skenario adversarial lulus · lima belas hijau, peta ke nama test di §7.1
- [x] Kalender diuji habis 2020–2035 · `CivilDate.t.sol` menelusuri 5.844 hari kalender yang ter-commit, dua arah
- [x] Coverage ≥ 95% pada kontrak inti · gerbang `build-test` di CI, run 35410613213
- [x] Slither & Aderyn bersih · gerbang `static-analysis` di CI, run 35418852026
- [x] Threat model selesai, risiko sisa terdokumentasi · sepuluh risiko sisa terbuka di §5, runbook §6.3 terisi 19 September 2026. Risiko 10 sengaja tidak dimitigasi, dibatasi ruang lingkupnya
- [ ] Monitoring jalan, runbook tertulis, kunci guardian teruji · runbook tertulis dan kunci guardian teruji lewat 16 test plus 5 bukti simbolis. Monitoring belum berjalan
- [ ] Exposure cap diset ke nilai peluncuran
- [ ] Semua P0 di `pertanyaan-terbuka.md` terjawab
- [ ] **Audit provenansi data §11 lulus — nol temuan mock di permukaan produk**

---

## 11. Audit provenansi data — gerbang pra-submission

> Gerbang ini tidak menguji apakah kode **benar**. Ia menguji apakah yang dilihat
> juri **nyata**. Dua hal berbeda, dan yang kedua tidak punya test runner.

**Kenapa ini ada sebagai gerbang formal, bukan imbauan.** Pemilik proyek pernah gagal
lolos ke final karena ada fitur dan data mock. Ini kerugian yang sudah terjadi, bukan
kekhawatiran hipotetis. Aturannya di `CLAUDE.md` §2 nomor 9; §11 ini adalah cara
membuktikan aturan itu dipatuhi.

### 11.1 Aturan satu pertanyaan

Telusuri **setiap layar demo, setiap angka di deck, setiap chart, setiap field UI.**
Untuk tiap item, jawab satu pertanyaan:

> **Dari mana data ini, dan bisakah juri memverifikasinya sendiri tanpa mempercayai kami?**

Tiga jawaban yang diterima:

| Jawaban | Contoh |
|---|---|
| **Onchain, bisa dicek** | tx hash, alamat kontrak di Blockscout, state pool |
| **Query publik, bisa diklik** | Dune query ber-ID, SQL terbuka |
| **Fork mainnet dari blok X** | reproducible, blok disebut eksplisit |

Apa pun selain ketiganya → **fiturnya dipotong.** Bukan diperbaiki di menit terakhir,
bukan diberi disclaimer kecil. Dipotong. Scope kecil yang sungguhan mengalahkan scope
besar yang separuh pura-pura.

### 11.2 Inventaris wajib

> Kerangka ini sudah mulai diisi di `demo.md` §7 — baris yang sumbernya bisa
> ditentukan sejak fase desain. Kolom vonis tetap diisi H-3.

Isi tabel ini secara lengkap. Baris tanpa sumber yang bisa diverifikasi tidak boleh
ikut submission.

| Permukaan | Item | Sumber | Bisa diverifikasi juri? | Vonis |
|---|---|---|---|---|
| UI | *(tiap layar)* | | | |
| Demo video | *(tiap adegan yang menampilkan angka)* | | | |
| Deck | *(tiap angka)* | | | |
| README | *(tiap klaim terukur)* | | | |
| Dashboard | *(tiap chart)* | | | |

### 11.3 Empat jebakan yang sudah teridentifikasi

Diperiksa khusus, karena keempatnya lahir dari niat baik dan justru karena itu mudah lolos.

**1. Lapisan agent** — `desain-agent.md` menjanjikan mandat dan Batch-TWAP. Kalau tidak
ada agent nyata yang terintegrasi saat submission, **jangan tampilkan agent memakai
Nokturn.** Ini yang paling rawan: paling mudah dipalsukan, paling sulit dibuat nyata.
Boleh: menjelaskan desainnya sebagai rencana. Haram: mendemokan agent boneka.

**2. Closing print & lelang** — keduanya butuh banyak peserta. Di mainnet yang baru
di-deploy, lelang penutupan kosong. Boleh: menunjukkan lelang berjalan di fork dengan
arus historis. Haram: slide yang menyiratkan closing print sudah dikonsumsi protokol
lain, atau lelang yang pesertanya kita karang.

**3. Placeholder UI** — angka yang dipasang saat menata layout lalu ikut terkirim. Paling
sepele, paling sering lolos, dan ini yang biasanya benar-benar menjatuhkan orang.
Cara mencegah: **grep seluruh frontend untuk angka literal** sebelum submission —
`grep -rnE '[0-9]{2,}\.[0-9]|lorem|placeholder|TODO|dummy|sample' app/`. Tiap temuan
harus punya alasan, atau dibuang.

**4. Kata "terukur" untuk backtest** — netting 63,8% / 50,1% / 27–33% adalah **simulasi
kontrafaktual di atas data asli**. Inputnya trade sungguhan Agustus 2026; mekanismenya
hipotetis karena Nokturn belum ada saat itu. Selalu tulis dan ucapkan **"backtest"**.
Periksa konsistensinya sampai ke **naskah lisan presentasi**, bukan cuma dokumen —
dokumen sudah benar, mulut yang biasanya keseleo.

### 11.4 Kapan dijalankan

**H-3 sebelum tenggat, bukan di hari H.** Alasannya: vonis "potong" butuh waktu untuk
dieksekusi. Kalau audit ini dijalankan di hari terakhir, satu-satunya jalan keluar dari
temuan mock adalah membiarkannya — dan itu mengalahkan seluruh tujuan gerbang ini.

Jalankan ulang setelah setiap pemotongan, karena memotong fitur sering meninggalkan
angka yatim di deck atau UI.

### 11.5 Yang **bukan** pelanggaran

Supaya gerbang ini tidak dipakai berlebihan sampai merugikan:

- **Mock token di suite test** (fee-on-transfer, desimal aneh, token rusak) — juri tidak
  melihatnya, dan menghapusnya melemahkan keamanan. Lihat §6.
- **Input sintetis untuk fuzz dan invariant** — itu memang gunanya.
- **Fixture kalender NYSE** (`data/nyse-calendar/`) — data referensi nyata yang
  dipra-komputasi, tervalidasi terhadap kalender independen 2020–2026.
- **Demo di atas fork mainnet** — state nyata sampai blok terakhir. Yang haram bukan
  fork-nya, melainkan mengklaimnya sebagai settlement live. Sebut bloknya.
- **Kontrak mainnet tanpa pengguna** — itu pra-peluncuran, bukan mock. Yang haram adalah
  mengklaim sudah ada adopsi.

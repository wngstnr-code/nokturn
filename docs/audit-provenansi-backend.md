# Audit provenansi M4, bagian backend

Dijalankan 29 September 2026 oleh Dharu, mengikuti `rencana-uji.md` §11. Satu
pertanyaan untuk setiap item. Dari mana datanya, dan bisakah juri memverifikasinya
sendiri tanpa mempercayai kami?

Cakupannya semua yang dihasilkan backend, yaitu setiap route API yang dibaca layar,
struk, replay, dan data backtest. Layar, deck, video, dan README milik Nabil dan tim.
Temuan di sisi frontend yang terlihat dari sini dicatat di bagian akhir supaya tidak
hilang, tapi vonisnya milik pemiliknya.

Tiga jawaban yang diterima, dari §11.1.

| Kode | Arti |
|---|---|
| **ON** | Onchain, bisa dicek lewat tx hash, alamat kontrak, atau state |
| **Q** | Kueri Dune publik ber-ID |
| **FK** | Fork mainnet dari blok yang disebut, reproducible |

Vonis. **Lolos** berarti sumber dan jalur verifikasinya ada di data yang sama.
**Lolos bersyarat** berarti lolos asal syarat yang ditulis dipenuhi sebelum submit.
**Potong** berarti tidak boleh tampil.

---

## 1. Struk batch, `GET /v1/batches/:batchId`

Layar utama `demo.md` §2 dan layar gagal §3. Semua struk di demo berasal dari fork
mainnet 4663 di blok 67.798.044, dan `provenance.source.kind` menyebutnya `fork`
lengkap dengan blok patokannya.

| Field | Sumber | Jalur juri | Kode | Vonis |
|---|---|---|---|---|
| `outcome`, `solver`, `totals.*` | Event `BatchSettled` atau `BatchPassthrough` di transaksi `finalize` | `provenance.transactionHash` dan log index di setiap baris | FK | Lolos |
| `fills[].executedSell`, `executedBuy`, `savingsUsd` | Event `IntentSettled` | Tx hash dan log index per fill | FK | Lolos |
| `fills[].baselineBuy` | `Solution.baselineQuotes` di calldata `submitSolution`, diteruskan ke event | Diperiksa lewat `baselineFloors`, lihat baris berikut | FK | Lolos, dengan catatan N23 |
| `baselineFloors[]` | Satu kuotasi `quoteFromState` per arah pasangan, di blok induk `submitSolution` | `verifyFloor.castCommand` bisa ditempel, dan `holds` harus benar | FK | Lolos. Ditambahkan 29 September 2026 (N23) |
| `fills[].verifyBaseline` | Kuotasi venue untuk ukuran fill itu saja | Perintah `cast` di field itu | FK | **Lolos bersyarat.** Di batch rute penuh, angkanya lebih tinggi dari `baselineBuy` karena baseline fill adalah bagian pro rata. Layar harus menampilkan `baselineFloors` sebagai tombol verifikasi, bukan `verifyBaseline` |
| `fills[].attribution` | Dihitung dari fill dan `VenueRouted` di batch yang sama | Kedua sumber punya tx hash | FK | Lolos |
| `clearingPrices[]` | Event `ClearingPrice`, yang dideklarasikan tapi tidak pernah diterbitkan kontrak (N9) | Tidak ada, karena field ini selalu kosong | FK | **Lolos bersyarat.** Tidak ada angka yang dikarang, tapi layar tidak boleh menampilkan bagian harga kliring seolah berisi. Tampilkan dari `fills` atau sembunyikan bagiannya sampai kontrak menerbitkan event itu |
| `venueRoutes[]` | Event `VenueRouted`, dan `minOut` dari calldata solusi pemenang | Tx hash, alamat pool | FK | Lolos |
| `solutions[]` | Event `SolutionSubmitted` dan `SolutionRejected` | Tx hash per baris | FK | Lolos. `accepted` diperbaiki 28 September 2026 (N16) |
| `failure.*` | Alasan di `BatchPassthrough`, `IntentCollectionFailed`, atau `expireBatch` | Tx hash | FK | Lolos |
| Semua perintah `cast` | URL RPC dari `NOKTURN_API_PUBLIC_RPC` | Ditempel juri | FK | **Lolos bersyarat.** Di fork URL-nya `127.0.0.1:8545`, yang hanya bisa dijalankan di mesin demo. Untuk submit, juri perlu fork yang bisa diakses, atau perintahnya disebut sebagai contoh yang dijalankan di depan mereka |

## 2. Rute baca lain

| Route | Isi | Sumber | Kode | Vonis |
|---|---|---|---|---|
| `GET /v1/config` | Alamat kontrak, EIP-712, batas cap | Dibaca dari kontrak saat request | ON / FK | Lolos |
| `GET /v1/session` | Sesi, durasi batch, band, sumber harga | `SessionManager` dan `PriceOracle` di blok yang disebut | ON / FK | Lolos |
| `GET /v1/allowlist` | Slot beacon, `uiMultiplier`, ukuran kode | Dibaca langsung dari token | ON | Lolos |
| `GET /v1/quote` | Baseline indikatif | `quoteFromState`, dengan `verify.castCommand` | ON / FK | Lolos |
| `GET /v1/batches` | Ringkasan batch | Tabel indexer dari event | FK | Lolos |
| `GET /v1/health` | Status komponen | Diukur saat request (N18) | Bukan klaim ke juri | Lolos |
| `GET /v1/auctions/:id` | Belum ada lelang di fork | Menjawab 503 dengan alasan, bukan data | Tidak menampilkan angka | Lolos. Tidak ada yang dikarang (N17) |

## 3. Angka backtest dan replay

| Item | Sumber | Kode | Vonis |
|---|---|---|---|
| Kurva netting lawan pangsa, `GET /v1/backtest/netting-curve` | Ekspor eksekusi `01M1KE310E23FY3E5QW4K9WG4A` dari kueri `8595303`, label `BACKTEST` di setiap baris | Q | Lolos, **asal layar memakai route ini** (lihat §5) |
| Netting 27 sampai 33 persen, 21,4 persen di pangsa 5 persen, 50,1 persen di 100 persen | Kueri `8595303`, baris `off_hours_weekday` | Q | Lolos, selalu disebut **backtest** |
| Fixture replay, 728 trade | Kueri `8846173`, publik dan permanen, setiap trade membawa tx hash asli | Q | Lolos |
| Netting hasil replay di fork | Struk replay, empat kunci lokal, fork blok 67.798.044 | FK | **Lolos bersyarat.** Kalimat kejujuran replay wajib ikut, yaitu arus Agustus, kunci lokal, fork, bukan mainnet. Tidak boleh disandingkan dengan angka backtest. Kalimatnya ada di `demo.md` §3d |
| Layar lelang | `tools/fork-auction.sh` milik Wangsit, fork blok 66.491.729, event `CrossExecuted` | FK | **Lolos bersyarat.** Disebut sebagai harness, bukan keeper yang berjalan sendiri (N17). Pesertanya dompet demo, dan itu diucapkan sebelum layarnya muncul (`demo.md` §3b) |

## 4. Temuan yang diperbaiki selama audit

- **N23.** Tombol verifikasi baseline per fill memberi angka yang tidak cocok di batch
  rute penuh. Diperbaiki dengan `baselineFloors`.
- **Key RPC di permukaan publik.** Perintah `cast` di struk mencetak URL RPC yang
  dipakai API. Dengan RPC berbayar, itu berarti key tercetak di setiap struk. Kini
  URL publik dipisah (`NOKTURN_API_PUBLIC_RPC`), dan API menolak start kalau URL baca
  membawa path tanpa URL publik. `pin-block.sh` juga pernah menulis URL lengkap ke
  berkas yang di-commit.
- **Kurva netting ditulis tetap di layar.** Backend kini menyajikannya dari data
  (F30). Pemindahan di layar ada di tangan Nabil.

## 5. Temuan di sisi frontend, untuk Nabil

Dicatat dari grep `rencana-uji.md` §11.3 butir 3 dan dari pemetaan layar ke route.
Vonis akhirnya milik Nabil.

| Layar | Temuan | Usul |
|---|---|---|
| `netting/page.tsx` baris 8 sampai 18 | Kurva ditulis tetap di kode. Angkanya benar dan cocok dengan kueri `8595303`, tapi tidak ditarik dari data, dan titik pangsa 40 persen hilang | Ganti dengan `GET /v1/backtest/netting-curve`, lalu tampilkan `source.duneQueryUrl` dan label dari data |
| `batch/[batchId]/page.tsx` baris 115 | Tombol verifikasi memakai `fill.verifyBaseline` | Tambahkan tombol dari `baselineFloors[].verifyFloor`, karena itu yang cocok dengan chain di batch rute |
| `session/page.tsx` | Membaca `SessionManager` langsung dari chain **testnet 46630**, bukan lewat API | Sebut testnet dengan jelas di layar. F12 meminta layar ini lewat `GET /v1/session` |
| `allowlist/page.tsx` | Membaca gerbang Stock Token langsung dari mainnet. Sah, karena onchain | Baris 88 menyebut 29,6 juta dolar dan 250 ribu trade Juli 2026 untuk token penyamar GME. Tautkan sumbernya |
| Semua layar | Grep angka literal tidak menemukan placeholder lain di luar ikon SVG | Jalankan ulang setelah perubahan terakhir |

## 5b. Dijalankan ulang setelah F5, 28 September 2026

§11.4 meminta audit ini diulang untuk setiap field yang berubah. F5 menutup
packaging, bukan data. Yang berubah hanya tiga hal, yaitu `data/` di-mount ke
container `deploy`, `data/backtest` ikut ke image api, dan letak store solver
profil b. Tidak ada field API, struk, atau angka yang berubah bentuk maupun
sumbernya, jadi tidak ada baris di §1 sampai §3 yang perlu divonis ulang.

Satu hal dikuatkan, bukan diubah. `NOKTURN_API_PUBLIC_RPC` di compose disetel ke
`http://127.0.0.1:8545`, yaitu fork sebagaimana diterbitkan di mesin yang
menjalankan demo dan bukan endpoint berbayar. Itu persis kondisi yang membuat
baris terakhir §1 berstatus lolos bersyarat, dan syaratnya belum hilang.

## 6. Yang masih harus terjadi sebelum submit

1. Nabil memindahkan layar netting ke route F30 dan menampilkan `baselineFloors`.
2. Tim memutuskan cara juri menjalankan perintah `cast` dari struk fork, apakah lewat
   fork yang dibuka ke publik, rekaman demo, atau disebut sebagai contoh.
3. Audit ini dijalankan ulang setelah setiap pemotongan, sesuai §11.4.

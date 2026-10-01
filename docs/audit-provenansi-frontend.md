# Audit provenansi M4, bagian frontend

Dijalankan 1 Oktober 2026 oleh Nabil, mengikuti `rencana-uji.md` §11 dan memakai
kode serta vonis yang sama dengan `audit-provenansi-backend.md`. Satu pertanyaan
untuk setiap item. Dari mana datanya, dan bisakah juri memverifikasinya sendiri
tanpa mempercayai kami?

Cakupannya setiap layar di `app/`, yaitu trade, batch, struk, lelang, sesi,
allowlist, netting, dan landing. Deck, video, dan README belum ada saat audit ini
dijalankan, jadi belum divonis. Lihat bagian 5.

| Kode | Arti |
|---|---|
| **ON** | Onchain, bisa dicek lewat tx hash, alamat kontrak, atau state |
| **Q** | Kueri Dune publik ber-ID |
| **FK** | Fork mainnet dari blok yang disebut, reproducible |

Saat audit dijalankan, aplikasi membaca coordinator mainnet di Railway. Coordinator
itu belum punya batch maupun lelang, karena feed oracle baru bisa dieksekusi lewat
time-lock pada 1 Oktober 2026 pukul 13.45.39 UTC. Layar yang butuh isi diperiksa
di fork mainnet blok 67.798.044 untuk batch dan blok 66.491.729 untuk lelang.

---

## 1. Layar demi layar

| Layar | Yang tampil | Sumber | Jalur juri | Kode | Vonis |
|---|---|---|---|---|---|
| Semua | Jaringan, alamat kontrak, daftar token | `GET /v1/config`. Tanpa coordinator, catatan deployment testnet milik aplikasi | Alamat bisa dibuka di Blockscout | ON | Lolos. Tanpa coordinator, layar menyebut testnet dan token uji |
| Semua | Peringatan jaringan dompet | `eth_blockNumber` dari dompet dibanding blok yang dibaca aplikasi | Kedua nomor blok ditampilkan | ON | Lolos |
| Trade | Estimasi yang diterima | `GET /v1/quote`, dihitung dari state pool | Nomor blok kuotasi tampil di kartu | ON | Lolos. Kalimat yang menjanjikan batch pasti mengalahkan estimasi sudah dibuang |
| Trade | Izin Permit2 | `allowance` dibaca langsung dari token | State token | ON | Lolos |
| Trade | Daftar intent | `GET /v1/intents/:hash` untuk intent yang dikirim tab ini | Nomor batch menaut ke struk | ON | Lolos. Layar menyebut ini bukan riwayat lengkap |
| Batch | Daftar batch | `GET /v1/batches` | Tiap baris menaut ke struk | ON atau FK | Lolos. Kosong di mainnet, dan layar bilang begitu |
| Struk | Hasil, fill, rute venue, solusi, kegagalan | `GET /v1/batches/:batchId` | Tx hash di tiap bagian | ON atau FK | Lolos |
| Struk | Baseline per fill | `fills[].baselineBuy` | Lewat lantai arah di baris berikut | ON atau FK | Lolos. Labelnya sekarang menyebut bagian pro rata |
| Struk | Tombol verifikasi | `baselineFloors[].verifyFloor` | Perintah `cast` bisa ditempel | ON atau FK | **Lolos bersyarat.** Di fork perintahnya menunjuk `127.0.0.1:8545`. Syaratnya sama dengan butir 2 di bagian 6 audit backend |
| Struk | Harga kliring | Tidak ditampilkan | | | Lolos. Field API selalu kosong (N9), jadi bagiannya tidak dibuat |
| Lelang | Daftar dan buku lelang | `auctionCount()` di AuctionHouse dan `GET /v1/auctions/:id` | Alamat kontrak dan blok baca ditampilkan | ON atau FK | **Lolos bersyarat.** Di mainnet belum ada lelang. Di fork pesertanya berasal dari harness. Lihat bagian 3 |
| Sesi | Sesi aktif, jendela batch, price band | `SessionManager` di chain yang dilayani coordinator, dibaca langsung | Alamat kontrak ditampilkan | ON | Lolos. Tidak lagi terkunci ke testnet |
| Allowlist | Slot beacon, `uiMultiplier()`, supply, ukuran kode | Dibaca langsung dari chain | Nomor blok dan chain di catatan kaki | ON | Lolos |
| Netting | Kurva dan tiga angka ringkas | `GET /v1/backtest/netting-curve` | Tautan ke kueri Dune dari data | Q | Lolos. Selalu berlabel backtest |
| Landing | Tautan dashboard | Dashboard Dune `passchick` | Bisa diklik | Q | Lolos. Tidak ada angka terukur di landing |

## 2. Temuan yang diperbaiki selama audit

| Layar | Temuan | Perbaikan |
|---|---|---|
| Struk | Tombol verifikasi memakai `fill.verifyBaseline`, yang di batch rute tidak cocok dengan chain dan terbaca seperti selisih | Diganti satu tombol per arah dari `baselineFloors[].verifyFloor` |
| Struk | Label baseline fill menyebut hasil kalau menjual sendirian di venue. Itu tidak benar untuk batch rute | Label dan penjelasannya menyebut bagian dari baseline arah |
| Struk | Batch yang terisi tapi membawa `failure` tertulis tidak ada yang settle | Kalimatnya mengikuti isi fill |
| Trade | Kalimat estimasi menjanjikan batch hanya bisa lebih baik | Diganti. Estimasi bukan janji |
| Allowlist | 29,6 juta dolar dan 250 ribu trade Juli 2026 untuk penyamar GME tanpa sumber yang bisa diklik, dan kueri Juli sudah hilang | **Dipotong.** Yang tersisa hanya bacaan chain |
| Allowlist | Kartu penyamar GME memakai logo GameStop asli | Kontrak yang tidak terverifikasi hanya mendapat inisial |
| Netting | Kurva tertulis tetap di kode, titik pangsa 40 persen hilang | Ditarik dari API, sumber Dune ditampilkan dari data |
| Sesi | Membaca testnet 46630 apa pun jaringannya | Mengikuti chain yang dilayani coordinator |

## 3. Empat jebakan `rencana-uji.md` §11.3

**Lapisan agent.** Tidak ada layar, tautan, atau teks tentang agent. Lolos.

**Lelang.** Mainnet belum punya lelang dan layarnya menampilkan keadaan kosong
beserta hasil `auctionCount()`. Lelang yang berisi hanya ada di fork, dengan
komitmen dari harness. Itu boleh ditunjukkan asal disebut fork dan disebut dari
mana arusnya. Tidak ada teks yang menyiratkan closing print sudah dipakai pihak
lain. Lolos bersyarat, syaratnya ada di narasi demo dan bukan di kode.

**Placeholder.** Grep §11.3 butir 3 dijalankan ulang atas `app/src`. Di luar path
SVG, temuannya tiga. Atribut `placeholder` pada kolom jumlah, yang memang kosong.
Kata itu di dua komentar kode. Dan kurva cadangan di `netting/page.tsx`, lihat
bagian 4. Tidak ada angka tata letak yang ikut terkirim.

**Kata terukur untuk backtest.** Layar netting menulis backtest di judul, di
legenda chart, dan di angka ringkas. Kata measured hanya muncul di komentar kode.
Lolos.

## 4. Yang masih bersyarat

| Item | Kenapa | Syarat |
|---|---|---|
| Kurva cadangan netting | Sembilan baris kueri `8595303` tersalin di kode, dipakai hanya kalau coordinator tidak menjawab. Angkanya cocok dengan API | Layar harus tetap menaut ke kueri yang sama saat cadangan dipakai. Kalau tim lebih suka layar kosong, cadangan ini dihapus |
| Situs `app.nokturn.xyz` | Masih tanpa `NEXT_PUBLIC_COORDINATOR_URL`, jadi menampilkan testnet dan token uji | Variabel disetel di hosting sebelum submit |
| Struk di mainnet | Belum pernah terlihat, karena belum ada batch di sana | Dilihat ulang setelah batch pertama |
| Struk di fork | Bacaan state lama gagal setelah beberapa waktu dan API menjawab 502 | Keputusan Dharu. Layar sudah menyebut bahwa struknya tidak bisa dibaca, bukan menampilkan isi lama |
| Komitmen lelang dari dompet | Jalurnya sudah ada tapi belum pernah diklik dari dompet nyata | Dicoba di fork lelang sebelum direkam |

## 5. Yang belum diaudit

Deck, video demo, dan README belum ada. Tiap angka di sana harus melewati
pertanyaan yang sama sebelum submit, dan audit ini dijalankan ulang untuk setiap
layar yang berubah, sesuai §11.4.

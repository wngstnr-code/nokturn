# Runbook operasi backend

Cara menyalakan, mengamati, dan memulihkan stack backend Nokturn di fork mainnet.
Persiapan sekali setelah clone ada di `infra/README.md`, dan deploy kontrak ke chain
sungguhan ada di `runbook-deploy.md`. Dokumen ini tentang menjalankannya dari hari ke
hari, terutama saat demo.

Semua perintah dijalankan dari root repo lewat Git Bash atau WSL, kecuali yang ditandai
PowerShell.

---

## 1. Sebelum menyalakan

**RPC archive.** Fork butuh state di blok patokan 67.798.044. Jangkauan drpc sudah
berubah tiga kali, yaitu jendela 20 sampai 40 ribu blok pada 16 September 2026, hanya
`latest` pada 26 September, riwayat penuh pada pagi 29 September, lalu sore harinya
menolak setiap nomor blok, di mainnet maupun testnet. Pagi itu `make fork`, `deploy`,
`fund`, dan seluruh fork test jalan di atas drpc. Karena perilakunya tidak stabil,
jangan bergantung padanya. Isi `.env` di root repo, yang tidak pernah
di-commit, dengan satu baris ini.

```
NOKTURN_RPC_MAINNET=https://robinhood-mainnet.g.alchemy.com/v2/<key>
```

Aktifkan jaringan Robinhood Chain Mainnet di app Alchemy lebih dulu. Selama sekitar dua
menit setelahnya sebagian panggilan masih dijawab 403, jadi uji dulu sebelum `make fork`.

```
cast storage 0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50 --block 67798044 --rpc-url $NOKTURN_RPC_MAINNET
```

Jawaban yang benar berakhiran `e10b6f6b275de231345c20d14ab812db62151b00`.

**Key tidak boleh keluar dari `.env`.** Jangan menaruhnya di `.env.example`, yang
di-commit. Skrip `infra` kini hanya mencetak host, dan API menolak start kalau URL
bacanya membawa path tanpa `NOKTURN_API_PUBLIC_RPC`.

**Memori.** Stack Nokturn sendiri hanya sekitar 0,6 GB. Yang biasanya penuh adalah
mesin virtual Docker (WSL), Chrome, dan aplikasi lain. Kalau RAM bebas di bawah 1 GB,
proses latar belakang bisa dihentikan sistem di tengah jalan. Batasi WSL lewat
`C:\Users\<nama>\.wslconfig` berisi `[wsl2]` dan `memory=3GB`, lalu `wsl --shutdown`.

**Port database.** Bawaannya 5440 di semua tempat, yaitu `db.sh`, compose, indexer,
dan test fork indexer. Kalau 5440 juga terpakai, pindahkan keduanya bersamaan.

```
export NOKTURN_DB_PORT=5441
export NOKTURN_DATABASE_URL=postgres://nokturn:nokturn@127.0.0.1:5441/nokturn
```

---

## 2a. Satu perintah, lewat Docker

Jalan tercepat dari clone kosong. Butuh Docker Desktop yang menyala dan `.env` dari
§1. Semua layanan berjalan di container, dan urutannya dijaga compose.

```
git submodule update --init --recursive
pnpm install
make up
make demo
make down
```

`git submodule` mengambil pustaka kontrak yang dikompilasi container `deploy`.
`pnpm install` dibutuhkan karena `make demo` berjalan di host. `make up` pertama kali
membangun empat image dan mengompilasi kontrak, jadi lebih lama dari berikutnya.

**Gladi bersih 28 September 2026.** Clone kosong ke `D:/Lomba/nokturn-clean`, lalu
kelima perintah di atas diikuti harfiah, tanpa satu pun langkah manual di antara
`make up` dan `make demo`. Dari clone sampai struk pertama **11 menit**, dengan
layer image sebagian sudah ter-cache. Di dalamnya `make up` sekitar 7 menit, hampir
seluruhnya `deploy`, yaitu kompilasi 86 berkas Solidity lewat via-ir ditambah sekitar
150 transaksi pendanaan pada `--block-time 1`. Perintah `cast` dari struknya
dijalankan ulang dan hasilnya sama persis dengan `expected`. `make down` tidak
menyisakan container, volume, maupun network.
`make logs` mengikuti log semua layanan. `make down` menghapus semua container dan
volume yang dibuat stack, termasuk database.

Jangan jalankan `make up` bersamaan dengan `make fork` atau `make api`. Keduanya
memakai port yang sama, dan `make up` menolak jalan kalau fork sudah menjawab di
port 8545.

## 2. Urutan menyalakan, tanpa Docker

Urutannya penting, karena API menolak start tanpa deployment, dan solver menolak start
tanpa API.

| Langkah | Perintah | Selesai kalau |
|---|---|---|
| 1 | `make db-up` | `postgres on 127.0.0.1:5440` |
| 2 | `make fork` | `cast chain-id --rpc-url http://127.0.0.1:8545` menjawab `4663` |
| 3 | `make deploy` | `settlement at 0x…` dan `refPrice` NVDA serta AAPL `true` |
| 4 | `make fund` | `baseline unchanged, funding done`. Kalau timeout, ulangi sekali |
| 5 | `make snapshot` | `snapshot 0x…` |
| 6 | `make indexer` | `indexing 0x… from block 67798045` |
| 7 | `make api` | `GET /v1/health` menjawab keempat komponen `up` |
| 8 | `make solver` | `batch … open, session 6` |
| 9 | `make status` | Solver bonded, user punya saldo, cap per batch 5000 USD |

Fork, indexer, API, dan solver berjalan terus. Jalankan masing-masing di terminal
sendiri, atau di latar belakang dengan log ke berkas.

---

## 3. Perintah demo

Semuanya di fork, dengan penanda tangan lokal. Setiap perintah mencetak sendiri
kalimat bahwa ini bukan mainnet.

| Adegan | Perintah | Syarat |
|---|---|---|
| Tiga struk gagal | `make demo-fail CASE=passthrough`, `expired`, `unwound` | `make solver` **dimatikan**, karena skrip menyalakan solver sendiri. `expired` men-slash bond, jadi jalankan di antara `make snapshot` dan `make revert` |
| Dua solver berkompetisi | `make demo-compete`, atau dengan `ARGS="--same-side"` | `make solver` dimatikan |
| Replay arus Agustus | `make replay ARGS="--duration 5"` | `make solver` **menyala**. Speed harus 1, dan replay menolak angka lain |
| Kurva netting backtest | `curl http://127.0.0.1:3000/v1/backtest/netting-curve` | Setiap baris berlabel `BACKTEST` |

Struk yang dihasilkan tersimpan di `infra/.torture/receipt-<kasus>.json`.

---

## 4. Membaca kesehatan

`GET /v1/health` mengukur keempat komponen setiap kali dipanggil.

| Komponen | `up` | `degraded` | `down` |
|---|---|---|---|
| `rpc` | Endpoint utama menjawab | Endpoint cadangan yang menjawab, atau anggaran per menit terlampaui | Tidak ada endpoint yang menjawab |
| `indexer` | Tertinggal paling banyak 10 blok | 11 sampai 60 blok | Lebih dari 60 blok, atau database mati |
| `database` | Menjawab dalam 2 detik | | Tidak menjawab |
| `scheduler` | Tick lifecycle dalam 10 detik terakhir | 10 sampai 60 detik | Lebih lama, atau belum pernah |

---

## 5. Kalau sesuatu macet

| Gejala | Penyebab yang pernah terjadi | Tindakan |
|---|---|---|
| `make fork` gagal `failed to create genesis` | RPC tidak menyajikan state di blok patokan, atau Alchemy masih 403 setelah jaringan diaktifkan | Uji `cast storage` di §1. Tunggu dua menit kalau 403 |
| `dns error; No such host is known` di log anvil | Koneksi atau DNS laptop sempat putus | Tunggu pulih, lalu ulangi langkah yang gagal |
| Solver melihat `batch … open` tapi tidak pernah melaporkan hasilnya | Setelah `make revert`, store solver masih memuat ID batch yang dipakai ulang | Matikan solver, pindahkan `solver/.state/4663-<settlement>` ke luar repo, nyalakan lagi |
| Solver menyelesaikan batch tapi tidak ada yang tutup | Lifecycle API tidak berjalan | Lihat `scheduler` di health. Sejak 28 September 2026 lifecycle ikut turun setelah revert |
| `BlockOutOfRangeError` setelah revert | Proses lama memegang head sebelum revert | Nyalakan ulang proses itu. Cache nomor blok sudah dimatikan di API, indexer, dan solver |
| `BaselineBelowVenue` di simulasi solver | Jumlah baseline per arah di bawah lantai kontrak | Seharusnya tidak terjadi lagi sejak perbaikan N20. Kalau muncul, catat batch dan pasangannya |
| `NonceAlreadyUsed` atau `COORDINATOR_DUPLICATE_INTENT` di replay | Nonce dipakai tes yang di-revert, atau dipegang intent yang masih menunggu | Replay menanyakan nonce ke API untuk setiap intent sejak 28 September 2026 |
| Replay atau test berhenti tanpa error | Sistem menghentikannya karena RAM hampir habis | Bebaskan RAM (§1), lalu ulangi |
| API gagal start `EADDRINUSE` | API lama masih memegang port 3000 | Hentikan proses lama itu dulu |
| API gagal start karena `NOKTURN_API_RPC looks like a paid endpoint` | URL baca membawa key, dan URL publik belum diset | Isi `NOKTURN_API_PUBLIC_RPC` dengan URL yang boleh dilihat juri |

**Setelah `make revert`**, waktu chain mundur. Nyalakan ulang solver dengan store yang
bersih. Indexer dan API menyesuaikan diri sendiri.

**Setelah laptop sleep**, waktu chain melompat saat bangun dan batch yang sedang
berjalan terlewat. Anggap fork sudah tidak bisa dipakai, lalu ulangi §2 dari langkah 2.

---

## 6. Memeriksa bahwa semuanya benar

| Pemeriksaan | Perintah | Hasil terakhir, 28 September 2026 |
|---|---|---|
| Rekonsiliasi indexer ke chain | `node indexer/src/index.ts --reconcile` | 118 dari 118 cocok setelah replay |
| Batch helper dan kontrak sepakat | `make check-batch` | 41 dari 41, di clone bersih |
| Digest Permit2 | `make check-permit2` | 3 dari 3, di clone bersih |
| Semua route API | `make postman-api` | 108 dari 108, di clone bersih |
| Test fork indexer | `pnpm -C indexer test:fork` | 8 dari 8, I9 di-skip karena tidak ada event lelang |
| Test fork solver | `pnpm -C solver test:fork` | 15 dari 15 |

Test fork memakai database sendiri. Arahkan ke port yang benar lewat
`NOKTURN_DATABASE_ADMIN_URL`.

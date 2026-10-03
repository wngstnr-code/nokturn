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
| Replay atau test berhenti tanpa error | Sistem menghentikannya karena RAM hampir habis | Bebaskan RAM (§1), lalu ulangi. Batasi VM Docker lewat `%USERPROFILE%\.wslconfig` (`memory=6GB`, `swap=8GB`, lalu `wsl --shutdown`) supaya Windows tetap punya ruang saat browser berat |
| `C:\Users\<nama>\.foundry\anvil\tmp` membengkak sampai belasan GB | Anvil menulis state blok lama ke folder per sesi, dan sesi yang dimatikan atau tertidur tidak pernah menghapusnya. 17 GB dari delapan sesi, 2 Oktober 2026 | Sejak 2 Oktober 2026 `fork.sh` menyapu folder `anvil-state-*` lama saat tidak ada anvil yang hidup, dan membatasi state di disk dengan `--max-persisted-states 3600` (satu jam). Ubah lewat `NOKTURN_FORK_PERSISTED_STATES`, tapi jangan di bawah 800, jendela uji I8 |
| `fund.sh` atau skrip `.sh` lain gagal di container dengan `$'\r': command not found` | Salinan di laptop ber-line-ending CRLF meski `.gitattributes` mematok LF | Hapus file itu lalu `git checkout -- <file>`. Cek semuanya dengan `git ls-files --eol \| grep w/crlf` |
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

---

## 7. Mainnet 4663, hanya baca

Ditulis 1 Oktober 2026, sehari setelah deploy mainnet Wangsit. Semua di bawah ini
membaca chain dan tidak pernah menandatangani atau mengirim transaksi.

```bash
make db-up
make rpc-proxy            # terminal 1, RPC resmi lewat alamat IP aslinya
make mainnet-indexer      # terminal 2
make mainnet-api          # terminal 3, port 3300, jadi API fork di 3000 tetap hidup
make check-batch-mainnet  # sekali, batch.ts lawan Settlement mainnet
```

**Kenapa ada proxy.** ISP Indonesia mencegat nama `rpc.mainnet.chain.robinhood.com`,
dan Node tidak punya `--resolve`. Proxy mendengarkan di `127.0.0.1:8547` dan membuka
TLS ke `172.66.147.70` dengan nama aslinya, jadi sertifikatnya tetap diperiksa.

**Siapa memakai endpoint mana.** Alchemy free tier menolak `eth_getLogs` lebih dari 10
blok, sedangkan RPC resmi melayani 460.000 blok sekali panggil. RPC resmi hanya
menyimpan state sekitar sepuluh menit. Karena itu indexer membaca lewat proxy dengan
langkah 50.000 blok, dan API membaca lewat Alchemy dulu (struk membaca baseline di blok
lama) lalu jatuh ke proxy. Log lelang di API dibaca 10 blok sekali.

**Database sendiri.** Baris mainnet masuk ke `nokturn_mainnet`, dibuat otomatis, jadi
run fork tidak pernah bercampur dengannya.

**Diukur 1 Oktober 2026.**

| Pemeriksaan | Hasil |
|---|---|
| Indexer dari blok 75.694.415 sampai head | 22 langkah, 38 detik, 121 log. Per kontrak sama persis dengan `getLogs` langsung, Settlement 9, AuctionHouse 6, SessionManager 104, SolverRegistry 2, PriceOracle 0, AgentMandate 0 |
| `make check-batch-mainnet` | 41 dari 41, termasuk jalan 16 jam menembus 1 Oktober |
| Gerbang nol selisih `v3math` di adapter mainnet | 5 dari 5 token, dua arah, pool mainnet yang hidup |
| Beban RPC API diam | 1.052 permintaan per menit dan 429 sebelum diperbaiki, 624 tanpa error sesudahnya |
| Health | Keempat komponen `up`, lag indexer diukur dalam detik chain |
| Feed solver | Keenam token `FeedNotSet`, dilaporkan per token, nol harga |

**Yang belum bisa, dan kenapa.** Oracle mainnet belum punya feed sampai `SetFeeds`
dieksekusi, paling cepat 1 Oktober 2026 pukul 13.45.39 UTC, dengan kunci proposer
Wangsit. Sebelum itu tidak ada batch yang bisa selesai. Sesudahnya pun batch pertama
butuh tiga hal yang memakai uang sungguhan dan tidak dijalankan dari sini tanpa
keputusan tim, yaitu solver yang bond 500 USDG dan punya gas, pengguna yang menandatangani
intent dengan dana nyata, dan keeper yang membayar gas untuk lelang.

**Di-host di Railway, 1 Oktober 2026.** `https://nokturn-production.up.railway.app`,
tiga service dari repo yang sama, branch `main`. Root Directory kosong di keduanya
karena image dibangun dari root repo. RPC resmi dipakai langsung tanpa proxy, karena
pencegatan DNS hanya terjadi di ISP Indonesia.

| Service | Dockerfile | Variabel |
|---|---|---|
| api | `api/Dockerfile`, domain publik port 8080, healthcheck `/v1/health` | `NOKTURN_API_PORT=8080`, `NOKTURN_DATABASE_URL=${{Postgres.DATABASE_URL}}`, `NOKTURN_API_RPC` (RPC resmi saja sejak 2 Oktober 2026), `NOKTURN_API_PUBLIC_RPC` (RPC resmi), `NOKTURN_API_LOG_BLOCK_RANGE=2000` |
| indexer | `indexer/Dockerfile`, tanpa domain | `NOKTURN_DATABASE_URL=${{Postgres.DATABASE_URL}}`, `NOKTURN_INDEXER_RPC` (RPC resmi), `NOKTURN_INDEXER_MAX_RANGE=50000`, `NOKTURN_INDEXER_FROM_BLOCK=75694415`, `NOKTURN_INDEXER_CONFIRMATIONS=20` |
| Postgres | plugin Railway | tabelnya dibuat indexer saat start pertama |

Diperiksa setelah deploy. Keempat komponen health `up`, lag indexer 28 blok, semua route
baca menjawab 200, dan `wss://.../v1/stream` mengirim `batch.opened` serta
`batch.collect_closed` dari mainnet. Satu jebakan yang sempat terjadi,
`NOKTURN_INDEXER_MAX_RANGE=500000` membuat indexer crash berulang, karena RPC resmi
menolak 500.000 blok dan menerima 50.000.

**Diubah 2 Oktober 2026.** Key Alchemy kena batas kapasitas bulanan, jadi API kini
hanya memakai RPC resmi, dan `NOKTURN_API_LOG_BLOCK_RANGE` naik dari 10 (batas Alchemy
free tier) ke 2000. Hasil ukur di hari yang sama, semuanya dari produksi.

| Yang diukur | Sebelum | Sesudah |
|---|---|---|
| `batch.collect_closed` sesudah collect tutup | 16 sampai 43 detik, selalu lewat jendela solusi | 2,5 sampai 3,1 detik |
| Sisa jendela solusi setelah solver membaca feed | Negatif | 6,3 sampai 6,9 detik |
| Route GET mana pun | 3 sampai 11 detik | 0,2 sampai 0,6 detik |
| RPC resmi dari Railway, p50 dan p95 | Belum diukur | 76 ms dan 91 ms |

Latensi RPC kini tercatat sekali semenit di log API, baris "rpc latency over the
last minute". Cara membacanya `railway logs --service nokturn`. Dari laptop di
Indonesia, RPC yang sama butuh 1,5 sampai 2 detik per panggilan, diukur dengan `curl`
langsung, sementara koneksi dan TLS-nya hanya sekitar 140 ms. Karena itu solver
sebaiknya berjalan dekat RPC, bukan di laptop. Indexer berhenti crash setelah rate
limit RPC resmi tidak lagi dibaca sebagai penolakan rentang.

Tiga batasan yang masih berlaku. RPC publik hanya menyimpan sekitar sepuluh menit
riwayat untuk `eth_call`, jadi perintah `cast --block` di struk hanya bisa dicek
selama itu (`audit-provenansi-backend.md` §5c). Fork dan job fork malam di CI butuh
RPC archive, jadi keduanya berhenti sampai Alchemy pulih atau ada penyedia lain.
Dan saat Railway berganti deploy, dua instance API sempat berjalan bersamaan dan RPC
resmi menjawab beberapa permintaan dengan "Too Many Requests". Tick yang gagal
diulang di poll berikutnya.

**Kunci solver di mainnet.** Di chain yang bukan fork, solver dan keeper menolak
mnemonic repo, karena mnemonic itu publik. Kuncinya dari `NOKTURN_SOLVER_PRIVATE_KEY`,
dan kunci milik akun di `infra/accounts.json` ditolak. Preflight menyebut alamat
SolverRegistry dan jumlah bond serta gas yang dibutuhkan, dihitung dari harga gas saat
itu. Pada 0,022 gwei itu 0,016 ETH untuk tiga jam.

## 8. Testnet 46630, untuk testnet.nokturn.xyz

Ditulis 3 Oktober 2026, hari yang sama dengan gladi testnet ketujuh. Fixture angkatan
ketiga mencermin harga Chainlink mainnet dan pool-nya bisa swap, jadi batch di 46630
bisa benar-benar settle (`parameter.md` §10.6). Bagian ini menyiapkan backend untuk
situs testnet publik. Tokennya token uji, dan setiap layar harus menyebutnya begitu.

**Satu image, dua chain.** API, indexer, dan solver memilih chain dari jawaban RPC,
bukan dari flag. Ketiga image sekarang memanggang catatan 4663 dan 46630, jadi
environment testnet di Railway memakai Dockerfile yang sama dengan production.

| Service | Dockerfile | Variabel di environment `testnet` |
|---|---|---|
| api | `api/Dockerfile`, domain `api-testnet.nokturn.xyz` port 8080 | `NOKTURN_API_PORT=8080`, `NOKTURN_DATABASE_URL=${{Postgres.DATABASE_URL}}`, `NOKTURN_API_RPC` dan `NOKTURN_API_PUBLIC_RPC` ke `https://rpc.testnet.chain.robinhood.com`, `NOKTURN_API_LOG_BLOCK_RANGE=2000`, `NOKTURN_EXPLORER=https://explorer.testnet.chain.robinhood.com` |
| indexer | `indexer/Dockerfile`, tanpa domain | `NOKTURN_DATABASE_URL=${{Postgres.DATABASE_URL}}`, `NOKTURN_INDEXER_RPC` ke RPC resmi testnet, `NOKTURN_INDEXER_MAX_RANGE=50000`, `NOKTURN_INDEXER_FROM_BLOCK=128002702`, `NOKTURN_INDEXER_CONFIRMATIONS=20` |
| Postgres | plugin Railway, terpisah dari production | |
| mirror | `infra/mirror/Dockerfile`, tanpa domain | `NOKTURN_MIRROR_KEYSTORE` (keystore `nokturn-testnet`, base64), `NOKTURN_MIRROR_PASSWORD` |
| solver | `solver/Dockerfile`, tanpa domain, volume di `/app/solver/.state` | `NOKTURN_SOLVER_RPC` ke RPC resmi testnet, `NOKTURN_API_URL=https://api-testnet.nokturn.xyz`, `NOKTURN_SOLVER_PRIVATE_KEY` (kunci testnet) |
| keeper | `solver/Dockerfile`, start command `node solver/src/keeper.ts --profile b` | `NOKTURN_SOLVER_RPC`, `NOKTURN_SOLVER_B_PRIVATE_KEY` (kunci testnet kedua) |

`NOKTURN_EXPLORER` wajib diisi, karena default-nya Blockscout mainnet.

**Diukur 3 Oktober 2026.**

| Pemeriksaan | Hasil |
|---|---|
| `Settlement` testnet dibuat | Blok 128.002.702, 06.53.38 UTC, dibaca dari Blockscout testnet. Itu `FROM_BLOCK` di atas |
| `eth_getLogs` RPC resmi testnet, 50.000 blok | Diterima, 343 ms |
| `eth_getLogs` RPC resmi testnet, 500.000 blok | Diterima, 312 ms. Mainnet menolak rentang ini, jadi 50.000 tetap dipakai supaya kedua environment sama |
| State di blok deploy, sekitar enam jam kemudian | Ditolak, `historical state ... is not available`. Sama seperti mainnet, perintah `cast --block` di struk testnet hanya bisa dicek beberapa menit |
| Kelima token fixture di `AuctionHouse.auctionTokenAllowed` | `true` semua |
| `minBond` SolverRegistry dan bond cross AuctionHouse | 500 tQUOTE masing-masing |
| Saldo kunci `nokturn-testnet` | 0,00597 ETH testnet. Di mainnet 0 ETH dan 0 USDG |

**Relayer.** `MirrorFeed.operator` immutable, jadi hanya kunci `nokturn-testnet` yang
bisa mendorong round. Kunci itu juga deployer testnet. Feed beku di akhir pekan
karena feed mainnet beku, jadi relayer harus sudah jalan sebelum Chainlink mainnet
mengeluarkan round lagi di awal pekan. Begitu ada round yang tidak tersalin, oracle
testnet stale dan batch gagal. Relayer membaca mainnet lewat drpc, yang masih
melayani `latest`, supaya beban itu tidak menambah rate limit RPC resmi mainnet yang
dipakai API production.

Biaya satu pass yang mendorong keenam feed dan lima `sync` kira kira satu juta gas,
sekitar 0,00001 ETH pada 0,01 gwei. Berapa lama saldo bertahan tergantung seberapa
sering mainnet mengeluarkan round, dan itu diukur di hari kerja pertama.

**Solver dan keeper.** Dua kunci baru, terpisah dari kunci mainnet. Bond dari laptop
cukup sekali per kunci.

```bash
NOKTURN_TESTNET_RPC=<endpoint yang menjangkau 46630> bash infra/scripts/testnet.sh bond     # solver
NOKTURN_TESTNET_RPC=<endpoint yang menjangkau 46630> bash infra/scripts/testnet.sh bond b   # keeper
```

Script mencetak tQUOTE yang kurang lewat `mint` yang terbuka, lalu approve dan bond.
Keeper dicetakkan bond solver plus empat bond cross, karena keeper meng-approve empat
sekaligus. Kunci testnet yang sama dengan kunci mainnet ditolak. Gas ETH testnet harus
sudah ada di kedua alamat.

Volume `.state` untuk solver bukan hiasan. Store menyimpan solusi yang sudah disubmit
supaya restart tetap mem-finalize-nya. Tanpa volume, deploy ulang di tengah jendela
finalize membuang catatan itu.

**Tiga hal yang diperbaiki supaya testnet bisa jalan.** Solver menaruh alamat USDG
mainnet di indeks kuota pada setiap chain, padahal di 46630 alamat itu tidak punya
kode, jadi tidak ada solusi testnet yang bisa lolos verifikasi. Keeper membaca daftar
token mainnet dari `infra/chain.json` dan berhenti karena tidak ada token yang
diizinkan. API menulis `USDG` dan `NVDA` di samping token uji. Ketiganya sekarang
mengikuti catatan chain, dan di testnet simbolnya `tQUOTE`, `tNVDA`, dan seterusnya.

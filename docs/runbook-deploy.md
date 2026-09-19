# Runbook deploy

Ditulis 19 September 2026. Berlaku untuk testnet 46630 dan mainnet 4663 dengan
perintah yang sama, hanya endpoint dan chain id yang berbeda.

## Sebelum apa pun

Isi `.env` dari `.env.example`. Tiga nilai yang wajib ada.

- `NOKTURN_TREASURY`, tujuan fee protokol, bond yang disita, dan debu cross.
- `NOKTURN_TIMELOCK_PROPOSERS`, dipisah koma tanpa spasi. Proposer sekaligus canceller.
- `NOKTURN_TIMELOCK_EXECUTORS`, dipisah koma tanpa spasi.

**Tidak ada private key di `.env`, dan tidak akan pernah ada.** Penandatanganan
lewat `--account <nama>` dari `cast wallet` atau `--ledger`. Alamat yang dipakai
untuk menandatangani harus ada di kedua daftar di atas, karena menjadwalkan lalu
mengeksekusi batch pada delay nol adalah satu orang melakukan dua hal.

Keputusan siapa proposer dan eksekutor diambil **sebelum** deploy pertama.
`governor` immutable di setiap kontrak, jadi tidak ada penyerahan setelahnya.

## Tiga langkah

```bash
cd contracts
export RPC=$NOKTURN_RPC_MAINNET   # atau NOKTURN_RPC_TESTNET

forge script script/Deploy.s.sol:Deploy --rpc-url $RPC --account nokturn --broadcast
forge script script/Bootstrap.s.sol:Bootstrap --rpc-url $RPC --account nokturn --broadcast
forge script script/Lock.s.sol:Lock --rpc-url $RPC --account nokturn --broadcast
```

**Langkah satu** menaruh kontrak di rantai dan menulis alamatnya ke
`deployments/<chain id>.json`. Timelock lahir dengan delay nol.

**Langkah dua** mengirim kalender, wiring, dan allowlist sebagai satu batch. Ia
menolak jalan kalau jendela bootstrap sudah tertutup, dan menolak memasukkan token
yang gagal gerbang beacon dan multiplier.

**Langkah tiga** menaikkan delay ke 48 jam. Setelah ini tidak ada yang berubah
tanpa dua hari pemberitahuan yang bisa diawasi siapa pun, termasuk delay-nya
sendiri. Jalankan `deployments/<chain id>.json` melalui langkah ini di hari yang
sama, jangan ditunda.

## Verifikasi

```bash
./tools/verify.sh 4663
```

Lewat Sourcify, bukan Blockscout. Domain Blockscout dicegat DNS ISP Indonesia, dan
per 19 September 2026 origin di balik workaround `--resolve` menjawab tantangan
Cloudflare alih-alih API-nya, jadi `forge verify-contract` ke sana tidak bisa
dipakai sama sekali. Sourcify mendaftarkan kedua chain sebagai didukung, tembus
tanpa workaround, dan Blockscout membaca Sourcify.

Argumen konstruktor dibaca dari catatan deploy, bukan ditebak. Tebakan gagal persis
di kontrak yang argumennya tidak biasa.

Satu hal yang perlu diketahui di muka. `foundry.toml` menyetel `bytecode_hash` ke
`none` dan mematikan CBOR metadata, jadi bytecode yang ter-deploy tidak membawa
trailer metadata. Verifier yang mengompilasi ulang menghasilkan byte yang sama,
dan itu kecocokan yang penting, tapi tidak ada hash metadata untuk dibandingkan.
Sourcify mencatatnya sebagai `match`, bukan `exact_match`.

## Yang sengaja belum dikerjakan script ini

**Feed harga.** `parameter.md` §7.1 melarang mengunci `PriceOracle` sebelum keluarga
feed dan staleness diputuskan, karena cadence September membuat angka Juli melempar
NVDA ke `PROTECTIVE` di sesi paling ramai. Itu P6-1. Ada test yang memastikan oracle
masih kosong setelah bootstrap, supaya ia tidak bisa terkonfigurasi tanpa sengaja.

Setelah P6-1 terjawab, feed masuk lewat proposal timelock biasa, dengan delay 48 jam
yang sudah berlaku. Itu memang jumlah pengawasan yang pantas untuk angka yang jadi
dasar harga seluruh protokol.

**Closing print feed per token.** Satu kontrak per token, dipasang saat token itu
benar-benar butuh permukaan Chainlink. Bukan bagian dari deploy inti.

## Gerbang sebelum mainnet

`rencana-uji.md` §10 adalah daftarnya, dan deploy mainnet hanya jalan kalau semuanya
hijau. Per hari ini enam dari empat belas tercentang. Testnet 46630 tidak menunggu
itu, karena ia gladi resik dan tokennya token uji. Sebut begitu apa adanya.

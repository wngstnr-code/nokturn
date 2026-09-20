# api

Coordinator API. Dimiliki Dharu, `docs/pembagian-tugas.md` §3.

Skemanya di `packages/shared/api-types.ts` dan **dibekukan**. Bentuk respons
tidak berubah tanpa diumumkan di standup.

## Menjalankannya

```bash
make fork      # terminal 1, biarkan hidup
make deploy    # sekali
make fund      # sekali
make api       # terminal 2
```

API menolak start kalau fork mati atau belum ada `infra/fork-deployment.json`.
Server yang tetap start lalu menjawab lima ratus di setiap permintaan terlihat
sehat bagi yang menjalankannya, dan itu setengah jam yang hilang.

## Tujuh rute nyata, enam belum

Pembagiannya tegas dan tidak ada yang di tengah. Sebuah rute menjawab data
sungguhan dari rantai, atau menolak menjawab. Tidak ada yang mengarang angka
supaya layar terlihat penuh, karena itu persis pelanggaran aturan 9 `CLAUDE.md`
yang pernah menjatuhkan proyek ini.

| Rute | Keadaan | Bacanya dari |
|---|---|---|
| `GET /v1/health` | nyata | RPC, dan jujur bahwa indexer mati |
| `GET /v1/config` | nyata | Settlement, Permit2, allowlist |
| `GET /v1/session` | nyata | SessionManager |
| `GET /v1/batches/current` | nyata | SessionManager lewat `packages/shared/batch.ts` |
| `GET /v1/allowlist` | nyata | slot beacon ERC-1967 dan `uiMultiplier()` |
| `GET /v1/quote` | nyata | `UniswapV3Adapter.quoteFromState` |
| `GET /v1/solvers` | nyata | SolverRegistry |
| `POST /v1/intents` | **503** | butuh coordinator |
| `GET /v1/intents/:hash` | **503** | butuh coordinator |
| `GET /v1/batches` | **503** | butuh indexer |
| `GET /v1/batches/:batchId` | **503** | butuh indexer |
| `GET /v1/auctions/:id` | **503** | butuh lelang yang sungguh dibuka |
| `WS /v1/stream` | **503** | butuh siklus hidup batch |

Yang 503 menjawab dengan bentuk `ApiError` yang sudah beku, bukan 404, dan
menyebut apa yang masih ditunggu. Rutenya ada, dia cuma belum bisa menjawab.

## Tiga hal yang dikerjakan rute ini dan mungkin tidak terduga

**`/v1/config` membaca tiga nilai EIP-712 dari rantai, tidak menyalinnya.**
Permit2 membangun ulang domain separator-nya begitu chain id bukan chain tempat
dia di-deploy, dan alamat Settlement berbeda di fork, di 46630, dan di mainnet.
Konstanta yang disalin benar di satu chain dan salah diam-diam di dua sisanya,
dan gejalanya tanda tangan yang ditolak tanpa penjelasan.

**`/v1/allowlist` menerima `?token=0x...` apa pun.** Alamat memecoin yang
bersimbol GME tidak ditulis di kode. Kalau ditulis, layarnya jadi panggung, bukan
gerbang yang bekerja. Panggil dengan alamat itu dan dia ditolak dengan ketiga
pemeriksaan gagal, di sebelah GME asli yang lolos dengan simbol yang sama persis.

**`/v1/quote` memanggil adapter, bukan menghitung ulang.** Gerbangnya nol selisih
terhadap `quoteFromState`, dan memanggil kontrak yang sama membuat selisihnya nol
secara konstruksi. Kalau adapter revert, itu jawaban sungguhan yang diteruskan
dengan nama error venue-nya, bukan kegagalan endpoint.

## Provenansi ikut di setiap angka

Tiap respons yang memuat angka membawa `provenance` berisi chain id, nomor blok,
timestamp, dan dari mana asalnya. Varian `fork` menyebut blok yang dipatok,
varian `testnet` membawa kalimat bahwa tokennya token uji.

`/v1/quote` juga membawa `verify`, yaitu perintah `cast` siap tempel lengkap
dengan `--block`, plus `expected` berisi angka yang kita publikasikan. Siapa pun
bisa menempelnya dan mendapat angka yang sama. Ini isi tombol salin di struk,
`docs/demo.md` §2.

## Mengujinya

```bash
make postman       # regenerate ketiga koleksi
make postman-api   # 17 permintaan, 98 assertion
```

Koleksi API membaca alamat token dari server yang sedang hidup, bukan dari
berkas, jadi dia tidak bisa menyimpang dari deployment yang benar-benar ditunjuk
server itu.

Yang diperiksanya, selain bahwa tiap rute menjawab:

- tiap angka yang diterbitkan membawa provenansi dengan nomor blok
- `witnessTypeString` memang witness Permit2, bukan Intent telanjang
- `spender` sama dengan alamat Settlement
- kelima token asli lolos gerbang, memecoin-nya ditolak, keduanya bersimbol GME
- `verify.expected` sama dengan `baselineBuy` yang diterbitkan
- keenam rute 503 tidak membawa muatan data apa pun

## Satu bug yang ditemukan koleksi itu

`POST` dengan `content-type: application/json` dan badan kosong, yaitu cara tiap
klien HTTP menyentuh rute, dianggap Fastify sebagai kegagalan parse. Errornya
lolos ke penangan umum dan keluar sebagai 502, sehingga stub terlihat seperti
upstream yang rusak. Sekarang badan kosong diterima dan badan yang rusak menjawab
400.

## Konfigurasi

| Variabel | Default |
|---|---|
| `NOKTURN_API_RPC` | `http://127.0.0.1:8545` |
| `NOKTURN_API_HOST` | `127.0.0.1` |
| `NOKTURN_API_PORT` | `3000` |
| `NOKTURN_EXPLORER` | `https://robinhoodchain.blockscout.com` |
| `NOKTURN_API_LOG_LEVEL` | `info` |

Jaringan tidak disetel lewat variabel. API menanyakannya ke node, karena fork
melaporkan chain id yang di-fork-nya sehingga chain id sendiri tidak bisa
membedakan keduanya, dan struk yang menulis mainnet padahal fork adalah persis
kegagalan provenansi yang dicegah seluruh skema ini.

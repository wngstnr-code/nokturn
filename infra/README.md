# infra

Fork mainnet 4663 lokal, deploy Nokturn ke atasnya, dan alat untuk memeriksa
hasilnya. Dimiliki Dharu, `docs/pembagian-tugas.md` §3.

Rencana lengkap dan daftar fitur F1 sampai F32 ada di `docs/rencana-backend.md`.

## Sekali saja, setelah clone

```bash
pnpm install --dir infra
cp ../.env.example ../.env   # satu berkas env untuk seluruh repo
```

`.env` tidak perlu diisi untuk fork lokal. Nilai defaultnya sudah menunjuk ke
endpoint yang tembus dari Indonesia.

## Lima perintah, dari nol sampai bisa dites

Jalankan di dua terminal, satu untuk `make fork` yang dibiarkan hidup dan satu
untuk sisanya.

```bash
make pin       # ukur head, patok blok, tulis infra/pinned-block.json
make fork      # anvil di depan, biarkan jalan
make deploy    # Deploy, Bootstrap, SetFeeds ke fork itu
make fund      # token nyata ke akun demo, approve Permit2, bond dua solver
make snapshot  # titik balik untuk mengulang adegan demo
make status    # satu layar isi keadaan fork
```

`make pin` hanya dijalankan ulang kalau tim sepakat memindahkan bloknya. Blok
fork adalah titik sinkronisasi 6, jadi ketiganya membaca angka yang sama dari
`infra/pinned-block.json` yang ikut di-commit.

## Kenapa chain id-nya tetap 4663

`SetFeeds.s.sol` menolak chain apa pun selain 4663, karena hanya mainnet yang
punya proxy Chainlink. Tanpa feed, `PriceOracle.refPrice` menjawab tidak sehat
dan setiap solusi revert dengan `OracleUnhealthy`. Jadi fork yang tidak bisa
menjalankan `SetFeeds` adalah fork yang tidak bisa menyelesaikan satu batch pun.

Akibatnya `Deploy.s.sol` menulis ke `contracts/deployments/4663.json`, yaitu
jalur yang sama dengan catatan mainnet sungguhan. `deploy.sh` menolak jalan kalau
berkas itu sudah ter-commit, dan memindahkannya ke `infra/fork-deployment.json`
begitu urutannya selesai. Backend membaca yang di `infra/`.

## Urutan deploy berbeda satu langkah dari runbook, dan itu disengaja

Di mainnet `SetFeeds` berjalan dua hari setelah `Lock`, lewat delay 48 jam penuh.
Di sini ia berjalan sebelum `Lock`, saat delay masih nol, karena fork tidak bisa
menunggu dua hari. `make lock` ada sebagai target terpisah dan tidak ikut
`make deploy`, sebab menaikkan delay akan membekukan setiap parameter yang masih
perlu digeser selama pengembangan.

Ini bukan jalan pintas menembus gerbang yang melindungi dana. Delay timelock
melindungi pengguna mainnet, dan rantai ini tidak punya pengguna.

## Dari mana token demo datang

`make fund` memindahkan token keluar dari pool Uniswap V3 masing-masing pasangan,
lewat impersonation. Transfer ERC20 biasa keluar dari pool V3 menggeser saldo
pool dan tidak menyentuh `slot0` maupun `liquidity`, jadi `quoteFromState`
menjawab angka yang sama persis sebelum dan sesudah. `fund.mjs` membandingkan
kuotasi sebelum dan sesudah lalu gagal kalau angkanya bergeser, jadi sifat itu
tidak perlu dipercaya begitu saja.

Ganti sumbernya dengan alamat pemegang nyata lewat `NOKTURN_FUNDING_SOURCE`
kalau tim lebih suka begitu.

## Reset, dan kenapa bukan lewat snapshot state

```bash
make snapshot   # ambil evm_snapshot
make revert     # kembalikan ke sana, lalu ambil snapshot baru otomatis
```

Ini reset yang benar-benar bekerja di atas fork, dan ia yang dipakai demo untuk
mengulang adegan tanpa mendeploy ulang apa pun.

**`anvil --dump-state` tidak bisa dipakai untuk itu, dan sudah diuji.** Diukur
20 September 2026. Fork mengambil state secara malas, dan dump-nya tidak memuat
semua slot yang pernah diambil. Setelah `--load-state`, `slot0` sebuah pool
kembali dengan benar sementara `liquidity()` dan `tickBitmap` kembali nol,
sehingga `quoteFromState` revert dengan `LiquidityExhausted`. Jalur TWAP juga
butuh seluruh array `observations`, yaitu 6.000 entri untuk NVDA, dan itu tidak
bisa disalin slot demi slot. Jadi tidak ada mode offline, dan jangan dibuat.

Asuransi kalau endpoint mati saat demo bukan snapshot berkas, melainkan tiga hal
lain. Blok yang dipatok, kedalaman arsip yang sudah diukur di
`docs/rencana-backend.md` §3, dan anvil yang tidak dimatikan selama demo
berlangsung.

## Prewarm

```bash
make prewarm
```

Menarik state yang dibaca demo ke dalam cache fork, yaitu kelima pool di enam
ukuran kuotasi, kelima feed, dan kode setiap kontrak. Gunanya menghindari
demo yang tersendat di panggilan dingin pertama, bukan menyiapkan mode offline.

Satu kegagalan di `prewarm` memang diharapkan. Kuotasi GME pada 100.000 USDG
revert, karena pool itu tidak bisa menyerapnya dari state. Itu jawaban yang
benar, dan ia adalah kasus pass-through deterministik untuk layar batch gagal di
`docs/demo.md` §3.

## Cara mengujinya

Tiga lapis, dari yang paling cepat.

### 1. `make status`

Satu layar. Sesi sekarang, durasi batch, price band, jendela batch berikutnya,
allowlist, harga oracle per token dengan umurnya, kuotasi baseline per token, dan
saldo tiap akun demo lengkap dengan status approve Permit2. Ini yang dijalankan
duluan setiap kali ada yang aneh, dan ini yang ditempel ke standup.

### 2. Postman

```bash
make postman       # regenerate dari deployment yang hidup
make postman-run   # jalankan headless dengan newman
```

Koleksinya **digenerate dan tidak di-commit**, karena alamat Settlement berbeda
setelah setiap `make deploy`, dan koleksi beralamat basi gagal dengan cara yang
terlihat seperti rantai rusak. Yang ikut ke repo adalah generatornya. Jalankan
`make postman` lagi setiap habis deploy, termasuk setelah clone.

Di Postman, impor dua berkas dari `infra/postman/`, yaitu koleksi dan
environment, lalu pilih environment **Nokturn local fork**. Tekan Run.

Sembilan belas permintaan, lima puluh lima assertion. Semuanya JSON-RPC biasa ke
`http://127.0.0.1:8545`, jadi tidak ada server yang perlu hidup selain anvil.
Yang dibuktikan kalau semuanya hijau:

| Permintaan | Yang dijawabnya |
|---|---|
| chain id, block number, kode Settlement | fork hidup dan Nokturn ada di atasnya |
| `currentSession`, `batchDuration`, `maxDeviationBps` | kalender dan tabel DST termuat |
| `tokenAllowed`, `baselineAdapter`, `capPerBatchUsd` | Bootstrap berjalan tuntas |
| `refPrice` sehat | `SetFeeds` berjalan, dan batch bisa settle sama sekali |
| `quoteFromState` di dua ukuran | baseline hidup, dan cekung terhadap ukuran |
| kuotasi GME 100k revert | adapter gagal tertutup, bukan menebak |
| `isActive` solver, saldo, allowance Permit2 | `make fund` berjalan |
| `DOMAIN_SEPARATOR`, `WITNESS_TYPE_STRING` | dua nilai yang wajib dibaca dari rantai, bukan disalin |

Dua yang terakhir layak diperhatikan. Permit2 membangun ulang domain
separator-nya ketika chain id bukan chain tempat ia di-deploy, dan
`WITNESS_TYPE_STRING` adalah string yang masuk ke tanda tangan pengguna.
Menyalin keduanya ke konstanta adalah cara paling umum membuat tanda tangan
berhenti terverifikasi. Koleksi ini menyimpan keduanya ke variabel koleksi supaya
terlihat nilainya.

### 3. JSON-RPC manual

Postman menembak `http://127.0.0.1:8545` dengan `POST` dan body JSON-RPC biasa.
Bentuknya selalu sama.

```json
{ "jsonrpc": "2.0", "id": 1, "method": "eth_call",
  "params": [{ "to": "{{settlement}}", "data": "0x..." }, "latest"] }
```

`data` dibuat dengan `cast calldata`, dan jawabannya dibaca dengan
`cast abi-decode`. Contoh untuk memeriksa allowlist sebuah token:

```bash
cast calldata "tokenAllowed(address)" 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
```

Kalau lebih suka tidak lewat Postman sama sekali, `cast call` melakukan keduanya
sekaligus.

```bash
cast call $SETTLEMENT "tokenAllowed(address)(bool)" $NVDA --rpc-url http://127.0.0.1:8545
```

### Yang belum bisa diuji hari ini

Endpoint coordinator di `packages/shared/api-types.ts` belum punya server.
Skemanya dibekukan hari ini supaya Nabil bisa coding terhadapnya, dan koleksi
Postman keduanya dibuat begitu server itu ada di hari 2. Sampai saat itu,
endpoint apa pun yang dipanggil akan menjawab `COORDINATOR_NOT_IMPLEMENTED`
dengan bentuk `ApiError` yang sudah ditetapkan, bukan 404 kosong.

## Berkas

| Berkas | Di-commit | Isinya |
|---|---|---|
| `pinned-block.json` | ya | blok fork, titik sinkronisasi 6 |
| `accounts.json` | ya | akun bawaan anvil dan perannya |
| `chain.json` | tidak | digenerate dari `contracts/script/Addresses.sol` |
| `fork-deployment.json` | tidak | alamat hasil deploy ke fork |
| `.snapshot-id` | tidak | id evm_snapshot terakhir |
| `postman/` | tidak | keluaran `make postman`, alamatnya beda di tiap laptop |
| `scripts/postman.mjs` | ya | generatornya, ini yang dipakai bersama |

`chain.json` digenerate karena `packages/shared/addresses.ts` sudah pernah
menyimpang dari `Addresses.sol`. Berkas itu memuat empat token sementara kontrak
memuat lima, dan alamat pool GME-nya berbeda. `Addresses.sol` adalah yang
benar-benar dijalankan deploy, jadi itu yang jadi sumber di sini.

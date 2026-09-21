# Runbook deploy

Ditulis 19 September 2026. Berlaku untuk testnet 46630 dan mainnet 4663 dengan
perintah yang sama, hanya endpoint dan chain id yang berbeda.

## Sebelum apa pun

**Muat `.env` ke shell dulu.** Ia ada di root repo, bukan di `contracts/`, jadi forge
tidak menemukannya sendiri saat dijalankan dari sana. Tanpa ini `--rpc-url
$NOKTURN_RPC_TESTNET` berangkat kosong dan forge menolak dengan pesan tentang nilai
yang kurang, bukan tentang env.

```bash
cd contracts
set -a; . ../.env; set +a
```

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

## Nol, hanya di testnet

Chain 46630 tidak punya USDG kanonik, Stock Token, maupun pool Uniswap V3. Umpannya
dipasang lebih dulu, sekali saja, dan alamatnya sudah jadi konstanta di
`script/Addresses.sol` lewat `parameter.md` §10.6. Langkah ini tidak diulang kecuali
umpannya diganti.

```bash
forge script script/testnet/DeployTestnetFixtures.s.sol:DeployTestnetFixtures \
  --rpc-url $NOKTURN_RPC_TESTNET --account nokturn-testnet --broadcast
```

Script ini menolak jalan di chain selain 46630.

### Umpannya diganti seluruhnya, 20 September 2026

GME masuk allowlist, jadi umpannya jadi lima. Seluruh set dipasang ulang, bukan
ditambah satu, karena token kuota dan keempat token lama tidak punya alasan untuk
dipertahankan dan satu set yang lahir bersama lebih gampang dipercaya daripada
campuran dua angkatan.

Dijalankan 20 September 2026. Sebelas kontrak, **6.364.366 gas, 0,00006364 ETH**.
Perkiraan script 8.475.212, jadi pemakaian sebenarnya 75% dari perkiraan.
Alamatnya di `parameter.md` §10.6 dan sudah jadi konstanta.

Urutannya dua tahap, dan tahap pertama harus selesai sebelum tahap kedua ditulis.
Tahap satu menjalankan perintah di atas, yang mencetak sebelas alamat dan menulis
`deployments/46630-fixtures.json`. Tahap dua memindahkan kesebelas alamat itu ke
`parameter.md` §10.6 lalu ke `script/Addresses.sol`, dan menaikkan cabang testnet
`allowlist()` serta `pools()` dari empat ke lima.

Alasan urutannya begitu, konstanta alamat nol yang menunggu diisi adalah jebakan yang
lolos kompilasi. Selama tahap satu belum jalan, cabang testnet tetap empat dan tetap
benar.

Satu langkah verifikasi yang layak diulang tiap kali. Kesebelas alamat dibaca ulang
dari chain, bukan disalin dari keluaran script, dan konstantanya dicocokkan kembali
ke `deployments/46630-fixtures.json`. Menyalin sebelas alamat dengan tangan adalah
persis bentuk kesalahan yang tidak akan revert di mana pun.

## Tiga langkah inti

```bash
cd contracts
export RPC=$NOKTURN_RPC_MAINNET   # atau NOKTURN_RPC_TESTNET

forge script script/Deploy.s.sol:Deploy --rpc-url $RPC --account <deployer> --broadcast
forge script script/Bootstrap.s.sol:Bootstrap --rpc-url $RPC --account <proposer> --broadcast
forge script script/Lock.s.sol:Lock --rpc-url $RPC --account <proposer> --broadcast
```

Kunci gladi resik testnet terpisah dari kunci mainnet, karena yang pertama diketik ke
faucet dan dipakai di rantai publik.

### Dua kunci, bukan satu, dan mana yang menandatangani apa

Ditemukan 20 September 2026 pada gladi resik ketiga, saat deployer dan proposer
dipisah untuk pertama kalinya. Sebelum itu keduanya alamat yang sama dan pembagian
ini tidak pernah terlihat.

| Langkah | Ditandatangani | Kenapa |
|---|---|---|
| `Deploy` | deployer | hanya mengirim `CREATE`, tidak menyentuh timelock |
| `Bootstrap` | **proposer** | `scheduleBatch` lalu `executeBatch` di timelock |
| `Lock` | **proposer** | menaikkan `minDelay` hanya bisa lewat timelock sendiri |
| `SetFeeds` | **proposer** | sama |

Menjalankan `Bootstrap` dengan kunci deployer gagal dengan
`AccessControlUnauthorizedAccount`, dan gagalnya setelah `Deploy` sudah membakar gas.
Konsekuensi anggarannya berlawanan dengan dugaan. **Proposer yang butuh gas paling
banyak**, bukan deployer, karena tiga dari empat langkah adalah miliknya.

Isi kedua alamat sebelum mulai. Kalau proposer lupa diisi, kirim dari deployer dengan
`cast send <proposer> --value <jumlah> --account <deployer> --rpc-url $RPC`.

### Simulasikan keempat langkah, bukan hanya yang pertama

Aturan yang lahir dari kegagalan di atas. `Deploy` lolos simulasi dan tiga langkah
sisanya tidak pernah disimulasikan, jadi masalah perannya baru muncul saat broadcast.
Jalankan tiap langkah tanpa `--broadcast` lebih dulu, dengan `--sender` disetel ke
alamat yang akan benar-benar menandatanganinya.

```bash
forge script script/Bootstrap.s.sol:Bootstrap --rpc-url $RPC --sender <alamat proposer>
```

Simulasi tidak menyentuh `deployments/<chain id>.json` sejak 20 September 2026, jadi
menjalankannya terhadap rantai yang sudah berisi deployment aman.

**Langkah satu** menaruh kontrak di rantai dan menulis alamatnya ke
`deployments/<chain id>.json`. Timelock lahir dengan delay nol.

**Langkah dua** mengirim kalender, wiring, dan allowlist sebagai satu batch. Ia
menolak jalan kalau jendela bootstrap sudah tertutup, dan menolak memasukkan token
yang gagal gerbang beacon dan multiplier.

**Langkah tiga** menaikkan delay ke 48 jam. Setelah ini tidak ada yang berubah
tanpa dua hari pemberitahuan yang bisa diawasi siapa pun, termasuk delay-nya
sendiri. Jalankan `deployments/<chain id>.json` melalui langkah ini di hari yang
sama, jangan ditunda.

## Langkah empat, sumber harga, dua hari setelahnya

```bash
forge script script/SetFeeds.s.sol:SetFeeds --rpc-url $RPC --account nokturn --broadcast
```

Feed sengaja tidak ikut `Bootstrap`. Bootstrap berjalan saat delay masih nol, dan
angka yang jadi dasar harga seluruh protokol tidak pantas bisa disetel dalam satu
blok oleh siapa pun yang memegang kunci deploy. `parameter.md` §7.1 menahannya
sampai P6-1 terjawab, dan P6-1 terjawab 19 September 2026 dengan keluarga feed `RH`
serta ambang p99 per feed.

**Jalankan dua kali.** Panggilan pertama menjadwalkan dan mencetak kapan ia bisa
dieksekusi. Panggilan kedua, setelah 48 jam lewat, mengeksekusinya. Tidak ada flag
untuk melewati tunggu itu, karena script yang bisa disuruh melewatinya akan disuruh
melewatinya.

Satu batch memuat delapan panggilan, yaitu satu feed dan satu sumber TWAP untuk tiap
token allowlist. Keduanya berangkat bersama. Oracle yang punya feed tanpa TWAP tidak
punya pendapat kedua di hari kerja dan tidak punya harga sama sekali di akhir pekan,
dan itu satu-satunya bentuk yang tidak bisa dilewati §7.3.

Script ini menolak jalan di chain selain 4663, karena 46630 tidak punya feed
Chainlink sama sekali.

Kedua allowlist sekarang sama panjang, lima token, sejak umpan `tGME` dipasang
20 September 2026. Sebelum itu gladi resik menguji bentuk batch yang sama dengan satu
token lebih sedikit, dan selisihnya sengaja dibiarkan terlihat alih alih dipadankan
diam diam.

## Verifikasi

```bash
./tools/verify.sh 46630   # atau 4663
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

## Langkah lima, menyalakan pemantau

Dijalankan setelah kontraknya berdiri, dan boleh dijalankan terhadap testnet kapan
saja untuk melihat bentuk keluarannya.

```bash
cd contracts
python3 tools/monitor.py --chain-id 46630 --rpc "$NOKTURN_RPC_TESTNET" --once
```

Tanpa argumen tambahan ia hanya membaca dan melapor, dan **tidak butuh kunci sama
sekali**. Tiap putaran berakhir dengan satu baris verdict, yaitu `ok`, `alert`, atau
`pause`. Putaran yang mati sebelum sampai kesimpulan tidak menghasilkan baris itu,
dan ketiadaannya dibaca sebagai kegagalan, bukan sebagai aman.

Untuk menjalankannya terus menerus, buang `--once`. Untuk mengizinkannya memanggil
`pause()` sendiri, tambahkan `--broadcast --account <nama keystore>`. Itu berarti
kunci guardian dalam keadaan siap pakai, dan konsekuensinya ada di `parameter.md`
§8.3.

Satu hal yang akan terlihat aneh di testnet dan memang benar. Keempat token akan
melaporkan `M4`, karena chain 46630 tidak punya feed Chainlink sama sekali, jadi
oracle tidak bisa memberi harga kedua untuk dibandingkan. Di mainnet baris itu
tidak seharusnya muncul.

## Yang sengaja belum dikerjakan script ini

**Closing print feed per token.** Satu kontrak per token, dipasang saat token itu
benar-benar butuh permukaan Chainlink. Bukan bagian dari deploy inti.

## Demo fork, batch akhir pekan pertama yang settled, 21 September 2026

Dijalankan di atas fork `infra/Makefile`, bukan fork sendiri. Urutannya empat
perintah.

```
make fork      # terminal sendiri, tetap di foreground
make deploy
make fund
tools/fork-demo.sh
```

Fork berdiri di blok **67.798.044**, yaitu blok di `infra/pinned-block.json`, dengan
jam chain 20 September 2026 pukul 08.31 UTC. Itu hari Minggu, jadi sesi yang
dijalani harness adalah `CLOSED_WEEKEND`, sesi dengan feed Chainlink beku dan harga
yang harus datang dari pool.

Yang keluar dari event `BatchSettled`, batch `1789903020`.

| | |
|---|---|
| Sesi | 6, `CLOSED_WEEKEND` |
| Intent | 2 |
| Volume ter-netting | $1.999,845580 |
| Volume dirutekan ke venue | $0 |
| Penghematan total | $0,883497 |
| Bagian solver | $0,094660 |
| Bagian protokol | $0,031554 |

Diverifikasi dari saldo, bukan dari log script. Alice menukar 1.000 USDG menjadi
**4,528260915110672293 NVDA**, Bob menukar NVDA yang sama menjadi
**999,873777 USDG**, dan selisih 0,126223 USDG adalah fee yang ditahan.

### Batch kedua, yang tidak menghemat apa apa

Layar kedua adalah batch yang gagal menghemat, dan itu harus dibangun, bukan
ditunggu. Batch ter-netting **tidak bisa** dibuat kalah. Kedua pihak melewatkan
bolak balik yang akan ditagih pool dua kali, jadi berapa pun harga kliringnya,
pasangan itu tetap lebih baik daripada berdagang sendiri sendiri. Memberi harga
buruk pada batch ter-netting tidak menghasilkan pass through, ia menghasilkan
batch yang gagal di salah satu pemeriksaan.

Yang menghasilkannya adalah dua intent di sisi yang sama. Tidak ada yang bisa
di-netting, seluruh volume masuk ke venue lewat satu panggilan, dan tiap intent
menerima bagiannya dari apa yang venue kembalikan.

Batch `1789908720`, dari event.

| | |
|---|---|
| Volume ter-netting | $0 |
| Volume dirutekan ke venue | $999,922790 |
| Penghematan total | $0 |
| Bagian solver | $0 |
| Bagian protokol | $0 |
| `BatchPassthrough` | `savings below threshold` |

`VenueRouted` mencatat 1.000 USDG masuk dan **4,525975205225726 NVDA** keluar,
angka yang sama persis dengan kuotasi baseline yang dicetak `make fund` sebelum
apa pun terjadi. Penghematannya bukan kecil. Ia nol, dan kontraknya yang bilang
sendiri, bukan diberi tahu.

Dua hal yang baru ketahuan di jalur ini.

**Batch yang tidak menghemat apa apa tidak boleh menahan apa apa.** Plafon fee
adalah bagian dari surplus, dan bagian dari nol adalah nol, jadi satu wei yang
tertinggal membatalkan seluruh batch dengan `FeeExceedsCap`. Kedua pengiriman
karena itu harus berjumlah persis sama dengan yang venue kembalikan.

**Harga seragam diambil dari sisi yang lebih buruk, bukan dari rata rata.** Bob
memegang sisanya, jadi pada harga rata rata sisinya bernilai sedikit lebih dari
yang dia jual, dan verifier menolaknya sebagai `NonUniformPrice` sebelum sempat
melihat seberapa kecil selisihnya. Jarak antara kedua harga itu satu wei NVDA
untuk seluruh batch.

### Tiga hal lain yang ditemukan saat menjalankannya

Ketiganya tercatat di dalam skripnya.

**Ukuran leg tidak boleh ditulis tetap.** Kedua leg batch dihitung ke plafon yang
sama, dan plafon itu dibagi dua lagi di sesi akhir pekan, hari libur, dan
protektif. Angka 1.500 USDG yang lolos di sesi `CLOSED_OVERNIGHT` ditolak dengan
`ExposureCapExceeded` di hari Minggu. Harness sekarang membaca `capPerBatchUsd()`
dari kontrak dan mengambil dua per lima dari plafon sesi yang berlaku.

**Fork menambang tiap detik, dan jendela solusi cuma sepuluh detik.** `forge script`
butuh lebih lama dari itu untuk memeriksa artefak, mensimulasikan, lalu mengirim,
jadi jendelanya tertutup sebelum transaksinya sampai. Harness mematikan timernya
selama demo dan menyalakannya lagi saat keluar, termasuk saat gagal.

**Urutan dua panggilan anvil itu penting.** `evm_setIntervalMining 0` ikut mematikan
automine, jadi node yang disuruh automine dulu lalu diberi interval nol berhenti
menambang sama sekali dan setiap transaksi menggantung, bukan revert.

## Gladi resik testnet 46630, keempat, 21 September 2026

Digelar ulang karena `PriceOracle` berubah. Aset kuotasi tidak pernah punya feed, dan
karena Settlement memberi harga setiap token di dalam solusi, tidak ada satu pun batch
yang bisa selesai. Rinciannya di `parameter.md` §7.1.

Alamat oracle masuk sebagai `immutable` di Settlement, AuctionHouse, dan AgentMandate,
dan `SolverRegistry.setSettlement` hanya bisa dipanggil sekali. Jadi oracle baru
menyeret kesembilannya. Itu harga yang dibayar aturan inti immutable, dan ia memang
sudah dipilih sadar. Umpan testnet tidak ikut diganti.

| Kontrak | Alamat |
|---|---|
| `TimelockController` | `0xfC1e78f59d2E950DA80fb65537913F39c21a262d` |
| `SessionManager` | `0x72A9164aB9b7f65f3056332bb356a53A13D24EB2` |
| `ClearingVerifier` | `0x1B0Efa5688cb1bf9f874239E4d5Fa05B60d299b6` |
| `PriceOracle` | `0xcc835817E1d2cac6f7503EC8C8DCA83B83A99eF3` |
| `SolverRegistry` | `0xDc5aFF28CbE174E99042Eccf61a3De5bFb57f4f0` |
| `Settlement` | `0x1475A90C3790b86ba95b1Fdf572Ce705cc914253` |
| `AuctionHouse` | `0x5c3f737bC9e6359e2819B560Bef421250DCE960F` |
| `AgentMandate` | `0x46bB255f78DC85660d5C0f8e32d2e805B00d9D3b` |
| `UniswapV3Adapter` | `0xdbA7506A6DF72883E2c772e851Ab19FC1F0eAD92` |

| Langkah | Gas | Biaya | Perkiraan script | Rasio |
|---|---|---|---|---|
| `Deploy`, 9 kontrak | 20.629.014 | 0,00020629 ETH | 27.246.669 | 76% |
| `Bootstrap`, 21 panggilan | 4.207.644 | 0,00004208 ETH | 6.021.174 | 70% |
| `Lock` | 134.260 | 0,00000134 ETH | 171.650 | 78% |

Totalnya 24.970.918 gas dan 0,00024971 ETH. Rasio 70 sampai 78 persen terhadap
perkiraan bertahan di angkatan keempat.

**Yang dibuktikan dengan membaca rantai.** `minDelay` 172.800. `minBond` 500000000
dengan lantai yang sama. Kelima token `true` di `tokenAllowed` Settlement dan di
`auctionTokenAllowed` AuctionHouse, dan kelima pool terpasang di adapter.
`SolverRegistry.settlement` menunjuk Settlement. Governor `SessionManager` adalah
timelock. Baseline adapter dan token kuotasi ikut ter-allowlist. Sourcify mencatat
kesembilannya `match`.

Pemantau melaporkan `M1` sampai `M3` bersih dan `M4` menyala di kelima token, sama
seperti tiga angkatan sebelumnya, karena 46630 tidak punya Chainlink.

`SetFeeds` tidak dijalankan, dan ia memang menolak chain ini. Itu berarti perbaikan
yang memicu gladi resik ini tidak mengubah apa pun secara fungsional di 46630. Yang
berubah adalah bytecode yang berdiri di sana kembali berasal dari sumber yang ada di
repo, dan itu satu satunya alasan angkatan ini digelar.

**Satu kegagalan, dan runbook ini sudah memuat obatnya.** Percobaan pertama berhenti
di `vm.envAddress: environment variable "NOKTURN_TREASURY" not found`, karena `.env`
ada di root repo sementara forge mencarinya di `contracts/`. Bagian pembuka dokumen
ini sudah menulis `set -a; . ../.env; set +a` sejak angkatan pertama. Yang gagal bukan
runbooknya, melainkan menjalankan perintah tanpa membacanya lebih dulu.

## Gladi resik testnet 46630, ketiga, 20 September 2026 sore

Diulang lagi di hari yang sama karena `MIN_BOND` berubah dari konstanta jadi parameter
bergubernur, dan kontrak angkatan pagi tidak lagi mencerminkan kode. Umpan testnet
tidak ikut diganti, kesebelas alamatnya masih berdiri dan dipakai ulang, jadi yang
digelar ulang hanya sembilan kontrak inti.

| Kontrak | Alamat |
|---|---|
| `TimelockController` | `0x2776885121811fC24bc9Eb274a6288e6bB7E6A95` |
| `SessionManager` | `0xB8f8e67463d0eCC5B44b2299f9393308fB5D3438` |
| `ClearingVerifier` | `0x0c83Cc4Fe29c1977Cc78af8F4b9B3accbF7d3aeC` |
| `PriceOracle` | `0xcDCdcDF159D47d647838E357a38B4EE797cf6a93` |
| `SolverRegistry` | `0x5B7Fce2bAe5079F6BC7B4AdAfD865025D1460b67` |
| `Settlement` | `0x3A98a18C4526118bA5430B80e191C6ea4AD7BFEF` |
| `AuctionHouse` | `0x3A6329d2379509056597fA0c28C6D9c302c9415B` |
| `AgentMandate` | `0xf09089Cb0b3F527E1305A9CE6B64c2086423C998` |
| `UniswapV3Adapter` | `0x6aa2372f4a81b78353BaECA73F1975bFDe632d43` |

| Langkah | Gas | Biaya | Perkiraan script |
|---|---|---|---|
| `Deploy`, 9 kontrak | 20.930.000 | 0,0002093 ETH | 26.819.796 |
| `Bootstrap`, 21 panggilan | 4.188.501 | 0,0000419 ETH | 6.006.872 |
| `Lock` | 130.749 | 0,0000013 ETH | 168.820 |

Rasio 75% terhadap perkiraan bertahan di angkatan ketiga, jadi ia aturan dan bukan
kebetulan satu kali.

**Yang dibuktikan dengan membaca rantai.** `minDelay` 172.800. `minBond` 500000000,
yaitu 500 USDG, dengan lantai 500 dan plafon 50.000 terbaca di kontrak. Kelima token
`true` di `tokenAllowed` Settlement dan di `auctionTokenAllowed` AuctionHouse. Adapter
dan token kuota ikut ter-allowlist. `SolverRegistry.settlement` menunjuk Settlement.
Governor `SessionManager` adalah timelock. Sourcify mencatat kesembilannya `match`,
dikonfirmasi lewat API per alamat.

Pemantau melaporkan `M1` sampai `M3` bersih dan `M4` menyala di kelima token, sama
seperti angkatan pagi, karena 46630 tidak punya Chainlink.

**Satu kegagalan, dan ia menemukan lubang di runbook ini.** `Bootstrap` ditolak dengan
`AccessControlUnauthorizedAccount` karena ditandatangani deployer, sementara proposer
sudah dipindah ke kunci terpisah. Baca bagian dua kunci di atas. `Deploy` sudah membakar
gas saat itu terjadi, jadi biayanya nyata meski kecil.

## Gladi resik testnet 46630, kedua, 20 September 2026 pagi

Diulang karena kontrak angkatan 19 September tidak lagi mencerminkan kode. Guardian,
lantai baseline, dan token kelima semuanya lahir setelahnya. Umpannya ikut diganti
seluruhnya, jadi ini gladi resik dari nol, bukan tambalan.

| Langkah | Gas | Biaya | Perkiraan script |
|---|---|---|---|
| Umpan testnet, 11 kontrak | 6.364.366 | 0,0000636 ETH | 8.475.212 |
| `Deploy`, 9 kontrak | 20.917.620 | 0,0002092 ETH | 27.795.867 |
| `Bootstrap`, 21 panggilan dalam satu batch | 4.233.030 | 0,0000423 ETH | 6.040.033 |
| `Lock` | 137.408 | 0,0000014 ETH | 174.836 |

Total **0,0003165 ETH** pada gas 0,01 gwei. Pemakaian nyata konsisten di sekitar
**75% dari perkiraan** di keempat langkah, jadi perkiraan script boleh dipakai sebagai
batas atas dan tidak boleh dipakai sebagai anggaran.

**Batch bootstrap 21 panggilan, bukan 18.** Bentuknya enam panggilan tetap ditambah
tiga per token, jadi empat token memberi 18 dan lima token memberi 21. Angka 18 yang
sempat dipakai sebagai titik periksa adalah angka sebelum GME masuk, dan itu menghentikan
gladi resik sekali tanpa ada yang rusak. Kalau menambah token lagi, hitung ulang dengan
rumusnya, jangan ingat angkanya.

Yang dibuktikan dengan membaca rantai, bukan membaca log.

Timelock jadi governor di keenam kontrak yang punya. `AgentMandate` tidak punya
`governor()` sama sekali, jadi pembacaannya revert dan itu bukan wiring yang kurang.

Kalender tertutup sampai 4 November 2035 dengan 103 entri sampai 2028. Natal 2026
terbaca `HOLIDAY` dan Sabtu 14 Maret 2026 terbaca `CLOSED_WEEKEND`, sama seperti
angkatan sebelumnya.

Kelima token lolos `StockTokenGate` dan masuk ketiga tempat sekaligus, yaitu allowlist
Settlement, allowlist lelang, dan pool di adapter. `tGME` termasuk, jadi allowlist
gladi resik akhirnya sama panjang dengan mainnet.

`baselineAdapter` terisi dan bukan alamat nol. Ini yang paling gampang luput, karena
adapter yang kosong membuat tiap batch jadi pass through yang aman tapi tidak
mengumpulkan apa apa, dan tidak ada yang revert.

Setelah `Lock`, `minDelay` 172.800 detik dan `Bootstrap` menolak jalan lagi dengan
`bootstrap window already closed`.

Sourcify mencatat kesembilannya `match`, dikonfirmasi lewat API per alamat dan bukan
lewat keluaran script.

Pemantau dijalankan terhadap deployment ini dan melaporkan lima token, naik dari empat.
`M1` sampai `M3`, yaitu ketiga sinyal yang memanggil pause, bersih semua. `M4` menyala
di kelima token karena 46630 tidak punya feed Chainlink, dan itu jawaban yang benar.

Tiga hal yang perlu diketahui sebelum mengulang ini. Prompt password keystore butuh TTY
sungguhan, jadi `--broadcast` dijalankan dari Terminal biasa. Domain testnet ikut
dicegat DNS ISP Indonesia, lihat `parameter.md` §10.6. Dan endpoint ini sempat menjawab
`eth_getCode` kosong untuk dua kontrak yang sebenarnya sudah mendarat, jadi kalau sebuah
alamat terbaca kosong tepat setelah deploy, baca ulang sebelum menyimpulkan apa pun.

## Gladi resik testnet 46630, 19 September 2026, digantikan


Dijalankan penuh. Keempat langkah lolos dan kesembilan kontrak terverifikasi.

| Langkah | Gas | Biaya |
|---|---|---|
| Umpan testnet, 9 kontrak | 5.406.833 | 0,0000541 ETH |
| `Deploy`, 9 kontrak | 19.455.390 | 0,0001946 ETH |
| `Bootstrap`, 17 panggilan dalam satu batch | 4.015.601 | 0,0000402 ETH |
| `Lock` | 133.650 | 0,0000013 ETH |

Total 0,00029 ETH pada gas 0,01 gwei. Saldo awal dari faucet 0,01 ETH, jadi berlebih
sekitar tiga puluh kali lipat.

Yang dibuktikan dengan membaca rantai, bukan membaca log. Timelock jadi governor di
keempat kontrak yang punya. Kalender tertutup sampai 4 November 2035, dan Natal 2026
terbaca `HOLIDAY` sementara Sabtu 14 Maret 2026 terbaca `CLOSED_WEEKEND`. Keempat
token lolos `StockTokenGate`, termasuk satu yang multiplier-nya 1,0032e18. Feed oracle
tetap kosong seperti yang diharuskan §7.1. Setelah `Lock`, `minDelay` 172.800 detik dan
`Bootstrap` menolak jalan lagi dengan `bootstrap window already closed`.

Sourcify mencatat kesembilannya `match` pada creation dan runtime sekaligus.

Dua hal yang perlu diketahui sebelum mengulang ini. Pertama, prompt password keystore
butuh TTY sungguhan, jadi `--broadcast` dijalankan dari Terminal biasa. Kedua, domain
testnet sekarang ikut dicegat DNS ISP Indonesia, lihat `parameter.md` §10.6.

## Gerbang sebelum mainnet

`rencana-uji.md` §10 adalah daftarnya, dan deploy mainnet hanya jalan kalau semuanya
hijau. Per hari ini sepuluh dari empat belas tercentang. Testnet 46630 tidak menunggu
itu, karena ia gladi resik dan tokennya token uji. Sebut begitu apa adanya.

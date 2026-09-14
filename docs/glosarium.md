# Nokturn — Glosarium

> Istilah yang dipakai konsisten di seluruh dokumen dan kode. Kalau sebuah konsep
> punya dua nama, salah satunya salah — perbaiki, jangan biarkan hidup berdampingan.

---

## Nama produk

**Nokturn** — satu kata, huruf besar hanya di awal, **tanpa "e" di akhir**.
Ejaan sebelumnya *"Nocturne"* sudah tidak dipakai (diubah 12 Agustus 2026).

| Konteks | Bentuk |
|---|---|
| Prosa, judul, pitch | **Nokturn** |
| Direktori repo, nama paket, kolom SQL, handle | `nokturn` (huruf kecil) |
| Kontrak & tipe Solidity | tetap deskriptif — `Settlement`, `SessionManager`. **Jangan** memberi awalan nama produk |

⚠️ **Slug URL dashboard Dune tetap `nocturne-…`** dan **tidak boleh diubah** —
mengubahnya mematikan tujuh tautan bukti di dokumen. Teks tampilannya sudah
"dashboard Nokturn"; alamatnya sengaja dibiarkan.

---

## Inti protokol

**Intent** — instruksi bertanda tangan (EIP-712), bukan transaksi. Menyatakan
*"jual X, terima minimal Y, dalam batas waktu ini"*. Ditandatangani gratis; dana
tetap di dompet pengguna sampai settlement. **Bukan** "order".

**Batch** — kumpulan intent yang diselesaikan bersama pada satu harga kliring
seragam. Panjangnya ditentukan sesi dan laju arus.

**Solver** — pihak tanpa izin yang menghitung solusi kliring dan bersaing untuk
memenangkan batch. Bonded. Tidak perlu dipercaya — solusinya diverifikasi kontrak.

**Solution** — usulan solver: harga per token, eksekusi per intent, panggilan
venue, dan klaim savings.

**Harga kliring** *(clearing price)* — satu harga per token per batch. Semua
peserta batch dieksekusi pada harga ini. Tidak ada diskriminasi urutan.

**Netting** *(coincidence of wants)* — bagian volume di mana pembeli dan penjual
saling menutup langsung, tanpa menyentuh venue. Nol spread, nol fee kolam, nol MEV.

**Routing** — sisa imbalance yang tidak ter-netting, dikirim ke venue eksternal
sebagai satu **order agregat**.

**Order (venue)** — ✅ **dipakai, dan hanya untuk ini**: panggilan yang Nokturn
kirim ke venue eksternal (swap Uniswap V3). Di sana ia memang order dalam pengertian
venue itu sendiri, dan menyebutnya "intent" justru salah — venue tidak menerima
intent.

> **Aturannya satu arah:** apa yang **masuk** ke Nokturn adalah **intent**; apa yang
> **keluar** ke venue adalah **order**. Batasnya di titik routing. Kalau sebuah kalimat
> memakai "order" untuk sesuatu yang ditandatangani pengguna, itu salah — bukan
> soal selera.

Turunan yang sah: *order agregat*, *satu order besar*, *routing order*.
Yang tetap terlarang: *"order pengguna"*, *"buku order"*, *"order book"*.

**Pass-through** — mode aman: kalau solusi terbaik tidak mengalahkan baseline
venue, tiap intent dirutekan langsung dan **tidak ada fee sama sekali**.

---

## Pengukuran

**Baseline** — berapa yang benar-benar akan diterima pengguna kalau mengeksekusi
sendiri di venue terbaik, pada ukuran itu, di blok itu juga. **Dihitung dari state
pool** (`slot0`, `liquidity`, `fee`) memakai matematika Uniswap — **bukan** lewat
`staticcall` ke Quoter, yang tidak mungkin karena Quoter mencoba `SSTORE`.
**Bukan** limit price, **bukan** harga tengah oracle.

**Savings** — `received − baselineReceived`. **Angka yang sama** dipakai untuk:
membayar solver, menghitung fee protokol, dan mengklaim hasil ke publik.
Satu metrik, tanpa cerita ganda.

**Netting ratio** — proporsi volume yang saling menutup internal. Mengukur apakah
efek jaringan mulai bekerja.

---

## Sesi & waktu

**Sesi** *(session)* — keadaan pasar dunia nyata: `OPEN`, `PRE_MARKET`,
`POST_MARKET`, `CLOSED_OVERNIGHT`, `CLOSED_WEEKEND`, `HOLIDAY`, `AUCTION_OPEN`,
`AUCTION_CLOSE`, `PROTECTIVE`. Menentukan durasi batch, price band, dan exposure cap.

**Off-hours** — semua waktu di luar `OPEN`. Sesi produk utama Nokturn.
**74,1% trade / 65,2% volume ekuitas terjadi di sini** (Agustus 2026).

**`PROTECTIVE`** — mode aman **per-token** (bukan per-chain) ketika bukti oracle
bertentangan dengan kalender: halt, feed basi, atau dua oracle tidak sepakat.
Band diperketat, cap diturunkan, lelang tidak pernah dijalankan.

**Guard band** — 60 detik di sekitar setiap batas sesi. Di dalamnya: tidak ada
batch baru, tidak ada cross, dan parameter yang dipakai adalah yang **lebih
konservatif** dari dua sesi yang berbatasan.

**Early close** — hari ketika bursa tutup pukul 13:00 ET, bukan 16:00. Sehari
setelah Thanksgiving, Malam Natal, 3 Juli. Menggeser jadwal lelang penutupan.

---

## Lelang

**Opening cross / closing cross** — lelang pembukaan dan penutupan. Empat fase:
akumulasi → pengungkapan indikatif → pembekuan → cross.

**Harga indikatif** — perkiraan harga kliring yang dipublikasikan tiap blok selama
jendela pengungkapan, bersama besar dan arah imbalance.

**Imbalance** — selisih permintaan dan penawaran pada harga indikatif.
Mempublikasikannya adalah **undangan terbuka kepada likuiditas** — mekanisme yang
mengubah risiko tak diketahui menjadi peluang terukur.

**Freeze** — batas waktu pembatalan. Setelahnya intent lelang tidak bisa ditarik
dan dananya ter-escrow, sehingga angka imbalance dijamin nyata.

**Collar** — batas penyimpangan harga lelang dari referensi oracle. Melebar
bertahap saat perpanjangan. Berbeda dari **price band** yang berlaku untuk batch biasa.

**Closing print** — harga penutupan harian kanonik yang dihasilkan lelang penutupan,
terbentuk dari permintaan-penawaran nyata onchain. **Barang publik** — dikonsumsi
protokol lain untuk menandai agunan. Terbit dengan status `sufficient` hanya jika
melewati ambang volume dan jumlah peserta.

---

## Jenis intent

**SPOT** — intent batch biasa.
**MOO** — *Market-on-Open*: eksekusi di berapa pun harga kliring lelang.
**LOO** — *Limit-on-Open*: hanya eksekusi jika harga kliring dalam limit **absolut**.
**ROO** — *Reference-on-Open*: limit **relatif terhadap harga referensi pembukaan**,
mis. "tidak lebih buruk dari 50 bps dari harga referensi pembukaan". Untuk orang
yang menandatangani hari Sabtu dan tidak tahu harga wajar hari Senin.

**Harga referensi pembukaan** — TWAP feed Chainlink selama 5 menit pertama sesi
`OPEN` menurut kalender SessionManager kita. ⚠️ **Bukan** harga pembukaan resmi
bursa — itu tidak tersedia onchain. Jangan pernah menyebutnya "resmi".
**Batch-TWAP** — satu tanda tangan, eksekusi tersebar ke N batch berturut-turut.

---

## Agent

**Mandat** *(mandate)* — batas onchain atas wewenang agent: aset yang boleh
disentuh, notional maksimum, sesi yang diizinkan, dan **penyimpangan maksimum dari
harga wajar**. Intent di luar mandat tidak pernah tereksekusi — bukan karena agent
patuh, tapi karena kontrak menolak.

**Papan skor solver** — reputasi yang diturunkan **sepenuhnya dari fakta settlement
onchain**, bukan ulasan yang dilaporkan sendiri. Sybil tidak berguna.

---

## Tata kelola & keamanan

**Guardian** — bisa pause **instan tanpa time-lock**, tidak bisa unpause, dan
**tidak bisa menyentuh dana**. Cepat tapi tidak berdaya.

**Owner** — bisa mengubah parameter, allowlist, dan kalender lewat **time-lock
48 jam**, dalam rentang keras yang tertanam di kontrak. Kuat tapi lambat.

**Exposure cap** — batas notional per batch, per token per hari, dan global per
hari. Membuat kerugian maksimum jadi **angka yang dihitung, bukan yang diharapkan**.
Inilah yang membuat mainnet awal aman meski belum diaudit.

**Time-lock** — 48 jam untuk semua perubahan parameter. Cukup untuk mendeteksi
kunci owner yang dikompromikan.

---

## Istilah yang sengaja TIDAK dipakai

| Jangan | Pakai | Alasan |
|---|---|---|
| "Order" — **untuk niat pengguna** | **Intent** | Order menyiratkan sesuatu yang berdiri di buku. Intent adalah niat bertanda tangan. ⚠️ Larangan ini **tidak** berlaku untuk panggilan ke venue — lihat "Order (venue)" di §Inti protokol |
| "Slippage protection" | **Limit** + **price band** | Dua mekanisme berbeda dengan jaminan berbeda; menggabungkannya mengaburkan keduanya |
| "MEV protection" | **Netting** + **harga seragam** | Kita menghapus permukaannya, bukan "melindungi" dari sesuatu yang tetap ada |
| "Oracle price" (untuk hasil kliring) | **Harga kliring** vs **harga referensi** | Kliring dihasilkan pasar; referensi berasal dari oracle. Membingungkan keduanya berbahaya |
| "APY" / "yield" | — | Nokturn bukan produk hasil. Ia menghemat biaya, tidak menghasilkan imbal hasil |
| "Token" / "poin" / "airdrop" | — | Keputusan sadar: tidak ada. Lihat `distribusi.md` §6 |

# Nokturn — Algoritma Kliring & Pembuktiannya

> Matematika penentuan harga seragam: bagaimana harga dipilih, kenapa pilihan itu
> benar, bagaimana sisa dijatah, dan **siapa yang membuktikan apa** kepada siapa.
>
> Pendamping: `desain-auction.md` · `desain-session-engine.md` · `spek-teknis.md`

---

## 1. Notasi

Semua intent pada satu pasangan, misalnya NVDA/USDG. Harga `p` dinyatakan dalam
USDG per NVDA.

Intent membawa `sellAmount` dan `minBuyAmount`. Dari keduanya lahir **harga limit**:

| Sisi | Intent | Harga limit | Menerima harga `p` bila |
|---|---|---|---|
| **Beli** | jual USDG `Sᵢ`, minta NVDA `Bᵢ` | `bᵢ = Sᵢ / Bᵢ` | `p ≤ bᵢ` |
| **Jual** | jual NVDA `S'ⱼ`, minta USDG `B'ⱼ` | `sⱼ = B'ⱼ / S'ⱼ` | `p ≥ sⱼ` |

> **Catatan implementasi penting:** rasio di atas hanya untuk penalaran. Di dalam
> kontrak **tidak pernah ada pembagian** — semua pemeriksaan ditulis sebagai
> perkalian silang. Lihat §7.

Dua kurva:

```
D(p) = Σ Bᵢ  untuk semua pembeli dengan bᵢ ≥ p     (permintaan, dalam NVDA)
S(p) = Σ S'ⱼ untuk semua penjual dengan sⱼ ≤ p     (penawaran, dalam NVDA)
```

Volume yang bisa dieksekusi pada harga `p`:

```
V(p) = min( D(p), S(p) )
```

---

## 2. Fungsi objektif

Hierarki yang dipakai bursa saham sungguhan, diadopsi apa adanya:

| Prioritas | Aturan |
|---|---|
| **1** | Maksimalkan `V(p)` |
| **2** | Bila seri → minimalkan imbalance `\|D(p) − S(p)\|` |
| **3** | Bila masih seri → minimalkan `\|p − p_ref\|` |

`p_ref` = harga referensi oracle (**Chainlink `DualAggregator`**, hidup 24 jam;
disilangkan dengan **TWAP Uniswap V3** untuk deteksi ketidaksepakatan).

Memakai hierarki yang sama dengan NYSE/Nasdaq bukan kemalasan — itu yang membuat
mekanismenya bisa dipertahankan di depan juri institusional, dan berarti perilaku
Nokturn bisa diprediksi oleh siapa pun yang paham pasar ekuitas.

---

## 3. Tiga lema yang membuat algoritmanya benar dan murah

### Lema 1 — `V` berpuncak tunggal (quasi-concave)

**Klaim.** `V(p) = min(D(p), S(p))` naik lalu turun; tidak punya puncak ganda.

**Bukti.** `D` tidak naik terhadap `p` (harga makin tinggi, makin sedikit pembeli
yang mau). `S` tidak turun terhadap `p`. Untuk `p` kecil, `S` mengikat dan `V = S`
yang tidak turun. Untuk `p` besar, `D` mengikat dan `V = D` yang tidak naik.
Titik peralihannya adalah perpotongan kurva. Maka `V` tidak turun lalu tidak naik
— berpuncak tunggal. ∎

**Kenapa penting.** Tidak ada maksimum lokal palsu. Pencarian tidak bisa terjebak.

### Lema 2 — cukup memeriksa harga-harga limit

**Klaim.** Maksimum `V` selalu tercapai pada salah satu harga limit yang ada,
yaitu `P = {bᵢ} ∪ {sⱼ}`.

**Bukti.** `D` dan `S` adalah fungsi tangga yang hanya berubah nilai di harga
limit. Di antara dua harga limit berurutan, keduanya konstan, sehingga `V` juga
konstan. Maka setiap nilai yang dicapai `V` sudah dicapai di salah satu titik
patah. ∎

**Kenapa penting.** Ruang pencarian menyusut dari kontinu menjadi **paling banyak
`N` titik**.

### Lema 3 — evaluasi pada satu harga itu `O(N)` tanpa pengurutan

**Klaim.** Menghitung `D(p)`, `S(p)`, dan `V(p)` untuk satu `p` hanya butuh satu
lintasan atas semua intent.

**Bukti.** Jumlahkan `Bᵢ` untuk `bᵢ ≥ p` dan `S'ⱼ` untuk `sⱼ ≤ p`. Tidak perlu
urutan. ∎

**Kenapa penting.** Ini yang membuat **verifikasi tantangan** di §6 murah — dan
itu keputusan arsitektur terpenting di dokumen ini.

---

## 4. Algoritma solver

```
1. Kumpulkan harga limit sebagai kandidat        P = {bᵢ} ∪ {sⱼ}
2. Urutkan menaik                                 O(N log N)
3. Sapu sekali, hitung D dan S secara inkremental O(N)
     · D(p) = suffix-sum kuantitas pembeli
     · S(p) = prefix-sum kuantitas penjual
4. Evaluasi V di tiap kandidat, terapkan hierarki §2
5. Jepit ke price band oracle
     · batch biasa → jepit ke tepi band, hitung ulang V di titik itu
     · lelang      → picu perpanjangan (lihat desain-auction.md §2.4)
6. Jatah sisi panjang (§5)
7. Rutekan imbalance sisa ke venue, ambil kuotasi baseline
```

**Kompleksitas: `O(N log N)`**, didominasi pengurutan. Untuk `N` dalam ribuan ini
sepele di offchain.

### 4.1 Contoh berangka

Pembeli NVDA:

| | Kuantitas | Limit |
|---|---|---|
| B1 | 100 | ≤ $180 |
| B2 | 50 | ≤ $178 |
| B3 | 80 | ≤ $176 |

Penjual NVDA:

| | Kuantitas | Limit |
|---|---|---|
| S1 | 60 | ≥ $175 |
| S2 | 70 | ≥ $177 |
| S3 | 90 | ≥ $179 |

| `p` | `D(p)` | `S(p)` | `V(p)` |
|---|---|---|---|
| 175 | 230 | 60 | 60 |
| 176 | 230 | 60 | 60 |
| **177** | **150** | **130** | **130** ← |
| **178** | **150** | **130** | **130** ← |
| 179 | 100 | 220 | 100 |
| 180 | 100 | 220 | 100 |

Perhatikan `V`: 60 → 60 → 130 → 130 → 100 → 100. **Naik lalu turun** — Lema 1
terlihat langsung.

Maksimum `V = 130` seri di `p ∈ {177, 178}`.
Imbalance sama-sama 20 → seri berlanjut.
Dengan `p_ref = 177,2` → **harga kliring = $177**.

---

## 5. Penjatahan (rationing)

Pada `p* = 177`: `D = 150`, `S = 130`. Sisi penjual lebih pendek → **terisi penuh**.
Sisi pembeli harus dijatah: 130 dari 150 yang diminta.

### 5.1 Dua aturan

**Aturan 1 — prioritas harga.** Intent yang harganya **lebih baik** dari `p*`
didahulukan atas intent yang tepat **di** `p*`.

Di contoh ini B3 (limit 176 < 177) tidak berdagang sama sekali. B1 dan B2 keduanya
ketat di atas `p*`, jadi tidak ada yang mendahului yang lain.

**Aturan 2 — pro-rata di antara yang setara.**

```
B1 : 130 × 100/150 = 86,67 NVDA
B2 : 130 ×  50/150 = 43,33 NVDA
```

### 5.2 Kenapa pro-rata, bukan prioritas waktu ⭐

Bursa sungguhan sering memakai prioritas waktu. **Onchain itu pilihan yang salah**,
dan alasannya penting.

Waktu kedatangan tidak bisa dipercaya di lingkungan terdesentralisasi. Siapa pun
yang bisa memengaruhi urutan — sequencer, relay, siapa saja yang melihat mempool
lebih dulu — bisa memanen prioritas. Memakai waktu sebagai pemeringkat berarti
**memasukkan kembali balapan urutan yang justru ingin dihapus batch auction.**

Pro-rata kebal terhadap itu: menyuntik intent lebih awal tidak memberi keuntungan
apa pun. Ini bukan sekadar lebih adil — **ini satu-satunya pilihan yang tahan
manipulasi**, dan konsisten dengan seluruh alasan protokol ini ada.

### 5.3 Pembulatan

Pro-rata melahirkan pecahan. Aturannya kaku:

1. Semua aritmetika bilangan bulat
2. Kuantitas yang **diterima** pengguna dibulatkan **ke bawah**
3. Selisih pembulatan tidak boleh membuat konservasi nilai negatif
4. Debu yang tersisa dicatat dan tidak pernah bisa negatif

Invarian yang diuji: **jumlah semua `executedBuy` ≤ nilai yang tersedia pada harga
kliring, dan selisihnya selalu ≥ 0.** Pembulatan yang salah arah adalah tempat bug
kliring biasanya bersembunyi.

---

## 6. Keputusan arsitektur: siapa membuktikan apa ⭐

Ini bagian paling penting di seluruh dokumen.

### 6.1 Masalahnya

Kontrak **tidak bisa** dengan murah memverifikasi bahwa sebuah harga benar-benar
memaksimalkan volume. Membuktikan optimalitas berarti memeriksa tidak ada harga
lain yang lebih baik — pada dasarnya menjalankan ulang seluruh algoritma `O(N log N)`
di dalam kontrak.

Jadi jangan lakukan itu. Pisahkan dua pertanyaan yang berbeda:

| Pertanyaan | Siapa yang menjamin |
|---|---|
| **Apakah solusi ini sah?** (tidak ada yang dirugikan) | **Kontrak**, selalu, tanpa kecuali |
| **Apakah solusi ini yang terbaik?** | **Mekanisme**, bukan kriptografi |

### 6.2 Batch biasa — validitas diverifikasi, optimalitas dikompetisikan

Kontrak memverifikasi **kesahihan**:

1. Harga seragam per token
2. Setiap limit dihormati (perkalian silang, §7)
3. Konservasi nilai per token, termasuk delta dari venue
4. Harga di dalam price band oracle
5. Savings yang diklaim benar, diukur terhadap kuotasi venue

Optimalitas datang dari **kompetisi**: solver bersaing, yang savings-nya tertinggi
menang, dan savings diukur terhadap **baseline objektif eksternal** — kuotasi venue
nyata di blok yang sama, bukan terhadap sesama solver.

Solusi yang malas tidak perlu "dibuktikan buruk". Ia cukup **kalah**. Dan kalau
semua solusi buruk, pass-through otomatis mengambil alih — sehingga pengguna
tetap tidak pernah lebih buruk dari mengeksekusi sendiri.

**Ini yang benar.** Optimalitas adalah hasil ekonomi, bukan jaminan kriptografis.

### 6.3 Lelang — kliring optimistik dengan bukti kesalahan ⭐

Untuk lelang pembukaan dan penutupan, taruhannya lebih tinggi: hasilnya adalah
**closing print** yang dikonsumsi protokol lain. Di sini optimalitas layak dijamin
lebih kuat.

Dan di sinilah Lema 3 membayar dirinya sendiri:

```
1. Solver mengajukan harga kliring p dan klaim volume V(p)
2. Jendela tantangan dibuka (mis. 2 menit)
3. Siapa pun boleh mengajukan p′ dengan klaim V(p′) > V(p)
4. Kontrak mengevaluasi HANYA p dan p′  →  O(N), tanpa pengurutan
5. Kalau penantang benar → p′ dipakai, bond pengaju awal disita,
   sebagian jadi hadiah penantang
```

**Kenapa ini bekerja:** memverifikasi tantangan tidak butuh pengurutan sama sekali
— cukup dua lintasan penjumlahan. Murah, bahkan untuk `N` besar. Dan karena intent
lelang **sudah ter-escrow dan publik** (`desain-auction.md` §2.6), siapa pun bisa
memverifikasi sendiri secara offchain lalu menantang.

Bentuknya **persis fraud proof Arbitrum**: jangan buktikan di jalur bahagia,
biarkan bisa ditantang. Ini bukan kemiripan yang dipaksakan — ini pola yang sama
karena masalahnya memang sama.

### 6.4 Ringkasan

| | Batch biasa | Lelang |
|---|---|---|
| Validitas | Diverifikasi kontrak | Diverifikasi kontrak |
| Optimalitas | Kompetisi solver + pass-through | **Optimistik + bisa ditantang** |
| Biaya verifikasi | `O(N)` validitas | `O(N)` validitas + `O(N)` per tantangan |
| Kenapa berbeda | Savings punya baseline eksternal objektif | Closing print jadi barang publik — perlu jaminan lebih kuat |

---

## 7. Aritmetika: tanpa pembagian, tanpa presisi hilang

Setiap pemeriksaan limit ditulis sebagai perkalian silang.

Untuk intent dengan `sellAmount = S`, `minBuyAmount = B`, yang dieksekusi
`executedSell = s`, `executedBuy = b`:

```
      b       B                                    ┌───────────────────┐
     ─── ≥  ───     ⟺     b · S  ≥  B · s          │  b·S ≥ B·s        │
      s       S                                    └───────────────────┘
```

Tidak ada pembagian, tidak ada pembulatan, tidak ada presisi yang hilang.
Risikonya hanya **overflow** — dan di sinilah Stylus membantu: aritmetika lebar
di Rust jauh lebih murah, sehingga memakai lebar penuh (`U512` untuk hasil antara)
tidak menghancurkan anggaran gas seperti di Solidity.

**Yang harus dibuktikan Halmos:**

| Properti |
|---|
| Perkalian silang tidak pernah overflow untuk seluruh rentang input yang valid |
| Pemeriksaan limit ekuivalen dengan rasio yang dimaksud, untuk semua input |
| Pembulatan pro-rata tidak pernah melampaui total yang tersedia |
| Konservasi nilai tetap terjaga di bawah pembulatan terburuk |

Empat properti ini domainnya terbatas dan bisa dibuktikan — bukan sekadar diuji.

---

## 8. Banyak token dalam satu batch

Scope penuh berarti bukan hanya pasangan TOKEN/USDG.

**Model harga:** setiap token punya **satu harga dalam numeraire USDG**. Intent
NVDA→SPY dieksekusi pada kurs silang tersirat `p_NVDA / p_SPY`.

Konservasi diperiksa **per token**, termasuk delta dari panggilan venue. Kalau
tidak ada yang mengambil sisi berlawanan SPY→NVDA, panggilan venue yang
menyeimbangkan. Kontrak tidak peduli dari mana keseimbangan datang, asal terjaga.

**Properti yang berharga:** kontraknya sudah mendukung pencocokan multi-token
secara native. Solver v1 boleh memakai strategi sederhana — kliring per pasangan
lalu routing sisa. Pencocokan multi-hop yang lebih pintar adalah **peningkatan
solver, bukan perubahan kontrak.**

> Artinya kualitas eksekusi bisa membaik terus tanpa menyentuh kontrak yang sudah
> di-deploy. Untuk protokol yang core-nya sengaja dibuat immutable, ini bukan
> kebetulan yang menyenangkan — ini alasan desainnya benar.

---

## 9. Yang bisa ditunjukkan ke juri

| Klaim | Bukti |
|---|---|
| Mekanisme harganya benar | Tiga lema, dengan bukti singkat yang bisa diperiksa |
| Perilakunya dapat diprediksi | Hierarki objektif identik dengan bursa sungguhan |
| Penjatahannya tahan manipulasi | Pro-rata, bukan prioritas waktu — dengan alasan yang jelas |
| Aritmetikanya aman | Tanpa pembagian; overflow dibuktikan Halmos, bukan diuji |
| Optimalitas lelang dijamin | Optimistik + bisa ditantang, verifikasi `O(N)` |
| Pengguna tidak pernah dirugikan | Pemeriksaan limit + pass-through + price band |

Dan satu kalimat penutup:

> *Kami tidak meminta siapa pun memercayai bahwa solver kami jujur. Kontraknya
> memverifikasi setiap solusi, kompetisi yang memilih yang terbaik, dan untuk
> lelang — siapa pun boleh membuktikan kami salah dan dibayar untuk itu.*

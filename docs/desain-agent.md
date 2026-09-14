# Nokturn — Sisi Agent

> Tesisnya bukan "protokol ini punya fitur agentic".
> Tesisnya: **agent adalah pengguna yang paling diuntungkan oleh mekanisme ini,
> dan pasar kontinu adalah tempat terburuk bagi mereka.**
>
> Pendamping: `desain-auction.md` · `ide-utama.md` · `spek-teknis.md`

---

## 1. Kenapa agent jadi mangsa di pasar kontinu

Lima kelemahan struktural. Tak satu pun bisa diperbaiki dengan membuat agent-nya
lebih pintar — semuanya berasal dari struktur pasarnya.

| # | Kelemahan | Kenapa fatal |
|---|---|---|
| 1 | **Waktunya bisa ditebak** | Agent jalan di jadwal atau pemicu event. Perilaku yang bisa diramalkan di pasar kontinu = perilaku yang bisa dieksploitasi |
| 2 | **Tidak bisa menawar** | Manusia mengamati, menunggu, memecah order. Agent umumnya menembakkan satu swap dengan toleransi slippage — dan **toleransi itu pada dasarnya pengumuman publik tentang berapa banyak yang boleh diambil darinya** |
| 3 | **Bertindak justru di saat terburuk** | Agent bereaksi terhadap sinyal dan berita. Itu tepat ketika pasar tipis dan bergerak. Reaksi terhadap berita semalam adalah kasus pakai agent paling kanonik — dan off-hours adalah tempat **ekor** eksekusi paling berbahaya: p99 **1.779,4 bps** lawan **209,3 bps** saat bursa buka (**8,50×**, Agustus 2026). Ditambah: **74,1% arus** berjalan tanpa harga referensi sama sekali |
| 4 | **Sering dan kecil** | Agent rebalancing menembakkan banyak order kecil. Tiap order bayar spread penuh. Mati karena seribu sayatan |
| 5 | **Jumlahnya akan meledak** | Robinhood sudah meluncurkan agentic trading. Arah industrinya satu arah. Setiap agent baru adalah mangsa baru dengan kelemahan yang sama |

> ⚠️ **Catatan angka — diperbarui 11 September 2026.** Versi sebelumnya menulis
> *"p90 3,4× lebih buruk"* dari data Juli. Klaim itu **gugur** di data Agustus:
> p90 off-hours turun ke **1,27×** dan akhir pekan praktis setara jam bursa buka.
> Masalahnya tidak lenyap, dia **pindah ke ekor** — p99 off-hours melebar ~2×
> (855,3 → 1.779,4 bps) sementara p99 jam buka menyempit ~3× (699,2 → 209,3 bps),
> sehingga rasionya melompat ke **8,50×**.
>
> Untuk argumen di dokumen ini pergeseran itu **memperkuat, bukan melemahkan**.
> Agent bertransaksi sistematis dan berulang, jadi yang menentukan hasil jangka
> panjangnya adalah **distribusi ekor, bukan median** — dan justru ekor itulah yang
> memburuk. Trader manusia bisa melihat harga aneh lalu membatalkan; agent yang
> menembak dengan toleransi slippage tetap **tidak bisa**.
>
> Sumber: `parameter.md` §1B · ringkasan di `CLAUDE.md` §6 ·
> [dashboard Agustus 2026](https://dune.com/passchick/nokturn-robinhood-chain-equity-market-structure-august-2026)

---

## 2. Kenapa batch justru membalik semuanya

Tiap kelemahan di atas hilang — bukan dikurangi, tapi hilang secara struktural.

| Kelemahan | Di dalam batch |
|---|---|
| Waktu bisa ditebak | **Tidak relevan.** Semua peserta jendela dapat satu harga yang sama. Tidak ada keunggulan urutan yang bisa dieksploitasi |
| Toleransi slippage terbuka | **Tidak ada lagi.** Agent menyatakan limit; kliring yang menegakkannya. Bukan "terima apa pun yang diberikan kolam" |
| Bertindak saat pasar tipis | **Justru di sinilah batch paling bernilai.** Arus yang tersebar dalam waktu dikumpulkan jadi likuiditas |
| Order kecil bayar spread penuh | **Bagian yang saling menutup tidak bayar spread sama sekali** |

### 2.1 Wawasan intinya ⭐

Ini argumen terkuat di seluruh dokumen ini, dan aku belum melihat ada yang menulisnya:

> **Arus dari agent adalah arus yang paling mungkin saling menutup di dalam batch.**

Alasannya ekonomis, bukan kebetulan. Agent itu **banyak, sistematis, dan beragam
strateginya**. Agent momentum membeli tepat ketika agent mean-reversion menjual.
Agent rebalancing mengurangi NVDA tepat ketika agent DCA menambahnya. Aset sama,
menit sama, arah berlawanan.

Di pasar kontinu, keduanya membayar kolam likuiditas — dan kolam itu mengambil
untung dari keduanya.

Di dalam batch, **mereka bertransaksi satu sama lain di harga tengah, gratis.**

Artinya semakin banyak agent yang memakai Nokturn, semakin bagus eksekusi untuk
setiap agent. Ini efek jaringan yang bekerja paling kuat justru pada populasi yang
sedang tumbuh paling cepat.

---

## 3. Intent sebagai primitif mandat agent

Ada lapisan kedua yang sama pentingnya, dan ini menyelesaikan masalah nyata:
**bagaimana memberi wewenang ke agent tanpa memberinya kendali penuh atas uangmu.**

### 3.1 Kenapa intent lebih baik daripada memberi kunci

| Pendekatan | Yang sebenarnya kamu berikan |
|---|---|
| Kasih agent private key + token approval | **Wewenang tak terbatas.** Ia bisa melakukan apa pun terhadap token yang di-approve |
| Session key di atas transaksi mentah | Lebih baik, tapi batasannya soal *panggilan kontrak apa* — bukan soal *harga yang wajar diterima* |
| **Agent menandatangani intent di bawah mandat** ✅ | **Wewenang yang terbatas dan bisa dibaca manusia**, dan batas harganya ditegakkan oleh mekanisme kliring itu sendiri |

Kuncinya: **intent sudah membawa limit harga di dalam dirinya**, dan settlement
sudah menegakkannya demi alasan lain. Kamu mendapat penegakan itu gratis.

### 3.2 Kontrak mandat

```solidity
struct Mandate {
    address owner;              // pemilik dana
    address agent;              // yang berwenang menandatangani intent
    address[] allowedTokens;    // aset yang boleh disentuh
    uint256 maxNotionalPerBatch;
    uint256 maxNotionalPerDay;
    uint16  maxDeviationFromRefBps;  // seberapa jauh dari harga wajar boleh diterima
    uint8   allowedSessions;    // bitmask: agent boleh jalan di sesi mana
    uint64  expiry;
    bool    auctionAllowed;     // boleh ikut lelang pembukaan/penutupan?
}
```

Settlement memvalidasi tiap intent bertanda-agent terhadap mandatnya.
**Intent di luar mandat tidak akan pernah tereksekusi** — bukan karena agent-nya
patuh, tapi karena kontraknya menolak.

Ini menjawab keberatan terbesar terhadap agentic finance —
*"kenapa aku harus percaya AI dengan uangku?"* — dengan jawaban yang tepat:
**kamu tidak perlu percaya. Kontraknya yang membatasi.** Bahkan agent yang
sepenuhnya dikompromikan tidak bisa keluar dari kotaknya.

### 3.3 Yang penting: batas dinyatakan dalam bahasa keuangan

Perhatikan `maxDeviationFromRefBps`. Ini bukan batas teknis seperti "boleh panggil
fungsi X" — ini batas **ekonomis**: *"agent-ku tidak boleh menerima harga yang
lebih dari 100 bps di luar harga wajar."*

Itu kalimat yang bisa dimengerti orang biasa, dan bisa ditegakkan mesin. Kombinasi
itu langka, dan hanya mungkin karena protokolnya memang sudah tahu apa itu
"harga wajar" — dari oracle referensi dan dari harga kliringnya sendiri.

---

## 4. Jenis intent asli-agent

Batch memungkinkan bentuk instruksi yang tidak bisa diungkapkan dengan bersih di
venue kontinu:

| Jenis | Isi | Kenapa hanya mungkin dengan batch |
|---|---|---|
| **Batch-TWAP** | *"Beli NVDA $1.000, sebar rata sepanjang 10 batch berikutnya"* | Satu tanda tangan, sepuluh partisipasi. Di venue kontinu ini butuh sepuluh transaksi terpisah, masing-masing bisa disergap |
| **Recurring / DCA** | *"Beli $50 SPY tiap sesi off-hours, selama 30 hari"* | Cocok alami dengan siklus sesi |
| **Reference-relative (ROO)** | *"Jangan lebih buruk dari 50 bps dari harga pembukaan"* | Butuh harga kliring & referensi resmi — konsep yang tidak ada di venue kripto |
| **Conditional-on-session** | *"Hanya eksekusi saat off-hours"* atau *"jangan pernah di jendela earnings"* | Butuh venue yang tahu keadaan pasar dunia nyata |

Batch-TWAP menurutku yang paling kuat secara produk: **satu tanda tangan yang
menghasilkan eksekusi bertahap yang secara struktural tidak bisa disergap.**
Itu persis yang dibutuhkan agent yang mengelola posisi besar secara pelan-pelan.

---

## 5. Agent di sisi lain: solver

Sisi kedua, sudah disinggung di `spek-teknis.md` — di sini konteks lengkapnya.

Memecahkan batch adalah **tugas agent yang ideal**:

- **Masalah optimasi nyata** — cari harga kliring yang memaksimalkan surplus
- **Imbalannya ekonomis dan langsung** — solusi terbaik menang
- **Hasilnya diverifikasi onchain** — solver tidak perlu dipercaya sama sekali
- **Kompetitif dan tanpa izin** — siapa pun boleh ikut

Ini bentuk yang **sama persis dengan tesis Arbitrum sendiri**: jangan percaya,
verifikasi lewat kompetisi dan kemampuan ditantang. Solver adalah agent ekonomis
yang keluarannya bisa dibuktikan benar — bukan chatbot yang meminta kepercayaan.

### 5.1 Reputasi solver yang benar-benar berarti

Riset sebelumnya menemukan reputasi agent di ERC-8004 rusak secara empiris:
73–90% pemberi ulasan menunjukkan perilaku Sybil terkoordinasi, dan umpan baliknya
hampir tidak pernah berakar pada interaksi yang bisa diverifikasi.

Di sini masalah itu **tidak ada sejak awal**. Rekam jejak solver bukan ulasan yang
dilaporkan sendiri — ia **diturunkan dari fakta settlement onchain**: berapa batch
yang dimenangkan, berapa surplus yang benar-benar dihasilkan untuk pengguna, berapa
kali gagal saat finalize.

Terbitkan sebagai papan skor publik. Sybil tidak ada gunanya, karena satu-satunya
cara menaikkan skor adalah **benar-benar menghasilkan penghematan untuk pengguna
nyata dengan modal nyata.**

Ini kontribusi kecil tapi jujur ke ekosistem agent — dan tidak menabrak AlphaGrid,
yang mengurusi agent *trader* yang memperebutkan modal. Ini soal agent *penyedia
infrastruktur*.

---

## 6. Apa yang dibangun untuk sisi ini

| Komponen | Isi |
|---|---|
| `AgentMandate.sol` | Registrasi mandat, validasi intent bertanda-agent, akuntansi batas harian |
| Intent multi-batch | Batch-TWAP & recurring, dengan penjadwalan sadar-sesi |
| Agent SDK (TypeScript) | Kirim intent, langganan hasil batch, kelola mandat |
| Solver reference + papan skor | Implementasi solver acuan; reputasi diturunkan dari settlement |

---

## 7. Catatan jujur tentang waktu

Permintaan agent onchain di Robinhood Chain **masih dini**. Virtuals ada di sana
sebagai launchpad agent, dan agentic trading Robinhood sendiri masih terpusat serta
khusus AS. Jadi sisi agent ini adalah **taruhan pada arah**, sama seperti taruhan
pada tumbuhnya pasar ekuitas onchain.

Bedanya dengan proyek yang murni bertaruh pada agent: **Nokturn tetap bekerja
sepenuhnya tanpa satu pun agent.** Trader manusia sudah cukup untuk membuatnya
bernilai — 139.093 dompet aktif, 8,58 juta trade per bulan (Agustus 2026),
semuanya terukur.

Lapisan agent adalah **penguat, bukan penopang.** Kalau gelombang agent datang
seperti yang ditunjukkan semua sinyal industri, Nokturn sudah jadi rel yang
seharusnya mereka pakai. Kalau tidak datang, protokolnya tetap berdiri.

Itu posisi yang benar untuk taruhan: ikut naik kalau tesisnya terbukti, tidak
runtuh kalau tidak.

---

## 8. Kalimat untuk juri track agentic

> Kebanyakan proyek agentic membangun agent yang lebih pintar.
> Kami membangun **pasar tempat agent berhenti jadi mangsa** — lalu membiarkan
> agent bersaing memperbaikinya.

Dua sisi, satu protokol: agent sebagai **pengirim niat** yang terlindungi oleh
struktur dan dibatasi oleh mandat, dan agent sebagai **solver** yang hasilnya
diverifikasi onchain.

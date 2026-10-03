# Brand Nokturn

Lapisan settlement berbasis intent untuk ekuitas tokenized di Robinhood Chain. Sebagian besar arusnya terjadi saat NYSE tutup, jadi identitasnya dibangun di sekitar malam dan burung hantu.

Ditetapkan 2026-10-01. Kalau sesuatu di sini berubah, ubah dokumen ini di hari yang sama.

## Logo

Kepala burung hantu, siluet geometris flat satu warna. Mata besar berlubang, pupil solid, paruh segitiga dengan garis negatif di sekelilingnya.

| | |
|---|---|
| File | `app/public/landing/logo-nokturn-owl.svg` |
| Warna | `currentColor`, jadi mengikuti warna teks induknya |
| Ukuran terkecil | 16 px, masih terbaca sebagai burung hantu |
| Warna utama | amber `#FFB825` di atas indigo gelap, atau indigo `#0D102C` di atas latar terang |

Logo monogram N lama di `public/logo-nokturn.svg` digantikan logo ini.

## Palet, Owl Amber

Indigo tengah malam dengan aksen kuning seperti mata burung hantu. Kategori DeFi, mood bold dan playful. Dipilih karena bedanya jelas dengan keluarga warna CoW (pink-krem, ungu, biru langit, oranye).

### Seed

| Peran | Gelap | Terang |
|---|---|---|
| bg-base | `oklch(0.140 0.045 275)` `#05071B` | `oklch(0.980 0.012 275)` `#F6F8FF` |
| bg-elevated | `oklch(0.190 0.055 275)` `#0D102C` | `oklch(1 0 0)` `#FFFFFF` |
| primary | `oklch(0.830 0.165 78)` `#FFB825` | `oklch(0.500 0.165 78)` `#945100` |
| primary-soft | `oklch(0.910 0.100 78)` `#FFDA94` | `oklch(0.650 0.080 78)` `#AA8955` |
| fg-base | `oklch(0.970 0.012 275)` `#F2F5FD` | `oklch(0.180 0.025 275)` `#0E111D` |

Di mode terang, primary turun jadi coklat amber `#945100` karena kuning terang tidak lolos kontras di atas latar putih. Kuning `#FFB825` tetap dipakai di mode terang sebagai bidang warna dengan teks indigo di atasnya, bukan sebagai warna teks.

### Token aplikasi

Repo ini tidak memakai Tailwind atau shadcn, jadi token tidak ditulis ke `globals.css`. Nilai turunannya dicatat di sini dan dipetakan manual ke CSS modules.

| Token | Gelap | Terang |
|---|---|---|
| background | `oklch(0.140 0.045 275)` | `oklch(0.980 0.012 275)` |
| foreground | `oklch(0.970 0.012 275)` | `oklch(0.180 0.025 275)` |
| card | `oklch(0.190 0.055 275)` | `oklch(1 0 0)` |
| popover | `oklch(0.210 0.055 275)` | `oklch(1 0 0)` |
| primary | `oklch(0.830 0.165 78)` | `oklch(0.500 0.165 78)` |
| primary-foreground | `oklch(0.120 0 0)` | `oklch(0.980 0 0)` |
| secondary | `oklch(0.230 0.065 275)` | `oklch(0.940 0.017 275)` |
| muted | `oklch(0.210 0.055 275)` | `oklch(0.950 0.012 275)` |
| muted-foreground | `oklch(0.670 0.012 275)` | `oklch(0.450 0.025 275)` |
| accent | `oklch(0.250 0.075 78)` | `oklch(0.930 0.032 78)` |
| border | `oklch(0.340 0.055 275)` | `oklch(0.840 0.012 275)` |
| input | `oklch(0.190 0.055 275)` | `oklch(0.960 0.012 275)` |
| ring | `oklch(0.830 0.165 78)` | `oklch(0.500 0.165 78)` |

Kontras WCAG AA, terukur.

| Pasangan | Terang | Gelap |
|---|---|---|
| foreground di atas background | 17,7:1 | 18,3:1 |
| muted-foreground di atas background | 7,0:1 | 6,7:1 |
| primary-foreground di atas primary | 5,8:1 | 11,7:1 |
| ring di atas background | 5,7:1 | 11,5:1 |

### Varian landing

Landing memakai versi playful dengan gaya kartu-kartu berwarna seperti cow.fi. Tokennya ada di `app/src/app/(landing)/landing.module.css` dengan prefiks `--nk-`.

| Token | Hex | Dipakai untuk |
|---|---|---|
| `--nk-ink-90` | `#E4E9FD` | Latar halaman, indigo pucat seperti cahaya bulan |
| `--nk-ink-100` | `#FFFFFF` | Kartu terang |
| `--nk-ink-10` | `#0D102C` | Header, kartu gelap, teks utama |
| `--nk-ink-0` | `#05071B` | Footer |
| `--nk-amber` | `#FFB825` | Logo, tombol utama, kartu aksen |
| `--nk-mint` | `#5FE6C1` | Aksen pendukung |
| `--nk-amber-mid` / `--nk-mint-mid` / `--nk-peri-mid` | `#E09600` / `#00AB89` / `#5F80E0` | Koin di animasi hero, cukup pekat untuk simbol putih |
| `--nk-mint-pale` / `--nk-mint-deep` | `#CAF7E7` / `#045B48` | Tag mint |
| `--nk-peri` / `--nk-peri-deep` | `#A2BCFF` / `#1C2369` | Tag dan kartu indigo |

Skala `--nk-ink-*` dari 0 sampai 100 adalah abu-abu bernuansa indigo (hue 275). Pasangan yang terukur antara lain teks utama di latar halaman 15,3:1, amber di indigo 10,7:1, tag mint 6,9:1, tag periwinkle 7,5:1, dan teks footer `ink-60` di atas `ink-0` 5,9:1. Teks footer sengaja tidak memakai `ink-50`, karena hanya 4,3:1 dan gagal AA.

## Tipografi

Plus Jakarta Sans untuk judul dan teks, JetBrains Mono untuk angka, alamat, dan nomor blok. Dua-duanya dari Google Fonts lewat `next/font/google`, jadi di-host sendiri saat build tanpa pergeseran layout.

Saat ini baru dipasang di landing (`app/src/app/(landing)/layout.tsx`) dengan variabel `--font-landing-sans` dan `--font-landing-mono`. Halaman app lain masih memakai Inter.

| Peran | Ukuran | Bobot |
|---|---|---|
| Hero landing | 148 px desktop, 80 px ponsel | 700 |
| Judul section | 51 px desktop, 38 px ponsel | 700 |
| Deskripsi section | 28 px desktop, 21 px ponsel | 500 |
| Teks UI | 14 sampai 16 px | 400 sampai 500 |
| Angka | mono, `tabular-nums` | 500 sampai 600 |

## Gradien

Tidak dipakai. Sempat dibuat 2026-10-01 (latar indigo pucat dan aksen amber ke kuning-lime), lalu dihapus di hari yang sama atas keputusan pemilik karena hasilnya tidak bagus. Semua bidang warna di landing dan app memakai warna solid.

## Nada dan suara

Visualnya playful, kalimatnya jujur. Keceriaan datang dari warna, maskot, dan bentuk, bukan dari klaim yang dibesar-besarkan.

**Pakai.** Kalimat pendek dengan subjek yang jelas. Angka yang bisa dicek, selalu dengan sumbernya. Istilah dari `docs/glosarium.md`, misalnya *intent* (bukan "order") dan *batch*. Humor ringan soal malam dan burung hantu boleh, selama tidak menggantikan informasi.

**Hindari.** Istilah yang dilarang glosarium, yaitu "MEV protection", "slippage protection", dan "APY". Klaim orisinalitas yang tidak ada di `docs/pitch.md` §2 sampai §3b. Kata hype seperti "revolutionary" atau "unlock". Em dash, dan titik dua atau titik koma di tengah kalimat (aturan prosa repo).

**Contoh.**

> NYSE tutup, burung hantu belum. Tanda tangani intent sekarang, semua peserta batch dapat satu harga yang sama, dan setiap angka membawa nomor blok tempat ia dibaca.

## Boleh dan jangan

**Boleh.**
- Ambil warna dari token, bukan hex di dalam komponen.
- Pakai mono dan `tabular-nums` untuk angka yang berubah di tempat.
- Logo selalu lewat `currentColor`, supaya mengikuti konteks terang atau gelap.

**Jangan.**
- Memakai kuning amber sebagai warna teks di latar terang. Pakai `#945100` atau jadikan amber sebagai bidang.
- Mengembalikan warna khas CoW (pink-krem `#F0DEDE`, ungu `#490072`, biru langit `#65D9FF`, oranye `#EC4612`).
- Memakai `transition: all`.

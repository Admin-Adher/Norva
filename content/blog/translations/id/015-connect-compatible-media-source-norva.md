---
language: "id"
source_slug: "connect-compatible-media-source-norva"
source_sha256: "8efa2f6c3971568d3ed277e8cdd99305ea755c0d2b3628b40aefe9cc0d3bf659"
title: "Cara menghubungkan sumber media kompatibel ke Norva"
seo_title: "Cara menghubungkan sumber media kompatibel ke Norva"
meta_description: "Siapkan, hubungkan, dan verifikasi satu sumber media kompatibel yang diizinkan di Norva sambil melindungi kredensial dan mencatat bukti pemecahan masalah."
excerpt: "Hubungkan satu sumber kompatibel yang diizinkan melalui alur pengelolaan sumber Norva, lindungi pengaturannya, tunggu katalog dimuat, dan verifikasi satu item sebelum menambah sumber."
topic_cluster: "Penyiapan dan akun Norva"
sources_heading: "Sumber"
next_step_heading: "Langkah Anda berikutnya"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Cara menghubungkan sumber media kompatibel ke Norva

> **Ringkasnya:** Di web, buka menu akun, lalu Settings dan TV service. Pilih M3U link untuk URL daftar putar lengkap atau Xtream login untuk detail penyedia yang kompatibel. Hubungkan hanya sumber yang Anda miliki atau diizinkan untuk Anda gunakan, rahasiakan kredensialnya, dan verifikasi satu item yang dikenal sebelum menambah sumber. Norva adalah pemutar; tidak menyediakan sumber maupun media.

**Yang diperiksa:** pada 10 September 2026, kami menggunakan akun uji yang sudah masuk di aplikasi web produksi untuk memeriksa formulir dan mengirim satu akses uji Xtream dari pengguna. Pemeriksaan berikutnya memastikan **Ready** (Siap), filter bahasa khusus sumber, dan pencarian yang membuka judul dengan dua belas versi. Tangkapan layar diambil langsung dari web tanpa perubahan dan tanpa detail koneksi pribadi. Impor M3U maupun alur native ponsel/TV tidak diuji; pemutaran berhasil tetap menjadi pemeriksaan terpisah.

## Sebelum memulai

Pastikan keempat kondisi:

- Anda mengendalikan akun Norva.
- Sumber milik Anda atau Anda memiliki izin menggunakannya.
- Ketentuan sumber mengizinkan koneksi yang dimaksud.
- Norva saat ini mendukung metode koneksi sumber.

Siapkan detail resmi sumber langsung dari pemilik sumber atau halaman akunnya. Jangan gunakan pengaturan terusan yang asalnya tidak jelas.

Baca [Yang perlu disiapkan sebelum menambahkan sumber media](/blog/prepare-media-source-setup/) untuk lembar persiapan.

## Langkah 1: Gunakan pintu masuk resmi Norva

Buka Norva dari situs resmi atau aplikasi yang terpasang. Periksa alamat atau identitas aplikasi sebelum memasukkan informasi akun atau sumber.

Masuk ke akun dan profil yang dimaksud. Jika memakai perangkat bersama atau pinjaman, jangan simpan kredensial pribadi kecuali perangkat tepercaya dan ketentuan sumber mengizinkannya.

**Hasil yang dapat diamati:** akun terbuka secara normal dan Anda dapat menjangkau kontrol pengelolaan sumber.

## Langkah 2: Temukan pengelolaan sumber

Di web, buka menu akun, pilih **Settings** (Pengaturan), lalu tab **TV Service** (Layanan TV). Label Inggris ini diterjemahkan ketika bahasa antarmuka lain dipilih. Jika membuka aplikasi membawa Anda ke Beranda, ikuti jalur menu ini; jangan berasumsi tautan pengaturan sumber tersimpan telah membuka panel yang benar.

Pilih **Add playlist** (Tambahkan daftar putar) atau **Add provider** (Tambahkan penyedia) untuk membuka dialog **Add TV service** (Tambahkan layanan TV). Di dalamnya, tab **M3U link** (Tautan M3U) dan **Xtream login** (Login Xtream) memungkinkan Anda mencocokkan formulir dengan informasi yang benar-benar diterima.

Sebelum memasukkan apa pun, periksa apakah sumber lain sudah ada. Menambahkan sumber yang sama dua kali dapat membuat kategori tampak duplikat dan membingungkan diagnosis berikutnya.

**Hasil yang dapat diamati:** formulir penambahan sumber atau pilihan koneksi yang didukung terlihat.

## Langkah 3: Pilih metode kompatibel yang terdokumentasi

Gunakan pembedaan berikut sebelum menempelkan apa pun:

| Yang Anda miliki | Pilihan di Norva | Pemeriksaan pertama |
| --- | --- | --- |
| Satu alamat daftar putar lengkap | M3U link | URL lengkap berasal dari sumber yang diizinkan, bukan halaman unduhan aplikasi. |
| Alamat server dan kredensial kompatibel, atau tautan Xtream lengkap | Xtream login | Pemilik sumber memastikan format ini dan izin Anda untuk menghubungkannya. |
| Hanya nama pengguna dan kata sandi aplikasi lain | My provider only gave me an app login | Minta format sumber yang kompatibel; jangan menebak alamat server. |

![Formulir sumber M3U Norva dengan kolom Playlist URL, nama layanan opsional, dan tombol Add.](/assets/blog/source-m3u-live-web-20260910.jpg "Formulir M3U web produksi, 10 September 2026. Kolomnya kosong; gambar ini bukan bukti impor M3U yang selesai.")

Untuk **M3U link**, masukkan alamat lengkap di **Playlist URL** (URL daftar putar). Formulir Norva menjelaskan alamat `http` atau `https` dan memberikan `.m3u`, `.m3u8`, serta `get.php` sebagai petunjuk umum, bukan bukti izin atau kompatibilitas. **Service name** (Nama layanan) opsional: nama panggilan netral membantu membedakan sumber tanpa menampilkan kredensial.

![Formulir koneksi Xtream Norva menampilkan langkah koneksi pertama serta opsi tautan lengkap atau detail server manual.](/assets/blog/source-xtream-live-web-20260910.jpg "Langkah entri Xtream di aplikasi produksi, diambil sebelum akses uji dimasukkan. Continue menuju pilihan periode akses, bukan langsung ke impor yang selesai.")

Untuk **Xtream login**, alur saat ini dimulai di **Connect provider** (Hubungkan penyedia). Gunakan **Provider URL or complete Xtream link** (URL penyedia atau tautan Xtream lengkap), atau perluas **Enter server login manually** (Masukkan login server secara manual) jika itulah format yang diterima. Tinjau setiap langkah layar berikutnya, jangan menganggap **Continue** (Lanjutkan) sebagai konfirmasi sumber sudah terhubung.

Cocokkan setiap nilai yang diminta dengan informasi resmi sumber. Hindari menambah spasi, mengubah huruf besar/kecil, atau “memperbaiki” alamat kecuali dokumentasi sumber memerintahkannya.

Kebijakan privasi Norva menyatakan pengaturan sumber digunakan untuk menghubungkan layanan ke sumber atas nama pengguna. Tinjau kebijakan itu sebelum mengirim pengaturan sensitif.

### Jika Anda hanya memiliki login aplikasi

Pilih **My provider only gave me an app login** (Penyedia hanya memberi saya login aplikasi). Panel bantuan menjelaskan mengapa kredensial aplikasi terpisah tidak dapat begitu saja diimpor sebagai sumber Norva dan menyediakan pesan permintaan tautan M3U kompatibel atau detail server Xtream. Tanyakan kepada pemilik sumber melalui saluran resminya; jangan tempelkan kata sandi ke kiriman dukungan publik.

![Panel bantuan Norva menjelaskan bahwa login aplikasi memerlukan detail sumber yang kompatibel sebelum dapat dihubungkan.](/assets/blog/source-app-login-help-live-web-20260910.jpg "Panduan web produksi untuk kredensial khusus aplikasi; tidak ada akun penyedia atau tautan pribadi yang ditampilkan.")

## Langkah 4: Masukkan pengaturan secara privat

Gunakan salin dan tempel bila praktis, lalu periksa awal dan akhir setiap nilai yang bukan rahasia. Jangan sertakan kata sandi, tautan pribadi, nama pengguna, dan token dalam:

- tangkapan layar;
- rekaman layar;
- utas dukungan publik;
- catatan analitik;
- dokumen bersama;
- alat riwayat papan klip yang tidak Anda percayai.

Jika televisi menyulitkan entri yang aman, gunakan alur pemasangan atau akun yang terdokumentasi, alih-alih menampilkan kredensial kepada orang lain.

**Hasil yang dapat diamati:** kolom wajib lengkap tanpa rahasia yang terbuka.

## Langkah 5: Simpan sekali dan biarkan pemuatan pertama berlangsung

Pada formulir M3U, gunakan **Add** (Tambahkan) sekali setelah memeriksa URL. Untuk Xtream, **Continue** membuka **Provider access period** (Periode akses penyedia). Pilihan yang terlihat adalah **Duration bought** (Durasi yang dibeli), **Start and end dates** (Tanggal mulai dan berakhir), serta **Add this later** (Tambahkan nanti). Catat hanya ketentuan yang benar-benar Anda ketahui; ini terpisah dari paket Norva Anda.

Dalam pengujian kami, tanggal akses tidak diberikan, sehingga kami memilih **Add this later**, lalu **Continue**, meninjau **Add later / No new dates** (Tambahkan nanti / Tidak ada tanggal baru), dan menggunakan **Finish without dates** (Selesaikan tanpa tanggal) sekali. Penghitung langkah berubah dari lima menjadi tiga untuk alur lebih singkat ini. Jangan mengarang tanggal hanya untuk menyelesaikan penyiapan.

![Pilihan periode akses Norva dengan Add this later terpilih dan penghitung langkah menunjukkan dua dari tiga.](/assets/blog/source-access-period-live-web-20260910.jpg "Alur uji sebenarnya: melanjutkan tanpa mencatat periode akses. Tidak ada pembelian, perpanjangan, atau pengingat yang diatur dalam panduan ini.")

Norva kemudian membuka **Preparing your catalog** (Menyiapkan katalog Anda), menampilkan **Importing** (Sedang mengimpor), dan menandai pemeriksaan koneksi sebagai **Done** (Selesai). Jumlah judul terdeteksi mulai bertambah sementara persiapan katalog masih berlangsung. Ini pengamatan yang terpisah: kredensial diterima tidak berarti setiap judul sudah siap diputar.

![Panel persiapan katalog Norva untuk sumber uji bernama netral, menunjukkan Importing serta tahap koneksi dan katalog yang terpisah.](/assets/blog/source-importing-live-web-20260910.jpg "Status impor antara yang nyata, bukan katalog selesai. Jumlah dan progres mencerminkan sumber uji ini saat gambar diambil; bukan janji kecepatan atau kapasitas.")

Pemutar mungkin perlu waktu untuk mengambil kategori, informasi katalog, atau data panduan. Jangan berulang kali mengirim atau menghapus sumber saat pemuatan normal masih berlangsung.

Tidak ada waktu pemuatan universal yang dapat dijanjikan. Ukuran sumber, koneksi, dan perangkat dapat memengaruhi hasil pertama.

**Hasil yang dapat diamati:** Norva menerima pengaturan atau menampilkan kesalahan spesifik yang dapat dicatat.

## Langkah 6: Verifikasi satu item yang dikenal

Ketika pustaka mencapai keadaan stabil:

1. periksa bagian utama yang diharapkan;
2. buka satu kategori yang diharapkan;
3. cari satu item yang dikenal;
4. verifikasi judul, tahun, atau identitas episode jika tersedia;
5. periksa informasi bahasa atau takarir yang disediakan sumber;
6. jangan menganggap metadata opsional yang hilang berarti seluruh koneksi gagal.

Misalnya, pilih satu judul yang keberadaannya dipastikan pemilik sumber. Jika kategorinya dimuat tetapi judul tidak muncul, catat hasil spesifik itu. Jika muncul tetapi gagal diputar, pemuatan katalog berhasil; pemutaran masih memerlukan pemeriksaan terpisah. Tidak satu pun pengamatan itu membuktikan seluruh sumber berfungsi atau rusak.

**Diamati dalam pemeriksaan lanjutan:** sumber yang sama ditandai **Ready** di **Settings → TV Service**. Kami membuka **Movies** (Film), memilih **Blog walkthrough test** di **Source** (Sumber), dan menggunakan **Audio language → Albanian** (Bahasa audio → Bahasa Albania). Kartu hasil menampilkan **Albanian**. Setelah **Clear all** (Hapus semua), pencarian judul yang dikenal membuka detail dengan dua belas versi, tahun, dan sinopsis. Tidak diperlukan sumber duplikat atau pengiriman ulang manual.

![Filter film Norva dengan sumber uji dan audio Albania terpilih, bersama kontrol kategori dan takarir terpisah.](/assets/blog/catalog-audio-filter-live-web-20260910.jpg "Pemeriksaan lanjutan setelah sumber mencapai Ready, 10 September 2026. Jumlah yang ditampilkan adalah cuplikan sumber uji pengguna ini, bukan janji mengenai konten atau kapasitas katalog Norva.")

### Jangan samakan label sumber dengan trek audio yang terverifikasi

Filter audio saat ini menyatukan label bahasa yang dikenali dan informasi trek berkas terdeteksi dalam kontrol penelusuran yang sama. Hal ini membuat label sumber berguna untuk menemukan versi, tetapi tidak mengubah negara, nama koleksi, atau awalan judul menjadi bukti trek di dalam berkas tersebut. Jika informasi trek sebenarnya tersedia, gunakan untuk memilih versi. Petunjuk regional seperti **Nordic languages** (Bahasa-bahasa Nordik) tidak menunjukkan satu bahasa lisan tertentu.

Gunakan pemeriksaan terpisah untuk setiap lapisan:

| Hasil yang terlihat | Yang dipastikan | Yang masih perlu diperiksa |
|---|---|---|
| Sumber menunjukkan Ready | Norva melaporkan katalog siap | Metadata setiap item dan kompatibilitas pemutaran |
| Judul muncul di bawah sumber terpilih | Item dapat ditemukan di katalog saat ini | Item lain dan versi terpilih |
| Kategori sumber muncul | Label pengelompokan diterima | Apakah genre film yang terverifikasi tersedia |
| Filter bahasa menghasilkan satu versi | Informasi bahasa yang tersedia cocok dengan filter | Trek yang benar-benar dapat dipilih dalam berkas dan pemutar |
| Language unidentified (Bahasa tidak teridentifikasi) | Tidak ada hasil bahasa audio yang dapat digunakan sedang ditampilkan | Ketersediaan trek sebenarnya dan status analisis |
| Halaman pemutar terbuka | Navigasi ke pemutar berhasil | Bingkai video, pemutaran yang maju, dan audio yang dapat digunakan |

Pemeriksaan terbaru menguji navigasi katalog, bukan pemutaran video. Percobaan sebelumnya saat penyiapan membuka pemutar tanpa memastikan video bergerak maju sebelum kembali melalui **Back** (Kembali). Karena itu, kami tidak menyajikan status Ready, penanda bahasa, atau gambar sebagai bukti bahwa sesi menonton berhasil.

## Langkah 7: Uji satu tindakan akun

Tambahkan satu favorit atau simpan sedikit progres pemutaran. Kembali ke pustaka dan pastikan status yang terlihat.

Ini menguji perbedaan antara data sumber dan konteks akun. Tidak membuktikan setiap item, format, atau perangkat kompatibel.

Favorit uji kami masih ada saat katalog dibuka lagi kemudian. Kami lalu menghapusnya dan memuat ulang untuk memastikan status awal. Saat langsung kembali dari detail, status terbaru belum terlihat, sehingga pengamatan ini memvalidasi persistensi item itu, bukan umpan balik seketika atau sinkronisasi lintas perangkat.

Rencana sesi pertama yang lebih luas ada di [Memulai Norva](/blog/norva-getting-started/).

## Jika koneksi hanya berhasil sebagian

Hasil parsial lebih informatif daripada “tidak berfungsi”. Catat lapisan yang berhasil:

- Apakah pengaturan diterima?
- Apakah ada kategori yang muncul?
- Apakah judul dimuat tetapi gambar gagal?
- Apakah informasi katalog dimuat tetapi data panduan tetap kosong?
- Apakah satu item yang dikenal terbuka?
- Apakah pemutaran gagal hanya di satu perangkat?

Ubah satu variabel setiap kali. Periksa ulang detail sumber sebelum memasang ulang aplikasi. Simpan tangkapan layar kesalahan yang disamarkan hanya setelah memastikan tidak ada kredensial di dalamnya.

## Keamanan dan pembersihan akun

Setelah penyiapan berhasil:

- tinjau perangkat tepercaya;
- hapus perangkat yang tidak lagi Anda kendalikan;
- rahasiakan catatan sumber;
- catat tempat izin dan ketentuan dapat ditinjau;
- putuskan sumber jika izin berakhir;
- ubah kredensial yang terpapar melalui proses resmi pemilik sumber.

Halaman privasi dan penghapusan akun Norva menjelaskan kontrol yang tersedia untuk data akun Norva.

## Keterbatasan

Koneksi berhasil tidak berarti setiap kolom sumber lengkap, setiap format media berfungsi pada setiap perangkat, atau akses offline tersedia. Bahasa dan takarir bergantung pada sumber dan media. Penggunaan offline bergantung pada perangkat, sumber, dan hak terkait.

Bukti mencakup kontrol web terkini, satu pengiriman Xtream, status Ready berikutnya, filter audio khusus sumber, pencarian/detail satu judul, dan persistensi/penghapusan satu favorit setelah dibuka kembali. Ini tidak membuktikan setiap rekaman katalog lengkap atau dapat diputar. Pemutaran berhasil dan umpan balik favorit langsung tidak divalidasi. Impor M3U, alur native ponsel/TV, penggunaan offline, dan kesinambungan lintas perangkat belum dinyatakan lulus oleh pengujian web ini.

## Pertanyaan yang sering diajukan

### Mengapa sebaiknya menambah hanya satu sumber dahulu?

Ini memberikan acuan awal yang jelas. Jika kategori, judul, atau kesalahan muncul, Anda tahu sumber yang menghasilkannya.

### Bolehkah saya membagikan tangkapan layar koneksi kepada dukungan?

Hanya setelah menyamarkan semua kata sandi, tautan pribadi, nama pengguna, token, dan pengenal pribadi. Gunakan jalur dukungan resmi Norva.

### Bagaimana jika Norva menerima pengaturan tetapi tidak ada yang muncul?

Tunggu pemuatan awal normal, lalu verifikasi detail dan koneksi. Catat apakah hasil benar-benar kosong atau dimuat sebagian sebelum menghubungi dukungan.

## Langkah Anda berikutnya

[Buka Norva dan hubungkan sumber Anda](https://norva.tv/app)

Setelah masuk, gunakan menu akun, **Settings**, lalu **TV Service** seperti ditunjukkan di atas.

## Sumber

- [Cara kerja Norva](https://norva.tv/#how-it-works)
- [Ketentuan Layanan Norva](https://norva.tv/terms)
- [Kebijakan Privasi Norva](https://norva.tv/privacy)
- [Dukungan Norva](https://norva.tv/support)

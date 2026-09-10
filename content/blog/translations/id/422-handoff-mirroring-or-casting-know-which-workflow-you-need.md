---
language: "id"
source_slug: "handoff-mirroring-or-casting-know-which-workflow-you-need"
source_sha256: "b46f9a584d473e98e7d7972e1d512ff3202c7d9490c7c540717f8958313a123e"
title: "Handoff, Pencerminan, atau Casting: Kenali Alur yang Anda Perlukan"
seo_title: "Handoff, Pencerminan Layar, atau Casting: Mana yang Dipilih?"
meta_description: "Pilih handoff untuk menonton mandiri, pencerminan untuk salinan layar, atau casting untuk pemutaran penerima. Bandingkan kontrol, privasi, akses, dan perangkat."
excerpt: "Tentukan apakah Anda memerlukan aplikasi mandiri, salinan layar, atau pemutaran penerima yang dikendalikan dari ponsel, lalu periksa persyaratan jalur tersebut."
topic_cluster: "Peralihan menonton lintas perangkat"
sources_heading: "Sumber"
next_step_heading: "Langkah Anda berikutnya"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Handoff, Pencerminan, atau Casting: Kenali Alur yang Anda Perlukan

> **Singkatnya:** Gunakan handoff untuk melanjutkan secara mandiri dalam aplikasi perangkat tujuan. Gunakan pencerminan layar untuk menampilkan salinan layar Anda pada layar lain. Gunakan casting berbasis penerima untuk memilih media di satu perangkat dan mengendalikan pemutaran di perangkat lain. Pilih berdasarkan perilaku yang diperlukan, lalu periksa persyaratan aplikasi, penerima, jaringan, dan sumber; kata “cast” saja tidak mengidentifikasi jalurnya.

“Tampilkan ini di TV” dapat berarti tiga hal berbeda: memindahkan progres menonton, menyalin antarmuka saat ini, atau menggunakan ponsel sebagai remote. Koneksi yang berhasil masih bisa merupakan alur yang salah jika tidak melakukan apa yang Anda harapkan.

Di sini, **perangkat sumber** berarti ponsel atau komputer tempat Anda memulai; **sumber media** berarti layanan atau file yang menyediakan media yang diizinkan untuk Anda gunakan. Keduanya tidak dapat dipertukarkan.

## Bandingkan ketiga alur kerja

| Alur kerja | Asal pengalaman yang terlihat | Perangkat sumber setelah dimulai | Verifikasi utama |
| --- | --- | --- | --- |
| Handoff | Aplikasi tujuan yang dibuka secara mandiri | Tidak diperlukan untuk merender sesi tujuan | Akun, profil, sumber, item, versi, progres |
| Pencerminan layar | Reproduksi layar sumber yang dibagikan | Terus memasok layar yang ditampilkan | Dukungan sistem operasi dan layar; apa yang dibagikan |
| Casting berbasis penerima | Media diputar oleh penerima, dipilih dari pengirim | Menyediakan kontrol sesi; ketergantungan selanjutnya bervariasi | Dukungan pengirim, penerima, media, jaringan, dan hak |

Ini adalah kategori praktis, bukan nama protokol yang kaku. Google mendokumentasikan [casting tab atau layar Chrome](https://support.google.com/chromecast/answer/3228332?hl=en) maupun [pemutaran penerima yang dikendalikan pengirim](https://developers.google.com/cast/docs/overview). Panduan ini menggunakan “casting berbasis penerima” untuk yang kedua agar Anda dapat membedakan perilaku yang dimaksud sebelum mengikuti petunjuk penyiapan.

## Pilih handoff untuk kesinambungan

Handoff cocok ketika tujuannya “selesaikan item ini di aplikasi TV” atau “pindah dari tablet ke web”. [Halaman fitur publik](https://norva.tv/#features) Norva menjelaskan bahwa progres, favorit, riwayat, dan preferensi profil mengikuti Anda di berbagai layar yang didukung. Itu adalah kesinambungan konteks menonton, bukan salinan layar pertama.

Perangkat tujuan tetap memerlukan jalur Norva tersendiri yang didukung dan akses ke sumber media kompatibel. Jeda sesi pertama, pastikan profil dan versi item yang dimaksud pada tujuan, lalu verifikasi posisi lanjut sebelum memutar. [Panduan handoff menurut keadaan](/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/) membahas urutan itu. Poster yang cocok saja tidak cukup untuk mengidentifikasi episode atau edisi yang sama.

**Pilih ini ketika:** Anda ingin tujuan menjadi layar utama tanpa mereproduksi layar sumber.

## Pilih pencerminan untuk salinan layar yang persis

Pencerminan layar mereproduksi tampilan yang dibagikan, bukan membuka salinan aplikasi tujuan secara mandiri. Berbagi seluruh layar dapat memperlihatkan navigasi, notifikasi, detail akun, atau aktivitas layar lainnya. Berbagi tab atau satu aplikasi memiliki cakupan lebih sempit jika platform menyediakannya; jangan menganggap semua mode tersebut menampilkan hal yang sama.

Periksa cakupan berbagi sebelum memulai dan tutup materi pribadi yang dapat muncul di dalamnya. Verifikasi gambar sekaligus suara: petunjuk Chrome dari Google membedakan casting tab dari seluruh layar dan mencatat bahwa audio casting layar dapat tetap berada di komputer. Gambar yang terlihat bukan bukti bahwa suara juga telah berpindah.

**Pilih ini ketika:** kebutuhan sebenarnya adalah menampilkan antarmuka atau layar nonmedia yang sama kepada penonton lain, dan dukungan pencerminan telah diverifikasi.

## Pilih pemutaran jarak jauh untuk alur penerima

Dalam model Cast Google, pengirim memulai dan mengendalikan sesi, sedangkan penerima menangani pemutaran media. Penerima bukan sekadar salinan kedua dari seluruh isi layar ponsel. Apakah sesi bertahan setelah pengirim ditutup atau kehilangan koneksi bergantung pada implementasi sebenarnya; periksa, jangan menganggapnya independen dari ponsel.

Alur penerima memerlukan kemampuan pengirim dan penerima yang kompatibel. Halaman utama publik Norva mencantumkan **Google Cast**, terpisah dari aplikasi Android TV dan kesinambungan lintas layar. Ketersediaan yang dipublikasikan itu bukan pengujian penerima, format media, trek subtitel, atau jaringan Anda secara khusus. Artikel ini tidak melaporkan pengujian casting Norva yang telah selesai.

[Draf W3C Remote Playback API](https://www.w3.org/TR/remote-playback/) menjelaskan keluarga mekanisme pemutaran jarak jauh yang lebih luas, termasuk ketika sumber masih merender atau meneruskan media. [Draf Presentation API](https://www.w3.org/TR/presentation-api/) membahas penyajian konten web pada layar lain. Tidak satu pun spesifikasi tersebut membuktikan bahwa aplikasi mengimplementasikan API tertentu atau bahwa setiap penerima kompatibel.

**Pilih ini ketika:** tujuan dirancang untuk menerima pemutaran dan pengirim, penerima, media, jaringan, hak sumber, serta dokumentasi produk saat ini semuanya mendukung jalur itu.

## Gunakan pertanyaan yang mendahulukan tujuan

Tanyakan:

1. Apakah saya ingin perangkat tujuan menjalankan aplikasinya sendiri setelah peralihan?
2. Apakah saya perlu membagikan seluruh layar, satu aplikasi saja, atau hanya media?
3. Apakah saya ingin tetap mengendalikan pemutaran dari perangkat sumber?
4. Informasi pribadi apa yang berada dalam cakupan berbagi yang dipilih?
5. Dapatkah jalur yang dipilih mengakses sumber media yang diizinkan?
6. Apakah fungsi itu didokumentasikan untuk perangkat dan versi aplikasi ini?
7. Apakah ketentuan paket perangkat lunak dan sumber media saat ini mengizinkan penggunaan yang dimaksud?

Jika jawabannya bertentangan, jangan mengaktifkan ikon koneksi secara acak. Perjelas tujuannya terlebih dahulu.

## Kontribusi orisinal: kartu pemilihan

Kartu lengkap berikut adalah **ilustrasi yang dibuat penulis**, bukan catatan pengujian produk. Orang, judul, dan posisi jeda bersifat fiktif. Setiap pilihan mengikuti tujuan yang dinyatakan; kolom terakhir adalah pekerjaan yang masih perlu dilakukan, bukan pemeriksaan yang sudah berhasil.

| Situasi yang dinyatakan | Alur yang dipilih | Mengapa cocok | Periksa sebelum digunakan |
| --- | --- | --- | --- |
| Maya menjeda film fiktif Harbour Walk pada 18:40 di ponsel dan ingin menyelesaikannya dalam aplikasi TV dengan remote TV | Handoff | TV seharusnya menjalankan sesi mandiri dengan konteks tersimpan yang benar | Profil sama, sumber yang diizinkan, versi tepat, dan posisi lanjut pada aplikasi TV yang didukung |
| Jules ingin orang lain melihat panel filter yang sedang terbuka di laptop | Pencerminan atau mode berbagi aplikasi/jendela yang didukung | Antarmuka itu sendiri, bukan hanya video, harus muncul pada layar | Cakupan berbagi yang tepat, dukungan layar, dan tidak adanya materi pribadi |
| Sam ingin memilih film di ponsel dan terus menggunakan kontrol pemutaran ponsel itu untuk penerima di ruang keluarga | Casting berbasis penerima | Pengirim mengendalikan pemutaran penerima tanpa membagikan seluruh antarmuka ponsel | Pengirim dan penerima yang didukung, media yang dapat dijangkau, penggunaan yang diizinkan, serta trek audio/subtitel yang diperlukan |

Keputusannya berbeda meskipun ketiganya mengatakan “tampilkan di layar besar”. Gunakan kembali empat kolom itu dengan situasi Anda. Jika pemeriksaan terakhir belum diketahui, pilihannya masih sementara; label fitur yang menarik tidak menuntaskan pemeriksaan itu.

## Verifikasi sebelum bertindak

Untuk TV bersama, sepakati progres dan preferensi siapa yang seharusnya berubah. [Panduan memilih profil terpisah atau bersama](/blog/separate-profiles-or-one-shared-profile-a-decision-framework/) membantu menentukannya sebelum pemutaran. Untuk alur penerima, periksa panduan Norva dan produsen perangkat terkini; jangan menyimpulkan dukungan dari bentuk ikon, tutorial lama, atau aplikasi lain.

Periksa ketersediaan audio dan subtitel pada tujuan juga. Gambar yang berhasil tidak membuktikan bahwa setiap [trek subtitel tertanam atau terpisah](/blog/built-in-and-separate-subtitle-tracks-what-viewers-need-to-know/) sampai ke tujuan. Catat versi aplikasi, model penerima, versi item yang dipilih, dan hasil terlihat jika membutuhkan bantuan; jangan membagikan kredensial sumber.

## Keterbatasan dan kesalahan umum

Istilah berbeda antar platform. Beberapa produk menggabungkan penemuan, kontrol, dan tampilan di bawah satu label. Artikel ini menyediakan kerangka keputusan, bukan petunjuk penyiapan khusus perangkat.

Kesalahan umum mencakup menyamakan handoff dengan pencerminan, menganggap setiap aplikasi TV adalah penerima, memperlihatkan notifikasi saat mencerminkan, menyamakan jumlah profil dengan izin penggunaan bersamaan, dan mengharapkan trek identik pada setiap jalur. Norva adalah perangkat lunak pemutar media; tidak ada konten atau langganan TV yang disertakan. Metode koneksi tidak memberikan hak atas media atau mengesampingkan ketentuan akses sumber.

## Pertanyaan yang sering diajukan

### Apakah sinkronisasi lintas perangkat Norva berarti mendukung casting?

Sinkronisasi saja tidak membuktikan dukungan casting. Norva mencantumkan Google Cast secara terpisah pada halaman utama publiknya. Periksa pengirim, penerima, sumber, dan media yang didukung untuk jalur yang hendak digunakan; panduan ini belum menguji kombinasi perangkat itu.

### Apakah pencerminan paling baik untuk video?

Tidak secara universal. Pencerminan dapat mereproduksi seluruh layar sumber dan tetap melibatkan sumber. Pilih berdasarkan tujuan sebenarnya dan jalur yang didukung.

### Bolehkah istilah-istilah itu dipakai bergantian?

Hindari melakukannya. Sebutkan perilaku sumber dan tujuan yang diharapkan agar dukungan dan anggota rumah tangga memahami alurnya.

## Langkah Anda berikutnya

Pilih satu baris dari kartu pemilihan, lalu [tinjau fitur lintas perangkat Norva](https://norva.tv/#features) berdasarkan tujuan itu. Nyatakan dengan jelas pemeriksaan perangkat dan sumber yang masih tersisa sebelum memindahkan sesi.

## Sumber

- [Google Cast: gambaran pengirim dan penerima](https://developers.google.com/cast/docs/overview)
- [Dukungan Google: casting tab atau layar Chrome ke TV](https://support.google.com/chromecast/answer/3228332?hl=en)
- [Draf W3C Remote Playback API](https://www.w3.org/TR/remote-playback/)
- [Draf W3C Presentation API](https://www.w3.org/TR/presentation-api/)
- [Fitur Norva](https://norva.tv/#features)


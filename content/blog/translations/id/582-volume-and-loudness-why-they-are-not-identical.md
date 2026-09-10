---
language: "id"
source_slug: "volume-and-loudness-why-they-are-not-identical"
source_sha256: "c5afea01c019d7d716ee9c9381688084918f14896336a67afc5e83d8a17ed1d1"
title: "Volume dan Kenyaringan: Mengapa Keduanya Berbeda"
seo_title: "Volume dan Kenyaringan: Apa Perbedaannya?"
meta_description: "Penggeser volume bukan pengukur kenyaringan. Bandingkan gain, kenyaringan program, puncak, rentang dinamis, dan perubahan keluaran tanpa menebak dari satu angka."
excerpt: "Pengaturan volume sama dapat menghasilkan tingkat dengar berbeda. Pisahkan gain sinyal, kenyaringan program, puncak, dan jalur keluaran dengan contoh hitung serta daftar pemeriksaan."
topic_cluster: "Literasi kualitas audio"
sources_heading: "Sumber"
next_step_heading: "Langkah Anda berikutnya"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Volume dan Kenyaringan: Mengapa Keduanya Berbeda

> **Singkatnya:** Kontrol volume mengubah gain pada suatu titik dalam rantai pemutaran. Kenyaringan adalah seberapa kuat suara terasa; pengukuran kenyaringan program memperkirakannya dari sinyal audio dengan metode tertentu. Rekaman, campuran suara, dan pemrosesan memengaruhi sinyal itu, sedangkan perangkat keluaran serta lingkungan mendengarkan juga memengaruhi yang Anda dengar. Posisi penggeser sama tidak menjamin tingkat dengar yang sama.

Jika satu film terdengar jauh lebih keras daripada film lain tanpa menyentuh remote, kontrol volumenya belum tentu berubah. Anda mungkin mendengar campuran suara, trek, atau mode pemrosesan berbeda. Mulailah dengan memisahkan pengaturan kontrol dari audio yang dipengaruhinya, bukan menganggap angka tampilan sebagai ukuran seluruh pengalaman.

## Petakan setiap tahap gain

Gain berarti penskalaan sinyal pada tahap tertentu. Gain digital sederhana mengalikan setiap sampel dengan suatu nilai; [dokumentasi GainNode MDN](https://developer.mozilla.org/en-US/docs/Web/API/GainNode) menunjukkan prinsip itu. Penggeser pada produk konsumen tidak harus menampilkan pengali tersebut secara langsung, dan pengaturan “50” bukan tingkat akustik universal atau jaminan separuh kenyaringan yang dirasakan.

Catat kontrol yang benar-benar berlaku: volume pemutar, tingkat media sistem operasi, tingkat TV atau penerima, kontrol headphone, dan penyesuaian per trek. Sebagian kontrol mungkin saling terhubung, sedangkan tahap lain mungkin tetap atau dilewati pada jalur yang dipilih. Pastikan perangkat mana yang menghasilkan suara sebelum mengubah satu kontrol setiap kali.

## Pahami kenyaringan program

[ITU-R BS.1770](https://www.itu.int/rec/R-REC-BS.1770/en) mendefinisikan algoritma pengukuran kenyaringan program dan puncak sejati. Pembacaan kenyaringan program menggambarkan sinyal audio menurut metode tersebut; tidak langsung mengukur tekanan suara pada telinga Anda. Rekomendasi itu juga mencatat bahwa kenyaringan terukur memperkirakan persepsi dengan ketidakpastian yang berbeda menurut pendengar, materi, dan kondisi mendengarkan.

Anda mungkin menemukan **LUFS**, satuan kenyaringan yang mengacu pada skala penuh digital. Pembacaan terintegrasi mencakup program atau cuplikan yang dianalisis, sedangkan pembacaan jangka pendek menggambarkan jendela lebih kecil. Sebutkan metode, kanal, interval analisis, serta apakah pengukuran dilakukan sebelum atau sesudah pemrosesan. Jangan memberi label hasil seluruh film pada sampel dialog singkat.

[EBU R 128](https://tech.ebu.ch/publications/r128) menggunakan pengukuran kenyaringan dalam kerangka normalisasi siaran dan membedakan kenyaringan dari tingkat puncak sejati maksimum. Ini bukan target universal setiap aplikasi konsumen dan tidak mengubah penggeser volume menjadi alat ukur.

## Pisahkan puncak dan rentang dinamis

Puncak sampel menggambarkan nilai absolut terbesar dari sampel yang direkam; pengukuran puncak sejati memperkirakan puncak gelombang yang dapat terjadi di antara sampel. Tidak satu pun angka itu memberi tahu seberapa terus-menerus program tetap keras. Benturan singkat dan dialog berkelanjutan dapat mencapai puncak sama sambil menghasilkan tingkat dengar keseluruhan yang berbeda.

Rentang dinamis berkaitan dengan perbedaan antara materi lebih pelan dan lebih keras. Menaikkan pengaturan volume tetap menaikkan keduanya; tidak secara selektif mendekatkan dialog pelan ke efek keras. Pemrosesan rentang dinamis menangani masalah berbeda. Misalnya, [panduan resmi Sony](https://www.sony.com/electronics/support/televisions-projectors/articles/00203665) menjelaskan pengaturan yang mengubah perbedaan itu pada TV dan format audio tertentu. Ini contoh khusus perangkat, bukan klaim bahwa Norva menawarkan pengaturan sama.

## Kontribusi orisinal: kartu gain-kenyaringan

Ini adalah **contoh aritmetika yang disusun**, bukan media terukur, uji mendengarkan, atau pengaturan volume Norva. Anggap terdapat dua sinyal digital dengan puncak sampel di bawah dan gain linear sederhana sebesar 0.5. Nilai puncak tanpa satuan merupakan pecahan skala penuh digital, bukan desibel atau pengukuran tekanan suara. Tidak ada pemrosesan lain yang disertakan.

| Sinyal rekaan | Sampel input absolut terbesar | Pengali gain | Puncak sampel keluaran yang dihitung | Kenyaringan program atau tingkat pada telinga |
| --- | --- | --- | --- | --- |
| A | 0.20 | 0.5 | 0.20 × 0.5 = 0.10 | Tidak diketahui dari nilai ini |
| B | 0.60 | 0.5 | 0.60 × 0.5 = 0.30 | Tidak diketahui dari nilai ini |

Gain sama menyisakan puncak keluaran berbeda karena sinyal input berbeda. Puncak sampel B yang dihitung adalah tiga kali A, tetapi itu **tidak** berarti B terdengar tiga kali lebih keras. Sisa setiap sinyal, durasinya, peralatan keluaran, dan kondisi mendengarkan belum ditentukan.

Menyamakan puncak tersebut tetap tidak membuktikan kenyaringan program yang sama. Kartu ini sengaja berhenti pada apa yang dibuktikan aritmetika; tidak dapat memberikan pembacaan LUFS, peringkat kualitas, atau tingkat headphone yang aman. Pengali 0.5 juga tidak menyiratkan bahwa penggeser produk tertentu harus diatur ke 50%.

## Bandingkan trek pada tingkat yang disetarakan

Jika pertanyaannya adalah trek mana yang lebih jelas, hindari menjadikan tingkat suara sebagai perbedaan yang tidak dikendalikan. Gunakan prosedur kecil berikut dengan media yang diizinkan untuk Anda putar:

1. Kenali label dan peran kedua trek. Trek komentar bukan campuran yang sama dengan soundtrack utama; gunakan [panduan daftar trek audio](/blog/how-to-read-an-audio-track-list-before-playback/) jika label tidak jelas.
2. Pilih bagian sama pada kedua versi. Catat waktu awal dan akhir, serta sertakan dialog dan momen lebih keras jika itulah masalah yang diselidiki.
3. Pertahankan perangkat, jalur keluaran, posisi mendengarkan, dan keadaan pemrosesan. Catat pengaturan yang tidak diketahui alih-alih menganggapnya nonaktif.
4. Bandingkan pada tingkat rendah yang nyaman. Turunkan trek yang terasa lebih keras saat menyetarakan tingkat secara kasar; jangan menaikkan trek lebih pelan sampai efek keras menjadi tidak nyaman. Jika memakai pengukur kenyaringan yang valid, catat metode dan cakupannya secara terpisah.
5. Ganti urutan dan catat pengamatan terbatas, misalnya “dialog tetap sulit diikuti setelah penyetaraan tingkat secara perkiraan”. Jangan mengubah preferensi informal menjadi klaim keunggulan terukur.

Penyetaraan berdasarkan telinga bersifat perkiraan, bukan hasil kepatuhan standar. Jika bagian tersebut tidak dapat dibandingkan dengan nyaman, hentikan perbandingan.

## Perhitungkan normalisasi

Normalisasi kenyaringan menyesuaikan gain program atau pemutaran menuju hubungan kenyaringan yang ditentukan. Normalisasi puncak menggunakan kriteria puncak. Kedua istilah itu sendiri tidak berarti dialog pelan dan efek keras menjadi lebih dekat dalam suatu program; hal itu memerlukan perubahan tingkat relatif keduanya.

Target, cakupan pengukuran, penanganan puncak, dan kontrol pengguna bergantung pada implementasi. Periksa dokumentasi aplikasi, TV, penerima, atau headphone untuk normalisasi atau pemrosesan dinamis yang aktif. Artikel ini tidak menetapkan target normalisasi Norva atau mengklaim bahwa Norva menerapkan EBU R 128.

## Perhitungkan sensitivitas keluaran dan ruangan

Headphone dan speaker dapat menghasilkan tingkat akustik berbeda dari sinyal digital atau pengaturan tampilan yang sama. Kesesuaian pemasangan, jarak, pantulan ruangan, kebisingan latar, dan pemrosesan perangkat juga memengaruhi pendengaran. Jika beralih keluaran, Anda mengubah perbandingan meskipun angka pada layar tetap sama.

Jika detail pelan tertutup kebisingan ruangan, selidiki lingkungan atau gunakan [cakupan takarir yang sesuai](/blog/captions-and-subtitles-why-the-accessibility-goals-can-differ/) alih-alih terus menaikkan volume. [Panduan mendengarkan aman WHO](https://www.who.int/news-room/questions-and-answers/item/deafness-and-hearing-loss-safe-listening) menekankan tingkat suara serta durasi paparan, dan menyarankan jeda serta mengurangi kebutuhan menaikkan suara di lingkungan bising. Kenyamanan saja bukan pengukuran paparan.

## Laporkan perbedaan tingkat suara

Catat item/versi, label trek yang tepat, waktu cuplikan, kontrol volume yang berlaku, keadaan pemrosesan, jalur dan perangkat keluaran, kondisi ruangan, metode perbandingan, serta hasil. Sertakan pengukuran valid hanya jika tersedia, beserta cakupannya. “Tidak ada pengukuran kenyaringan; pemrosesan TV tidak diketahui” lebih berguna daripada perkiraan desibel yang dikarang dari penggeser.

[Panduan kualitas audio lengkap](/blog/the-complete-guide-to-understanding-audio-quality/) memetakan bagian rantai lainnya.

## Kesalahan umum dan keterbatasan

Hindari membandingkan angka penggeser antar perangkat, menyamakan pencocokan puncak dengan pencocokan kenyaringan, atau menggunakan pembacaan tingkat suara ponsel yang belum divalidasi sebagai bukti terkalibrasi. Mikrofon ponsel di dekat speaker juga bukan pengukuran langsung suara di dalam headphone. Mendengarkan secara informal bukan uji kepatuhan kenyaringan formal, penilaian pendengaran, atau bukti bahwa codec maupun pemutar lebih baik.

## Periksa tingkat setelah perubahan jalur

Saat beralih dari speaker ke headphone atau penerima, periksa tingkat tujuan sebelum memulai atau melanjutkan pemutaran dan mulai dari tingkat rendah. Catat tahap gain yang aktif, bukan menyalin angka sebelumnya. Jika jalur dan media diubah bersamaan, kembali ke bagian yang dikenal pada tingkat rendah sebelum memutuskan bahwa trek baru menyebabkan perbedaan.

## Pertanyaan yang sering diajukan

### Apakah volume sama dengan kenyaringan program?

Tidak. Kontrol volume mengatur gain pada suatu tahap pemutaran. Pembacaan kenyaringan program mencirikan sinyal menurut metode pengukuran tertentu; keduanya tidak sendirian menentukan tingkat akustik pada telinga Anda.

### Apakah nilai penggeser yang sama menghasilkan kenyaringan sama pada dua perangkat?

Tidak. Struktur gain, penguat, sensitivitas keluaran, speaker atau headphone, ruangan, dan pemrosesan berbeda.

### Apakah normalisasi puncak sama dengan normalisasi kenyaringan?

Tidak. Pengukuran puncak dan kenyaringan menggambarkan sifat berbeda serta mendukung alur kerja berbeda.

## Langkah Anda berikutnya

Sebelum membandingkan versi lain, catat trek dan jalur keluaran yang benar-benar digunakan. Lalu [jelajahi fitur pemutaran Norva](https://norva.tv/#features) tanpa menganggap adanya mode normalisasi yang tidak didokumentasikan. Norva adalah perangkat lunak pemutar media, tanpa konten atau langganan TV yang disertakan; media harus berasal dari sumber kompatibel yang diizinkan untuk Anda gunakan.

## Sumber

- [MDN: gain digital dan GainNode](https://developer.mozilla.org/en-US/docs/Web/API/GainNode)
- [ITU-R BS.1770: kenyaringan program dan puncak sejati](https://www.itu.int/rec/R-REC-BS.1770/en)
- [EBU R 128: normalisasi kenyaringan](https://tech.ebu.ch/publications/r128)
- [Sony: pengaturan rentang dinamis dan format yang berlaku](https://www.sony.com/electronics/support/televisions-projectors/articles/00203665)
- [WHO: mendengarkan aman, tingkat, dan durasi paparan](https://www.who.int/news-room/questions-and-answers/item/deafness-and-hearing-loss-safe-listening)
- [Fitur Norva](https://norva.tv/#features)


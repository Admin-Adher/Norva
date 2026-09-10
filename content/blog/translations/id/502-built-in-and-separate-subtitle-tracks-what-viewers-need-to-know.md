---
language: "id"
source_slug: "built-in-and-separate-subtitle-tracks-what-viewers-need-to-know"
source_sha256: "98b9d0bbd83440fb5f247e1595988ce7cc53b352a8396f7bd1e88988ce55ed90"
title: "Trek Subtitel Bawaan dan Terpisah: Yang Perlu Diketahui Penonton"
seo_title: "Subtitel Tertanam, Eksternal, dan Menyatu dengan Gambar"
meta_description: "Bandingkan trek subtitel tertanam, file eksternal, dan teks yang menyatu dengan gambar. Pahami arti kontainer, pemilih trek, dan kontrol nonaktif."
excerpt: "Trek tertanam bukan teks yang menyatu dengan gambar. Bandingkan pengemasan subtitel melalui contoh lengkap, lalu bedakan bukti dari pemilih dan hal yang belum diketahui."
topic_cluster: "Pengelolaan subtitel"
sources_heading: "Sumber"
next_step_heading: "Langkah Anda berikutnya"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Trek Subtitel Bawaan dan Terpisah: Yang Perlu Diketahui Penonton

> **Singkatnya:** Data subtitel tertanam disimpan di dalam kontainer media; subtitel eksternal disimpan terpisah dan dikaitkan dengan media. Keduanya dapat menjadi trek yang bisa dipilih jika didukung. Subtitel yang menyatu dengan gambar sudah menjadi bagian dari gambar video dan tidak dapat dinonaktifkan sebagai trek. Pemilih subtitel yang berfungsi membuktikan bahwa kontrol bekerja, bukan lokasi penyimpanan data subtitel.

“Bawaan” sering dipakai untuk trek tertanam maupun teks yang dirender permanen ke dalam gambar. Ambiguitas itu penting: yang satu mungkin dapat dipilih, sedangkan yang lain merupakan bagian gambar itu sendiri. Mulailah dari cara media dikemas, lalu periksa apa yang ditampilkan pemutar untuk versi yang dipilih.

## Definisikan tiga kategori praktis

- **Trek tertanam yang dapat dipilih:** data subtitel dikemas di dalam kontainer media, terpisah dari gambar video, dan ditampilkan sebagai pilihan jika didukung.
- **Trek terpisah yang dikaitkan:** data subtitel disimpan terpisah dari media dan dihubungkan melalui sumber atau konteks pemutaran. File terpisah kadang disebut file pendamping atau sidecar.
- **Teks yang menyatu dengan gambar:** piksel yang sudah ada dalam gambar video; tidak ada pemilih yang dapat mematikannya secara independen.

**Kontainer**, seperti MKV atau MP4, mengemas aliran media dan metadata. Kontainer itu sendiri bukan trek subtitel atau jaminan dukungan dekoder. [Panduan kontainer MDN](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers) membedakan kontainer dari codec di dalamnya. Karena itu, ekstensi MKV saja tidak memberi tahu subtitel apa yang tersedia atau apakah pemutar tertentu akan menampilkannya sebagai pilihan.

Data subtitel tidak selalu berupa teks biasa. [Spesifikasi subtitel Matroska](https://www.matroska.org/technical/subtitles.html) menjelaskan subtitel berbasis teks dan format berbasis gambar seperti VobSub. Trek subtitel berbasis gambar tetap terpisah dari gambar video; “berbasis gambar” tidak berarti “menyatu dengan gambar video”. Kategori ini menjelaskan pengemasan, bukan kualitas terjemahan atau kelengkapan aksesibilitas.

## Kenali kategori melalui perilaku

Buka pemilih subtitel untuk item dan versi yang tepat, lalu catat entrinya sebelum mengubah apa pun. Pilih satu trek, catat labelnya, dan periksa adegan yang memuat satu teks subtitel. Jika tersedia kontrol nonaktif, gunakan lalu kunjungi kembali momen yang sama; membandingkan dua momen berbeda mungkin hanya membandingkan teks dengan jeda tanpa subtitel.

Jika teks yang dipilih menghilang, itu membuktikan bahwa teks dapat dikontrol dalam konteks tersebut. Itu **tidak** membedakan trek tertanam dari trek eksternal. Jika teks tetap ada, teks yang menyatu dengan gambar merupakan salah satu kemungkinan, tetapi periksa lapisan takarir aktif lain atau fitur takarir tingkat perangkat sebelum menyimpulkan bahwa teks adalah bagian video. Pastikan penyimpanan melalui informasi tentang media yang disediakan, bukan hanya gaya visual.

## Anggap dukungan trek terpisah bersyarat

Sumber daya terpisah memerlukan kaitan dengan item yang benar dan format yang didukung konteks pemutaran. Contohnya, [elemen HTML track](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/track) secara eksplisit menunjuk sumber daya eksternal dan dapat menyediakan bahasa serta label. [Draf spesifikasi WebVTT](https://www.w3.org/TR/webvtt1/) mendefinisikan format teks berwaktu untuk keperluan itu. Ini adalah contoh platform web, bukan deskripsi kontrol impor Norva.

File yang berada di samping video tidak otomatis dikaitkan dengannya pada setiap pemutar. Periksa alur yang didokumentasikan untuk perangkat dan sumber yang Anda gunakan. Keberadaan trek subtitel eksternal saja tidak membuktikan dukungan impor sembarang file lokal, pencocokan nama file otomatis, atau semua format dalam Norva.

## Kontribusi orisinal: kartu pengemasan

**Ilustrasi yang dibuat penulis** ini memakai klip fiktif Harbour Gate, dengan kalimat “The gate is open” (“Gerbangnya terbuka”) pada 00:18. Tidak ada file contoh untuk diunduh dan tidak ada pengamatan pemutaran Norva. Baris A–C mendefinisikan cara berbeda yang dapat digunakan pemilik untuk menyiapkan klip; perilaku kontrol mengasumsikan pemutar mendukung sumber daya yang disebutkan.

| Versi | Informasi pengemasan dalam contoh | Perilaku kontrol yang diharapkan | Kesimpulan yang beralasan |
| --- | --- | --- | --- |
| A | Kontainer MKV berisi video, audio, dan trek subtitel bahasa Inggris yang terpisah di dalamnya | Memilih bahasa Inggris menampilkan teks; mematikan trek itu menyembunyikannya | Trek subtitel tertanam, karena lokasi penyimpanannya diketahui secara eksplisit |
| B | Video MP4 secara eksplisit dikaitkan dengan file WebVTT bahasa Inggris terpisah yang memuat teks tersebut | Memilih bahasa Inggris menampilkan teks; mematikannya menyembunyikan teks | Sumber daya subtitel eksternal, karena kaitan dan penyimpanan terpisah diketahui |
| C | Pemilik merender kalimat bahasa Inggris ke dalam gambar video; tidak ada trek subtitel yang disediakan | Kontrol nonaktif subtitel tidak dapat menghapus piksel itu | Teks menyatu dengan gambar, karena video yang disediakan didefinisikan demikian |
| D | Hanya entri pemutar berlabel English yang diketahui; entri itu dapat menampilkan dan menyembunyikan teks | Kontrol aktif/nonaktif bekerja seperti pada A dan B | Trek subtitel yang dapat dipilih; penyimpanan tertanam atau eksternal belum dikonfirmasi |

Baris A dan B dapat terlihat identik dalam pemutar. Baris D adalah batas pentingnya: pengujian tombol nonaktif tidak dapat membedakan keduanya. Item nyata juga dapat menggabungkan teks yang menyatu dengan gambar dan terjemahan yang dapat dipilih, sehingga lebih dari satu kategori bisa berlaku untuk baris teks berbeda yang terlihat.

Untuk memakai ulang kartu, catat item/versi, seluruh daftar pemilih, label yang dipilih, waktu teks, hasil saat nonaktif, dan sumber informasi pengemasan. Tulis “belum dikonfirmasi” jika sumber media tidak memberikan detail yang cukup.

## Bandingkan versi dengan hati-hati

Satu versi mungkin mengemas subtitel secara berbeda atau menawarkan kumpulan lain. Pertahankan perangkat, profil, dan sumber media saat membandingkan versi, lalu rekam seluruh daftar trek masing-masing. Verifikasi edisi dan durasi, selain judul: sumber daya subtitel yang diatur waktunya untuk suntingan lain mungkin tidak selaras dengan film bernama sama.

Trek yang hilang setelah pergantian versi tidak membuktikan bahwa sumber daya terpisah gagal dimuat.

## Diagnosis trek terpisah yang hilang

Pertama, tetapkan alasan Anda mengharapkan trek itu. Label katalog, file dari pemilik, dan trek yang benar-benar tercantum untuk versi ini adalah jenis bukti berbeda. Tanyakan apakah pemilik sumber mengonfirmasi sumber daya dan kaitannya dengan versi yang dipilih.

Catat bahasa dan peran yang diharapkan, perangkat, versi aplikasi atau browser, konektivitas, serta pemilih lengkap. Pisahkan “tidak tercantum”, “tercantum tetapi tidak dapat dipilih”, dan “dipilih tetapi teks tidak terlihat pada momen yang diperiksa”. Pengamatan itu mengarah ke pertanyaan berbeda; tidak satu pun sendirian membuktikan kerusakan pemutar. Simpan bukti ini sebelum mengganti nama file, memindahkan sumber daya, menghapus sumber, mengosongkan data, atau memasang ulang.

## Pahami perbedaan fitur

Trek tertanam dan eksternal sama-sama dapat menyediakan subtitel yang berguna. Pilihan gaya bergantung pada format dan perender; sumber daya berbasis teks dan gambar tidak harus menawarkan kontrol yang sama. Teks yang menyatu dengan gambar tidak dapat diubah gayanya atau dinonaktifkan secara independen melalui pemilih subtitel. [Panduan takarir](https://www.w3.org/WAI/media/av/captions/) W3C juga membedakan takarir yang dapat disembunyikan penonton dari takarir terbuka yang tetap ditampilkan.

[Panduan pengelolaan subtitel lengkap](/blog/the-complete-guide-to-managing-subtitle-tracks/) menjelaskan pemeriksaan bahasa, peran, waktu, keadaan, dan perangkat setelah suatu trek ditemukan.

Selanjutnya nilai isi trek: [takarir aksesibilitas dan subtitel dialog dapat memenuhi kebutuhan informasi berbeda](/blog/captions-and-subtitles-why-the-accessibility-goals-can-differ/). Jika teks ada tetapi sulit dibaca, bedakan [kejelasan bentuk dan kemudahan membaca](/blog/legibility-and-readability-two-different-viewing-problems/) alih-alih menyalahkan metode penyimpanan.

## Lindungi hak sumber dan privasi

Gunakan media dan sumber daya subtitel yang Anda miliki atau diizinkan untuk Anda akses. Norva adalah pemutar media, tanpa konten atau langganan TV yang disertakan; menghubungkan sumber daya tidak memberikan hak atasnya. Jangan mengunggah file media atau subtitel ke dukungan tanpa izin yang diperlukan. Mulai laporan dengan label, langkah, dan cap waktu yang tidak sensitif; periksa tangkapan layar untuk alamat sumber pribadi atau detail akun sebelum membagikannya.

## Kesalahan umum dan keterbatasan

Hindari menyebut teks yang menyatu dengan gambar sebagai trek tertanam yang dapat dipilih, menjanjikan pencocokan otomatis, menganggap semua format didukung, dan mengedit file sumber sebelum menyimpan bukti.

Pengemasan dapat tetap tidak jelas ketika sumber hanya menampilkan pilihan yang dapat diputar. Jelaskan perilaku pemilih yang diamati, bukan menebak metode penyimpanannya.

## Pertanyaan yang sering diajukan

### Bisakah subtitel yang menyatu dengan gambar dinonaktifkan?

Tidak sebagai trek terpisah karena teks merupakan bagian gambar. Versi media lain mungkin berbeda, tetapi verifikasi ketersediaannya.

### Apakah trek subtitel terpisah selalu berupa file teks?

Tidak. WebVTT dan SubRip adalah contoh berbasis teks, tetapi sumber daya subtitel juga dapat berbasis gambar, seperti VobSub. “Terpisah” menjelaskan lokasi penyimpanan sumber daya terhadap media, bukan cara teks atau gambarnya dikodekan. Periksa format sebenarnya dan dukungan terdokumentasi.

### Apakah trek terpisah yang hilang berarti pemutarnya rusak?

Tidak. Verifikasi kaitan, item/versi, metadata sumber, dukungan format, dan pemilih sebelum menentukan penyebab.

## Langkah Anda berikutnya

Jika sumber mengonfirmasi sumber daya subtitel tetapi hasil tetap tidak jelas, bawa kartu pengemasan lengkap Anda ke [dukungan Norva](https://norva.tv/support). Nyatakan yang Anda amati dan yang belum dikonfirmasi; jangan sertakan file media atau detail koneksi pribadi dalam laporan awal.

## Sumber

- [MDN: kontainer media dan codec di dalamnya](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers)
- [Matroska: codec subtitel, termasuk trek berbasis teks dan gambar](https://www.matroska.org/technical/subtitles.html)
- [MDN: elemen HTML track dan sumber daya eksternal](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/track)
- [W3C: draf spesifikasi WebVTT](https://www.w3.org/TR/webvtt1/)
- [W3C: takarir, subtitel, dan penyajian terbuka atau tertutup](https://www.w3.org/WAI/media/av/captions/)
- [Norva: fitur dan persyaratan sumber kompatibel](https://norva.tv/#features)


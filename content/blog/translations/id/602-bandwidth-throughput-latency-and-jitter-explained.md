---
language: "id"
source_slug: "bandwidth-throughput-latency-and-jitter-explained"
source_sha256: "1187d6fb8fd3c55e3350243076646f12a474e161b0a321d197fcb55237b068da"
title: "Memahami Bandwidth, Throughput, Latensi, dan Jitter"
seo_title: "Bandwidth, Throughput, Latensi, dan Jitter untuk Video"
meta_description: "Pahami bandwidth, throughput, latensi, dan jitter lewat contoh jaringan video. Pelajari mengapa skor uji kecepatan atau batas jitter universal dapat menyesatkan."
excerpt: "Kapasitas, laju transfer terukur, waktu tunda, dan variasinya menjawab pertanyaan berbeda. Tafsirkan contoh perbandingan jaringan sebelum menyalahkan satu angka atas buffering."
topic_cluster: "Dasar jaringan rumah untuk video"
sources_heading: "Sumber"
next_step_heading: "Langkah Anda berikutnya"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Memahami Bandwidth, Throughput, Latensi, dan Jitter

> **Singkatnya:** Bandwidth adalah konsep kapasitas tersedia atau nominal; throughput adalah laju data berguna yang diukur dalam pengujian tertentu. Latensi adalah waktu tunda, sedangkan jitter menggambarkan variasi waktu tunda menurut metode yang disebutkan. Kehilangan paket merupakan hal terpisah lagi. Video dapat dipengaruhi satu atau beberapa faktor, jadi catat metode dan jalur sebelum menafsirkan angka.

Setiap metrik hanya memberikan sebagian gambaran. Dua pengujian dengan satuan sama tetap dapat mengukur endpoint, protokol, arah, durasi, rute, atau kondisi lalu lintas yang berbeda.

## Bandwidth bukan hasil yang telah diterima

Orang sering memakai bandwidth sebagai sebutan singkat untuk kecepatan, tetapi label kapasitas tidak memberi tahu jumlah data aplikasi yang tiba dalam interval tertentu. Sambungan bersama, overhead protokol, kemacetan, kondisi radio, batas perangkat, dan endpoint jarak jauh dapat mengurangi throughput yang diamati.

Karena itu, laju paket langganan, laju sambungan Wi-Fi, label Ethernet, dan throughput aplikasi merupakan nilai berbeda. Catat nilai mana yang ditampilkan sebelum membandingkannya dengan yang lain.

## Throughput memerlukan konteks pengujian

Throughput adalah laju transfer terukur. RFC 6349 menjelaskan kerangka pengujian throughput TCP dan menekankan metodologi pengujian. Hasil harus disertai endpoint, arah, protokol, durasi, jumlah koneksi, perangkat, rute, dan waktu.

[Panduan dasar jaringan rumah](/blog/the-complete-guide-to-home-network-basics-for-video/) memetakan jalur antara perangkat dan sumber. Server uji terdekat tidak mereproduksi setiap jalur sumber yang diizinkan, dan puncak singkat tidak seharusnya disajikan sebagai kinerja aplikasi berkelanjutan.

## Latensi adalah waktu tunda yang berlalu

Latensi menjelaskan berapa lama data atau respons menempuh jalur yang diukur. Waktu tunda satu arah membutuhkan sinkronisasi jam serta perhitungan ketidakpastian waktu menurut metode RFC 7679; banyak alat konsumen justru melaporkan perjalanan pulang-pergi. Hasil itu tidak dapat dipertukarkan.

Awal video, kontrol, autentikasi, dan permintaan segmen dapat terasa responsif atau tertunda karena alasan berbeda. Hasil throughput tinggi tidak otomatis berarti latensi rendah.

## Jitter adalah variasi, bukan sekadar lambat

RFC 3393 mendefinisikan metrik variasi waktu tunda paket. Dalam alat sehari-hari, “jitter” dapat memakai perhitungan, arah, interval, atau statistik berbeda. Baca definisi alat sebelum membandingkan nilai.

Koneksi dapat memiliki throughput rata-rata memadai tetapi kedatangan paket tidak teratur, atau waktu tunda stabil tetapi throughput berkelanjutan tidak mencukupi. Waktu pulang-pergi tetap 80 ms dan waktu yang bergantian antara 20 dan 140 ms dapat memiliki rata-rata sama sambil berperilaku berbeda. Ilustrasi itu menjelaskan variasi, bukan rumus jitter atau batas yang dapat diterima.

## Kehilangan paket adalah dimensi lain

RFC 7680 mendefinisikan metrik kehilangan paket satu arah dengan metodologi eksplisit. Hasil alat konsumen mungkin justru menyimpulkan kehilangan dari balasan yang tidak datang, dan beberapa perangkat dapat menurunkan prioritas lalu lintas diagnostik. Angka nol tidak membuktikan setiap paket aplikasi tiba; hasil bukan nol memerlukan pemeriksaan pengulangan dan cakupan.

Pisahkan paket yang hilang dari paket yang terlambat dalam catatan. Jeda pemutaran adalah gejala terlihat, bukan diagnosis tingkat paket.

## Kontribusi orisinal: kamus metrik

| Metrik | Pertanyaan sederhana | Konteks yang diperlukan | Yang tidak dapat dibuktikan sendiri |
|---|---|---|---|
| Bandwidth/kapasitas | Apa yang dapat dibawa sambungan ini menurut definisinya? | Sambungan, label, arah | Pengiriman aplikasi |
| Throughput | Laju berguna berapa yang diukur? | Endpoint, protokol, durasi, rute | Setiap jalur sumber |
| Latensi | Berapa waktu tunda yang diamati metode? | Satu arah/pulang-pergi, jam, jalur | Kapasitas berkelanjutan |
| Jitter | Bagaimana waktu tunda bervariasi? | Rumus, sampel, statistik | Throughput rata-rata |
| Kehilangan | Paket yang diharapkan mana yang tidak ada? | Jenis probe, arah, interval | Penyebab pemutaran yang tepat |

Cantumkan satuan pada setiap nilai dan simpan hasil mentah jika privasi mengizinkan.

### Contoh lengkap: paket cepat dan malam yang tidak konsisten

Ini adalah **hasil pembelajaran fiktif**, bukan pengujian Norva atau suatu sumber. Sebuah rumah tangga memiliki paket berlabel 100 Mbps. Mereka menguji laptop yang sama di lokasi Wi-Fi yang sama terhadap endpoint terdekat yang sama, dengan pengaturan unduhan identik dan tiga pengujian masing-masing 30 detik pada setiap rentang waktu.

| Pengamatan | Waktu sepi | Waktu sibuk | Penafsiran |
|---|---|---|---|
| Throughput unduhan, tiga pengujian | 82, 80, 84 Mbps | 28, 14, 31 Mbps | Median turun dari 82 menjadi 28 Mbps; rentang waktu sibuk 14–31 Mbps |
| Median waktu tunda pulang-pergi yang dilaporkan alat, pada kondisi beban sama | 18 ms | 65 ms | Jalur uji ini merespons lebih lambat pada waktu sibuk |
| Jitter yang ditampilkan alat, rumus dan pengaturan sampel sama | 3 ms | 24 ms | Waktu tunda lebih bervariasi menurut definisi alat; ini bukan nilai lulus/gagal |
| Video yang diizinkan saat waktu sibuk | Tidak diperiksa | Dua jeda dicatat | Jeda bertepatan dengan hasil lebih buruk, tetapi endpoint video tidak diukur |

Langkah masuk akal berikutnya adalah mengulang pada waktu gejala terjadi, dengan pilihan mengubah hanya koneksi lokal ke Ethernet jika didukung. Langkahnya **bukan** langsung membeli paket lebih cepat. Bahkan sampel 14 Mbps tidak dapat membuktikan apakah video seharusnya dapat diputar: kebutuhan versi sebenarnya, penurunan singkat, jalur sumber, dan perilaku buffering belum diketahui.

Bedakan Mbps (megabit per detik) dari MB/s (megabita per detik): 8 Mbps sama dengan 1 MB/s sebelum memperhitungkan definisi overhead pengukuran. Milidetik menggambarkan waktu, bukan laju data. Satuan tersebut tidak dapat dibandingkan seolah angka lebih besar selalu berarti koneksi lebih baik.

## Susun kumpulan pengukuran kecil

Gunakan perangkat yang terdampak pada lokasi biasanya. Catat tiga sampel berjeda pada waktu sepi dan tiga saat gejala terjadi. Jika aman dan didukung, ulangi melalui satu sambungan lokal alternatif tanpa mengubah endpoint atau pengaturan pengujian.

Lalu bandingkan median, rentang, dan pengulangan alih-alih memilih angka terbaik. Catat unggahan bersamaan, perubahan mesh, keadaan daya perangkat, dan cuaca hanya jika diamati langsung; jangan mengarang hubungan sebab-akibat dari peristiwa yang kebetulan bersamaan.

## Tafsirkan kombinasi

Throughput berkelanjutan yang rendah dapat menguras buffer pemutaran. Variasi waktu tunda dan kehilangan paket dapat mengganggu pengiriman meskipun rata-rata singkat tampak memadai. Latensi tinggi dapat memperlambat urutan permintaan-respons tanpa harus membatasi transfer panjang. Aplikasi, perilaku transport, desain buffering, dan sumber menentukan dampak yang terlihat.

Jika pemutaran berjalan tetapi gambar buruk, gunakan [perbandingan kualitas gambar](/blog/the-complete-guide-to-understanding-video-quality/) alih-alih menganggap keburaman sebagai bukti jaringan lambat. Norva memutar sumber kompatibel yang diizinkan; tidak menyediakan katalog atau mengendalikan router, jalur sumber, maupun encoding-nya.

## Kesalahan penafsiran umum

Jangan membandingkan bit dengan bita, menyamakan laju sambungan dengan throughput, menyebut semua variasi waktu tunda sebagai “kehilangan paket”, atau menganggap satu hasil server sebagai jaminan. Hindari mengukur hanya setelah mengganti router, perangkat, dan sumber sekaligus.

## Pertanyaan yang sering diajukan

### Metrik mana yang paling penting untuk video?

Tidak ada satu metrik yang selalu dominan. Pola pengiriman versi, jalur, perangkat, dan gejala menentukan pengukuran yang relevan.

### Bisakah throughput melebihi label paket?

Label, penyediaan kapasitas, metode uji, satuan, dan definisi overhead bervariasi. Verifikasi arti setiap angka sebelum menganggap perbedaannya sebagai kesalahan.

### Apakah jitter diukur dengan cara sama oleh setiap alat?

Tidak. Periksa rumus, arah, jenis probe, periode sampel, dan statistik yang dilaporkan alat.

### Berapa jitter yang dapat diterima untuk streaming video?

Tidak ada ambang milidetik universal yang menjamin pemutaran video. Video sesuai permintaan dengan buffer dan panggilan interaktif memiliki toleransi waktu tunda berbeda; alat juga menghitung jitter secara berbeda. Bandingkan hasil berulang dari metode sama dengan gejala sebenarnya. Batas yang diterbitkan untuk satu aplikasi atau protokol tidak seharusnya menjadi persyaratan umum Norva.

### Mengapa video mengalami buffering setelah uji kecepatan bagus?

Pengujian mungkin memakai server, rute, pola transfer, atau waktu berbeda. Pengujian dapat melewatkan gangguan singkat, dan pemutaran juga bergantung pada sumber serta perangkat. Catat apakah penundaan terjadi sebelum frame pertama atau saat pemutaran sebelum memilih pengujian berikutnya.

## Langkah Anda berikutnya

[Cocokkan gejala pemutaran dengan pemeriksaan berikutnya](https://norva.tv/blog/a-symptom-pattern-atlas-for-video-buffering/). Sertakan perangkat, rentang waktu, metode uji, dan satu gejala yang dapat diulang—bukan kredensial sumber—dalam permintaan dukungan.

## Sumber

- [RFC 6349: pengujian throughput TCP](https://www.rfc-editor.org/rfc/rfc6349)
- [RFC 7679: metrik waktu tunda satu arah](https://www.rfc-editor.org/rfc/rfc7679)
- [RFC 3393: metrik variasi waktu tunda](https://www.rfc-editor.org/rfc/rfc3393)
- [RFC 7680: metrik kehilangan paket satu arah](https://www.rfc-editor.org/rfc/rfc7680)


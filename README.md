---
title: WhatsApp AI Bot
emoji: 🤖
colorFrom: green
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# 🤖 WhatsApp AI Bot (Google Gemini + Multi-Downloader + Creative Tools)

Bot WhatsApp cerdas bertenaga **Google Gemini AI (15-Key Rotation Pool)** dan **Multi-Downloader & Creative Tools** yang berjalan 24/7 di VPS Linux:

### 📥 1. Multi-Platform Downloader
* 📸 **Instagram**: Reels, Foto, Carousel, & Story (`/download.ig <link>`)
* 🎬 **TikTok**: Video HD tanpa watermark & Slide Foto (`/download.tt <link>`)
* 📕 **RedNote / Xiaohongshu**: Video HD, Foto Asli, & Live Photo (`/download.rn <link>`)
* 👥 **Facebook**: Video & Reels kualitas HD (`/download.fb <link>`)
* 🧵 **Threads**: Foto & Video (`/download.th <link>`)
* ▶️ **YouTube**: Shorts & Video (`/download.yt <link>`)
* 🐦 **Twitter / X**: Video & GIF (`/download.x <link>`)
* 🎵 **Audio MP3**: Musik YouTube / Search Lagu (`/mp3 <judul/link>`)

### 🎨 2. Media & Stiker Kreatif
* 🖼️ **AI Image Generator (`/imagine <prompt>` atau `/draw`)**: Buat gambar nyata dari imajinasi teks bertenaga AI.
* 🎨 **Pembuat Stiker Otomatis (`/s` atau `/sticker`)**: Ubah foto/video singkat menjadi stiker WhatsApp (didukung animasi).
* 🎭 **Pembuat Stiker Meme (`/smeme <teks atas> | <teks bawah>`)**: Buat stiker meme dengan teks Impact atas dan bawah.
* 🔄 **Ubah Stiker Jadi Foto (`/toimg`)**: Balas stiker untuk mengubahnya kembali menjadi gambar biasa.
* 📝 **Salin Teks Foto / OCR (`/ocr` atau `/baca`)**: Ekstrak seluruh teks tulisan dari dokumen, struk, atau foto.
* 🎙️ **Transkrip Voice Note (`/transkrip` atau `/vn`)**: Ubah rekaman suara VN menjadi tulisan teks otomatis.
* 🗣️ **Text to Speech (`/tts <teks>`)**: Ubah teks tulisan menjadi rekaman suara VN WhatsApp.
* 🌐 **AI Translator (`/tr <bahasa> <teks>`)**: Menerjemahkan bahasa secara akurat via Gemini AI.

### 🧠 3. AI Multimodal & Pengetahuan (Google Gemini)
* 👁️ **AI Vision**: Kirim foto apa saja (soal matematika, barang, tempat, dokumen) + caption pertanyaan, bot akan menganalisis langsung gambar tersebut.
* 🌤️ **Info Cuaca Realtime (`/cuaca <nama kota>`)**: Cek suhu, cuaca, kelembapan, dan angin kota dunia secara langsung.
* 🧮 **Kalkulator & Solver (`/calc <soal>`)**: Hitung angka cepat atau pecahkan soal matematika rumit via AI.
* 💡 **Fakta Unik Dunia (`/fakta`)**: Menampilkan fakta sains, sejarah, dan fenomena dunia yang menarik.
* ✨ **Kata Motivasi & Quotes (`/quotes`)**: Kutipan inspiratif dan mendalam dari tokoh-tokoh dunia.
* 📖 **Wikipedia Instant Search (`/wiki <kueri>`)**: Cari artikel dan definisi ensiklopedia resmi Wikipedia bahasa Indonesia.
* 📰 **Web Article Summarizer (`/ringkas <link>`)**: Meringkas isi artikel web atau berita panjang menggunakan AI.
* 💬 **Chat Gemini AI**: Tanya atau diskusi apa saja (`/ai <pertanyaan>`).
* 🧹 **Reset Chat**: Bersihkan memori percakapan (`/reset`).

### 🛠️ 4. Utilitas & Produktivitas
* 💱 **Konversi Mata Uang (`/kurs <jumlah> <mata_uang>`)**: Cek nilai tukar mata uang dunia terkini ke Rupiah (USD, EUR, JPY, SGD, MYR, dll).
* 📱 **QR Code Generator (`/qr <teks>`)**: Buat barcode / QR Code instan dari teks atau tautan.
* ⏰ **Pengingat / Alarm Otomatis (`/ingatkan <waktu> <pesan>`)**: Atur alarm dan bot akan menandai Anda saat waktu habis (misal: `/ingatkan 10m Matikan kompor`).

### 🎮 5. Hiburan & Game Interaktif
* 🧩 **Tebak Gambar (`/tebakgambar`)**: Game tebak gambar seru dengan 1.000 level langsung di obrolan / grup!
* 🧠 **Asah Otak (`/asahotak`)**: Game teka-teki logika dan wawasan seru untuk chat pribadi atau grup!
* 🏳️ **Menyerah Game (`/nyerah`)**: Menyerah dan melihat jawaban yang benar jika kesulitan.
* 🎮 **SonnDev Roblox Script (`/roblox`)**: Temukan script game Roblox terbaik & terupdate di rscripts.net.

### 💎 6. Sistem Premium & Bebas Iklan (AI Vision Auto-Verification)
* 💎 **Info Paket (`/premium`)**: Cek daftar 8 paket langganan Bebas Iklan:
  * 📱 **Personal**: 5k (30 Hari), 8k (60 Hari), 12k (120 Hari), 20k (Permanen).
  * 👥 **Grup**: 15k (30 Hari), 20k (30 Hari + Admin Menu), 25k (60 Hari + Admin Menu), 30k (60 Hari + Admin Menu + 24 Jam CS).
* 💳 **Pembayaran QRIS (`/qris` atau `/bayar`)**: Scan barcode QRIS instan dari semua E-Wallet (Dana, OVO, GoPay, ShopeePay) & M-Banking (BCA, Mandiri, BRI, BNI, Seabank, Jago).
* 🤖 **Auto-Verifikasi AI (`/konfirmasi`)**: Kirim foto bukti transfer/struk pembayaran dengan caption `/konfirmasi`, AI Vision otomatis memvalidasi keabsahan bukti, membaca nominal, dan langsung mengaktifkan status Bebas Iklan tanpa perlu menunggu admin manual!
* 🔍 **Cek Status (`/cekprem`)**: Cek status, nama paket, dan sisa masa aktif Bebas Iklan nomor/grup.
* 🛡️ **Menu Admin Grup (`/adminmenu`)**: Akses cepat menu manajemen grup bagi grup yang berlangganan paket Admin Menu.
* 👑 **Manual Admin Override**: `/addprem <target> <hari>`, `/delprem <target>`, `/listprem`.
* 📢 **Interval Iklan Otomatis**: Iklan promosi script Roblox SonnDev hanya muncul tiap **5 request di chat pribadi** dan **20 request di grup**. Member/grup Premium 100% bebas dari seluruh iklan.

### 👥 7. Utilitas Grup WhatsApp
* 📢 **Hidetag (`/hidetag <pesan>`)**: Tag seluruh anggota grup dalam satu pesan.
* 🚨 **Panggil Admin (`/tagadmin [pesan]`)**: Panggil semua admin grup yang bertugas.
* 🔒 **Buka / Tutup Grup (`/group open` atau `/group close`)**: Atur izin kirim pesan grup khusus admin.
* 👢 **Keluarkan Anggota (`/kick @tag`)**: Admin mengeluarkan anggota bermasalah.
* 🛡️ **Anti-Link (`/antilink on/off`)**: Menghapus otomatis tautan grup WhatsApp liar.
* 👋 **Auto Welcome**: Menyapa anggota baru yang bergabung ke grup secara ramah.

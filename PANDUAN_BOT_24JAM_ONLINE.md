# 🌐 PANDUAN MENJALANKAN BOT WHATSAPP AI 24 JAM (KOMPUTER MATI/OFFLINE)

Agar bot WhatsApp tetap aktif dan membalas pesan secara otomatis meskipun **komputer/laptop Anda dimatikan atau offline**, bot harus dijalankan pada server yang selalu terhubung ke internet.

Berikut adalah **3 metode terbaik dan paling praktis**:

---

## 🟢 OPSI 1: Cloud Hosting Gratis (Render.com / Railway) — *Paling Mudah & Praktis*

Layanan cloud modern memungkinkan bot berjalan di server mereka secara gratis.

### Langkah-langkah di Render.com:
1. Buat akun di **[github.com](https://github.com)** (jika belum ada) dan buat repositori baru (misal: `whatsapp-ai-bot`).
2. Upload semua file dari folder `c:\Users\Perso\Documents\AI` ke repositori GitHub Anda *(kecuali folder `wa_session` dan `node_modules`)*.
3. Buka **[render.com](https://render.com)** dan login menggunakan akun GitHub Anda.
4. Klik **New +** > **Web Service** > Pilih repositori bot Anda.
5. Konfigurasi:
   - **Name**: `whatsapp-ai-bot`
   - **Environment**: `Node` (atau `Docker`)
   - **Build Command**: `npm install`
   - **Start Command**: `npm run start:wa`
   - **Instance Type**: `Free`
6. Masuk ke tab **Environment Variables** lalu tambahkan:
   - `GEMINI_API_KEYS` : *(Kunci API Gemini Anda)*
   - `WA_PHONE_NUMBER` : *(Nomor WhatsApp bot, contoh: `6285196323485`)*
7. Klik **Deploy Web Service**.
8. **Tautkan Akun**:
   - Karena server cloud tidak memiliki layar monitor untuk scan QR, bot sudah dilengkapi fitur **Pairing Code**.
   - Buka menu **Logs** di Render. Bot akan memunculkan 8 digit **Kode Pairing** (contoh: `ABCD-EFGH`).
   - Buka WhatsApp di HP Anda > **Perangkat tertaut** > **Tautkan dengan nomor telepon saja** > Masukkan 8 kode tersebut.
   - Selesai! Bot sekarang berjalan 24 jam di cloud tanpa butuh komputer menyala.

---

## 📱 OPSI 2: HP Android dengan Termux — *100% Gratis Tanpa Sewa Server*

Jika Anda memiliki HP Android lama (atau HP pribadi) yang selalu terhubung ke Wi-Fi / kuota internet, Anda bisa menjadikan HP tersebut sebagai server bot 24 jam!

### Langkah-langkah:
1. Download dan instal **Termux** dari **F-Droid** (jangan dari Play Store karena versi Play Store sudah usang).
2. Buka Termux, ketik perintah berikut satu per satu:
   ```bash
   pkg update && pkg upgrade -y
   pkg install nodejs git -y
   ```
3. Salin folder bot Anda ke HP, atau clone dari GitHub.
4. Masuk ke folder bot dan install library:
   ```bash
   cd AI
   npm install
   ```
5. Jalankan bot:
   ```bash
   npm run start:wa
   ```
6. Scan QR code yang muncul di layar Termux.
7. Tekan tombol notifikasi Termux **"Acquire Wakelock"** agar Termux tidak tertidur saat layar HP mati.
8. HP bisa diletakkan di samping router/kamar sambil dicas — bot akan aktif 24 jam nonstop!

---

## 💻 OPSI 3: VPS Linux Murah / Oracle Cloud Always Free — *Paling Stabil & Profesional*

Jika Anda ingin performa maksimal dan bot stabil selamanya tanpa kendala:
* Anda bisa menggunakan **Oracle Cloud Always Free** (Gratis selamanya) atau sewa VPS murah seperti IDCloudHost / DomaiNesia / DigitalOcean (sekitar Rp 30.000 - Rp 50.000/bulan).

### Langkah Menjalankan di VPS (Ubuntu/Debian):
1. Login ke VPS Anda via SSH:
   ```bash
   ssh root@ip_vps_anda
   ```
2. Install Node.js dan PM2 (Process Manager agar bot otomatis restart jika error):
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
   apt install -y nodejs git
   npm install -g pm2
   ```
3. Upload kode bot atau clone dari git:
   ```bash
   cd AI
   npm install
   ```
4. Jalankan bot menggunakan PM2:
   ```bash
   pm2 start wa_bot.js --name "wa-bot"
   pm2 startup
   pm2 save
   ```
5. Lihat log untuk scan QR atau pairing code:
   ```bash
   pm2 logs wa-bot
   ```
6. Selesai! VPS akan menjaga bot hidup 24 jam per hari, 365 hari per tahun.

---

### 💡 Catatan Penting
* File **[`Dockerfile`](file:///c:/Users/Perso/Documents/AI/Dockerfile)** dan **[`docker-compose.yml`](file:///c:/Users/Perso/Documents/AI/docker-compose.yml)** sudah disiapkan di folder Anda jika ingin menggunakan Docker.
* Fitur **Pairing Code** via `WA_PHONE_NUMBER` sudah aktif otomatis di [`wa_bot.js`](file:///c:/Users/Perso/Documents/AI/wa_bot.js).

# Instagram AI Chatbot (Node.js + Google Gemini AI)

Bot otomatis pembalas pesan Direct Message (DM) Instagram asli secara cerdas dan kontekstual menggunakan Google Gemini AI dan dashboard monitoring berbasis web.

---

## 🚀 Fitur Unggulan

1. **Auto Reply DM Berbasis AI**: Menjawab DM masuk secara otomatis dengan kecerdasan Google Gemini (`gemini-2.5-flash`).
2. **Memahami Konteks Percakapan**: Bot membaca riwayat beberapa pesan terakhir agar jawabannya nyambung dengan obrolan pengguna.
3. **Penyimpanan Sesi (Anti-Spam Login)**: Menyimpan cookie login di `session.json`, sehingga tidak perlu login ulang dan meminimalisir verifikasi keamanan dari Instagram.
4. **Dukungan 2FA & Checkpoint OTP**: Jika Instagram meminta verifikasi SMS/Email/Authenticator saat login pertama, Anda dapat memasukkan kode langsung di terminal.
5. **Deduplikasi Pesan**: Bot tidak akan membalas pesan lama berulang kali.
6. **Dashboard Web Realtime**: Tersedia dashboard di `http://localhost:3000` untuk memantau status bot, log pesan masuk/keluar, dan menguji coba respon AI.

---

## 📋 Langkah Pengaturan

### 1. Dapatkan Gemini API Key (Gratis)
1. Buka [Google AI Studio](https://aistudio.google.com/).
2. Login dengan akun Google Anda dan klik **Get API Key**.
3. Buat API Key baru dan salin kuncinya.

### 2. Isi Kredensial di File `.env`
Buka file `.env` di folder proyek ini (`c:\Users\Perso\Documents\AI\.env`), lalu isi data akun Anda:

```env
# Akun Instagram Anda
IG_USERNAME=username_instagram_anda
IG_PASSWORD=password_instagram_anda

# Gemini API Key dari Google AI Studio
GEMINI_API_KEY=AIzaSy...

# Pengaturan Tambahan (Opsional)
PORT=3000
CHECK_INTERVAL_SECONDS=10
AI_SYSTEM_PROMPT="Kamu adalah asisten AI Instagram yang ramah, sopan, dan responsif. Jawablah pesan dengan gaya santai tapi profesional, ringkas, dan jelas dalam bahasa Indonesia."
```

### 3. Jalankan Bot
Buka terminal di folder ini dan jalankan perintah:

```bash
npm start
```

### 4. Buka Dashboard Web
Setelah bot berjalan, buka browser Anda di:
👉 **[http://localhost:3000](http://localhost:3000)**

---

## 🛡️ Tips Keamanan untuk Akun Instagram Asli

1. **Gunakan Password Asli & Nonaktifkan Login Mencurigakan**: Saat login pertama kali dari server/komputer ini, buka aplikasi Instagram di HP Anda. Jika muncul notifikasi *"Apakah ini Anda?"*, pilih **"Ya, ini saya"**.
2. **Jangan Atur Interval Terlalu Cepat**: Biarkan `CHECK_INTERVAL_SECONDS` di angka **10 detik atau lebih** agar tidak terdeteksi melakukan spam request ke server Instagram.
3. **Session Cookies**: File `session.json` dan `.env` bersifat rahasia, jangan dibagikan kepada orang lain.

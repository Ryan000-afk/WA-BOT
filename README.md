---
title: WhatsApp AI Bot
emoji: 🤖
colorFrom: green
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# 🤖 WhatsApp AI Bot (Google Gemini + Multi-Platform Downloader)

Bot WhatsApp cerdas bertenaga **Google Gemini AI (Multi-Key Rotation Pool)** dan **Multi-Platform Media Downloader** yang berjalan 24/7 di VPS Linux:
* 📸 **Instagram Downloader**: Reels, Foto, Carousel, & Story (`/download.ig <link>`)
* 👥 **Facebook Downloader**: Video & Reels kualitas HD (`/download.fb <link>`)
* 🧵 **Threads Downloader**: Foto & Video (`/download.threads <link>`)
* 🎬 **TikTok Downloader**: Video HD Tanpa Watermark & Slide Foto (`/download.tiktok <link>`)
* 📕 **Xiaohongshu (RedNote) Downloader**: Video HD, Foto Asli, & Live Photo bergerak (`/download.xiaohongshu <link>`)
* 🐦 **Twitter / X Downloader**: Video & GIF (`/download.tw <link>`)
* ▶️ **YouTube Downloader**: Shorts & Video (`/download.yt <link>`)

---

## 🚀 Fitur Unggulan

1. **Multi-Platform Downloader Otomatis**:
   * Cukup kirimkan tautan sosmed langsung ke chat (atau gunakan awalan slash command seperti `/download.ig`, `/download.fb`, `/download.threads`, dll).
   * Otomatis mengunduh video kualitas terbaik dan foto resolusi tinggi.
2. **Google Gemini AI Multi-Key Failover**:
   * Dilengkapi rotasi otomatis 5+ API Key. Jika satu key terkena limit, bot otomatis berpindah ke key cadangan secara instan tanpa memutus obrolan.
   * Model AI: `gemini-3.7-flash`, `gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`.
3. **Persona Asisten Resmi & Profesional**:
   * Menghilangkan persona pacar/pasangan romantis, bertindak sebagai Asisten AI cerdas, sopan, dan solutif.
4. **Memori Percakapan Multi-turn**:
   * Bot mengingat konteks percakapan sebelumnya untuk tiap kontak/grup (`/reset` untuk membersihkan).
5. **24/7 VPS Hosting via PM2**:
   * Dikelola dengan Process Manager (PM2) di Ubuntu VPS dengan auto-restart jika terjadi gangguan jaringan.

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const crypto = require('crypto');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  delay
} = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');

// ====================================================================
// KONFIGURASI BOT & MULTI-KEY GEMINI AI
// ====================================================================
const SESSION_DIR = path.join(__dirname, 'wa_session');

// Kumpulkan seluruh API Key dari GEMINI_API_KEYS dan GEMINI_API_KEY
const rawKeys = [
  ...(process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(',') : []),
  process.env.GEMINI_API_KEY
]
  .map(k => (k || '').trim())
  .filter(k => k && k.startsWith('AIzaSy'));

// Hilangkan duplikat key
const GEMINI_KEYS = Array.from(new Set(rawKeys));

if (GEMINI_KEYS.length === 0) {
  console.error('\n[ERROR] Tidak ada GEMINI_API_KEY valid yang ditemukan di file .env!');
  console.error('Silakan isi GEMINI_API_KEYS di file .env terlebih dahulu.\n');
  process.exit(1);
}

console.log(`[INFO] Berhasil memuat ${GEMINI_KEYS.length} Gemini API Key ke dalam Pool Rotasi.`);

let activeKeyIndex = 0;
const AI_MODELS = ['gemini-3.7-flash', 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'];

// Set penyimpan grup yang mengaktifkan Anti-Link
const antilinkGroups = new Set();

// Penyimpan game tebak gambar aktif per chat: Map<jid, { jawaban: string, deskripsi: string, img: string }>
const activeGames = new Map();

// Persona Asisten AI WhatsApp (Profesional, Cerdas & Sopan - Bukan Pacar/Pasangan)
const DEFAULT_SYSTEM_PROMPT = 
  process.env.WA_AI_SYSTEM_PROMPT || 
  `Kamu adalah asisten AI WhatsApp pintar, sopan, ramah, dan profesional.
- PERATURAN MUTLAK: Kamu adalah ASISTEN VIRTUAL RESMI. DILARANG KERAS bertingkah laku sebagai pacar, pasangan romantis, bersikap manja, atau memanggil lawan bicara dengan sebutan romantis (seperti 'sayang', 'beb', 'pacarku', 'cintaku', dsb).
- Berikan jawaban yang informatif, ringkas, jelas, to the point, dan bermanfaat bagi pengguna.
- Gunakan bahasa Indonesia yang santai, ramah, namun tetap menjaga etika dan sopan santun.
- Fitur Spesial Bot yang kamu miliki:
  1. Unduh Instagram (/download.ig <link>)
  2. Unduh TikTok (/download.tt <link>)
  3. Unduh RedNote / Xiaohongshu (/download.rn <link>)
  4. Unduh Facebook (/download.fb <link>)
  5. Unduh Threads (/download.th <link>)
  6. Unduh YouTube (/download.yt <link>)
  7. Unduh Twitter / X (/download.x <link>)
  8. Unduh Audio Musik MP3 (/mp3 <judul/link>)
  9. Pembuat Gambar AI (/imagine <prompt>)
  10. Pembuat Stiker Otomatis (/s dari foto/video)
  11. Text to Speech Suara VN (/tts <teks>)
  12. Penerjemah AI Multibahasa (/tr <bahasa> <teks>)
  13. AI Vision (Menganalisis isi foto/gambar yang dikirim)
  14. Pencarian Wikipedia (/wiki <kueri>)
  15. Merangkum Artikel Berita (/ringkas <link>)
  16. Kalkulator Kurs Mata Uang (/kurs <jumlah> <mata_uang>)
  17. Pembuat Kode QR (/qr <teks>)
  18. Alarm & Pengingat (/ingatkan <waktu> <pesan>)
  19. Game Tebak Gambar (/tebakgambar)
  20. Utilitas Grup (/hidetag <pesan>, /antilink on/off)
- Pengguna juga bisa langsung mengirimkan/menempelkan tautan link langsung ke chat tanpa harus mengetik perintah!
- Gunakan formatting WhatsApp yang nyaman dibaca (*bold*, _italic_, daftar poin).
- Jika pengguna bertanya dalam bahasa lain, jawablah dalam bahasa yang sama dengan profesional.`;

// Konfigurasi perilaku
const CONFIG = {
  replyInGroupsOnlyWhenTagged: process.env.WA_GROUP_ONLY_TAG !== 'false', // default: hanya balas jika di-tag di grup
  autoReplyPrivateChat: true, // balas otomatis pesan pribadi
  maxHistoryPerChat: 8, // simpan 8 pesan terakhir per kontak untuk konteks
};

// Memory riwayat percakapan per user/grup: Map<jid, Array<{ role: 'user'|'model', text: string }>>
const chatHistories = new Map();

function getChatHistory(jid) {
  if (!chatHistories.has(jid)) {
    chatHistories.set(jid, []);
  }
  return chatHistories.get(jid);
}

function addChatHistory(jid, role, text) {
  const history = getChatHistory(jid);
  history.push({ role, text });
  if (history.length > CONFIG.maxHistoryPerChat) {
    history.shift();
  }
}

function clearChatHistory(jid) {
  chatHistories.delete(jid);
}

// ====================================================================
// FUNGSI GENERATE JAWABAN GEMINI AI (MULTIMODAL: TEKS & GAMBAR)
// ====================================================================
async function generateAiReply(jid, userMessage, senderName = 'Teman', imageBuffer = null, imageMime = 'image/jpeg') {
  const history = getChatHistory(jid);

  let prompt = '';
  if (history.length > 0) {
    prompt += 'Berikut riwayat percakapan sebelumnya:\n';
    for (const h of history) {
      prompt += `${h.role === 'user' ? senderName : 'AI'}: ${h.text}\n`;
    }
    prompt += `\nPesan baru dari ${senderName}: "${userMessage || 'Jelaskan gambar ini'}"\nBalasanmu:`;
  } else {
    prompt = userMessage || 'Jelaskan gambar ini secara lengkap dan informatif.';
  }

  let contentsPayload;
  if (imageBuffer) {
    contentsPayload = [
      {
        role: 'user',
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: imageMime || 'image/jpeg',
              data: imageBuffer.toString('base64')
            }
          }
        ]
      }
    ];
  } else {
    contentsPayload = prompt;
  }

  let replyText = null;
  let lastError = null;

  // Coba semua key yang ada di pool jika terkena limit kuota / 429
  const totalKeys = GEMINI_KEYS.length;
  for (let keyAttempt = 0; keyAttempt < totalKeys; keyAttempt++) {
    const currentKeyIdx = (activeKeyIndex + keyAttempt) % totalKeys;
    const currentKey = GEMINI_KEYS[currentKeyIdx];
    const client = new GoogleGenAI({ apiKey: currentKey });
    let keyHitLimit = false;

    for (const modelName of AI_MODELS) {
      try {
        const response = await client.models.generateContent({
          model: modelName,
          contents: contentsPayload,
          config: {
            systemInstruction: DEFAULT_SYSTEM_PROMPT,
            temperature: 0.7,
          }
        });

        if (response && response.text) {
          replyText = response.text.trim();
          activeKeyIndex = currentKeyIdx;
          break;
        }
      } catch (err) {
        lastError = err;
        const errMsg = err.message || '';
        const isQuotaError = errMsg.includes('429') || 
                             errMsg.includes('RESOURCE_EXHAUSTED') || 
                             errMsg.includes('quota') || 
                             errMsg.includes('limit');

        if (isQuotaError) {
          console.warn(`⚠️ [LIMIT] Key #${currentKeyIdx + 1} (${currentKey.substring(0, 10)}...) limit pada model ${modelName}.`);
          keyHitLimit = true;
          break;
        }
      }
    }

    if (replyText) break;

    if (keyHitLimit) {
      console.log(`🔄 [ROTASI KEY] Beralih otomatis ke API Key berikutnya (Key #${((currentKeyIdx + 1) % totalKeys) + 1})...`);
    }
  }

  if (!replyText) {
    console.error('[GEMINI ALL KEYS FAILED]', lastError?.message || lastError);
    return 'Maaf, seluruh kuota AI saat ini sedang sibuk atau mengalami kendala. Silakan coba lagi beberapa saat lagi ya!';
  }

  // Simpan riwayat setelah berhasil
  addChatHistory(jid, 'user', userMessage || '[Kirim Gambar]');
  addChatHistory(jid, 'model', replyText);

  return replyText;
}

// ====================================================================
// FUNGSI TRANSLATOR DENGAN GEMINI AI
// ====================================================================
async function translateText(targetLang, text) {
  const prompt = `Terjemahkan kalimat berikut secara alami dan akurat ke dalam bahasa target [${targetLang}].
Berikan HANYA teks hasil terjemahannya saja, tanpa kata pengantar, tanpa tanda petik pembuka/penutup, dan tanpa penjelasan tambahan.
Teks yang diterjemahkan: "${text}"`;

  const totalKeys = GEMINI_KEYS.length;
  for (let attempt = 0; attempt < totalKeys; attempt++) {
    const kIdx = (activeKeyIndex + attempt) % totalKeys;
    const client = new GoogleGenAI({ apiKey: GEMINI_KEYS[kIdx] });
    for (const m of AI_MODELS) {
      try {
        const res = await client.models.generateContent({
          model: m,
          contents: prompt
        });
        if (res && res.text) return res.text.trim();
      } catch (e) {
        // coba model berikutnya
      }
    }
  }
  return null;
}

// ====================================================================
// FUNGSI GENERATE GAMBAR AI (POLLINATIONS)
// ====================================================================
async function generateAiImage(prompt) {
  const cleanPrompt = prompt.trim();
  const seed = Math.floor(Math.random() * 1000000);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}?width=1024&height=1024&seed=${seed}&nologo=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Status ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ====================================================================
// FUNGSI PENCARIAN WIKIPEDIA
// ====================================================================
async function searchWikipedia(query) {
  try {
    const url = `https://id.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=1`;
    const res = await fetch(url);
    const data = await res.json();
    const results = data.query?.search || [];
    if (results.length === 0) return null;
    const top = results[0];
    const cleanSnippet = top.snippet.replace(/<[^>]+>/g, '').trim();
    return {
      title: top.title,
      snippet: cleanSnippet,
      url: `https://id.wikipedia.org/wiki/${encodeURIComponent(top.title.replace(/ /g, '_'))}`
    };
  } catch (err) {
    return null;
  }
}

// ====================================================================
// FUNGSI KURS MATA UANG REALTIME
// ====================================================================
async function getExchangeRate(amount, fromCurr = 'USD', toCurr = 'IDR') {
  const from = fromCurr.toUpperCase();
  const to = toCurr.toUpperCase();
  const res = await fetch(`https://open.er-api.com/v6/latest/${from}`);
  const data = await res.json();
  if (!data || !data.rates || !data.rates[to]) {
    throw new Error(`Mata uang ${from} atau ${to} tidak didukung.`);
  }
  const rate = data.rates[to];
  const converted = amount * rate;
  return { rate, converted, from, to };
}

// ====================================================================
// FUNGSI MERANGKUM ARTIKEL WEB
// ====================================================================
async function summarizeArticle(targetUrl) {
  try {
    const res = await fetch(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = await res.text();
    const bodyText = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 4000);

    const prompt = `Rangkumkan artikel berikut ke dalam bahasa Indonesia menjadi 3-5 poin penting yang padat, jelas, dan mudah dipahami:\n\n${bodyText}`;

    const totalKeys = GEMINI_KEYS.length;
    for (let attempt = 0; attempt < totalKeys; attempt++) {
      const kIdx = (activeKeyIndex + attempt) % totalKeys;
      const client = new GoogleGenAI({ apiKey: GEMINI_KEYS[kIdx] });
      for (const m of AI_MODELS) {
        try {
          const response = await client.models.generateContent({
            model: m,
            contents: prompt
          });
          if (response && response.text) return response.text.trim();
        } catch (e) {}
      }
    }
  } catch (err) {
    return `Gagal merangkum artikel: ${err.message}`;
  }
  return 'Gagal merangkum artikel. Pastikan tautan artikel dapat diakses publik.';
}

// ====================================================================
// FUNGSI PARSER DURASI PENGINGAT / ALARM
// ====================================================================
function parseReminderDuration(input) {
  const match = input.match(/^([0-9]+)\s*(s|dtk|detik|m|mnt|menit|h|j|jam|d|hri|hari)?/i);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  const unit = (match[2] || 'm').toLowerCase();

  let ms = num * 60 * 1000;
  let unitName = 'menit';
  if (['s', 'dtk', 'detik'].includes(unit)) { ms = num * 1000; unitName = 'detik'; }
  else if (['m', 'mnt', 'menit'].includes(unit)) { ms = num * 60 * 1000; unitName = 'menit'; }
  else if (['h', 'j', 'jam'].includes(unit)) { ms = num * 3600 * 1000; unitName = 'jam'; }
  else if (['d', 'hri', 'hari'].includes(unit)) { ms = num * 24 * 3600 * 1000; unitName = 'hari'; }

  const reminderText = input.replace(/^([0-9]+)\s*(s|dtk|detik|m|mnt|menit|h|j|jam|d|hri|hari)?\s*/i, '').trim();
  return { ms, durationStr: `${num} ${unitName}`, reminderText: reminderText || 'Waktunya selesai!' };
}

// ====================================================================
// FUNGSI MEMUAT DATASET GAME TEBAK GAMBAR
// ====================================================================
let tebakGambarCache = [];
async function loadTebakGambar() {
  if (tebakGambarCache.length > 0) return tebakGambarCache;
  try {
    const res = await fetch('https://raw.githubusercontent.com/BochilTeam/database/master/games/tebakgambar.json');
    if (res.ok) {
      tebakGambarCache = await res.json();
    }
  } catch (err) {
    console.warn('[TEBAK GAMBAR LOAD WARN]', err.message);
  }
  return tebakGambarCache;
}

// ====================================================================
// FUNGSI TEXT TO SPEECH (TTS GOOGLE NATIVE STREAM)
// ====================================================================
async function generateTtsAudio(text, lang = 'id') {
  const cleanText = text.substring(0, 200).trim();
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(cleanText)}&tl=${lang}&client=tw-ob`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    }
  });
  if (!res.ok) throw new Error(`Status TTS ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ====================================================================
// FUNGSI EKSTRAKSI MEDIA DARI PESAN (LANGSUNG ATAU REPLY/QUOTE)
// ====================================================================
async function extractMedia(msg) {
  let targetMsg = msg;
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

  if (quoted && (quoted.imageMessage || quoted.videoMessage || quoted.stickerMessage || quoted.audioMessage)) {
    targetMsg = {
      key: {
        remoteJid: msg.key.remoteJid,
        id: msg.message.extendedTextMessage.contextInfo.stanzaId,
        participant: msg.message.extendedTextMessage.contextInfo.participant
      },
      message: quoted
    };
  }

  const isImage = !!targetMsg.message?.imageMessage;
  const isVideo = !!targetMsg.message?.videoMessage;
  const isSticker = !!targetMsg.message?.stickerMessage;
  const isAudio = !!targetMsg.message?.audioMessage;

  if (!isImage && !isVideo && !isSticker && !isAudio) return null;

  try {
    const buffer = await downloadMediaMessage(
      targetMsg,
      'buffer',
      {},
      {
        logger: pino({ level: 'silent' })
      }
    );

    return {
      buffer,
      isImage,
      isVideo,
      isSticker,
      isAudio,
      mimeType: targetMsg.message?.imageMessage?.mimetype ||
                targetMsg.message?.videoMessage?.mimetype ||
                targetMsg.message?.audioMessage?.mimetype ||
                'image/jpeg'
    };
  } catch (err) {
    console.warn('[EXTRACT MEDIA ERROR]', err.message);
    return null;
  }
}

// ====================================================================
// FUNGSI KONVERSI MEDIA MENJADI STIKER WEBP VIA FFMPEG
// ====================================================================
function bufferToWebpSticker(inputBuffer, isVideo = false) {
  return new Promise(async (resolve, reject) => {
    const tempDir = os.tmpdir();
    const id = 'stk_' + crypto.randomBytes(6).toString('hex');
    const inputPath = path.join(tempDir, `${id}.${isVideo ? 'mp4' : 'jpg'}`);
    const outputPath = path.join(tempDir, `${id}.webp`);

    try {
      await fs.promises.writeFile(inputPath, inputBuffer);
      const ffmpegBin = process.platform === 'win32' ? 'ffmpeg' : (fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : 'ffmpeg');

      const args = isVideo
        ? [
            '-y',
            '-i', inputPath,
            '-t', '9',
            '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,fps=12,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
            '-vcodec', 'libwebp',
            '-lossless', '0',
            '-compression_level', '6',
            '-q:v', '40',
            '-loop', '0',
            '-an',
            '-vsync', '0',
            outputPath
          ]
        : [
            '-y',
            '-i', inputPath,
            '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
            '-vcodec', 'libwebp',
            '-lossless', '0',
            '-compression_level', '6',
            '-q:v', '70',
            outputPath
          ];

      execFile(ffmpegBin, args, { timeout: 35000 }, async (err) => {
        try {
          if (fs.existsSync(outputPath)) {
            const webpBuf = await fs.promises.readFile(outputPath);
            await fs.promises.unlink(inputPath).catch(() => {});
            await fs.promises.unlink(outputPath).catch(() => {});
            return resolve(webpBuf);
          }
        } catch (e) {}

        await fs.promises.unlink(inputPath).catch(() => {});
        reject(err || new Error('Gagal konversi stiker webp.'));
      });
    } catch (err) {
      reject(err);
    }
  });
}

// ====================================================================
// UNIVERSAL HELPER: YT-DLP EXECUTION (SERVER LINUX & VPS)
// ====================================================================
function getYtDlpBinary() {
  if (fs.existsSync('/usr/local/bin/yt-dlp')) return '/usr/local/bin/yt-dlp';
  if (fs.existsSync('/usr/bin/yt-dlp')) return '/usr/bin/yt-dlp';
  return 'yt-dlp';
}

async function runYtDlpDownload(targetUrl, maxMb = 50) {
  const binary = getYtDlpBinary();
  const fileId = 'ytdl_' + crypto.randomBytes(6).toString('hex');
  const tempDir = os.tmpdir();
  const outputTemplate = path.join(tempDir, `${fileId}.%(ext)s`);

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--max-filesize', `${maxMb}M`,
    '-f', 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best',
    '--merge-output-format', 'mp4',
    '-o', outputTemplate,
    targetUrl
  ];

  return new Promise((resolve) => {
    execFile(binary, args, { timeout: 80000 }, async (err, stdout, stderr) => {
      try {
        const files = await fs.promises.readdir(tempDir);
        const match = files.find(f => f.startsWith(fileId));
        if (match) {
          const filePath = path.join(tempDir, match);
          const stat = await fs.promises.stat(filePath);
          const buffer = await fs.promises.readFile(filePath);
          await fs.promises.unlink(filePath).catch(() => {});
          
          const isVideo = match.endsWith('.mp4') || match.endsWith('.webm') || match.endsWith('.mkv');
          return resolve({
            success: true,
            type: isVideo ? 'video' : 'image',
            buffer,
            size: stat.size,
            filename: match
          });
        }
      } catch (scanErr) {
        // ignore
      }

      return resolve({ 
        success: false, 
        error: stderr ? stderr.split('\n').filter(Boolean).slice(-2).join(' ') : (err?.message || 'Download gagal.')
      });
    });
  });
}

// ====================================================================
// FUNGSI DOWNLOAD MUSIK / AUDIO MP3
// ====================================================================
async function downloadAudioMp3(queryOrUrl) {
  const binary = getYtDlpBinary();
  const fileId = 'mp3_' + crypto.randomBytes(6).toString('hex');
  const tempDir = os.tmpdir();
  const outputTemplate = path.join(tempDir, `${fileId}.%(ext)s`);

  const isUrl = /^https?:\/\//i.test(queryOrUrl.trim());
  const target = isUrl ? queryOrUrl.trim() : `ytsearch1:${queryOrUrl.trim()}`;

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--extract-audio',
    '--audio-format', 'mp3',
    '--audio-quality', '192K',
    '--max-filesize', '30M',
    '-o', outputTemplate,
    target
  ];

  return new Promise((resolve) => {
    execFile(binary, args, { timeout: 90000 }, async (err, stdout, stderr) => {
      try {
        const files = await fs.promises.readdir(tempDir);
        const match = files.find(f => f.startsWith(fileId));
        if (match) {
          const filePath = path.join(tempDir, match);
          const stat = await fs.promises.stat(filePath);
          const buffer = await fs.promises.readFile(filePath);
          await fs.promises.unlink(filePath).catch(() => {});
          
          return resolve({
            success: true,
            buffer,
            size: stat.size,
            filename: match
          });
        }
      } catch (scanErr) {}

      return resolve({
        success: false,
        error: stderr ? stderr.split('\n').filter(Boolean).slice(-2).join(' ') : (err?.message || 'Gagal mengunduh audio MP3.')
      });
    });
  });
}

// ====================================================================
// 1. FUNGSI DOWNLOAD INSTAGRAM (REELS, FOTO, CAROUSEL, STORIES)
// ====================================================================
const IG_REGEX = /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|reels|tv|stories)\/([a-zA-Z0-9_\-\.]+)/i;

async function downloadInstagram(rawUrl) {
  const cleanUrl = rawUrl.replace(/[,;.)]+$/, '').trim();

  // Cara 1: Menggunakan btch-downloader
  try {
    const btch = require('btch-downloader');
    const data = await btch.igdl(cleanUrl);
    if (data && data.status && Array.isArray(data.result) && data.result.length > 0) {
      const mediaList = [];
      for (const item of data.result) {
        if (!item.url) continue;
        const isVideo = item.url.includes('.mp4') || (item.thumbnail && item.thumbnail.length > 0);
        mediaList.push({
          url: item.url,
          thumbnail: item.thumbnail,
          isVideo: isVideo
        });
      }
      if (mediaList.length > 0) {
        return {
          success: true,
          type: 'multi',
          mediaList
        };
      }
    }
  } catch (err) {
    console.warn('[IG BTCH WARN]', err.message);
  }

  // Cara 2: Fallback ke yt-dlp di VPS
  try {
    const ytdlRes = await runYtDlpDownload(cleanUrl, 50);
    if (ytdlRes.success) {
      return {
        success: true,
        type: ytdlRes.type,
        buffer: ytdlRes.buffer
      };
    }
  } catch (err) {
    console.warn('[IG YTDL WARN]', err.message);
  }

  return {
    success: false,
    error: 'Tidak dapat mengunduh konten Instagram. Pastikan akun tidak diprivat dan tautannya aktif.'
  };
}

// ====================================================================
// 2. FUNGSI DOWNLOAD FACEBOOK (VIDEO & REELS HD)
// ====================================================================
const FB_REGEX = /https?:\/\/(?:www\.|web\.|m\.|fb\.)?(?:facebook\.com\/(?:watch\/?\?v=[0-9]+|share\/[vr]\/[a-zA-Z0-9]+|reel\/[0-9]+|videos\/[0-9]+|[^\/\s]+\/videos\/[0-9]+|story\.php\?[^\s]+)|fb\.watch\/[a-zA-Z0-9_\-]+)/i;

async function downloadFacebook(rawUrl) {
  const cleanUrl = rawUrl.replace(/[,;.)]+$/, '').trim();

  // Cara 1: btch-downloader
  try {
    const btch = require('btch-downloader');
    const data = await btch.fbdown(cleanUrl);
    if (data && data.status && (data.HD || data.Normal_video)) {
      const downloadLink = data.HD || data.Normal_video;
      const res = await fetch(downloadLink);
      if (res.ok) {
        return {
          success: true,
          type: 'video',
          buffer: Buffer.from(await res.arrayBuffer()),
          quality: data.HD ? 'HD' : 'Normal'
        };
      }
    }
  } catch (err) {
    console.warn('[FB BTCH WARN]', err.message);
  }

  // Cara 2: yt-dlp di VPS
  try {
    const ytdlRes = await runYtDlpDownload(cleanUrl, 60);
    if (ytdlRes.success) {
      return {
        success: true,
        type: ytdlRes.type,
        buffer: ytdlRes.buffer,
        quality: 'Original'
      };
    }
  } catch (err) {
    console.warn('[FB YTDL WARN]', err.message);
  }

  return {
    success: false,
    error: 'Tidak dapat mengunduh video Facebook. Pastikan video bersifat publik dan tautannya aktif.'
  };
}

// ====================================================================
// 3. FUNGSI DOWNLOAD THREADS (VIDEO & FOTO)
// ====================================================================
const THREADS_REGEX = /https?:\/\/(?:www\.)?threads\.net\/(?:@[a-zA-Z0-9_.]+\/post\/|t\/)[a-zA-Z0-9_-]+/i;

async function downloadThreads(rawUrl) {
  const cleanUrl = rawUrl.replace(/[,;.)]+$/, '').trim();

  // Cara 1: btch-downloader
  try {
    const btch = require('btch-downloader');
    const data = await btch.threads(cleanUrl);
    if (data && data.status && data.result) {
      const resData = data.result;
      const videoUrl = resData.video_urls?.[0]?.download_url || resData.video || (typeof resData === 'string' && resData.includes('.mp4') ? resData : null);
      if (videoUrl) {
        const res = await fetch(videoUrl);
        if (res.ok) {
          return {
            success: true,
            type: 'video',
            buffer: Buffer.from(await res.arrayBuffer())
          };
        }
      }

      const imageUrls = resData.image_urls || resData.images;
      if (Array.isArray(imageUrls) && imageUrls.length > 0) {
        return {
          success: true,
          type: 'gallery',
          images: imageUrls.map(i => typeof i === 'string' ? i : (i.download_url || i.url))
        };
      }
    }
  } catch (err) {
    console.warn('[THREADS BTCH WARN]', err.message);
  }

  // Cara 2: yt-dlp di VPS
  try {
    const ytdlRes = await runYtDlpDownload(cleanUrl, 40);
    if (ytdlRes.success) {
      return {
        success: true,
        type: ytdlRes.type,
        buffer: ytdlRes.buffer
      };
    }
  } catch (err) {
    console.warn('[THREADS YTDL WARN]', err.message);
  }

  return {
    success: false,
    error: 'Tidak dapat mengunduh konten Threads. Pastikan postingan bersifat publik dan tautannya aktif.'
  };
}

// ====================================================================
// 4. FUNGSI DOWNLOAD TWITTER / X (VIDEO & GIF)
// ====================================================================
const TWITTER_REGEX = /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/[a-zA-Z0-9_]+\/status\/[0-9]+/i;

async function downloadTwitter(rawUrl) {
  const cleanUrl = rawUrl.replace(/[,;.)]+$/, '').trim();

  // Cara 1: btch-downloader
  try {
    const btch = require('btch-downloader');
    const data = await btch.twitter(cleanUrl);
    if (data && data.status && data.url) {
      const res = await fetch(data.url);
      if (res.ok) {
        return {
          success: true,
          title: data.title || 'Video Twitter / X',
          buffer: Buffer.from(await res.arrayBuffer())
        };
      }
    }
  } catch (err) {
    console.warn('[TWITTER BTCH WARN]', err.message);
  }

  // Cara 2: yt-dlp
  try {
    const ytdlRes = await runYtDlpDownload(cleanUrl, 50);
    if (ytdlRes.success) {
      return {
        success: true,
        title: 'Video Twitter / X',
        buffer: ytdlRes.buffer
      };
    }
  } catch (err) {
    console.warn('[TWITTER YTDL WARN]', err.message);
  }

  return {
    success: false,
    error: 'Tidak dapat mengunduh video dari Twitter/X. Pastikan postingan memiliki video publik.'
  };
}

// ====================================================================
// 5. FUNGSI DOWNLOAD YOUTUBE (SHORTS & VIDEO)
// ====================================================================
const YOUTUBE_REGEX = /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=[a-zA-Z0-9_-]+|shorts\/[a-zA-Z0-9_-]+)|youtu\.be\/[a-zA-Z0-9_-]+)/i;

async function downloadYouTube(rawUrl) {
  const cleanUrl = rawUrl.replace(/[,;.)]+$/, '').trim();

  // Cara 1: yt-dlp di VPS
  try {
    const ytdlRes = await runYtDlpDownload(cleanUrl, 50);
    if (ytdlRes.success) {
      return {
        success: true,
        buffer: ytdlRes.buffer
      };
    }
  } catch (err) {
    console.warn('[YOUTUBE YTDL WARN]', err.message);
  }

  // Cara 2: btch-downloader
  try {
    const btch = require('btch-downloader');
    const data = await btch.youtube(cleanUrl);
    if (data && data.status && data.mp4) {
      const res = await fetch(data.mp4);
      if (res.ok) {
        return {
          success: true,
          title: data.title,
          buffer: Buffer.from(await res.arrayBuffer())
        };
      }
    }
  } catch (err) {
    console.warn('[YOUTUBE BTCH WARN]', err.message);
  }

  return {
    success: false,
    error: 'Tidak dapat mengunduh video YouTube (Maksimal ukuran file yang didukung adalah 50MB).'
  };
}

// ====================================================================
// 6. FUNGSI DOWNLOAD VIDEO TIKTOK TANPA WATERMARK
// ====================================================================
const TIKTOK_REGEX = /https?:\/\/(?:www\.|v[tm]\.|m\.)?tiktok\.com\/[^\s]+/i;

async function downloadTikTokVideo(tiktokUrl) {
  try {
    const cleanUrl = tiktokUrl.replace(/[,;.)]+$/, '').trim();

    const res = await fetch('https://www.tikwm.com/api/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: new URLSearchParams({
        url: cleanUrl,
        hd: '1'
      })
    });

    const json = await res.json();
    if (json.code !== 0 || !json.data) {
      return { 
        success: false, 
        error: json.msg || 'Gagal memproses video TikTok. Pastikan video tidak diprivat dan tautannya aktif.' 
      };
    }

    const { data } = json;
    const title = data.title || 'Video TikTok';
    const author = data.author?.nickname || data.author?.unique_id || 'TikTok User';

    // Jika berupa slide foto / gambar
    if (data.images && Array.isArray(data.images) && data.images.length > 0 && !data.play) {
      return {
        success: true,
        type: 'slide',
        title,
        author,
        images: data.images,
        music: data.music
      };
    }

    // Video URL (hdplay atau play)
    let videoUrl = data.hdplay || data.play;
    if (videoUrl && !videoUrl.startsWith('http')) {
      videoUrl = 'https://www.tikwm.com' + videoUrl;
    }

    if (!videoUrl) {
      return { success: false, error: 'Tautan video tanpa watermark tidak ditemukan.' };
    }

    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) {
      return { success: false, error: `Gagal mengunduh file video dari server (Status: ${videoRes.status})` };
    }

    const arrayBuffer = await videoRes.arrayBuffer();
    const videoBuffer = Buffer.from(arrayBuffer);

    return {
      success: true,
      type: 'video',
      title,
      author,
      videoBuffer,
      music: data.music
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ====================================================================
// 7. FUNGSI DOWNLOAD KONTEN XIAOHONGSHU / REDNOTE (VIDEO, FOTO, LIVE PHOTO)
// ====================================================================
const XHS_REGEX = /https?:\/\/(?:www\.)?(?:xiaohongshu\.com\/(?:explore|discovery\/item)\/[a-zA-Z0-9_]+|xhslink\.com\/[a-zA-Z0-9_\/]+)/i;

async function downloadXiaohongshu(rawUrl) {
  try {
    let targetUrl = rawUrl.trim();

    // 1. Expand tautan pendek xhslink.com
    if (targetUrl.includes('xhslink.com')) {
      try {
        const redirectRes = await fetch(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          },
          redirect: 'follow'
        });
        if (redirectRes.url && !redirectRes.url.includes('xhslink.com')) {
          targetUrl = redirectRes.url;
        }
      } catch (e) {
        // Lewati jika error redirect
      }
    }

    // 2. Fetch halaman Xiaohongshu langsung dengan header lengkap
    const randomA1 = '18' + Math.random().toString(16).substring(2, 10) + Math.random().toString(16).substring(2, 10) + Math.random().toString(16).substring(2, 10);
    const cookieHeader = process.env.XHS_COOKIE || `a1=${randomA1}; webId=${randomA1.substring(0, 16)}; web_session=none`;

    const pageRes = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Cookie': cookieHeader,
        'Referer': 'https://www.xiaohongshu.com/'
      }
    });

    const html = await pageRes.text();

    const stateMatch = html.match(/window\.__INITIAL_(?:SSR_)?STATE__\s*=\s*(\{.*?\});?<\/script>/s);

    if (stateMatch && stateMatch[1]) {
      try {
        const cleanJsonStr = stateMatch[1].replace(/:\s*undefined/g, ': null');
        const state = JSON.parse(cleanJsonStr);

        const noteDetailMap = state?.note?.noteDetailMap || state?.noteData?.noteDetailMap;
        let note = null;

        if (noteDetailMap) {
          const keys = Object.keys(noteDetailMap);
          if (keys.length > 0) {
            note = noteDetailMap[keys[0]]?.note || noteDetailMap[keys[0]];
          }
        } else if (state?.note) {
          note = state.note;
        }

        if (note) {
          const title = note.title || 'Postingan Xiaohongshu';
          const desc = note.desc || '';
          const author = note.user?.nickname || 'Pengguna Xiaohongshu';
          const isVideo = note.type === 'video';

          if (isVideo) {
            const videoUrl = note.video?.media?.stream?.h264?.[0]?.masterUrl ||
                             note.video?.media?.stream?.h265?.[0]?.masterUrl ||
                             note.video?.consumer?.originVideoKey;

            if (videoUrl) {
              const videoRes = await fetch(videoUrl);
              const arrayBuffer = await videoRes.arrayBuffer();
              return {
                success: true,
                type: 'video',
                title,
                desc,
                author,
                videoBuffer: Buffer.from(arrayBuffer)
              };
            }
          } else {
            const imageList = note.imageList || [];
            const mediaItems = [];

            for (const img of imageList) {
              const photoUrl = img.urlDefault || img.infoList?.[1]?.url || img.infoList?.[0]?.url || img.urlOriginal || img.url;
              const liveVideoUrl = img.livePhotoVideoUrl || 
                                   img.stream?.h264?.[0]?.masterUrl || 
                                   (img.livePhoto && (img.media?.video?.url || img.video?.url));

              mediaItems.push({
                photoUrl,
                isLivePhoto: !!(img.livePhoto || liveVideoUrl),
                liveVideoUrl
              });
            }

            if (mediaItems.length > 0) {
              return {
                success: true,
                type: 'gallery',
                title,
                desc,
                author,
                mediaItems
              };
            }
          }
        }
      } catch (err) {
        console.warn('[XHS PARSE WARNING]', err.message);
      }
    }

    // 3. Fallback ke btch-downloader
    try {
      const btch = require('btch-downloader');
      const btchRes = await btch.xiaohongshu(rawUrl);
      if (btchRes && btchRes.status && btchRes.result) {
        const resData = btchRes.result;
        const title = resData.title || 'Postingan Xiaohongshu';
        const author = resData.author?.name || 'Pengguna Xiaohongshu';

        if (resData.video) {
          const vRes = await fetch(resData.video);
          return {
            success: true,
            type: 'video',
            title,
            author,
            videoBuffer: Buffer.from(await vRes.arrayBuffer())
          };
        } else if (resData.images && resData.images.length > 0) {
          return {
            success: true,
            type: 'gallery',
            title,
            author,
            mediaItems: resData.images.map(imgUrl => ({ photoUrl: imgUrl, isLivePhoto: false }))
          };
        }
      }
    } catch (e) {
      // Abaikan fallback error
    }

    return {
      success: false,
      error: 'Tidak dapat mengunduh konten Xiaohongshu. Pastikan tautan benar dan postingan bersifat publik.'
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ====================================================================
// SERVER HTTP HEALTH-CHECK (UNTUK CLOUD DEPLOYMENT SEPERTI VPS/RENDER)
// ====================================================================
const http = require('http');
const HTTP_PORT = process.env.PORT || 7860;
try {
  const healthServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'online',
      bot: 'WhatsApp AI Bot (Gemini + Multi-Downloader + Tools)',
      timestamp: new Date().toISOString()
    }));
  });
  healthServer.listen(HTTP_PORT, () => {
    console.log(`[HTTP HEALTH-CHECK] Server aktif di port ${HTTP_PORT}`);
  });
} catch (e) {
  // Abaikan jika port sudah dipakai
}

// ====================================================================
// INISIALISASI BAILEYS WHATSAPP SOCKET
// ====================================================================
async function startWhatsAppBot() {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  console.log('\n==================================================');
  console.log('🤖 MEMULAI WHATSAPP AI BOT (GEMINI & DOWNLOADER)...');
  console.log('==================================================');

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Menggunakan versi WhatsApp Web v${version.join('.')}${isLatest ? ' (Terbaru)' : ''}`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    generateHighQualityLinkPreview: true,
  });

  sock.ev.on('creds.update', saveCreds);

  // Sambutan otomatis saat ada anggota baru masuk grup
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    if (action === 'add') {
      for (const p of participants) {
        try {
          const welcomeText = `👋 Halo @${p.split('@')[0]}, selamat datang di grup! Silakan patuhi aturan grup dan nikmati obrolan ya! ✨`;
          await sock.sendMessage(id, { text: welcomeText, mentions: [p] });
        } catch (wErr) {
          // ignore
        }
      }
    }
  });

  const pairingNumber = process.env.WA_PHONE_NUMBER || process.env.PAIRING_NUMBER;
  if (!state.creds.registered && pairingNumber) {
    const cleanPhone = pairingNumber.replace(/[^0-9]/g, '');
    console.log(`[PAIRING] Meminta kode pairing untuk nomor: +${cleanPhone}...`);
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(cleanPhone);
        console.log('\n==================================================');
        console.log('🔑 KODE PAIRING TAUTAN WHATSAPP ANDA:');
        console.log(`\n       👉  ${code?.match(/.{1,4}/g)?.join('-') || code}  👈\n`);
        console.log('1. Buka WhatsApp di HP Anda');
        console.log('2. Buka "Perangkat tertaut" > "Tautkan dengan nomor telepon saja"');
        console.log('3. Masukkan 8 karakter kode di atas.');
        console.log('==================================================\n');
      } catch (pairErr) {
        console.error('[PAIRING ERROR] Gagal meminta kode pairing:', pairErr.message);
      }
    }, 4000);
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !pairingNumber) {
      console.log('\n==================================================');
      console.log('📲 SCAN QR CODE BERIKUT DENGAN WHATSAPP:');
      console.log('1. Buka aplikasi WhatsApp di HP Anda');
      console.log('2. Tekan menu titik tiga (Android) atau Pengaturan (iPhone)');
      console.log('3. Pilih "Perangkat tertaut" (Linked Devices)');
      console.log('4. Tekan "Tautkan perangkat" dan arahkan kamera ke QR ini:');
      console.log('==================================================\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`\n[KONEKSI TERPUTUS] Kode status: ${statusCode}. Reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        console.log('Menghubungkan ulang dalam 5 detik...');
        setTimeout(() => startWhatsAppBot(), 5000);
      } else {
        console.log('[LOGOUT] Sesi telah keluar. Hapus folder wa_session jika ingin scan QR baru.');
      }
    } else if (connection === 'open') {
      const botNumber = sock.user?.id ? sock.user.id.split(':')[0] : 'Unknown';
      console.log('\n==================================================');
      console.log('✅ WHATSAPP AI BOT SUDAH TERHUBUNG & AKTIF!');
      console.log(`📱 Nomor Bot: +${botNumber}`);
      console.log(`⚡ Model AI : ${AI_MODELS.join(', ')}`);
      console.log('📥 Fitur    : Downloader, Vision, Stiker, TTS, Translate, QR, Kurs, Game');
      console.log('==================================================\n');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid === 'status@broadcast') continue;

        const remoteJid = msg.key.remoteJid;
        const isGroup = remoteJid.endsWith('@g.us');
        const pushName = msg.pushName || 'Teman';

        const body = (
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          ''
        ).trim();

        const lowerBody = body.toLowerCase().trim();

        // ----------------------------------------------------------------
        // CEK JAWABAN GAME TEBAK GAMBAR (JIKA AKTIF DI CHAT INI)
        // ----------------------------------------------------------------
        if (activeGames.has(remoteJid) && body) {
          const game = activeGames.get(remoteJid);
          const cleanAnswer = lowerBody.replace(/[^a-zA-Z0-9]/g, '');
          const targetAnswer = game.jawaban.toLowerCase().replace(/[^a-zA-Z0-9]/g, '');

          if (lowerBody === '/nyerah' || lowerBody === '!nyerah') {
            activeGames.delete(remoteJid);
            await sock.sendMessage(remoteJid, {
              text: `🏳️ *MENYERAH!*\n\nJawaban yang benar adalah: *${game.jawaban.toUpperCase()}*\n📝 ${game.deskripsi || ''}`
            }, { quoted: msg });
            continue;
          } else if (cleanAnswer === targetAnswer) {
            activeGames.delete(remoteJid);
            const winner = msg.key.participant || remoteJid;
            await sock.sendMessage(remoteJid, {
              text: `🎉 *JAWABAN BENAR!*\n\nSelamat @${winner.split('@')[0]}! Jawabannya adalah *${game.jawaban.toUpperCase()}*.\n📝 ${game.deskripsi || ''}`,
              mentions: [winner]
            }, { quoted: msg });
            continue;
          }
        }

        // ----------------------------------------------------------------
        // PROTEKSI ANTI-LINK GRUP (JIKA ON)
        // ----------------------------------------------------------------
        if (isGroup && antilinkGroups.has(remoteJid)) {
          const isWaGroupLink = /(?:chat\.whatsapp\.com\/[a-zA-Z0-9]+)/i.test(body);
          if (isWaGroupLink) {
            const sender = msg.key.participant || remoteJid;
            try {
              await sock.sendMessage(remoteJid, { delete: msg.key });
              await sock.sendMessage(remoteJid, {
                text: `⚠️ Dilarang mengirim tautan grup lain di sini! @${sender.split('@')[0]}`,
                mentions: [sender]
              });
              continue;
            } catch (delErr) {
              // Abaikan jika bot bukan admin
            }
          }
        }

        const botNumber = sock.user?.id ? sock.user.id.split(':')[0] : '';
        const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const isTagged = mentionedJids.some(jid => jid.includes(botNumber));

        if (isGroup) {
          const isExplicitCommand = body.startsWith('/') || body.startsWith('!') || body.toLowerCase().startsWith('ai ');
          if (CONFIG.replyInGroupsOnlyWhenTagged && !isTagged && !isExplicitCommand) {
            continue;
          }
        }

        // ================================================================
        // 1. MENU & PANDUAN (/menu atau /help)
        // ================================================================
        if (lowerBody === '/menu' || lowerBody === '/help' || lowerBody === '!menu' || lowerBody === '!help') {
          const menuText = 
`╭────────────────────────╮
│   🤖 *WHATSAPP BOT*    │
╰────────────────────────╯

Halo, *${pushName}*! 👋

📥 *DOWNLOADER*
├ • */download.ig <link>*
├ • */download.tt <link>*
├ • */download.rn <link>*
├ • */download.fb <link>*
├ • */download.th <link>*
├ • */download.yt <link>*
├ • */download.x <link>*
├ • */mp3 <judul/link>*
╰────────────────────────

🎨 *AI KREATIF & MEDIA*
├ • */imagine <teks>* : Bikin gambar AI
├ • */s* : Buat stiker (foto/video)
├ • */tts <teks>* : Teks jadi suara VN
├ • */tr <bahasa> <teks>* : Terjemahan AI
╰────────────────────────

🧠 *AI & INFORMASI*
├ • Kirim foto + caption : Tanya isi foto
├ • */wiki <kueri>* : Cari info Wikipedia
├ • */ringkas <link>* : Rangkum artikel
├ • */kurs <jml> <uang>* : Kurs uang (e.g. 100 usd)
├ • */qr <teks>* : Buat kode QR
├ • */ingatkan <waktu> <pesan>* : Alarm
├ • */ai <teks>* : Tanya AI Gemini
├ • */reset* : Hapus riwayat chat
╰────────────────────────

👥 *GRUP & GAME*
├ • */hidetag <pesan>* : Tag semua anggota
├ • */antilink on/off* : Proteksi link grup
├ • */tebakgambar* : Main tebak gambar
├ • */nyerah* : Nyerah tebak gambar
╰────────────────────────

⚙️ *SISTEM*
├ • */menu* : Daftar perintah
├ • */ping* : Cek kecepatan bot
├ • */status* : Info server VPS

💡 _Tips: Bisa langsung kirim/paste link ke chat tanpa ketik perintah!_`;

          await sock.sendMessage(remoteJid, { text: menuText }, { quoted: msg });
          continue;
        }

        // ================================================================
        // 2. STATUS SERVER VPS (/status)
        // ================================================================
        if (lowerBody === '/status' || lowerBody === '!status') {
          const uptimeSec = process.uptime();
          const d = Math.floor(uptimeSec / (3600 * 24));
          const h = Math.floor((uptimeSec % (3600 * 24)) / 3600);
          const m = Math.floor((uptimeSec % 3600) / 60);
          const s = Math.floor(uptimeSec % 60);
          const uptimeStr = `${d > 0 ? d + ' hari ' : ''}${h} jam ${m} menit ${s} detik`;

          const totalMem = (os.totalmem() / 1024 / 1024).toFixed(0);
          const freeMem = (os.freemem() / 1024 / 1024).toFixed(0);
          const usedMem = (totalMem - freeMem);

          const statusText = 
`📊 *STATUS SERVER VPS*

🖥️ *OS*: Ubuntu Linux (64-bit)
⏱️ *Uptime Bot*: ${uptimeStr}
💾 *RAM Server*: ${usedMem} MB / ${totalMem} MB
⚡ *Node.js*: ${process.version}
🔑 *Gemini API Pool*: ${GEMINI_KEYS.length} Kunci Aktif (Anti-Limit)
🤖 *Fitur*: Multi-Downloader, Vision, Imagine, Stiker, TTS, Translate, Game
🌐 *Status*: Online 24/7 di VPS Indonesia`;

          await sock.sendMessage(remoteJid, { text: statusText }, { quoted: msg });
          continue;
        }

        // ================================================================
        // 3. PING & CEK RESPON (/ping)
        // ================================================================
        if (lowerBody === '/ping' || lowerBody === '!ping') {
          const start = Date.now();
          await sock.sendMessage(remoteJid, { text: '🏓 *Pinging server...*' }, { quoted: msg });
          const latency = Date.now() - start;
          await sock.sendMessage(remoteJid, { 
            text: `🏓 *Pong!*\n⚡ Kecepatan respon: *${latency} ms*\n🌐 Server VPS: *Online & Aktif 24 Jam*` 
          }, { quoted: msg });
          continue;
        }

        // ================================================================
        // 4. RESET MEMORI CHAT (/reset atau /clear)
        // ================================================================
        if (lowerBody === '/reset' || lowerBody === '/clear' || lowerBody === '!reset' || lowerBody === '!clear') {
          clearChatHistory(remoteJid);
          await sock.sendMessage(remoteJid, { 
            text: '🧹 *Memori percakapan telah dibersihkan!*\nKita bisa memulai obrolan topik baru dari awal.' 
          }, { quoted: msg });
          continue;
        }

        // ================================================================
        // 5. PEMBUAT GAMBAR AI (/imagine <prompt> atau /draw)
        // ================================================================
        const isImagineCommand = lowerBody.startsWith('/imagine') || 
                                 lowerBody.startsWith('/draw') || 
                                 lowerBody.startsWith('!imagine') || 
                                 lowerBody.startsWith('!draw');

        if (isImagineCommand) {
          const prompt = body.replace(/^[\/!](?:imagine|draw)\s*/i, '').trim();
          if (!prompt) {
            await sock.sendMessage(remoteJid, {
              text: '⚠️ *Format*: */imagine <deskripsi_gambar>*\nContoh: `/imagine seekor kucing astronot melayang di angkasa gaya anime`'
            }, { quoted: msg });
            continue;
          }

          console.log(`🖼️ Menggenerate gambar AI untuk ${pushName}: "${prompt}"`);
          await sock.sendMessage(remoteJid, { text: `🎨 *Sedang membuat gambar AI...*\n"${prompt}"\n_Mohon tunggu beberapa detik ya!_` }, { quoted: msg });
          await sock.sendPresenceUpdate('recording', remoteJid);

          try {
            const imgBuf = await generateAiImage(prompt);
            await sock.sendPresenceUpdate('paused', remoteJid);
            await sock.sendMessage(remoteJid, {
              image: imgBuf,
              caption: `🖼️ *AI Image*: "${prompt}"\n⚡ _Dibuat oleh AI WhatsApp Bot_`
            }, { quoted: msg });
          } catch (imgErr) {
            await sock.sendPresenceUpdate('paused', remoteJid);
            await sock.sendMessage(remoteJid, { text: `❌ Gagal membuat gambar: ${imgErr.message}` }, { quoted: msg });
          }
          continue;
        }

        // ================================================================
        // 6. PEMBUAT STIKER OTOMATIS (/s atau /sticker)
        // ================================================================
        const isStickerCommand = lowerBody === '/s' || 
                                 lowerBody === '!s' || 
                                 lowerBody.startsWith('/s ') || 
                                 lowerBody.startsWith('/sticker') || 
                                 lowerBody.startsWith('!sticker');

        if (isStickerCommand) {
          const media = await extractMedia(msg);
          if (!media || (!media.isImage && !media.isVideo && !media.isSticker)) {
            await sock.sendMessage(remoteJid, {
              text: '⚠️ Kirim foto/video pendek (<10 detik) dengan caption */s* atau reply foto/video dengan */s* untuk membuat stiker!'
            }, { quoted: msg });
            continue;
          }

          await sock.sendMessage(remoteJid, { text: '⏳ *Sedang membuat stiker...*' }, { quoted: msg });
          try {
            const webpBuffer = await bufferToWebpSticker(media.buffer, media.isVideo);
            await sock.sendMessage(remoteJid, { sticker: webpBuffer }, { quoted: msg });
            console.log(`✅ Stiker berhasil dikirim ke ${pushName}`);
          } catch (stkErr) {
            console.error('[STICKER ERROR]', stkErr);
            await sock.sendMessage(remoteJid, {
              text: '❌ Gagal membuat stiker. Pastikan file media tidak rusak dan durasi video di bawah 10 detik.'
            }, { quoted: msg });
          }
          continue;
        }

        // ================================================================
        // 7. TEXT TO SPEECH VN (/tts <teks>)
        // ================================================================
        const isTtsCommand = lowerBody.startsWith('/tts') || lowerBody.startsWith('!tts');
        if (isTtsCommand) {
          let ttsText = body.replace(/^[\/!]tts\s*/i, '').trim();
          let lang = 'id';
          
          const parts = ttsText.split(' ');
          if (parts.length > 1 && parts[0].length === 2 && /^[a-z]{2}$/i.test(parts[0])) {
            lang = parts[0].toLowerCase();
            ttsText = parts.slice(1).join(' ');
          }

          if (!ttsText) {
            await sock.sendMessage(remoteJid, {
              text: '⚠️ *Format*: */tts <teks>* atau */tts en <teks>*\nContoh: `/tts halo apa kabar semua`'
            }, { quoted: msg });
            continue;
          }

          await sock.sendMessage(remoteJid, { text: '🎙️ *Sedang membuat pesan suara...*' }, { quoted: msg });
          try {
            const audioBuf = await generateTtsAudio(ttsText, lang);
            await sock.sendMessage(remoteJid, {
              audio: audioBuf,
              mimetype: 'audio/mp4',
              ptt: true
            }, { quoted: msg });
            console.log(`✅ TTS suara terkirim ke ${pushName}`);
          } catch (ttsErr) {
            await sock.sendMessage(remoteJid, { text: `❌ Gagal membuat suara: ${ttsErr.message}` }, { quoted: msg });
          }
          continue;
        }

        // ================================================================
        // 8. AI TRANSLATOR INSTAN (/tr <kode_bahasa> <teks>)
        // ================================================================
        const isTrCommand = lowerBody.startsWith('/tr') || lowerBody.startsWith('!tr');
        if (isTrCommand) {
          let trInput = body.replace(/^[\/!]tr\s*/i, '').trim();
          const trParts = trInput.split(' ');
          if (trParts.length < 2) {
            await sock.sendMessage(remoteJid, {
              text: '⚠️ *Format*: */tr <bahasa> <teks>*\nContoh:\n• `/tr en selamat pagi` (ke Inggris)\n• `/tr id good morning` (ke Indonesia)\n• `/tr jp terima kasih` (ke Jepang)'
            }, { quoted: msg });
            continue;
          }

          const targetLang = trParts[0];
          const textToTranslate = trParts.slice(1).join(' ');

          await sock.sendPresenceUpdate('composing', remoteJid);
          const translated = await translateText(targetLang, textToTranslate);
          await sock.sendPresenceUpdate('paused', remoteJid);

          if (translated) {
            await sock.sendMessage(remoteJid, {
              text: `🌐 *Hasil Terjemahan [${targetLang.toUpperCase()}]*:\n\n${translated}`
            }, { quoted: msg });
            console.log(`✅ Terjemahan terkirim ke ${pushName}`);
          } else {
            await sock.sendMessage(remoteJid, {
              text: '❌ Gagal menerjemahkan teks. Silakan coba lagi.'
            }, { quoted: msg });
          }
          continue;
        }

        // ================================================================
        // 9. PENCARIAN WIKIPEDIA (/wiki <kueri>)
        // ================================================================
        const isWikiCommand = lowerBody.startsWith('/wiki') || lowerBody.startsWith('!wiki');
        if (isWikiCommand) {
          const query = body.replace(/^[\/!]wiki\s*/i, '').trim();
          if (!query) {
            await sock.sendMessage(remoteJid, {
              text: '⚠️ *Format*: */wiki <kata_kunci>*\nContoh: `/wiki planet mars` atau `/wiki soekarno`'
            }, { quoted: msg });
            continue;
          }

          await sock.sendMessage(remoteJid, { text: `🔍 *Mencari informasi Wikipedia tentang "${query}"...*` }, { quoted: msg });
          const result = await searchWikipedia(query);
          if (result) {
            const textMsg = `📚 *WIKIPEDIA: ${result.title}*\n\n${result.snippet}...\n\n🔗 _Baca selengkapnya_: ${result.url}`;
            await sock.sendMessage(remoteJid, { text: textMsg }, { quoted: msg });
          } else {
            await sock.sendMessage(remoteJid, { text: `❌ Tidak ditemukan artikel Wikipedia tentang "${query}".` }, { quoted: msg });
          }
          continue;
        }

        // ================================================================
        // 10. MERANGKUM ARTIKEL WEB (/ringkas <link>)
        // ================================================================
        const isRingkasCommand = lowerBody.startsWith('/ringkas') || 
                                 lowerBody.startsWith('/summarize') || 
                                 lowerBody.startsWith('!ringkas');

        if (isRingkasCommand) {
          const urlMatch = body.match(/https?:\/\/[^\s]+/i);
          if (!urlMatch) {
            await sock.sendMessage(remoteJid, {
              text: '⚠️ *Format*: */ringkas <link_artikel>*\nContoh: `/ringkas https://kompas.com/artikel...`'
            }, { quoted: msg });
            continue;
          }

          const targetUrl = urlMatch[0];
          await sock.sendMessage(remoteJid, { text: '📄 *Sedang membaca dan merangkum artikel...*\nMohon tunggu beberapa detik ya!' }, { quoted: msg });
          await sock.sendPresenceUpdate('composing', remoteJid);

          const summary = await summarizeArticle(targetUrl);
          await sock.sendPresenceUpdate('paused', remoteJid);

          await sock.sendMessage(remoteJid, {
            text: `📄 *RINGKASAN ARTIKEL*\n🔗 ${targetUrl}\n\n${summary}`
          }, { quoted: msg });
          continue;
        }

        // ================================================================
        // 11. KALKULATOR KURS MATA UANG (/kurs <jumlah> <mata_uang>)
        // ================================================================
        const isKursCommand = lowerBody.startsWith('/kurs') || lowerBody.startsWith('!kurs');
        if (isKursCommand) {
          const input = body.replace(/^[\/!]kurs\s*/i, '').trim();
          const match = input.match(/^([0-9.,]+)\s*([a-zA-Z]{3})(?:\s*(?:ke|to)\s*([a-zA-Z]{3}))?/i);
          if (!match) {
            await sock.sendMessage(remoteJid, {
              text: '⚠️ *Format*: */kurs <jumlah> <mata_uang>*\nContoh:\n• `/kurs 100 usd`\n• `/kurs 50000 jpy`\n• `/kurs 20 eur`'
            }, { quoted: msg });
            continue;
          }

          const amount = parseFloat(match[1].replace(/,/g, ''));
          const from = match[2].toUpperCase();
          const to = (match[3] || 'IDR').toUpperCase();

          try {
            const rateData = await getExchangeRate(amount, from, to);
            const textRes = 
`💱 *KURS MATA UANG*

💵 *${amount.toLocaleString()} ${rateData.from}* = *${to === 'IDR' ? 'Rp ' : ''}${Math.round(rateData.converted).toLocaleString('id-ID')} ${to}*
📊 1 ${rateData.from} = ${to === 'IDR' ? 'Rp ' : ''}${rateData.rate.toLocaleString('id-ID')} ${to}
⏱️ _Data kurs real-time_`;

            await sock.sendMessage(remoteJid, { text: textRes }, { quoted: msg });
          } catch (err) {
            await sock.sendMessage(remoteJid, { text: `❌ ${err.message}` }, { quoted: msg });
          }
          continue;
        }

        // ================================================================
        // 12. PEMBUAT KODE QR (/qr <teks/link>)
        // ================================================================
        const isQrCommand = lowerBody.startsWith('/qr') || lowerBody.startsWith('!qr');
        if (isQrCommand) {
          const qrData = body.replace(/^[\/!]qr\s*/i, '').trim();
          if (!qrData) {
            await sock.sendMessage(remoteJid, {
              text: '⚠️ *Format*: */qr <teks atau link>*\nContoh: `/qr https://instagram.com`'
            }, { quoted: msg });
            continue;
          }

          const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(qrData)}`;
          try {
            const qrRes = await fetch(qrUrl);
            if (qrRes.ok) {
              const qrBuf = Buffer.from(await qrRes.arrayBuffer());
              await sock.sendMessage(remoteJid, {
                image: qrBuf,
                caption: `🔲 *Kode QR Berhasil Dibuat!*\n📝 Data: "${qrData}"`
              }, { quoted: msg });
            }
          } catch (qrErr) {
            await sock.sendMessage(remoteJid, { text: `❌ Gagal membuat kode QR: ${qrErr.message}` }, { quoted: msg });
          }
          continue;
        }

        // ================================================================
        // 13. ALARM & PENGINGAT (/ingatkan <waktu> <pesan>)
        // ================================================================
        const isRemindCommand = lowerBody.startsWith('/ingatkan') || 
                                lowerBody.startsWith('/remind') || 
                                lowerBody.startsWith('!ingatkan') || 
                                lowerBody.startsWith('!remind');

        if (isRemindCommand) {
          const input = body.replace(/^[\/!](?:ingatkan|remind)\s*/i, '').trim();
          const parsed = parseReminderDuration(input);

          if (!parsed || parsed.ms <= 0) {
            await sock.sendMessage(remoteJid, {
              text: '⚠️ *Format*: */ingatkan <waktu> <pesan>*\nContoh:\n• `/ingatkan 10m matikan kompor`\n• `/ingatkan 1h meeting zoom`\n• `/ingatkan 30s cek pesan`'
            }, { quoted: msg });
            continue;
          }

          const sender = msg.key.participant || remoteJid;
          await sock.sendMessage(remoteJid, {
            text: `⏰ *Pengingat Disetel!*\n\nBot akan mengingatkan dalam *${parsed.durationStr}*:\n"${parsed.reminderText}"`
          }, { quoted: msg });

          setTimeout(async () => {
            try {
              await sock.sendMessage(remoteJid, {
                text: `⏰ *PENGINGAT WAKTU TIBA!*\n\n📢 "${parsed.reminderText}"\n\n_Pengingat disetel untuk @${sender.split('@')[0]}_`,
                mentions: [sender]
              });
            } catch (rErr) {
              console.warn('[REMINDER FIRE ERROR]', rErr.message);
            }
          }, parsed.ms);

          continue;
        }

        // ================================================================
        // 14. GAME TEBAK GAMBAR (/tebakgambar atau /tg)
        // ================================================================
        const isTgCommand = lowerBody === '/tebakgambar' || 
                            lowerBody === '/tg' || 
                            lowerBody === '!tebakgambar' || 
                            lowerBody === '!tg';

        if (isTgCommand) {
          if (activeGames.has(remoteJid)) {
            await sock.sendMessage(remoteJid, {
              text: '⚠️ Masih ada tebak gambar yang belum terjawab di chat ini! Ketik */nyerah* jika menyerah.'
            }, { quoted: msg });
            continue;
          }

          const list = await loadTebakGambar();
          if (!list || list.length === 0) {
            await sock.sendMessage(remoteJid, { text: '❌ Gagal memuat database tebak gambar. Coba lagi nanti.' }, { quoted: msg });
            continue;
          }

          const randomIndex = Math.floor(Math.random() * list.length);
          const q = list[randomIndex];

          activeGames.set(remoteJid, {
            jawaban: q.jawaban.trim(),
            deskripsi: q.deskripsi || '',
            img: q.img
          });

          const clue = q.jawaban.replace(/[a-zA-Z]/g, '_ ');
          await sock.sendMessage(remoteJid, {
            image: { url: q.img },
            caption: `🎮 *GAME TEBAK GAMBAR*\n\nPetunjuk: *${clue}*\n\nKetik jawaban Anda langsung di chat!\n(Ketik */nyerah* jika menyerah)`
          }, { quoted: msg });
          continue;
        }

        // ================================================================
        // 15. DOWNLOAD MUSIK MP3 (/mp3 <judul/link>)
        // ================================================================
        const isMp3Command = lowerBody.startsWith('/mp3') || 
                             lowerBody.startsWith('/download.mp3') || 
                             lowerBody.startsWith('/downdload.mp3') || 
                             lowerBody.startsWith('!mp3');

        if (isMp3Command) {
          const query = body.replace(/^[\/!](?:download\.)?mp3\s*/i, '').trim();
          if (!query) {
            await sock.sendMessage(remoteJid, {
              text: '⚠️ *Format*: */mp3 <judul lagu atau link>*\nContoh:\n• `/mp3 komang raim laode`\n• `/mp3 https://youtu.be/xxxx`'
            }, { quoted: msg });
            continue;
          }

          console.log(`🎵 Mencari audio MP3 dari ${pushName}: "${query}"`);
          await sock.sendMessage(remoteJid, { text: `🎵 *Mencari dan mengunduh audio: "${query}"...*\nMohon tunggu beberapa saat ya!` }, { quoted: msg });
          await sock.sendPresenceUpdate('recording', remoteJid);

          const result = await downloadAudioMp3(query);
          await sock.sendPresenceUpdate('paused', remoteJid);

          if (result.success && result.buffer) {
            await sock.sendMessage(remoteJid, {
              audio: result.buffer,
              mimetype: 'audio/mp4',
              fileName: `${query.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30)}.mp3`
            }, { quoted: msg });
            console.log(`✅ Lagu MP3 "${query}" berhasil dikirim ke ${pushName}`);
          } else {
            await sock.sendMessage(remoteJid, {
              text: `❌ Gagal mengunduh audio MP3: ${result.error || 'Lagu tidak ditemukan atau ukuran terlalu besar.'}`
            }, { quoted: msg });
          }
          continue;
        }

        // ================================================================
        // 16. HIDETAG / TAG ALL GRUP (/hidetag <pesan>)
        // ================================================================
        const isHidetag = lowerBody.startsWith('/hidetag') || 
                          lowerBody.startsWith('/tagall') || 
                          lowerBody.startsWith('/everyone') || 
                          lowerBody.startsWith('!hidetag') ||
                          lowerBody.startsWith('!tagall');

        if (isHidetag) {
          if (!isGroup) {
            await sock.sendMessage(remoteJid, { text: '⚠️ Perintah ini hanya dapat digunakan di dalam grup!' }, { quoted: msg });
            continue;
          }

          try {
            const groupMetadata = await sock.groupMetadata(remoteJid);
            const participants = groupMetadata.participants.map(p => p.id);
            const tagText = body.replace(/^[\/!](?:hidetag|tagall|everyone)\s*/i, '').trim();

            await sock.sendMessage(remoteJid, {
              text: tagText || '📢 *PENGUMUMAN GRUP*',
              mentions: participants
            }, { quoted: msg });
          } catch (grpErr) {
            await sock.sendMessage(remoteJid, { text: '❌ Gagal melakukan hidetag: ' + grpErr.message }, { quoted: msg });
          }
          continue;
        }

        // ================================================================
        // 17. PROTEKSI ANTI-LINK ON/OFF (/antilink on/off)
        // ================================================================
        const isAntilinkCmd = lowerBody.startsWith('/antilink') || lowerBody.startsWith('!antilink');
        if (isAntilinkCmd) {
          if (!isGroup) {
            await sock.sendMessage(remoteJid, { text: '⚠️ Perintah ini hanya dapat digunakan di dalam grup!' }, { quoted: msg });
            continue;
          }

          const opt = lowerBody.replace(/^[\/!]antilink\s*/i, '').trim();
          if (opt === 'on') {
            antilinkGroups.add(remoteJid);
            await sock.sendMessage(remoteJid, { text: '🛡️ *Anti-Link AKTIF!*\nPesan yang berisi tautan undangan grup WhatsApp lain akan otomatis dihapus.' }, { quoted: msg });
          } else if (opt === 'off') {
            antilinkGroups.delete(remoteJid);
            await sock.sendMessage(remoteJid, { text: '🛡️ *Anti-Link DINONAKTIFKAN.*' }, { quoted: msg });
          } else {
            const isAct = antilinkGroups.has(remoteJid);
            await sock.sendMessage(remoteJid, { text: `🛡️ Status Anti-Link grup ini: *${isAct ? 'ON' : 'OFF'}*\nKetik */antilink on* atau */antilink off*` }, { quoted: msg });
          }
          continue;
        }

        // ================================================================
        // 18. DOWNLOAD INSTAGRAM (/download.ig <link>)
        // ================================================================
        const isIgCommand = lowerBody.startsWith('/download.ig') ||
                            lowerBody.startsWith('/downdload.ig') ||
                            lowerBody.startsWith('/download.instagram') ||
                            lowerBody.startsWith('/ig') ||
                            lowerBody.startsWith('!ig') ||
                            lowerBody.startsWith('!download.ig');

        const igMatch = body.match(IG_REGEX);

        if (isIgCommand || igMatch) {
          const igUrl = igMatch ? igMatch[0] : '';
          if (!igUrl) {
            await sock.sendMessage(remoteJid, { 
              text: '⚠️ *Format*: */download.ig <link_ig>*\nContoh: `/download.ig https://instagram.com/reel/xxxxxx/`' 
            }, { quoted: msg });
            continue;
          }

          console.log(`📸 Mendeteksi link Instagram dari ${pushName}: ${igUrl}`);
          await sock.sendMessage(remoteJid, { text: '⏳ *Sedang memproses konten Instagram...*' }, { quoted: msg });
          await sock.sendPresenceUpdate('recording', remoteJid);

          const result = await downloadInstagram(igUrl);
          await sock.sendPresenceUpdate('paused', remoteJid);

          if (result.success) {
            if (result.type === 'multi' && result.mediaList) {
              const maxItems = Math.min(result.mediaList.length, 10);
              for (let i = 0; i < maxItems; i++) {
                const item = result.mediaList[i];
                const caption = (i === 0) ? `📸 *Instagram Downloader* (${result.mediaList.length} media)` : undefined;
                try {
                  const mediaRes = await fetch(item.url);
                  if (mediaRes.ok) {
                    const buf = Buffer.from(await mediaRes.arrayBuffer());
                    if (item.isVideo) {
                      await sock.sendMessage(remoteJid, { video: buf, caption, mimetype: 'video/mp4' }, { quoted: i === 0 ? msg : undefined });
                    } else {
                      await sock.sendMessage(remoteJid, { image: buf, caption }, { quoted: i === 0 ? msg : undefined });
                    }
                  }
                } catch (e) {
                  console.warn('[IG SEND ITEM ERROR]', e.message);
                }
              }
            } else if (result.buffer) {
              if (result.type === 'video') {
                await sock.sendMessage(remoteJid, { 
                  video: result.buffer, 
                  caption: '📸 *Instagram Reel / Video*',
                  mimetype: 'video/mp4' 
                }, { quoted: msg });
              } else {
                await sock.sendMessage(remoteJid, { 
                  image: result.buffer, 
                  caption: '📸 *Instagram Photo*' 
                }, { quoted: msg });
              }
            }
            console.log(`✅ Instagram media berhasil dikirim ke ${pushName}`);
          } else {
            await sock.sendMessage(remoteJid, { 
              text: `❌ *Gagal mengunduh Instagram*: ${result.error}` 
            }, { quoted: msg });
          }
          continue;
        }

        // ================================================================
        // 19. DOWNLOAD FACEBOOK (/download.fb <link>)
        // ================================================================
        const isFbCommand = lowerBody.startsWith('/download.fb') ||
                            lowerBody.startsWith('/downdload.fb') ||
                            lowerBody.startsWith('/download.facebook') ||
                            lowerBody.startsWith('/fb') ||
                            lowerBody.startsWith('!fb') ||
                            lowerBody.startsWith('!download.fb');

        const fbMatch = body.match(FB_REGEX);

        if (isFbCommand || fbMatch) {
          const fbUrl = fbMatch ? fbMatch[0] : '';
          if (!fbUrl) {
            await sock.sendMessage(remoteJid, { 
              text: '⚠️ *Format*: */download.fb <link_fb>*\nContoh: `/download.fb https://fb.watch/xxxxxx/`' 
            }, { quoted: msg });
            continue;
          }

          console.log(`👥 Mendeteksi link Facebook dari ${pushName}: ${fbUrl}`);
          await sock.sendMessage(remoteJid, { text: '⏳ *Sedang mengunduh video Facebook...*' }, { quoted: msg });
          await sock.sendPresenceUpdate('recording', remoteJid);

          const result = await downloadFacebook(fbUrl);
          await sock.sendPresenceUpdate('paused', remoteJid);

          if (result.success && result.buffer) {
            await sock.sendMessage(remoteJid, {
              video: result.buffer,
              caption: `👥 *Facebook Video Downloader (${result.quality || 'HD'})*`,
              mimetype: 'video/mp4'
            }, { quoted: msg });
            console.log(`✅ Video Facebook berhasil dikirim ke ${pushName}`);
          } else {
            await sock.sendMessage(remoteJid, {
              text: `❌ *Gagal mengunduh video Facebook*: ${result.error}`
            }, { quoted: msg });
          }
          continue;
        }

        // ================================================================
        // 20. DOWNLOAD THREADS (/download.th <link>)
        // ================================================================
        const isThreadsCommand = lowerBody.startsWith('/download.th') ||
                                 lowerBody.startsWith('/downdload.th') ||
                                 lowerBody.startsWith('/download.threads') ||
                                 lowerBody.startsWith('/downdload.threads') ||
                                 lowerBody.startsWith('/th') ||
                                 lowerBody.startsWith('/threads') ||
                                 lowerBody.startsWith('!th') ||
                                 lowerBody.startsWith('!download.th');

        const threadsMatch = body.match(THREADS_REGEX);

        if (isThreadsCommand || threadsMatch) {
          const threadsUrl = threadsMatch ? threadsMatch[0] : '';
          if (!threadsUrl) {
            await sock.sendMessage(remoteJid, { 
              text: '⚠️ *Format*: */download.th <link_threads>*\nContoh: `/download.th https://www.threads.net/@user/post/xxxx`' 
            }, { quoted: msg });
            continue;
          }

          console.log(`🧵 Mendeteksi link Threads dari ${pushName}: ${threadsUrl}`);
          await sock.sendMessage(remoteJid, { text: '⏳ *Sedang mengunduh konten Threads...*' }, { quoted: msg });
          await sock.sendPresenceUpdate('recording', remoteJid);

          const result = await downloadThreads(threadsUrl);
          await sock.sendPresenceUpdate('paused', remoteJid);

          if (result.success) {
            if (result.type === 'video' && result.buffer) {
              await sock.sendMessage(remoteJid, {
                video: result.buffer,
                caption: '🧵 *Threads Video*',
                mimetype: 'video/mp4'
              }, { quoted: msg });
            } else if (result.type === 'gallery' && result.images) {
              for (let i = 0; i < Math.min(result.images.length, 10); i++) {
                await sock.sendMessage(remoteJid, {
                  image: { url: result.images[i] },
                  caption: i === 0 ? `🧵 *Threads Media* (${result.images.length} foto)` : undefined
                });
              }
            } else if (result.buffer) {
              await sock.sendMessage(remoteJid, {
                image: result.buffer,
                caption: '🧵 *Threads Image*'
              }, { quoted: msg });
            }
            console.log(`✅ Konten Threads berhasil dikirim ke ${pushName}`);
          } else {
            await sock.sendMessage(remoteJid, {
              text: `❌ *Gagal mengunduh Threads*: ${result.error}`
            }, { quoted: msg });
          }
          continue;
        }

        // ================================================================
        // 21. DOWNLOAD REDNOTE / XIAOHONGSHU (/download.rn <link>)
        // ================================================================
        const isXhsCommand = lowerBody.startsWith('/download.rn') ||
                             lowerBody.startsWith('/downdload.rn') ||
                             lowerBody.startsWith('/download.rednote') ||
                             lowerBody.startsWith('/download.xiaohongshu') ||
                             lowerBody.startsWith('/download.xhs') ||
                             lowerBody.startsWith('/rn') ||
                             lowerBody.startsWith('/xhs') ||
                             lowerBody.startsWith('!rn') ||
                             lowerBody.startsWith('!download.rn');

        const xhsMatch = body.match(XHS_REGEX);

        if (isXhsCommand || xhsMatch) {
          const xhsUrl = xhsMatch ? xhsMatch[0] : '';

          if (!xhsUrl) {
            await sock.sendMessage(remoteJid, { 
              text: '⚠️ *Format*: */download.rn <link_rednote>*\nContoh: `/download.rn http://xhslink.com/xxxx`' 
            }, { quoted: msg });
            continue;
          }

          console.log(`📕 Mendeteksi tautan RedNote/Xiaohongshu dari ${pushName}: ${xhsUrl}`);
          await sock.sendMessage(remoteJid, { text: '⏳ *Sedang mengunduh konten RedNote...*' }, { quoted: msg });

          await sock.sendPresenceUpdate('recording', remoteJid);
          const result = await downloadXiaohongshu(xhsUrl);
          await sock.sendPresenceUpdate('paused', remoteJid);

          if (result.success) {
            if (result.type === 'video') {
              const caption = `📕 *RedNote Video (No Watermark)*\n👤 ${result.author} - ${result.title}`;

              await sock.sendMessage(remoteJid, {
                video: result.videoBuffer,
                caption: caption,
                mimetype: 'video/mp4'
              }, { quoted: msg });
              console.log(`✅ Video RedNote berhasil dikirim ke ${pushName}`);
            } else if (result.type === 'gallery') {
              let livePhotoCount = 0;
              const totalItems = result.mediaItems.length;

              for (let i = 0; i < Math.min(totalItems, 10); i++) {
                const item = result.mediaItems[i];
                const isFirst = i === 0;
                const caption = isFirst 
                  ? `📕 *RedNote Media* (${totalItems} foto)\n👤 ${result.author}`
                  : undefined;

                if (item.photoUrl) {
                  await sock.sendMessage(remoteJid, {
                    image: { url: item.photoUrl },
                    caption: caption
                  });
                }

                if (item.isLivePhoto && item.liveVideoUrl) {
                  livePhotoCount++;
                  try {
                    const liveRes = await fetch(item.liveVideoUrl);
                    if (liveRes.ok) {
                      const liveBuf = Buffer.from(await liveRes.arrayBuffer());
                      await sock.sendMessage(remoteJid, {
                        video: liveBuf,
                        caption: `✨ *Live Photo Motion #${i + 1}*`,
                        mimetype: 'video/mp4'
                      });
                    }
                  } catch (liveErr) {
                    console.warn('[LIVE PHOTO FETCH ERROR]', liveErr.message);
                  }
                }
              }
              console.log(`✅ ${totalItems} media RedNote (${livePhotoCount} Live Photo) berhasil dikirim ke ${pushName}`);
            }
          } else {
            await sock.sendMessage(remoteJid, {
              text: `❌ *Gagal mengunduh RedNote*: ${result.error}`
            }, { quoted: msg });
          }

          continue;
        }

        // ================================================================
        // 22. DOWNLOAD TIKTOK (/download.tt <link>)
        // ================================================================
        const isTtCommand = lowerBody.startsWith('/download.tt') ||
                            lowerBody.startsWith('/downdload.tt') ||
                            lowerBody.startsWith('/download.tiktok') ||
                            lowerBody.startsWith('/downdload.tiktok') ||
                            lowerBody.startsWith('/tt') ||
                            lowerBody.startsWith('/tiktok') ||
                            lowerBody.startsWith('!tt') ||
                            lowerBody.startsWith('!download.tt');

        const tiktokMatch = body.match(TIKTOK_REGEX);

        if (isTtCommand || tiktokMatch) {
          const tiktokUrl = tiktokMatch ? tiktokMatch[0] : '';

          if (!tiktokUrl) {
            await sock.sendMessage(remoteJid, { 
              text: '⚠️ *Format*: */download.tt <link_tiktok>*\nContoh: `/download.tt https://vt.tiktok.com/xxxxxx/`' 
            }, { quoted: msg });
            continue;
          }

          console.log(`🎬 Mendeteksi tautan TikTok dari ${pushName}: ${tiktokUrl}`);
          await sock.sendMessage(remoteJid, { text: '⏳ *Sedang mengunduh TikTok...*' }, { quoted: msg });

          await sock.sendPresenceUpdate('recording', remoteJid);
          const result = await downloadTikTokVideo(tiktokUrl);
          await sock.sendPresenceUpdate('paused', remoteJid);

          if (result.success) {
            if (result.type === 'video') {
              const caption = `🎬 *TikTok Video (No Watermark)*\n👤 ${result.author} - ${result.title}`;

              await sock.sendMessage(remoteJid, {
                video: result.videoBuffer,
                caption: caption,
                mimetype: 'video/mp4'
              }, { quoted: msg });
              console.log(`✅ Video TikTok berhasil dikirim ke ${pushName}`);
            } else if (result.type === 'slide') {
              for (let i = 0; i < Math.min(result.images.length, 10); i++) {
                await sock.sendMessage(remoteJid, {
                  image: { url: result.images[i] },
                  caption: i === 0 ? `📸 *Slide Foto TikTok* (${result.images.length} foto)\n👤 @${result.author}` : undefined
                });
              }
              console.log(`✅ ${result.images.length} Foto Slide TikTok berhasil dikirim ke ${pushName}`);
            }
          } else {
            await sock.sendMessage(remoteJid, {
              text: `❌ *Gagal mengunduh TikTok*: ${result.error}`
            }, { quoted: msg });
          }

          continue;
        }

        // ================================================================
        // 23. DOWNLOAD TWITTER / X (/download.x <link>)
        // ================================================================
        const isTwCommand = lowerBody.startsWith('/download.x') ||
                            lowerBody.startsWith('/downdload.x') ||
                            lowerBody.startsWith('/download.tw') ||
                            lowerBody.startsWith('/downdload.tw') ||
                            lowerBody.startsWith('/download.twitter') ||
                            lowerBody.startsWith('/x ') ||
                            lowerBody === '/x' ||
                            lowerBody.startsWith('/tw') ||
                            lowerBody.startsWith('!x') ||
                            lowerBody.startsWith('!tw');

        const twMatch = body.match(TWITTER_REGEX);

        if (isTwCommand || twMatch) {
          const twUrl = twMatch ? twMatch[0] : '';
          if (!twUrl) {
            await sock.sendMessage(remoteJid, { 
              text: '⚠️ *Format*: */download.x <link_x>*\nContoh: `/download.x https://x.com/user/status/xxxx`' 
            }, { quoted: msg });
            continue;
          }

          console.log(`🐦 Mendeteksi link Twitter/X dari ${pushName}: ${twUrl}`);
          await sock.sendMessage(remoteJid, { text: '⏳ *Sedang mengunduh video Twitter/X...*' }, { quoted: msg });
          await sock.sendPresenceUpdate('recording', remoteJid);

          const result = await downloadTwitter(twUrl);
          await sock.sendPresenceUpdate('paused', remoteJid);

          if (result.success && result.buffer) {
            await sock.sendMessage(remoteJid, {
              video: result.buffer,
              caption: `🐦 *Twitter / X Video*`,
              mimetype: 'video/mp4'
            }, { quoted: msg });
            console.log(`✅ Video Twitter berhasil dikirim ke ${pushName}`);
          } else {
            await sock.sendMessage(remoteJid, {
              text: `❌ *Gagal mengunduh Twitter/X*: ${result.error}`
            }, { quoted: msg });
          }
          continue;
        }

        // ================================================================
        // 24. DOWNLOAD YOUTUBE (/download.yt <link>)
        // ================================================================
        const isYtCommand = lowerBody.startsWith('/download.yt') ||
                            lowerBody.startsWith('/downdload.yt') ||
                            lowerBody.startsWith('/download.youtube') ||
                            lowerBody.startsWith('/yt') ||
                            lowerBody.startsWith('!yt') ||
                            lowerBody.startsWith('!download.yt');

        const ytMatch = body.match(YOUTUBE_REGEX);

        if (isYtCommand || ytMatch) {
          const ytUrl = ytMatch ? ytMatch[0] : '';
          if (!ytUrl) {
            await sock.sendMessage(remoteJid, { 
              text: '⚠️ *Format*: */download.yt <link_youtube>*\nContoh: `/download.yt https://youtu.be/xxxx`' 
            }, { quoted: msg });
            continue;
          }

          console.log(`▶️ Mendeteksi link YouTube dari ${pushName}: ${ytUrl}`);
          await sock.sendMessage(remoteJid, { text: '⏳ *Sedang mengunduh video YouTube...*' }, { quoted: msg });
          await sock.sendPresenceUpdate('recording', remoteJid);

          const result = await downloadYouTube(ytUrl);
          await sock.sendPresenceUpdate('paused', remoteJid);

          if (result.success && result.buffer) {
            await sock.sendMessage(remoteJid, {
              video: result.buffer,
              caption: `▶️ *YouTube Video*`,
              mimetype: 'video/mp4'
            }, { quoted: msg });
            console.log(`✅ Video YouTube berhasil dikirim ke ${pushName}`);
          } else {
            await sock.sendMessage(remoteJid, {
              text: `❌ *Gagal mengunduh YouTube*: ${result.error}`
            }, { quoted: msg });
          }
          continue;
        }

        // ================================================================
        // 25. CHAT AI GEMINI (MULTIMODAL: TEKS & VISION GAMBAR)
        // ================================================================
        let cleanPrompt = body;
        if (cleanPrompt.startsWith('/ai')) {
          cleanPrompt = cleanPrompt.replace(/^\/ai\s*/i, '');
        } else if (cleanPrompt.startsWith('/cek')) {
          cleanPrompt = cleanPrompt.replace(/^\/cek\s*/i, '');
        } else if (cleanPrompt.startsWith('/tanya')) {
          cleanPrompt = cleanPrompt.replace(/^\/tanya\s*/i, '');
        } else if (cleanPrompt.startsWith('/ask')) {
          cleanPrompt = cleanPrompt.replace(/^\/ask\s*/i, '');
        } else if (cleanPrompt.startsWith('!ai')) {
          cleanPrompt = cleanPrompt.replace(/^!ai\s*/i, '');
        } else if (cleanPrompt.toLowerCase().startsWith('ai ')) {
          cleanPrompt = cleanPrompt.replace(/^ai\s+/i, '');
        }

        let imageBuffer = null;
        let imageMime = 'image/jpeg';
        const media = await extractMedia(msg);
        if (media && (media.isImage || media.isSticker)) {
          imageBuffer = media.buffer;
          imageMime = media.mimeType || 'image/jpeg';
          console.log(`👁️ Memproses gambar dengan Gemini AI Vision dari ${pushName}`);
        }

        if (!cleanPrompt.trim() && !imageBuffer) {
          await sock.sendMessage(remoteJid, { 
            text: 'Halo! Ada yang bisa saya bantu? Ketik */ai <pertanyaan>* atau ketik */menu* untuk melihat semua fitur.' 
          }, { quoted: msg });
          continue;
        }

        // Efek "Sedang Mengetik..." di WhatsApp agar terasa natural
        await sock.sendPresenceUpdate('composing', remoteJid);

        // Generate balasan via Gemini AI (Multimodal jika ada gambar)
        const aiResponse = await generateAiReply(remoteJid, cleanPrompt, pushName, imageBuffer, imageMime);

        // Hentikan efek mengetik
        await sock.sendPresenceUpdate('paused', remoteJid);

        // Kirim balasan ke pengguna (reply quoted)
        await sock.sendMessage(remoteJid, { text: aiResponse }, { quoted: msg });
        console.log(`💬 Balasan terkirim ke ${pushName}: "${aiResponse.substring(0, 80).replace(/\n/g, ' ')}..."`);

      } catch (err) {
        console.error('[ERROR MEMPROSES PESAN]', err);
      }
    }
  });

  return sock;
}

// Jalankan bot
startWhatsAppBot().catch((err) => {
  console.error('[FATAL ERROR BOT]', err);
});

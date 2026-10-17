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

// Persona Asisten AI WhatsApp (Profesional, Cerdas & Sopan - Bukan Pacar/Pasangan)
const DEFAULT_SYSTEM_PROMPT = 
  process.env.WA_AI_SYSTEM_PROMPT || 
  `Kamu adalah asisten AI WhatsApp pintar, sopan, ramah, dan profesional.
- PERATURAN MUTLAK: Kamu adalah ASISTEN VIRTUAL RESMI. DILARANG KERAS bertingkah laku sebagai pacar, pasangan romantis, bersikap manja, atau memanggil lawan bicara dengan sebutan romantis (seperti 'sayang', 'beb', 'pacarku', 'cintaku', dsb).
- Berikan jawaban yang informatif, jelas, to the point, dan bermanfaat bagi pengguna.
- Gunakan bahasa Indonesia yang santai, ramah, namun tetap menjaga etika dan sopan santun.
- Fitur Spesial Bot yang kamu miliki:
  1. Unduh Instagram: Reels, Foto, Carousel, & Story (Perintah: /download.ig <link> atau /ig)
  2. Unduh Facebook: Video & Reels kualitas HD (Perintah: /download.fb <link> atau /fb)
  3. Unduh Threads: Foto & Video (Perintah: /download.threads <link> atau /threads)
  4. Unduh TikTok: Video tanpa watermark & Slide Foto (Perintah: /download.tiktok <link> atau /tt)
  5. Unduh Xiaohongshu / RedNote: Video, Foto HD, & Live Photo bergerak (Perintah: /download.xiaohongshu <link> atau /xhs)
  6. Unduh Twitter / X: Video & GIF (Perintah: /download.tw <link> atau /x)
  7. Unduh YouTube: Video & Shorts (Perintah: /download.yt <link> atau /yt)
  8. Cek Status VPS (/status) dan Kecepatan Respon (/ping)
- Jika pengguna bertanya tentang fitur bot, jelaskan perintah-perintah di atas dengan rapi.
- Pengguna juga bisa langsung mengirimkan/menempelkan tautan media sosial langsung ke chat tanpa harus mengetik awalan perintah!
- Gunakan formatting WhatsApp yang nyaman dibaca (*bold*, _italic_, daftar poin).
- Jika pengguna bertanya dalam bahasa lain (misal Inggris atau Mandarin), jawablah dalam bahasa yang sama dengan profesional.`;

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
// FUNGSI GENERATE JAWABAN GEMINI AI DENGAN FAILOVER MULTI-KEY
// ====================================================================
async function generateAiReply(jid, userMessage, senderName = 'Teman') {
  const history = getChatHistory(jid);

  let prompt = '';
  if (history.length > 0) {
    prompt += 'Berikut riwayat percakapan sebelumnya:\n';
    for (const h of history) {
      prompt += `${h.role === 'user' ? senderName : 'AI'}: ${h.text}\n`;
    }
    prompt += `\nPesan baru dari ${senderName}: "${userMessage}"\nBalasanmu:`;
  } else {
    prompt = userMessage;
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
          contents: prompt,
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
  addChatHistory(jid, 'user', userMessage);
  addChatHistory(jid, 'model', replyText);

  return replyText;
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

    // Cari window.__INITIAL_STATE__ atau window.__INITIAL_SSR_STATE__
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
      bot: 'WhatsApp AI Bot (Gemini + Multi-Downloader)',
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
      console.log('📥 Downloader: IG, FB, Threads, TikTok, RedNote, X, YT');
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

        if (!body) continue;

        console.log(`\n📩 [${isGroup ? 'GRUP' : 'JAPRI'}] Dari: ${pushName} (${remoteJid}): "${body}"`);

        const botNumber = sock.user?.id ? sock.user.id.split(':')[0] : '';
        const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const isTagged = mentionedJids.some(jid => jid.includes(botNumber));

        if (isGroup) {
          const isExplicitCommand = body.startsWith('/') || body.startsWith('!') || body.toLowerCase().startsWith('ai ');
          if (CONFIG.replyInGroupsOnlyWhenTagged && !isTagged && !isExplicitCommand) {
            continue;
          }
        }

        const lowerBody = body.toLowerCase().trim();

        // ================================================================
        // 1. MENU & PANDUAN (/menu atau /help)
        // ================================================================
        if (lowerBody === '/menu' || lowerBody === '/help' || lowerBody === '!menu' || lowerBody === '!help') {
          const menuText = 
`╭────────────────────────────╮
│    🤖 *WHATSAPP AI BOT*    │
│  _Online 24 Jam di VPS_   │
╰────────────────────────────╯

Halo, *${pushName}*! 👋
Berikut daftar fitur dan perintah yang tersedia:

📥 *DOWNLOADER (MULTI PLATFORM)*
├ • */download.ig <link>* (atau */ig*)
│   _Instagram Reels, Foto, Carousel, & Story_
│   Contoh: \`/download.ig https://instagram.com/reel/...\`
│
├ • */download.fb <link>* (atau */fb*)
│   _Facebook Video & Reels kualitas HD_
│   Contoh: \`/download.fb https://facebook.com/watch/...\`
│
├ • */download.threads <link>* (atau */threads*)
│   _Foto & Video dari Threads_
│   Contoh: \`/download.threads https://threads.net/...\`
│
├ • */download.tiktok <link>* (atau */tt*)
│   _Video TikTok HD tanpa watermark & Slide Foto_
│   Contoh: \`/download.tiktok https://vt.tiktok.com/...\`
│
├ • */download.xiaohongshu <link>* (atau */xhs*)
│   _Video, Foto HD Asli, & Live Photo (RedNote)_
│   Contoh: \`/download.xiaohongshu http://xhslink.com/...\`
│
├ • */download.tw <link>* (atau */x*)
│   _Video & GIF Twitter / X_
│   Contoh: \`/download.tw https://x.com/...\`
│
├ • */download.yt <link>* (atau */yt*)
│   _YouTube Shorts & Video (Maks 50MB)_
│   Contoh: \`/download.yt https://youtu.be/...\`
╰────────────────────────────

🧠 *AI ASSISTANT (GEMINI)*
├ • */ai <pertanyaan>*
│   _Tanya atau diskusi apa saja dengan Gemini AI_
│   Contoh: \`/ai berikan ide ide konten media sosial\`
│
├ • */reset*
│   _Hapus riwayat chat untuk memulai topik baru_
╰────────────────────────────

⚙️ *SISTEM & INFORMASI*
├ • */menu* : Menampilkan menu perintah ini
├ • */ping* : Cek kecepatan respon bot
├ • */status* : Cek info server VPS & RAM
╰────────────────────────────

💡 *Tips Praktis*: Anda tidak wajib mengetik perintah! Cukup tempelkan (paste) link langsung ke chat ini, bot akan otomatis mendeteksi platformnya!`;

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
🤖 *Downloader*: yt-dlp + ffmpeg + btch
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
        // 5. DOWNLOAD INSTAGRAM (/download.ig <link> atau /ig atau link langsung)
        // ================================================================
        const isIgCommand = lowerBody.startsWith('/download.ig') ||
                            lowerBody.startsWith('/download.instagram') ||
                            lowerBody.startsWith('/ig') ||
                            lowerBody.startsWith('!ig') ||
                            lowerBody.startsWith('!download.ig');

        const igMatch = body.match(IG_REGEX);

        if (isIgCommand || igMatch) {
          const igUrl = igMatch ? igMatch[0] : '';
          if (!igUrl) {
            await sock.sendMessage(remoteJid, { 
              text: '⚠️ *Format Perintah Instagram*\n\nGunakan format:\n*/download.ig <link_instagram>*\nContoh: \`/download.ig https://www.instagram.com/reel/xxxxxx/\`' 
            }, { quoted: msg });
            continue;
          }

          console.log(`📸 Mendeteksi link Instagram dari ${pushName}: ${igUrl}`);
          await sock.sendMessage(remoteJid, { text: '⏳ *Sedang memproses dan mengunduh konten Instagram...*\nMohon tunggu beberapa detik ya!' }, { quoted: msg });
          await sock.sendPresenceUpdate('recording', remoteJid);

          const result = await downloadInstagram(igUrl);
          await sock.sendPresenceUpdate('paused', remoteJid);

          if (result.success) {
            if (result.type === 'multi' && result.mediaList) {
              const maxItems = Math.min(result.mediaList.length, 10);
              for (let i = 0; i < maxItems; i++) {
                const item = result.mediaList[i];
                const caption = (i === 0) ? `📸 *Instagram Downloader*\nTotal media: ${result.mediaList.length}\n⚡ _Berhasil diunduh oleh AI Bot_` : undefined;
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
                  caption: '📸 *Instagram Reel / Video*\n⚡ _Berhasil diunduh oleh AI WhatsApp Bot!_',
                  mimetype: 'video/mp4' 
                }, { quoted: msg });
              } else {
                await sock.sendMessage(remoteJid, { 
                  image: result.buffer, 
                  caption: '📸 *Instagram Photo*\n⚡ _Berhasil diunduh oleh AI WhatsApp Bot!_' 
                }, { quoted: msg });
              }
            }
            console.log(`✅ Instagram media berhasil dikirim ke ${pushName}`);
          } else {
            await sock.sendMessage(remoteJid, { 
              text: `❌ *Gagal mengunduh konten Instagram*\n\nAlasan: ${result.error}\n_Pastikan akun tidak diprivat dan tautannya aktif._` 
            }, { quoted: msg });
          }
          continue;
        }

        // ================================================================
        // 6. DOWNLOAD FACEBOOK (/download.fb <link> atau /fb atau link langsung)
        // ================================================================
        const isFbCommand = lowerBody.startsWith('/download.fb') ||
                            lowerBody.startsWith('/download.facebook') ||
                            lowerBody.startsWith('/fb') ||
                            lowerBody.startsWith('!fb') ||
                            lowerBody.startsWith('!download.fb');

        const fbMatch = body.match(FB_REGEX);

        if (isFbCommand || fbMatch) {
          const fbUrl = fbMatch ? fbMatch[0] : '';
          if (!fbUrl) {
            await sock.sendMessage(remoteJid, { 
              text: '⚠️ *Format Perintah Facebook*\n\nGunakan format:\n*/download.fb <link_facebook>*\nContoh: \`/download.fb https://fb.watch/xxxxxx/\`' 
            }, { quoted: msg });
            continue;
          }

          console.log(`👥 Mendeteksi link Facebook dari ${pushName}: ${fbUrl}`);
          await sock.sendMessage(remoteJid, { text: '⏳ *Sedang mengunduh video Facebook...*\nMohon tunggu beberapa detik ya!' }, { quoted: msg });
          await sock.sendPresenceUpdate('recording', remoteJid);

          const result = await downloadFacebook(fbUrl);
          await sock.sendPresenceUpdate('paused', remoteJid);

          if (result.success && result.buffer) {
            await sock.sendMessage(remoteJid, {
              video: result.buffer,
              caption: `👥 *Facebook Video Downloader (${result.quality || 'HD'})*\n⚡ _Berhasil diunduh oleh AI WhatsApp Bot!_`,
              mimetype: 'video/mp4'
            }, { quoted: msg });
            console.log(`✅ Video Facebook berhasil dikirim ke ${pushName}`);
          } else {
            await sock.sendMessage(remoteJid, {
              text: `❌ *Gagal mengunduh video Facebook*\n\nAlasan: ${result.error}\n_Pastikan video bersifat publik dan tautannya aktif._`
            }, { quoted: msg });
          }
          continue;
        }

        // ================================================================
        // 7. DOWNLOAD THREADS (/download.threads <link> atau /threads)
        // ================================================================
        const isThreadsCommand = lowerBody.startsWith('/download.threads') ||
                                 lowerBody.startsWith('/threads') ||
                                 lowerBody.startsWith('!threads') ||
                                 lowerBody.startsWith('!download.threads');

        const threadsMatch = body.match(THREADS_REGEX);

        if (isThreadsCommand || threadsMatch) {
          const threadsUrl = threadsMatch ? threadsMatch[0] : '';
          if (!threadsUrl) {
            await sock.sendMessage(remoteJid, { 
              text: '⚠️ *Format Perintah Threads*\n\nGunakan format:\n*/download.threads <link_threads>*\nContoh: \`/download.threads https://www.threads.net/@user/post/xxxx\`' 
            }, { quoted: msg });
            continue;
          }

          console.log(`🧵 Mendeteksi link Threads dari ${pushName}: ${threadsUrl}`);
          await sock.sendMessage(remoteJid, { text: '⏳ *Sedang mengunduh konten Threads...*\nMohon tunggu beberapa detik ya!' }, { quoted: msg });
          await sock.sendPresenceUpdate('recording', remoteJid);

          const result = await downloadThreads(threadsUrl);
          await sock.sendPresenceUpdate('paused', remoteJid);

          if (result.success) {
            if (result.type === 'video' && result.buffer) {
              await sock.sendMessage(remoteJid, {
                video: result.buffer,
                caption: '🧵 *Threads Video Downloader*\n⚡ _Berhasil diunduh oleh AI WhatsApp Bot!_',
                mimetype: 'video/mp4'
              }, { quoted: msg });
            } else if (result.type === 'gallery' && result.images) {
              for (let i = 0; i < Math.min(result.images.length, 10); i++) {
                await sock.sendMessage(remoteJid, {
                  image: { url: result.images[i] },
                  caption: i === 0 ? `🧵 *Threads Media* (${result.images.length} foto)\n⚡ _Berhasil diunduh oleh AI WhatsApp Bot!_` : undefined
                });
              }
            } else if (result.buffer) {
              await sock.sendMessage(remoteJid, {
                image: result.buffer,
                caption: '🧵 *Threads Image*\n⚡ _Berhasil diunduh oleh AI WhatsApp Bot!_'
              }, { quoted: msg });
            }
            console.log(`✅ Konten Threads berhasil dikirim ke ${pushName}`);
          } else {
            await sock.sendMessage(remoteJid, {
              text: `❌ *Gagal mengunduh konten Threads*\n\nAlasan: ${result.error}\n_Pastikan tautan benar dan postingan bersifat publik._`
            }, { quoted: msg });
          }
          continue;
        }

        // ================================================================
        // 8. DOWNLOAD XIAOHONGSHU (/download.xiaohongshu <link>)
        // ================================================================
        const isXhsCommand = lowerBody.startsWith('/download.xiaohongshu') ||
                             lowerBody.startsWith('/download.xhs') ||
                             lowerBody.startsWith('/xiaohongshu') ||
                             lowerBody.startsWith('/xhs') ||
                             lowerBody.startsWith('!download.xiaohongshu');

        const xhsMatch = body.match(XHS_REGEX);

        if (isXhsCommand || xhsMatch) {
          const xhsUrl = xhsMatch ? xhsMatch[0] : '';

          if (!xhsUrl) {
            const helpMsg = 
`⚠️ *Format Perintah Xiaohongshu*

Gunakan format:
*/download.xiaohongshu <link_postingan>*

Contoh:
\`/download.xiaohongshu http://xhslink.com/a/xxxxxx\`

_Fitur: Mengunduh Video tanpa watermark, Foto resolusi asli, dan Live Photo bergerak!_`;
            await sock.sendMessage(remoteJid, { text: helpMsg }, { quoted: msg });
            continue;
          }

          console.log(`📕 Mendeteksi tautan Xiaohongshu dari ${pushName}: ${xhsUrl}`);

          await sock.sendMessage(remoteJid, { 
            text: '⏳ *Sedang mendownload konten Xiaohongshu (RedNote)...*\nMohon tunggu beberapa detik ya!' 
          }, { quoted: msg });

          await sock.sendPresenceUpdate('recording', remoteJid);
          const result = await downloadXiaohongshu(xhsUrl);
          await sock.sendPresenceUpdate('paused', remoteJid);

          if (result.success) {
            if (result.type === 'video') {
              const caption = 
`📕 *Xiaohongshu Video Downloader (No Watermark)*

👤 *Author*: ${result.author}
📝 *Judul*: ${result.title}
${result.desc ? `\n💬 *Deskripsi*: ${result.desc.substring(0, 150)}...` : ''}

⚡ _Berhasil diunduh tanpa watermark oleh AI WhatsApp Bot!_`;

              await sock.sendMessage(remoteJid, {
                video: result.videoBuffer,
                caption: caption,
                mimetype: 'video/mp4'
              }, { quoted: msg });
              console.log(`✅ Video Xiaohongshu berhasil dikirim ke ${pushName}`);
            } else if (result.type === 'gallery') {
              let livePhotoCount = 0;
              const totalItems = result.mediaItems.length;

              for (let i = 0; i < Math.min(totalItems, 10); i++) {
                const item = result.mediaItems[i];
                const isFirst = i === 0;
                const caption = isFirst 
                  ? `📕 *Xiaohongshu Media Gallery*\n👤 *Author*: ${result.author}\n📝 *Judul*: ${result.title}\n📷 Total: ${totalItems} foto ${item.isLivePhoto ? '(Termasuk Live Photo)' : ''}`
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
                        caption: `✨ *Live Photo Motion Clip #${i + 1}* (Klip foto bergerak/dinamis)`,
                        mimetype: 'video/mp4'
                      });
                    }
                  } catch (liveErr) {
                    console.warn('[LIVE PHOTO FETCH ERROR]', liveErr.message);
                  }
                }
              }
              console.log(`✅ ${totalItems} media Xiaohongshu (${livePhotoCount} Live Photo) berhasil dikirim ke ${pushName}`);
            }
          } else {
            await sock.sendMessage(remoteJid, {
              text: `❌ *Gagal mengunduh konten Xiaohongshu*\n\nAlasan: ${result.error}\n_Pastikan tautan benar dan postingan dapat diakses publik._`
            }, { quoted: msg });
          }

          continue;
        }

        // ================================================================
        // 9. DOWNLOAD TIKTOK (/download.tiktok <link>)
        // ================================================================
        const isTtCommand = lowerBody.startsWith('/download.tiktok') ||
                            lowerBody.startsWith('/download.tt') ||
                            lowerBody.startsWith('/tiktok') ||
                            lowerBody.startsWith('/tt') ||
                            lowerBody.startsWith('!download.tiktok');

        const tiktokMatch = body.match(TIKTOK_REGEX);

        if (isTtCommand || tiktokMatch) {
          const tiktokUrl = tiktokMatch ? tiktokMatch[0] : '';

          if (!tiktokUrl) {
            const helpMsg = 
`⚠️ *Format Perintah TikTok*

Gunakan format:
*/download.tiktok <link_video>*

Contoh:
\`/download.tiktok https://vt.tiktok.com/xxxxxx/\`

_Fitur: Mengunduh Video HD tanpa watermark dan Slide Foto!_`;
            await sock.sendMessage(remoteJid, { text: helpMsg }, { quoted: msg });
            continue;
          }

          console.log(`🎬 Mendeteksi tautan TikTok dari ${pushName}: ${tiktokUrl}`);

          await sock.sendMessage(remoteJid, { 
            text: '⏳ *Sedang mendownload video TikTok tanpa watermark...*\nMohon tunggu beberapa detik ya!' 
          }, { quoted: msg });

          await sock.sendPresenceUpdate('recording', remoteJid);
          const result = await downloadTikTokVideo(tiktokUrl);
          await sock.sendPresenceUpdate('paused', remoteJid);

          if (result.success) {
            if (result.type === 'video') {
              const caption = 
`🎬 *TikTok Video Downloader (No Watermark)*

👤 *Author*: ${result.author}
📝 *Judul*: ${result.title}

⚡ _Berhasil diunduh tanpa watermark oleh AI WhatsApp Bot!_`;

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
                  caption: i === 0 ? `📸 *Slide Foto TikTok* (${result.images.length} foto)\n👤 @${result.author}\n📝 ${result.title}` : undefined
                });
              }
              console.log(`✅ ${result.images.length} Foto Slide TikTok berhasil dikirim ke ${pushName}`);
            }
          } else {
            await sock.sendMessage(remoteJid, {
              text: `❌ *Gagal mengunduh video TikTok*\n\nAlasan: ${result.error}\n_Pastikan tautan benar dan video bersifat publik._`
            }, { quoted: msg });
          }

          continue;
        }

        // ================================================================
        // 10. DOWNLOAD TWITTER / X (/download.tw <link> atau /tw atau /x)
        // ================================================================
        const isTwCommand = lowerBody.startsWith('/download.tw') ||
                            lowerBody.startsWith('/download.twitter') ||
                            lowerBody.startsWith('/download.x') ||
                            lowerBody.startsWith('/tw') ||
                            lowerBody.startsWith('/x ') ||
                            lowerBody === '/x' ||
                            lowerBody.startsWith('!tw');

        const twMatch = body.match(TWITTER_REGEX);

        if (isTwCommand || twMatch) {
          const twUrl = twMatch ? twMatch[0] : '';
          if (!twUrl) {
            await sock.sendMessage(remoteJid, { 
              text: '⚠️ *Format Perintah Twitter/X*\n\nGunakan format:\n*/download.tw <link_tweet>*\nContoh: \`/download.tw https://x.com/user/status/xxxx\`' 
            }, { quoted: msg });
            continue;
          }

          console.log(`🐦 Mendeteksi link Twitter/X dari ${pushName}: ${twUrl}`);
          await sock.sendMessage(remoteJid, { text: '⏳ *Sedang mengunduh video Twitter/X...*\nMohon tunggu beberapa detik ya!' }, { quoted: msg });
          await sock.sendPresenceUpdate('recording', remoteJid);

          const result = await downloadTwitter(twUrl);
          await sock.sendPresenceUpdate('paused', remoteJid);

          if (result.success && result.buffer) {
            await sock.sendMessage(remoteJid, {
              video: result.buffer,
              caption: `🐦 *${result.title || 'Twitter / X Video'}*\n⚡ _Berhasil diunduh oleh AI WhatsApp Bot!_`,
              mimetype: 'video/mp4'
            }, { quoted: msg });
            console.log(`✅ Video Twitter berhasil dikirim ke ${pushName}`);
          } else {
            await sock.sendMessage(remoteJid, {
              text: `❌ *Gagal mengunduh video Twitter/X*\n\nAlasan: ${result.error}\n_Pastikan postingan memiliki video publik._`
            }, { quoted: msg });
          }
          continue;
        }

        // ================================================================
        // 11. DOWNLOAD YOUTUBE (/download.yt <link> atau /yt)
        // ================================================================
        const isYtCommand = lowerBody.startsWith('/download.yt') ||
                            lowerBody.startsWith('/download.youtube') ||
                            lowerBody.startsWith('/yt') ||
                            lowerBody.startsWith('!yt') ||
                            lowerBody.startsWith('!download.yt');

        const ytMatch = body.match(YOUTUBE_REGEX);

        if (isYtCommand || ytMatch) {
          const ytUrl = ytMatch ? ytMatch[0] : '';
          if (!ytUrl) {
            await sock.sendMessage(remoteJid, { 
              text: '⚠️ *Format Perintah YouTube*\n\nGunakan format:\n*/download.yt <link_youtube>*\nContoh: \`/download.yt https://youtu.be/xxxx\`' 
            }, { quoted: msg });
            continue;
          }

          console.log(`▶️ Mendeteksi link YouTube dari ${pushName}: ${ytUrl}`);
          await sock.sendMessage(remoteJid, { text: '⏳ *Sedang mengunduh video/Shorts YouTube...*\nMohon tunggu beberapa saat ya!' }, { quoted: msg });
          await sock.sendPresenceUpdate('recording', remoteJid);

          const result = await downloadYouTube(ytUrl);
          await sock.sendPresenceUpdate('paused', remoteJid);

          if (result.success && result.buffer) {
            await sock.sendMessage(remoteJid, {
              video: result.buffer,
              caption: `▶️ *YouTube Downloader*\n⚡ _Berhasil diunduh oleh AI WhatsApp Bot!_`,
              mimetype: 'video/mp4'
            }, { quoted: msg });
            console.log(`✅ Video YouTube berhasil dikirim ke ${pushName}`);
          } else {
            await sock.sendMessage(remoteJid, {
              text: `❌ *Gagal mengunduh video YouTube*\n\nAlasan: ${result.error}\n_Catatan: Bot hanya dapat mengunduh video maksimal 50MB._`
            }, { quoted: msg });
          }
          continue;
        }

        // ================================================================
        // 12. CHAT AI GEMINI (/ai <pertanyaan> atau chat langsung di japri)
        // ================================================================
        let cleanPrompt = body;
        if (cleanPrompt.startsWith('/ai')) {
          cleanPrompt = cleanPrompt.replace(/^\/ai\s*/i, '');
        } else if (cleanPrompt.startsWith('/tanya')) {
          cleanPrompt = cleanPrompt.replace(/^\/tanya\s*/i, '');
        } else if (cleanPrompt.startsWith('/ask')) {
          cleanPrompt = cleanPrompt.replace(/^\/ask\s*/i, '');
        } else if (cleanPrompt.startsWith('!ai')) {
          cleanPrompt = cleanPrompt.replace(/^!ai\s*/i, '');
        } else if (cleanPrompt.toLowerCase().startsWith('ai ')) {
          cleanPrompt = cleanPrompt.replace(/^ai\s+/i, '');
        }

        if (!cleanPrompt.trim()) {
          await sock.sendMessage(remoteJid, { 
            text: 'Halo! Ada yang bisa saya bantu? Ketik */ai <pertanyaan Anda>* atau ketik */menu* untuk melihat panduan fitur.' 
          }, { quoted: msg });
          continue;
        }

        // Efek "Sedang Mengetik..." di WhatsApp agar terasa natural
        await sock.sendPresenceUpdate('composing', remoteJid);

        // Generate balasan via Gemini AI
        const aiResponse = await generateAiReply(remoteJid, cleanPrompt, pushName);

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

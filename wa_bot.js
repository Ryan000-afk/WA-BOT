require('dotenv').config();
const path = require('path');
const fs = require('fs');
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

// Persona default jika tidak disetel khusus di .env
const DEFAULT_SYSTEM_PROMPT = 
  process.env.WA_AI_SYSTEM_PROMPT || 
  process.env.AI_SYSTEM_PROMPT || 
  `Kamu adalah asisten AI WhatsApp pintar, ramah, dan solutif.
- Fitur Spesialmu:
  1. DOWNLOAD VIDEO TIKTOK TANPA WATERMARK: Pengguna cukup kirim link TikTok ke chat.
  2. DOWNLOAD KONTEN XIAOHONGSHU (REDNOTE / 小红书): Pengguna cukup kirim link Xiaohongshu (xhslink.com atau xiaohongshu.com), dan kamu bisa mengunduh video tanpa watermark, foto resolusi tinggi, serta Live Photo (foto + klip gerak/animasi).
- Jawablah pesan dengan bahasa Indonesia yang santai, alami, jelas, dan mudah dipahami.
- Gunakan formatting WhatsApp yang rapi (*bold*, _italic_, daftar poin) jika diperlukan.
- Jangan berbelit-belit atau terlalu kaku seperti robot.
- Jika pengguna bertanya dalam bahasa lain, balas dengan bahasa yang sama.`;

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
          // Simpan key aktif yang berhasil agar permintaan berikutnya menggunakan key ini
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
          break; // Pindah ke API Key berikutnya di pool
        }
      }
    }

    if (replyText) break; // Berhasil mendapatkan balasan

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
// FUNGSI DOWNLOAD VIDEO TIKTOK TANPA WATERMARK
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

    // Unduh langsung video ke Buffer
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
// FUNGSI DOWNLOAD KONTEN XIAOHONGSHU / REDNOTE (VIDEO, FOTO, LIVE PHOTO)
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
// SERVER HTTP HEALTH-CHECK (UNTUK CLOUD DEPLOYMENT SEPERTI RENDER/RAILWAY)
// ====================================================================
const http = require('http');
const HTTP_PORT = process.env.PORT || 3000;
try {
  const healthServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'online',
      bot: 'WhatsApp AI Bot (Gemini + Downloader)',
      timestamp: new Date().toISOString()
    }));
  });
  healthServer.listen(HTTP_PORT, () => {
    console.log(`[HTTP HEALTH-CHECK] Server aktif di port ${HTTP_PORT} (Siap untuk Cloud Hosting)`);
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
  console.log('🤖 MEMULAI WHATSAPP AI BOT (GEMINI)...');
  console.log('==================================================');

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Menggunakan versi WhatsApp Web v${version.join('.')}${isLatest ? ' (Terbaru)' : ''}`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04'], // Format standar agar kompatibel di Linux cloud/VPS
    generateHighQualityLinkPreview: true,
  });

  sock.ev.on('creds.update', saveCreds);

  // Opsi Pairing Code jika nomor HP diisi di .env (Sangat berguna di Server Cloud tanpa layar)
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

    // Cetak QR hanya jika belum registered dan tidak sedang menggunakan pairing code
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
      console.log('==================================================\n');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        // Abaikan pesan jika dikirim oleh bot sendiri
        if (msg.key.fromMe) continue;

        // Abaikan status broadcast
        if (msg.key.remoteJid === 'status@broadcast') continue;

        const remoteJid = msg.key.remoteJid;
        const isGroup = remoteJid.endsWith('@g.us');
        const pushName = msg.pushName || 'Teman';

        // Ekstraksi teks pesan dari berbagai format WhatsApp
        const body = (
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          ''
        ).trim();

        if (!body) continue;

        console.log(`\n📩 [${isGroup ? 'GRUP' : 'JAPRI'}] Dari: ${pushName} (${remoteJid}): "${body}"`);

        // Cek apakah bot di-tag di grup
        const botJid = sock.user?.id ? sock.user.id.replace(/:.*@/, '@') : '';
        const botNumber = sock.user?.id ? sock.user.id.split(':')[0] : '';
        const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const isTagged = mentionedJids.some(jid => jid.includes(botNumber));

        // Penanganan di grup
        if (isGroup) {
          const isExplicitCommand = body.startsWith('!ai') || body.startsWith('/ai') || body.toLowerCase().startsWith('ai ');
          if (CONFIG.replyInGroupsOnlyWhenTagged && !isTagged && !isExplicitCommand) {
            // Abaikan obrolan grup biasa agar tidak spam
            continue;
          }
        }

        // ================================================================
        // DETEKSI DAN DOWNLOAD VIDEO TIKTOK (NO WATERMARK)
        // ================================================================
        const tiktokMatch = body.match(TIKTOK_REGEX);
        if (tiktokMatch) {
          const tiktokUrl = tiktokMatch[0];
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

          continue; // Selesai memproses TikTok
        }

        // ================================================================
        // DETEKSI DAN DOWNLOAD KONTEN XIAOHONGSHU (REDNOTE)
        // ================================================================
        const xhsMatch = body.match(XHS_REGEX);
        if (xhsMatch) {
          const xhsUrl = xhsMatch[0];
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
`📕 *Xiaohongshu Video (No Watermark)*

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

                // Jika berupa Live Photo, kirimkan juga klip video geraknya
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

          continue; // Selesai memproses Xiaohongshu
        }

        // ================================================================
        // PERINTAH KHUSUS
        // ================================================================
        const lowerBody = body.toLowerCase();

        if (lowerBody === '!ping') {
          await sock.sendMessage(remoteJid, { text: '🏓 *Pong!*\nBot WhatsApp AI aktif dan siap merespon.' }, { quoted: msg });
          continue;
        }

        if (lowerBody === '!reset' || lowerBody === '!clear') {
          clearChatHistory(remoteJid);
          await sock.sendMessage(remoteJid, { text: '🧹 *Memori percakapan telah dibersihkan!*\nKita bisa memulai obrolan topik baru dari awal.' }, { quoted: msg });
          continue;
        }

        if (lowerBody === '!help' || lowerBody === '!menu') {
          const helpText = 
`🤖 *PANDUAN BOT WHATSAPP AI*

Berikut beberapa fitur dan perintah yang bisa Anda gunakan:
• *Download Video TikTok Tanpa Watermark*: Kirim/paste link video TikTok (contoh: https://vt.tiktok.com/...)
• *Download Xiaohongshu (RedNote)*: Kirim/paste link Xiaohongshu (xhslink.com atau xiaohongshu.com) untuk download Video, Foto HD, & Live Photo (foto + klip gerak)!
• *Ketik apa saja* langsung di chat ini untuk mengobrol atau bertanya apa pun dengan AI.
• *!reset* atau *!clear* : Menghapus ingatan percakapan agar mulai dari topik baru.
• *!ping* : Memeriksa status keaktifan bot.
• *!help* : Menampilkan menu bantuan ini.

Di grup WhatsApp:
• Tag/mention bot atau gunakan format: *!ai <pertanyaan>*`;
          await sock.sendMessage(remoteJid, { text: helpText }, { quoted: msg });
          continue;
        }

        // Bersihkan prefix command jika ada (contoh: "!ai siapa kamu?" -> "siapa kamu?")
        let cleanPrompt = body;
        if (cleanPrompt.startsWith('!ai')) {
          cleanPrompt = cleanPrompt.replace(/^!ai\s*/i, '');
        } else if (cleanPrompt.startsWith('/ai')) {
          cleanPrompt = cleanPrompt.replace(/^\/ai\s*/i, '');
        } else if (cleanPrompt.toLowerCase().startsWith('ai ')) {
          cleanPrompt = cleanPrompt.replace(/^ai\s+/i, '');
        }

        if (!cleanPrompt.trim()) {
          await sock.sendMessage(remoteJid, { text: 'Halo! Ada yang bisa saya bantu? Ketik pesan atau pertanyaan Anda ya.' }, { quoted: msg });
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

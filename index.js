require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const express = require('express');
const { IgApiClient, IgCheckpointError, IgLoginTwoFactorRequiredError } = require('instagram-private-api');
const { GoogleGenAI } = require('@google/genai');

const PORT = process.env.PORT || 3000;
const SESSION_FILE = path.join(__dirname, 'session.json');
const PROCESSED_FILE = path.join(__dirname, 'processed_ids.json');
const POLL_INTERVAL = (parseInt(process.env.CHECK_INTERVAL_SECONDS, 10) || 10) * 1000;

// State aplikasi
const appState = {
  status: 'initializing', // 'initializing', 'online', 'error', 'waiting_auth'
  username: process.env.IG_USERNAME || '',
  error: null,
  repliedCount: 0,
  logs: []
};

function addLog(type, message) {
  const time = new Date().toLocaleTimeString('id-ID');
  console.log(`[${time}] [${type.toUpperCase()}] ${message}`);
  appState.logs.push({ time, type, message });
  if (appState.logs.length > 100) {
    appState.logs.shift();
  }
}

// Inisialisasi Express Dashboard
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  res.json({
    status: appState.status,
    username: appState.username,
    error: appState.error,
    repliedCount: appState.repliedCount,
    pollInterval: POLL_INTERVAL / 1000,
    logs: appState.logs
  });
});

app.post('/api/test-ai', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Pesan tidak boleh kosong.' });
    if (!process.env.GEMINI_API_KEY) {
      return res.status(400).json({ error: 'GEMINI_API_KEY belum diisi di file .env' });
    }
    const reply = await generateAiReply(message, []);
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Setup Gemini AI
let geminiClient = null;
if (process.env.GEMINI_API_KEY) {
  geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

async function generateAiReply(userMessage, conversationHistory = []) {
  if (!geminiClient) {
    return 'Halo! Mohon maaf, kunci Gemini API belum dikonfigurasi di server.';
  }

  const systemInstruction = process.env.AI_SYSTEM_PROMPT || 
    'Kamu adalah asisten AI Instagram yang ramah, santun, dan responsif. ' +
    'Jawablah pesan pengguna dengan gaya bahasa yang alami, ringkas, informatif, dan tidak kaku. ' +
    'Gunakan bahasa Indonesia kecuali pengguna berbicara dalam bahasa lain.';

  try {
    let prompt = '';
    if (conversationHistory.length > 0) {
      prompt += 'Riwayat pesan sebelumnya:\n';
      conversationHistory.forEach(item => {
        prompt += `${item.sender}: ${item.text}\n`;
      });
      prompt += `\nPesan terbaru dari User: "${userMessage}"\nBalaslah pesan ini:`;
    } else {
      prompt = userMessage;
    }

    const response = await geminiClient.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        systemInstruction: systemInstruction,
        temperature: 0.7,
      }
    });

    return response.text ? response.text.trim() : 'Maaf, saya belum dapat memproses jawaban saat ini.';
  } catch (err) {
    addLog('error', `Gagal menghasilkan balasan AI: ${err.message}`);
    return 'Terima kasih atas pesan Anda! Mohon tunggu sebentar, pesan Anda akan segera kami respon.';
  }
}

// Helper input CLI untuk 2FA atau Checkpoint
function promptCli(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Penyimpanan Pesan yang sudah diproses (Deduplikasi)
let processedIds = new Set();
try {
  if (fs.existsSync(PROCESSED_FILE)) {
    const raw = fs.readFileSync(PROCESSED_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      processedIds = new Set(arr);
    }
  }
} catch (e) {
  addLog('warn', 'Gagal memuat processed_ids.json, membuat baru.');
}

function saveProcessedIds() {
  try {
    const arr = Array.from(processedIds);
    // Simpan maksimal 1000 ID pesan terakhir agar file tidak membengkak
    const trimmed = arr.slice(-1000);
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify(trimmed, null, 2));
  } catch (err) {
    addLog('warn', `Gagal menyimpan processed_ids.json: ${err.message}`);
  }
}

// Inisialisasi Klien Instagram
const ig = new IgApiClient();

async function saveSession() {
  try {
    const serialized = await ig.state.serialize();
    delete serialized.constants;
    fs.writeFileSync(SESSION_FILE, JSON.stringify(serialized, null, 2));
    addLog('info', 'Sesi login Instagram tersimpan ke session.json.');
  } catch (e) {
    addLog('warn', `Gagal menyimpan sesi: ${e.message}`);
  }
}

async function loginInstagram() {
  const username = process.env.IG_USERNAME;
  const password = process.env.IG_PASSWORD;

  if (!username || !password) {
    throw new Error('IG_USERNAME atau IG_PASSWORD belum diisi di file .env');
  }

  ig.state.generateDevice(username);

  // Jika ada sesi tersimpan sebelumnya, coba gunakan
  if (fs.existsSync(SESSION_FILE)) {
    addLog('info', 'Memuat sesi dari session.json...');
    try {
      const sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      await ig.state.deserialize(sessionData);
      const currentUser = await ig.account.currentUser();
      addLog('success', `Berhasil login via sesi tersimpan sebagai @${currentUser.username}`);
      appState.status = 'online';
      appState.username = currentUser.username;
      return currentUser;
    } catch (err) {
      addLog('warn', 'Sesi lama tidak valid atau kedaluwarsa. Mencoba login ulang...');
    }
  }

  addLog('info', `Melakukan login baru untuk @${username}...`);
  await ig.simulate.preLoginFlow();

  try {
    const loggedInUser = await ig.account.login(username, password);
    await saveSession();
    addLog('success', `Login berhasil sebagai @${loggedInUser.username}`);
    appState.status = 'online';
    appState.username = loggedInUser.username;
    return loggedInUser;
  } catch (err) {
    if (err instanceof IgLoginTwoFactorRequiredError) {
      addLog('warn', 'Instagram meminta kode Autentikasi Dua Faktor (2FA)!');
      appState.status = 'waiting_auth';
      const { two_factor_identifier } = err.response.body.two_factor_info;
      const code = await promptCli('Masukkan kode 2FA / OTP (dari SMS atau Authenticator App): ');
      
      const loggedInUser = await ig.account.twoFactorLogin({
        username,
        verificationCode: code,
        twoFactorIdentifier: two_factor_identifier,
        verificationMethod: '1',
        trustThisDevice: '1',
      });
      await saveSession();
      addLog('success', `2FA Berhasil! Login sebagai @${loggedInUser.username}`);
      appState.status = 'online';
      appState.username = loggedInUser.username;
      return loggedInUser;
    }

    if (err instanceof IgCheckpointError) {
      addLog('warn', 'Instagram meminta verifikasi keamanan (Checkpoint)!');
      appState.status = 'waiting_auth';
      await ig.challenge.auto(true);
      addLog('info', 'Kode verifikasi telah dikirimkan oleh Instagram ke Email/SMS Anda.');
      const code = await promptCli('Masukkan kode verifikasi keamanan: ');
      await ig.challenge.sendSecurityCode(code);
      await saveSession();
      addLog('success', 'Verifikasi keamanan berhasil diselesaikan!');
      const currentUser = await ig.account.currentUser();
      appState.status = 'online';
      appState.username = currentUser.username;
      return currentUser;
    }

    throw err;
  }
}

// Fungsi utama pengecekan Inbox DM
let isChecking = false;
let isInitialRun = true;

async function checkInbox() {
  if (isChecking) return;
  isChecking = true;

  try {
    const inboxFeed = ig.feed.directInbox();
    const threads = await inboxFeed.items();

    for (const thread of threads) {
      if (!thread.items || thread.items.length === 0) continue;

      const latestItem = thread.items[0];
      const botUserId = ig.state.cookieUserId;

      // Hanya proses pesan teks yang bukan dari bot sendiri
      if (latestItem.item_type !== 'text') continue;
      if (latestItem.user_id.toString() === botUserId.toString()) continue;

      const itemId = latestItem.item_id;

      // Jika bot baru pertama kali dinyalakan dan processedIds kosong, tandai pesan lama agar tidak di-spam
      if (isInitialRun && processedIds.size === 0) {
        processedIds.add(itemId);
        continue;
      }

      if (processedIds.has(itemId)) continue;

      // Tandai sudah diproses
      processedIds.add(itemId);
      saveProcessedIds();

      const userText = latestItem.text;
      const senderUser = thread.users.find(u => u.pk.toString() === latestItem.user_id.toString());
      const senderName = senderUser ? senderUser.username : 'Pengguna';

      addLog('info', `Pesan masuk dari @${senderName}: "${userText}"`);

      // Buat riwayat konteks percakapan (5 pesan terakhir)
      const contextHistory = thread.items
        .slice(0, 5)
        .reverse()
        .filter(it => it.item_type === 'text')
        .map(it => ({
          sender: it.user_id.toString() === botUserId.toString() ? 'Bot' : `@${senderName}`,
          text: it.text
        }));

      // Tandai pesan sudah dibaca (seen)
      try {
        const directThread = ig.entity.directThread(thread.thread_id);
        await directThread.markItemSeen(itemId);
      } catch (err) {
        // Abaikan jika gagal markItemSeen
      }

      // Hasilkan balasan dengan Gemini AI
      addLog('info', `Membuat respon AI untuk @${senderName}...`);
      const aiReply = await generateAiReply(userText, contextHistory);

      // Kirim balasan ke Direct Message
      try {
        const directThread = ig.entity.directThread(thread.thread_id);
        await directThread.broadcastText(aiReply);
        appState.repliedCount++;
        addLog('success', `Berhasil membalas @${senderName}: "${aiReply}"`);
      } catch (sendErr) {
        addLog('error', `Gagal mengirim balasan ke @${senderName}: ${sendErr.message}`);
      }
    }

    if (isInitialRun) {
      isInitialRun = false;
      saveProcessedIds();
      addLog('info', 'Inisialisasi pesan lama selesai. Bot siap membalas DM baru!');
    }
  } catch (err) {
    addLog('error', `Kesalahan saat memeriksa inbox: ${err.message}`);
  } finally {
    isChecking = false;
  }
}

// Jalankan Web Server & Mulai Bot
app.listen(PORT, async () => {
  addLog('info', `==============================================`);
  addLog('info', `🚀 Instagram AI Bot Server berjalan!`);
  addLog('info', `🌐 Dashboard Web: http://localhost:${PORT}`);
  addLog('info', `==============================================`);

  if (!process.env.IG_USERNAME || !process.env.IG_PASSWORD) {
    appState.status = 'error';
    appState.error = 'Kredensial Instagram belum diisi di file .env';
    addLog('warn', 'PERHATIAN: Silakan isi IG_USERNAME dan IG_PASSWORD di file .env terlebih dahulu.');
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    addLog('warn', 'PERHATIAN: GEMINI_API_KEY belum diisi di file .env. Bot tidak dapat menghasilkan respon AI.');
  }

  try {
    await loginInstagram();
    addLog('info', `Mulai memantau pesan DM setiap ${POLL_INTERVAL / 1000} detik...`);
    
    // Jalankan pengecekan pertama
    await checkInbox();

    // Jalankan loop berkala
    setInterval(checkInbox, POLL_INTERVAL);
  } catch (err) {
    appState.status = 'error';
    appState.error = err.message;
    addLog('error', `Gagal memulai bot Instagram: ${err.message}`);
  }
});

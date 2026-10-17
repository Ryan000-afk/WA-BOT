import os
import sys
import time
import json
import base64
import sqlite3
import shutil
import ctypes
from ctypes import wintypes
from Cryptodome.Cipher import AES
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright
from google import genai

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
SYSTEM_PROMPT = os.getenv("AI_SYSTEM_PROMPT", "")
COOKIES_FILE = os.path.join(os.path.dirname(__file__), "playwright_cookies.json")

gemini_client = None
if GEMINI_API_KEY:
    try:
        gemini_client = genai.Client(api_key=GEMINI_API_KEY)
    except Exception as e:
        print(f"[!] Gemini Client Init Error: {e}")

import random
import requests

def is_bryan(contact: str) -> bool:
    """Mengecek apakah lawan bicara adalah pacar resmi Bryan (@bryanadelsonn / ZeroRegret)."""
    if not contact:
        return False
    c = contact.lower().strip()
    return "bryan" in c or "adelson" in c or "bryanadelsonn" in c or "zeroregret" in c

def get_contextual_fallback(partner: bool, user_message: str, last_sent: str = "") -> str:
    """Fallback cerdas bervariasi jika API sedang sibuk (503) sehingga tidak pernah mengulang balasan yang sama."""
    if not partner:
        options = [
            "Maaf, saya sudah punya pacar. Tolong jangan kirim pesan.",
            "Who are you? I already have a boyfriend.",
            "Siapa ya? Tolong jangan kirim pesan.",
            "Mohon jangan chat saya lagi, terima kasih."
        ]
        return random.choice([o for o in options if o != last_sent] or options)

    msg_lower = user_message.lower()
    if any(k in msg_lower for k in ["hok", "game", "main", "play", "login", "ayo"]):
        options = [
            "Okey baby, bentar yaa aku buka game-nya sekarang! 🎮",
            "Ayo sayang, tunggu aku login yaa~",
            "Wait for me baby, aku lagi buka game nih! ❤️",
            "Siaap baby, gendong aku yaa nanti! 🎮❤️"
        ]
    elif any(k in msg_lower for k in ["kangen", "miss", "sayang", "love", "530", "520"]):
        options = [
            "Aku juga kangen banget sama kamu baby! ❤️",
            "I miss you more baby! ❤️",
            "Aww sayangku manis banget sih, love you too! 🥰",
            "Peluk online dulu sini baby~ ❤️"
        ]
    elif any(k in msg_lower for k in ["makan", "eat", "lunch", "dinner", "lapar"]):
        options = [
            "Kamu udah makan belum baby? Jangan telat makan yaa! ❤️",
            "Aku udah sayang, kamu jangan lupa makan yaa baby~",
            "Makan yang enak ya baby biar ada tenaga! 🥰"
        ]
    else:
        # Deteksi bahasa pesan Bryan
        is_english = any(w in msg_lower for w in ["what", "how", "are", "you", "same", "here", "want", "let", "the", "with"])
        if is_english:
            options = [
                "Haha sure baby! What's up? ❤️",
                "Yes baby, I'm here for you! 🥰",
                "Aww okay baby, always happy to chat with you! ❤️",
                "Got it baby, tell me more! ❤️"
            ]
        else:
            options = [
                "Iya sayangku, kenapa baby? ❤️",
                "Aku di sini sayang, kangen kamu tau~ 🥰",
                "Ada apa baby? Hehe ❤️",
                "Iya cintaku, lagi mikirin kamu nih~ ❤️"
            ]

    valid = [o for o in options if o != last_sent]
    return random.choice(valid if valid else options)

def get_ai_reply(sender_contact: str, user_message: str, last_sent: str = "") -> str:
    partner = is_bryan(sender_contact)

    if not GEMINI_API_KEY:
        return get_contextual_fallback(partner, user_message, last_sent)

    if partner:
        prompt = (
            f"Kamu adalah @yii_aimao (Yiyi), pacar manis dan perhatian dari Bryan (@bryanadelsonn / ZeroRegret).\n\n"
            f"ATURAN BAHASA PENTING:\n"
            f"1. JANGAN mencampuradukkan 3 bahasa (Inggris + Mandarin + Indonesia) dalam satu kalimat.\n"
            f"2. Ikuti bahasa Bryan (mirroring):\n"
            f"   - Jika Bryan chat Bahasa Inggris (misal: 'Do you want to play?', 'Login hok'): Balas dengan Bahasa Inggris yang santai, manis, dan natural (contoh: 'Okay baby! Wait a minute, opening the game now! 🎮').\n"
            f"   - Jika Bryan chat Bahasa Indonesia (misal: 'Ayo login HOK', 'Kamu lagi apa?'): Balas dengan Bahasa Indonesia yang manis, imut, dan manja.\n"
            f"   - Jika Bryan chat Mandarin: Balas dalam Mandarin santai.\n"
            f"3. Panggilan cukup 'baby' atau 'sayang'. Balas singkat (1 kalimat pendek layaknya pacaran di DM Instagram).\n\n"
            f"Pesan dari pacarmu Bryan: \"{user_message}\"\n"
            f"Balasan singkatmu:"
        )
    else:
        prompt = (
            f"Kamu adalah @yii_aimao. Kamu punya pacar bernama Bryan (@bryanadelsonn) dan SANGAT SETIA.\n"
            f"Orang asing (@{sender_contact}) mengirim pesan: \"{user_message}\"\n\n"
            f"ATURAN:\n"
            f"- Balas sangat dingin, datar, tegas menolak, dan TANPA emoji sama sekali (0 emoji).\n"
            f"- Contoh: 'Maaf, saya sudah punya pacar. Tolong jangan kirim pesan.'\n"
            f"Balas singkat (1 kalimat dingin):"
        )

    models = [
        "gemini-3.5-flash-lite",
        "gemini-flash-lite-latest",
        "gemini-3.1-flash-lite",
        "gemini-3.8-flash",
        "gemini-3.5-flash"
    ]

    for m in models:
        try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={GEMINI_API_KEY}"
            payload = {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {
                    "temperature": 0.85 if partner else 0.2,
                    "maxOutputTokens": 100
                }
            }
            r = requests.post(url, json=payload, timeout=6)
            if r.status_code == 200:
                data = r.json()
                text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
                text = " ".join(text.split()).strip()
                if text and text != last_sent:
                    return text
        except Exception:
            continue

    return get_contextual_fallback(partner, user_message, last_sent)

def extract_cookies_from_edge():
    print("[*] Mengekstrak cookie sesi login asli dari Microsoft Edge...")
    local_state_path = os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\User Data\Local State")
    cookie_db = os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\User Data\Default\Network\Cookies")

    if not os.path.exists(local_state_path) or not os.path.exists(cookie_db):
        return []

    try:
        with open(local_state_path, "r", encoding="utf-8") as f:
            local_state = json.load(f)

        encrypted_key = base64.b64decode(local_state["os_crypt"]["encrypted_key"])[5:]

        class DATA_BLOB(ctypes.Structure):
            _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

        blob_in = DATA_BLOB(len(encrypted_key), ctypes.create_string_buffer(encrypted_key, len(encrypted_key)))
        blob_out = DATA_BLOB()
        ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out))
        master_key = ctypes.string_at(blob_out.pbData, blob_out.cbData)

        temp_db = os.path.join(os.path.dirname(__file__), "temp_cookies_extract.db")
        shutil.copyfile(cookie_db, temp_db)

        conn = sqlite3.connect(temp_db)
        cursor = conn.cursor()
        cursor.execute("SELECT host_key, name, path, encrypted_value, is_secure, is_httponly, expires_utc FROM cookies WHERE host_key LIKE '%instagram.com%'")

        cookies = []
        for host_key, name, path, encrypted_value, is_secure, is_httponly, expires_utc in cursor.fetchall():
            try:
                nonce = encrypted_value[3:15]
                ciphertext = encrypted_value[15:-16]
                tag = encrypted_value[-16:]
                cipher = AES.new(master_key, AES.MODE_GCM, nonce=nonce)
                value = cipher.decrypt_and_verify(ciphertext, tag).decode("utf-8")

                cookie_obj = {
                    "name": name,
                    "value": value,
                    "domain": host_key,
                    "path": path,
                    "secure": bool(is_secure),
                    "httpOnly": bool(is_httponly)
                }
                if expires_utc and expires_utc > 0:
                    unix_time = (expires_utc - 11644473600000000) / 1000000
                    if unix_time > 0:
                        cookie_obj["expires"] = unix_time

                cookies.append(cookie_obj)
            except Exception:
                pass

        conn.close()
        if os.path.exists(temp_db):
            os.remove(temp_db)

        if cookies:
            with open(COOKIES_FILE, "w", encoding="utf-8") as f:
                json.dump(cookies, f, indent=2)
            print(f"[+] Berhasil menyalin {len(cookies)} cookies Instagram asli!")
            return cookies
    except Exception as e:
        print(f"[-] Catatan ekstraksi: {e}")

    return []

def perform_instagram_login(page, context):
    """Melakukan login otomatis menggunakan kredensial yang valid."""
    print("[*] Melakukan login Instagram otomatis...")
    page.goto("https://www.instagram.com/accounts/login/", timeout=60000)
    page.wait_for_timeout(4000)

    # 1. Jika ada tombol Continue yii_aimao
    try:
        btn = page.locator("div[aria-label*='Continue']").first
        if btn.count() > 0:
            btn.click(timeout=3000)
            page.wait_for_timeout(2000)
    except Exception:
        pass

    # 2. Ketik Username jika form muncul
    u = page.locator("input[name='username'], input[aria-label*='Phone number'], input[type='text']").first
    if u.count() > 0 and u.is_visible():
        print("[*] Memasukkan username @yii_aimao...")
        u.click()
        page.keyboard.type("yii_aimao", delay=40)
        page.wait_for_timeout(500)

    # 3. Ketik Password
    pw = page.locator("input[name='password'], input[type='password']").first
    if pw.count() > 0 and pw.is_visible():
        print("[*] Memasukkan password akun...")
        pw.click()
        page.keyboard.type("110208bryan", delay=40)
        page.wait_for_timeout(500)

        print("[*] Mengirim formulir login...")
        page.keyboard.press("Enter")
        page.wait_for_timeout(8000)

    # 4. Handle Simpan Info / Not Now
    for _ in range(4):
        try:
            not_now = page.locator("button:has-text('Not Now'), button:has-text('Lain Kali'), button:has-text('Save info'), button:has-text('Simpan info')")
            if not_now.count() > 0:
                not_now.first.click(timeout=3000)
                page.wait_for_timeout(1500)
        except Exception:
            pass

    # 5. Buka Direct Inbox
    page.goto("https://www.instagram.com/direct/inbox/", timeout=60000)
    page.wait_for_timeout(4000)

    if "/direct" in page.url.lower():
        cookies = context.cookies()
        with open(COOKIES_FILE, "w", encoding="utf-8") as f:
            json.dump(cookies, f, indent=2)
        print(f"[+] Sesi login berhasil disimpan ({len(cookies)} cookies)!")
        return True
    return False

def main():
    print("=" * 65)
    print("🤖 AUTONOMOUS INSTAGRAM AI BOT (@yii_aimao)")
    print("💑 Pasangan Resmi : Bryan (@bryanadelsonn / ZeroRegret)")
    print("❄️ Orang Asing    : Siapa pun selain Bryan -> Ditolak dingin (0 emoji)")
    print("=" * 65)

    cookies = []
    if os.path.exists(COOKIES_FILE):
        try:
            with open(COOKIES_FILE, "r", encoding="utf-8") as f:
                cookies = json.load(f)
            print(f"[+] Memuat {len(cookies)} cookies tersimpan.")
        except Exception:
            pass

    if not cookies:
        cookies = extract_cookies_from_edge()

    with sync_playwright() as p:
        print("[*] Meluncurkan browser Microsoft Edge untuk kontrol AI...")
        browser = p.chromium.launch(
            channel="msedge",
            headless=False,
            args=["--start-maximized", "--disable-blink-features=AutomationControlled"]
        )

        context = browser.new_context(no_viewport=True)

        if cookies:
            print("[+] Memasukkan sesi login ke browser (Bypass konfirmasi & password)...")
            context.add_cookies(cookies)

        page = context.new_page()
        page.goto("https://www.instagram.com/direct/inbox/", timeout=60000)
        page.wait_for_timeout(5000)

        # Cek apakah perlu login
        if "login" in page.url.lower() or "accounts" in page.url.lower():
            success = perform_instagram_login(page, context)
            if not success:
                print("[!] Menunggu pengguna menyelesaikan login di browser...")
                while "/direct" not in page.url.lower():
                    time.sleep(2)
                cookies = context.cookies()
                with open(COOKIES_FILE, "w", encoding="utf-8") as f:
                    json.dump(cookies, f, indent=2)

        print("\n" + "=" * 65)
        print("🎉 BERHASIL MASUK KE INSTAGRAM DIRECT INBOX!")
        print("🤖 AI AKTIF & MENGAWASI OBROLAN SECARA REAL-TIME")
        print("=" * 65 + "\n")

        bot_replies = set()
        last_replied_msg = ""
        last_sent_reply = ""

        while True:
            try:
                # 1. Pastikan selalu berada di halaman Direct
                if "/direct" not in page.url.lower():
                    print("[*] Mengarahkan kembali ke Direct Inbox...")
                    page.goto("https://www.instagram.com/direct/inbox/", timeout=60000)
                    page.wait_for_timeout(4000)
                    continue

                # Tutup dialog pop-up jika muncul ("Not Now" / "Cancel")
                try:
                    popups = page.locator("button:has-text('Not Now'), button:has-text('Lain Kali'), button:has-text('Cancel'), button:has-text('Batal')")
                    if popups.count() > 0:
                        popups.first.click(timeout=1000)
                        page.wait_for_timeout(500)
                except Exception:
                    pass

                # 2. Cek apakah ada pesan belum dibaca (Unread) dari orang lain di sidebar
                unread_info = page.evaluate("""() => {
                    const els = Array.from(document.querySelectorAll("div[role='button'], div[tabindex='0']"));
                    for (let e of els) {
                        const r = e.getBoundingClientRect();
                        if (r.left < 450 && r.top > 250 && r.width > 200 && r.height > 40) {
                            const text = (e.innerText || "");
                            if (text.includes("Unread") && !text.toLowerCase().includes("zeroregret") && !text.toLowerCase().includes("bryan")) {
                                const name = text.split("\\n")[0].trim();
                                return { hasUnread: true, name: name };
                            }
                        }
                    }
                    return { hasUnread: false };
                }""")

                if unread_info.get("hasUnread"):
                    stranger_name = unread_info.get("name")
                    print(f"\n[!] Ada pesan baru dari orang asing: @{stranger_name} di sidebar!")
                    target_el = page.locator(f"div[role='button']:has-text('{stranger_name}'), span:has-text('{stranger_name}')").first
                    if target_el.count() > 0:
                        target_el.click(timeout=3000)
                        page.wait_for_timeout(3000)

                # Jika tidak sedang membuka pesan orang asing, pastikan selalu berada di obrolan Bryan
                if not unread_info.get("hasUnread") and "17845226400270680" not in page.url:
                    print("[*] Memastikan obrolan dengan pacar resmi Bryan (@bryanadelsonn) aktif...")
                    page.goto("https://www.instagram.com/direct/t/17845226400270680/", timeout=60000)
                    page.wait_for_timeout(3000)

                # 3. Deteksi Nama Lawan Bicara
                if "17845226400270680" in page.url:
                    contact = "bryanadelsonn"
                else:
                    contact = page.evaluate("""() => {
                        let user = "";
                        const header = document.querySelector("header");
                        if (header) {
                            const text = (header.innerText || "").toLowerCase();
                            if (text.includes("bryan") || text.includes("zeroregret")) {
                                return "bryanadelsonn";
                            }
                            const links = header.querySelectorAll("a[href^='/']");
                            for (let a of links) {
                                const href = a.getAttribute("href") || "";
                                const clean = href.replace(/\\//g, "").trim().toLowerCase();
                                if (clean && !['direct', 'inbox', 'explore', 'reels', 'stories'].includes(clean)) {
                                    user = clean;
                                    break;
                                }
                            }
                            if (!user) {
                                const lines = (header.innerText || "").split("\\n").map(x => x.trim()).filter(Boolean);
                                if (lines.length > 0) user = lines[0].toLowerCase();
                            }
                        }
                        return user || "stranger";
                    }""")

                # 4. Baca Balon Pesan Terbaru di Chat Pane (role='presentation')
                chat_info = page.evaluate("""() => {
                    // Cari semua elemen gelembung pesan di area kanan chat
                    const bubbles = Array.from(document.querySelectorAll("div[role='presentation']"));
                    const valid = [];

                    for (let b of bubbles) {
                        const r = b.getBoundingClientRect();
                        // Harus di area chat sebelah kanan (x >= 450)
                        if (r.left < 450 || r.height < 15 || r.width < 20) continue;

                        const text = (b.innerText || "").trim();
                        if (!text) continue;

                        // Filter pesan sistem
                        const lower = text.toLowerCase();
                        if (lower.includes("changed the theme") || 
                            lower.includes("set your nickname") || 
                            lower.includes("view profile") ||
                            lower.includes("seen ") ||
                            lower.includes("dibaca ") ||
                            lower.includes("unsent a message")) {
                            continue;
                        }

                        // Deteksi Kiri (Incoming) vs Kanan (Outgoing)
                        // Area chat berawal dari x ~ 470 hingga x ~ 1280
                        const distFromLeft = r.left - 470;
                        const distFromRight = window.innerWidth - r.right;
                        const isOutgoing = (distFromRight < distFromLeft);

                        valid.push({
                            text: text,
                            isOutgoing: isOutgoing,
                            distFromLeft: distFromLeft,
                            distFromRight: distFromRight
                        });
                    }

                    if (valid.length === 0) return { hasMessage: false };

                    const last = valid[valid.length - 1];
                    return {
                        hasMessage: true,
                        isIncoming: !last.isOutgoing,
                        text: last.text
                    };
                }""")

                has_msg = chat_info.get("hasMessage", False)
                is_incoming = chat_info.get("isIncoming", False)
                cur_text = chat_info.get("text", "").strip()

                # 5. Jika Pesan Terakhir adalah INCOMING dari lawan bicara
                if has_msg and is_incoming and cur_text:
                    # Cegah echo atau membalas pesan yang sudah dibalas
                    is_bot_echo = False
                    for b_text in bot_replies:
                        if cur_text in b_text or b_text in cur_text:
                            is_bot_echo = True
                            break

                    if cur_text != last_replied_msg and not is_bot_echo:
                        last_replied_msg = cur_text

                        partner = is_bryan(contact)
                        if partner:
                            print(f"\n📩 [CHAT DARI PASANGAN - Bryan @bryanadelsonn]: \"{cur_text}\"")
                            print("❤️ Status: Pasangan resmi (@bryanadelsonn) -> Menyusun balasan manis & manja...")
                        else:
                            print(f"\n📩 [CHAT DARI ORANG ASING - @{contact}]: \"{cur_text}\"")
                            print("❄️ Status: Orang asing -> Menyusun penolakan dingin tanpa emoji...")

                        # Dapatkan balasan AI dari Gemini
                        ai_reply = get_ai_reply(contact, cur_text, last_sent_reply)
                        ai_reply = " ".join(ai_reply.split()).strip()
                        last_sent_reply = ai_reply

                        # Simpan ke cache filter
                        bot_replies.add(ai_reply)
                        bot_replies.add(ai_reply.lower())
                        for sentence in ai_reply.split(". "):
                            if len(sentence.strip()) > 3:
                                bot_replies.add(sentence.strip())
                                bot_replies.add(sentence.strip().lower())

                        print(f"💬 [BALASAN @yii_aimao]: \"{ai_reply}\"")

                        # Ketik dan kirim pesan
                        tb = page.locator("[contenteditable='true'], [role='textbox']").first
                        if tb.count() > 0:
                            tb.click()
                            page.wait_for_timeout(300)
                            page.keyboard.type(ai_reply, delay=30)
                            page.wait_for_timeout(500)
                            page.keyboard.press("Enter")
                            page.wait_for_timeout(1000)

                            send_btn = page.locator("button:has-text('Send'), div[role='button']:has-text('Send')")
                            if send_btn.count() > 0:
                                send_btn.first.click()
                                page.wait_for_timeout(1000)

                            print("✅ Balasan berhasil dikirimkan ke Instagram Direct!\n")

                            # Jika baru saja menolak orang asing, langsung kembali ke chat Bryan
                            if not is_bryan(contact):
                                print("[*] Selesai menolak orang asing, kembali ke obrolan pacar Bryan (@bryanadelsonn)...")
                                page.goto("https://www.instagram.com/direct/t/17845226400270680/", timeout=60000)
                                page.wait_for_timeout(3000)

                time.sleep(2)

            except KeyboardInterrupt:
                print("\nBot dihentikan oleh pengguna.")
                break
            except Exception as e:
                print(f"[!] Catatan Loop: {e}")
                time.sleep(3)

if __name__ == "__main__":
    main()

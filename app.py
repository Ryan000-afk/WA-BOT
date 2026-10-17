import os
import sys
import json
import time
import threading

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass
from datetime import datetime
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from instagrapi import Client
from instagrapi.exceptions import (
    BadPassword,
    TwoFactorRequired,
    ChallengeRequired,
    FeedbackRequired,
    PleaseWaitFewMinutes,
    LoginRequired
)

load_dotenv()

# Konfigurasi
PORT = int(os.getenv("PORT", 3000))
IG_USERNAME = os.getenv("IG_USERNAME", "")
IG_PASSWORD = os.getenv("IG_PASSWORD", "")
IG_SESSIONID = os.getenv("IG_SESSIONID", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
POLL_INTERVAL = int(os.getenv("CHECK_INTERVAL_SECONDS", 10))
SYSTEM_PROMPT = os.getenv(
    "AI_SYSTEM_PROMPT",
    "Kamu adalah asisten AI Instagram yang ramah, santun, dan responsif. "
    "Jawablah pesan pengguna secara alami, ringkas, jelas, dan informatif dalam bahasa Indonesia."
)

SESSION_FILE = os.path.join(os.path.dirname(__file__), "session_python.json")
PROCESSED_FILE = os.path.join(os.path.dirname(__file__), "processed_ids.json")

# State Aplikasi
app_state = {
    "status": "initializing",  # initializing, online, error, waiting_auth
    "username": IG_USERNAME,
    "error": None,
    "replied_count": 0,
    "logs": []
}

def add_log(log_type, message):
    time_str = datetime.now().strftime("%H:%M:%S")
    print(f"[{time_str}] [{log_type.upper()}] {message}", flush=True)
    app_state["logs"].append({
        "time": time_str,
        "type": log_type,
        "message": message
    })
    if len(app_state["logs"]) > 100:
        app_state["logs"].pop(0)

# Gemini AI Client
gemini_client = None
if GEMINI_API_KEY:
    try:
        from google import genai
        gemini_client = genai.Client(api_key=GEMINI_API_KEY)
    except Exception as e:
        add_log("warn", f"Inisialisasi Gemini gagal: {str(e)}")

def generate_ai_reply(user_message, history=None, sender_name=""):
    if not gemini_client:
        return "iya.."
    
    try:
        is_bryan = any(b in (sender_name or "").lower() for b in ["bryan", "adelson"])
        context_note = ""
        if is_bryan:
            context_note = (
                f"[PENTING: Lawan bicaramu adalah pacar/pasanganmu sendiri, Bryan (@{sender_name})! "
                f"Bersikaplah sangat manis, perhatian, manja, panggil sayang/beb, dan ketik 100% seperti pacar sungguhan.]\n"
            )
        elif sender_name:
            context_note = (
                f"[Catatan: Lawan bicaramu adalah @{sender_name} (bukan pacarmu Bryan). "
                f"Bersikaplah ramah, santai, tetapi tetap wajar dan menjaga batasan karena kamu setia dan sudah punya pacar Bryan.]\n"
            )

        prompt = context_note
        if history and len(history) > 0:
            prompt += "Riwayat percakapan sebelumnya:\n"
            for item in history:
                prompt += f"{item['sender']}: {item['text']}\n"
            prompt += f"\nPesan terbaru dari {sender_name or 'User'}: \"{user_message}\"\nBalas langsung layaknya chatting di HP:"
        else:
            prompt += f"Pesan masuk: \"{user_message}\"\nBalas langsung:"

        models_to_try = ["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.8-flash"]
        for m in models_to_try:
            try:
                response = gemini_client.models.generate_content(
                    model=m,
                    contents=prompt,
                    config={
                        "system_instruction": SYSTEM_PROMPT,
                        "temperature": 0.8
                    }
                )
                if response and response.text:
                    return response.text.strip()
            except Exception:
                continue

        return "iyaa.."
    except Exception as e:
        add_log("error", f"Kesalahan Gemini AI: {str(e)}")
        return "iyaa.."

# Deduplikasi Pesan
processed_ids = set()
if os.path.exists(PROCESSED_FILE):
    try:
        with open(PROCESSED_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, list):
                processed_ids = set(data)
    except Exception:
        pass

def save_processed_ids():
    try:
        with open(PROCESSED_FILE, "w", encoding="utf-8") as f:
            json.dump(list(processed_ids)[-1000:], f, indent=2)
    except Exception as e:
        add_log("warn", f"Gagal menyimpan {PROCESSED_FILE}: {str(e)}")

# Instagrapi Worker
cl = Client()
cl.set_country("ID")
cl.set_locale("id_ID")
cl.set_timezone_offset(7 * 3600)

def challenge_code_handler(username, choice):
    add_log("warn", f"Instagram meminta kode verifikasi ({choice}) untuk @{username}")
    app_state["status"] = "waiting_auth"
    print(f"\n[PERHATIAN] Instagram mengirim kode verifikasi ke {choice}.")
    code = input("Masukkan kode verifikasi (OTP): ").strip()
    return code

cl.challenge_code_handler = challenge_code_handler

def bot_worker():
    global app_state
    if not IG_USERNAME or not IG_PASSWORD:
        app_state["status"] = "error"
        app_state["error"] = "IG_USERNAME dan IG_PASSWORD belum diisi di .env"
        add_log("warn", "Silakan lengkapi IG_USERNAME dan IG_PASSWORD di file .env")
        return

    add_log("info", f"Menyiapkan login Instagram untuk @{IG_USERNAME}...")

    # Load session jika ada
    logged_in = False
    if os.path.exists(SESSION_FILE):
        add_log("info", "Mencoba login via sesi tersimpan (session_python.json)...")
        try:
            cl.load_settings(SESSION_FILE)
            cl.get_timeline_feed()
            logged_in = True
            add_log("success", f"Berhasil menggunakan sesi tersimpan untuk @{cl.username or IG_USERNAME}")
        except Exception:
            add_log("warn", "Sesi tersimpan telah kedaluwarsa. Mencoba login ulang...")

    if not logged_in and IG_SESSIONID:
        add_log("info", "Mencoba autentikasi menggunakan IG_SESSIONID dari browser...")
        try:
            cl.login_by_sessionid(IG_SESSIONID.strip())
            logged_in = True
            app_state["username"] = cl.username or IG_USERNAME
            add_log("success", f"Berhasil login via SESSIONID sebagai @{app_state['username']}!")
        except Exception as sess_err:
            add_log("warn", f"Login via IG_SESSIONID gagal: {str(sess_err)}. Mencoba login password...")

    if not logged_in:
        try:
            add_log("info", f"Melakukan autentikasi langsung ke Instagram...")
            cl.login(IG_USERNAME, IG_PASSWORD)
            cl.dump_settings(SESSION_FILE)
            add_log("success", f"Login Instagram berhasil! Sesi disimpan.")
            logged_in = True
        except TwoFactorRequired:
            add_log("warn", "Instagram meminta kode 2FA (Two Factor Authentication)!")
            app_state["status"] = "waiting_auth"
            code = input("Masukkan kode 2FA Instagram Anda: ").strip()
            cl.login(IG_USERNAME, IG_PASSWORD, verification_code=code)
            cl.dump_settings(SESSION_FILE)
            add_log("success", "2FA Berhasil! Sesi disimpan.")
            logged_in = True
        except BadPassword:
            app_state["status"] = "error"
            app_state["error"] = "Password Instagram salah."
            add_log("error", "Password yang dimasukkan salah!")
            return
        except PleaseWaitFewMinutes:
            app_state["status"] = "error"
            app_state["error"] = "Instagram meminta menunggu beberapa menit (Rate limited)."
            add_log("error", "Instagram meminta untuk menunggu beberapa menit sebelum mencoba login lagi.")
            return
        except Exception as e:
            app_state["status"] = "error"
            app_state["error"] = str(e)
            add_log("error", f"Gagal login Instagram: {str(e)}")
            return

    app_state["status"] = "online"
    add_log("info", f"Mulai memantau inbox DM setiap {POLL_INTERVAL} detik...")

    is_initial_run = True

    while True:
        try:
            threads = cl.direct_threads(amount=10)
            my_user_id = str(cl.user_id)

            for thread in threads:
                if not thread.messages:
                    continue

                latest_msg = thread.messages[0]

                # Hanya proses teks dan pesan dari orang lain
                if latest_msg.item_type != "text":
                    continue
                if str(latest_msg.user_id) == my_user_id:
                    continue

                msg_id = str(latest_msg.id)

                # Jika saat pertama bot menyala dan cache pesan kosong, tandai pesan lama
                if is_initial_run and len(processed_ids) == 0:
                    processed_ids.add(msg_id)
                    continue

                if msg_id in processed_ids:
                    continue

                processed_ids.add(msg_id)
                save_processed_ids()

                sender_name = "Pengguna"
                for u in thread.users:
                    if str(u.pk) == str(latest_msg.user_id):
                        sender_name = u.username
                        break

                user_text = latest_msg.text
                add_log("info", f"DM Masuk dari @{sender_name}: \"{user_text}\"")

                # Buat riwayat percakapan (5 pesan terakhir)
                history = []
                for msg in reversed(thread.messages[:5]):
                    if msg.item_type == "text":
                        history.append({
                            "sender": "Bot" if str(msg.user_id) == my_user_id else f"@{sender_name}",
                            "text": msg.text
                        })

                # Tandai sudah dibaca
                try:
                    cl.direct_send_seen(thread.id)
                except Exception:
                    pass

                # Dapatkan respon AI
                add_log("info", f"Menghasilkan balasan AI untuk @{sender_name}...")
                ai_reply = generate_ai_reply(user_text, history, sender_name=sender_name)

                # Kirim balasan
                try:
                    cl.direct_answer(thread.id, ai_reply)
                    app_state["replied_count"] += 1
                    add_log("success", f"Berhasil membalas @{sender_name}: \"{ai_reply}\"")
                except Exception as send_err:
                    add_log("error", f"Gagal mengirim balasan ke @{sender_name}: {str(send_err)}")

            if is_initial_run:
                is_initial_run = False
                save_processed_ids()
                add_log("info", "Inisialisasi pesan lama selesai. Bot siap menerima pesan baru!")

        except LoginRequired:
            add_log("warn", "Sesi kedaluwarsa saat polling. Mencoba relogin...")
            try:
                cl.relogin()
            except Exception as re_err:
                add_log("error", f"Relogin gagal: {str(re_err)}")
        except Exception as e:
            add_log("warn", f"Kendala saat memeriksa inbox: {str(e)}")

        time.sleep(POLL_INTERVAL)

# Flask Web Server
flask_app = Flask(__name__, static_folder="public")

@flask_app.after_request
def after_request(response):
    response.headers.add("Access-Control-Allow-Origin", "*")
    response.headers.add("Access-Control-Allow-Headers", "Content-Type,Authorization")
    response.headers.add("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS")
    return response

@flask_app.route("/")
def index():
    return send_from_directory("public", "index.html")

@flask_app.route("/api/status")
def status():
    return jsonify({
        "status": app_state["status"],
        "username": app_state["username"],
        "error": app_state["error"],
        "repliedCount": app_state["replied_count"],
        "pollInterval": POLL_INTERVAL,
        "logs": app_state["logs"]
    })

@flask_app.route("/api/test-ai", methods=["POST", "OPTIONS"])
def test_ai():
    if request.method == "OPTIONS":
        return "", 200
    data = request.get_json() or {}
    message = data.get("message", "")
    if not message:
        return jsonify({"error": "Pesan tidak boleh kosong"}), 400
    reply = generate_ai_reply(message)
    return jsonify({"reply": reply})

@flask_app.route("/api/chat-ai", methods=["POST", "OPTIONS"])
def chat_ai():
    if request.method == "OPTIONS":
        return "", 200
    data = request.get_json() or {}
    message = data.get("message", "")
    sender = data.get("sender", "bryanadelson")
    if not message:
        return jsonify({"error": "Pesan tidak boleh kosong"}), 400
    reply = generate_ai_reply(message, sender_name=sender)
    add_log("info", f"DM dari {sender}: \"{message}\" -> Dibalas: \"{reply}\"")
    return jsonify({"reply": reply})

if __name__ == "__main__":
    print("=" * 50)
    print("🚀 Instagram AI Bot Server (Python + Instagrapi) Berjalan!")
    print(f"🌐 Dashboard Web: http://localhost:{PORT}")
    print("=" * 50, flush=True)

    # Jalankan background worker untuk bot
    t = threading.Thread(target=bot_worker, daemon=True)
    t.start()

    # Jalankan Flask
    flask_app.run(host="0.0.0.0", port=PORT, debug=False)

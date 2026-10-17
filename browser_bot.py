import os
import sys
import time
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

IG_USERNAME = os.getenv("IG_USERNAME", "yii_aimao").strip()
IG_PASSWORD = os.getenv("IG_PASSWORD", "141adabryan").strip()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
SYSTEM_PROMPT = os.getenv("AI_SYSTEM_PROMPT", "")

gemini_client = None
if GEMINI_API_KEY:
    try:
        gemini_client = genai.Client(api_key=GEMINI_API_KEY)
    except Exception as e:
        print(f"[!] Error Inisialisasi Gemini: {e}")

def get_ai_reply(user_message, chat_partner=""):
    if not gemini_client:
        return "iya.."
    
    # Deteksi apakah lawan bicara adalah Bryan
    is_bryan = any(b in (chat_partner or "").lower() for b in ["bryan", "adelson"])
    
    context_note = ""
    if is_bryan:
        context_note = (
            f"[PENTING: Lawan bicaramu saat ini adalah pacar/pasanganmu sendiri, Bryan (@{chat_partner or 'bryanadelsonn'})! "
            f"Bersikaplah sangat manis, perhatian, manja, panggil sayang/beb, dan ketiklah 100% seperti pacar sungguhan yang menyayanginya.]"
        )
    elif chat_partner:
        context_note = (
            f"[Catatan: Lawan bicaramu adalah @{chat_partner} (bukan pacarmu Bryan). "
            f"Bersikaplah ramah, santai, tetapi tetap wajar dan menjaga batasan karena kamu setia dan sudah punya pacar Bryan.]"
        )
    
    prompt = f"{context_note}\nPesan masuk dari {chat_partner or 'Pengguna'}: \"{user_message}\"\nBalas langsung layaknya kamu membalas chat di Instagram:"
    
    models = ["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.8-flash"]
    for m in models:
        try:
            res = gemini_client.models.generate_content(
                model=m,
                contents=prompt,
                config={
                    "system_instruction": SYSTEM_PROMPT,
                    "temperature": 0.8
                }
            )
            if res and res.text:
                return res.text.strip()
        except Exception:
            continue
    return "iyaa.."

def main():
    profile_dir = os.path.join(os.path.dirname(__file__), "browser_profile")
    os.makedirs(profile_dir, exist_ok=True)

    print("=" * 65)
    print("🚀 MEMULAI INSTAGRAM AI BOT PASANGAN @bryanadelson")
    print("=" * 65)
    print("[*] Membuka jendela Microsoft Edge...")

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=profile_dir,
            channel="msedge",
            headless=False,
            args=["--start-maximized", "--disable-blink-features=AutomationControlled"],
            no_viewport=True
        )

        page = context.pages[0] if context.pages else context.new_page()
        page.goto("https://www.instagram.com/direct/inbox/", timeout=60000)
        time.sleep(4)

        # Cek jika perlu login
        if "login" in page.url.lower() or page.locator("input[name='username']").count() > 0:
            print("\n[🔐 LOGIN] Mengisi username dan password...")
            try:
                if page.locator("input[name='username']").count() > 0:
                    page.fill("input[name='username']", IG_USERNAME)
                    time.sleep(0.5)
                    page.fill("input[name='password']", IG_PASSWORD)
                    time.sleep(0.5)
                    page.click("button[type='submit']")
                    print("[INFO] Tombol login berhasil diklik.")
                    print("[INFO] Silakan selesaikan jika ada verifikasi atau pop-up di jendela Edge yang muncul.")
            except Exception as e:
                print(f"[WARN] Error saat mengisi login: {e}")

        print("\n⏳ Menunggu halaman Direct Messages terbuka...")
        # Loop menunggu sampai masuk ke halaman DM
        while True:
            current_url = page.url.lower()
            if "direct" in current_url:
                # Tutup popup notifikasi jika muncul ("Not Now" / "Lain Kali")
                try:
                    not_now = page.locator("button:has-text('Not Now'), button:has-text('Lain Kali'), button:has-text('Jangan Sekarang')")
                    if not_now.count() > 0:
                        not_now.first.click()
                        time.sleep(1)
                except Exception:
                    pass
                print("🎉 BERHASIL TERHUBUNG KE DIRECT MESSAGES INSTAGRAM!")
                break
            time.sleep(2)

        print("\n=======================================================")
        print("💑 BOT AI PASANGAN AKTIF & SIAP MEMBALAS SECARA NATURAL!")
        print("💡 Jendela Microsoft Edge jangan ditutup (boleh di-minimize).")
        print("=======================================================\n")

        replied_messages = set()

        while True:
            try:
                # Deteksi nama lawan bicara di header chat
                chat_partner = ""
                try:
                    header_span = page.locator("header span[dir='auto'], header h1, a[href^='/'][role='link'] span").first
                    if header_span.count() > 0:
                        chat_partner = header_span.inner_text().strip()
                except Exception:
                    pass

                # Cek apakah ada textbox input chat
                textbox = page.locator("div[role='textbox'], div[contenteditable='true']")
                
                if textbox.count() > 0:
                    # Ambil semua balon pesan
                    message_elements = page.locator("div[dir='auto']")
                    count = message_elements.count()
                    
                    if count > 0:
                        last_msg = ""
                        for i in range(count - 1, -1, -1):
                            txt = message_elements.nth(i).inner_text().strip()
                            if txt and len(txt) > 0 and "\n" not in txt and txt != "Seen" and txt != "Dibaca":
                                last_msg = txt
                                break

                        if last_msg and last_msg not in replied_messages:
                            replied_messages.add(last_msg)
                            partner_label = f"@{chat_partner}" if chat_partner else "Chat Aktif"
                            print(f"\n📩 [DM DITERIMA dari {partner_label}]: \"{last_msg}\"")
                            print("🤖 Mengetik balasan natural...")
                            
                            ai_reply = get_ai_reply(last_msg, chat_partner)
                            print(f"💬 [BALASAN]: \"{ai_reply}\"")
                            
                            # Ketik balasan ke textbox
                            tb = textbox.first
                            tb.click()
                            time.sleep(0.5)
                            page.keyboard.type(ai_reply, delay=25)
                            time.sleep(0.5)
                            page.keyboard.press("Enter")
                            print("✅ Balasan terkirim!\n")
                
                time.sleep(4)
            except KeyboardInterrupt:
                print("\nBot dihentikan oleh pengguna.")
                break
            except Exception:
                time.sleep(4)

if __name__ == "__main__":
    main()

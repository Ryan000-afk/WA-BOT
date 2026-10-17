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
        return "好呀.."
    
    # Deteksi apakah lawan bicara adalah Bryan
    is_bryan = any(b in (chat_partner or "").lower() for b in ["bryan", "adelson"])
    
    context_note = ""
    if is_bryan:
        context_note = (
            f"[PENTING: Lawan bicaramu adalah pacar/pasanganmu sendiri, Bryan (@{chat_partner or 'bryanadelsonn'})! "
            f"Bersikaplah sangat manis, perhatian, manja, panggil 宝贝/baby/臭宝. "
            f"Gunakan campuran Mandarin & Simple English, dan bahasa Indonesia HANYA jika diminta atau saat bercanda translate kaku. "
            f"Gunakan angka seperti 555 untuk menangis atau 2333 untuk tertawa secara natural.]"
        )
    elif chat_partner:
        context_note = (
            f"[Catatan: Lawan bicaramu adalah @{chat_partner} (bukan pacarmu Bryan). "
            f"Sangat dingin, flat, jual mahal, dan TANPA EMOTIKON SAMA SEKALI: '你是谁？我有男朋友了，请不要发信息。']"
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
                    "temperature": 0.85
                }
            )
            if res and res.text:
                return res.text.strip()
        except Exception:
            continue
    return "好呀 宝贝 ❤️"

def main():
    print("=" * 65)
    print("🚀 MENYAMBUNGKAN BOT KE JENDELA MICROSOFT EDGE YANG SUDAH TERBUKA...")
    print("=" * 65)

    with sync_playwright() as p:
        try:
            browser = p.chromium.connect_over_cdp("http://localhost:9222")
        except Exception as conn_err:
            print("\n❌ Gagal terhubung ke port 9222!")
            print("Pastikan Anda sudah menjalankan start_edge.bat terlebih dahulu.")
            print(f"Detail error: {conn_err}")
            return

        context = browser.contexts[0] if browser.contexts else None
        if not context:
            print("❌ Tidak ada context browser ditemukan.")
            return

        # Cari tab Instagram yang sudah terbuka
        page = None
        for p_item in context.pages:
            if "instagram.com" in p_item.url:
                page = p_item
                print(f"[+] Ditemukan tab Instagram yang aktif: {page.url}")
                break

        if not page:
            print("[*] Tab Instagram belum ada, membuka tab baru di Edge Anda...")
            page = context.new_page()
            page.goto("https://www.instagram.com/direct/inbox/", timeout=60000)

        # Pastikan berada di Direct Inbox
        if "direct" not in page.url:
            print("[*] Mengarahkan ke Direct Messages (DM)...")
            page.goto("https://www.instagram.com/direct/inbox/", timeout=60000)

        time.sleep(3)

        print("\n=======================================================")
        print("🎉 BOT BERHASIL MENEMPEL KE JENDELA EDGE ANDA!")
        print("💑 Karakter Chinese Native Girlfriend (@yii_aimao) AKTIF!")
        print("💬 Siap membalas DM dari Bryan (@bryanadelson) & menjaga jarak dari orang lain.")
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
                            print(f"💬 [BALASAN @yii_aimao]: \"{ai_reply}\"")
                            
                            # Ketik balasan ke textbox
                            tb = textbox.first
                            tb.click()
                            time.sleep(0.5)
                            page.keyboard.type(ai_reply, delay=25)
                            time.sleep(0.5)
                            page.keyboard.press("Enter")
                            print("✅ Balasan terkirim ke DM Instagram!\n")
                
                time.sleep(3)
            except KeyboardInterrupt:
                print("\nBot dihentikan.")
                break
            except Exception:
                time.sleep(3)

if __name__ == "__main__":
    main()

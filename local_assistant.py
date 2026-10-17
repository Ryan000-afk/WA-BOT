import os
import sys
import time
import threading
import tkinter as tk
from tkinter import ttk, messagebox
import pyautogui
import pyperclip
from dotenv import load_dotenv
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
        print(f"Gemini Init Error: {e}")

def get_ai_reply(user_message, sender_name="Bryan"):
    if not gemini_client:
        return "好呀 宝贝 ❤️"

    is_bryan = any(b in sender_name.lower() for b in ["bryan", "adelson", "sayang", "beb", "pacar"])
    context_note = ""
    if is_bryan:
        context_note = (
            f"[PENTING: Lawan bicaramu adalah pacar/pasanganmu sendiri, Bryan (@{sender_name})! "
            f"Bersikaplah sangat manis, perhatian, manja, panggil 宝贝/baby/臭宝. "
            f"Gunakan campuran Mandarin & Simple English, dan bahasa Indonesia HANYA jika diminta atau saat bercanda translate kaku ala Google Translate. "
            f"Gunakan angka seperti 555 untuk menangis atau 2333 untuk tertawa secara natural.]\n"
        )
    else:
        context_note = (
            f"[Catatan: Lawan bicaramu adalah @{sender_name} (bukan pacarmu Bryan). "
            f"Sangat dingin, flat, jual mahal, dan TANPA EMOTIKON SAMA SEKALI: '你是谁？我有男朋友了，请不要发信息。']\n"
        )

    prompt = f"{context_note}Pesan masuk: \"{user_message}\"\nBalas langsung secara alami (1-2 baris pendek):"

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

class LocalAiCompanion:
    def __init__(self, root):
        self.root = root
        self.root.title("💖 @yii_aimao - AI Companion")
        self.root.geometry("440x560")
        self.root.attributes("-topmost", True)  # Selalu melayang di atas browser
        self.root.configure(bg="#161722")

        # Styling
        style = ttk.Style()
        style.theme_use("clam")

        # Header
        header = tk.Frame(root, bg="#212234", pady=10)
        header.pack(fill="x")
        
        lbl_title = tk.Label(
            header, 
            text="💑 @yii_aimao - Desktop AI Companion", 
            font=("Segoe UI", 12, "bold"), 
            fg="#ff4d79", 
            bg="#212234"
        )
        lbl_title.pack()
        
        lbl_sub = tk.Label(
            header, 
            text="Chinese Native Girlfriend untuk Bryan (@bryanadelson)", 
            font=("Segoe UI", 8), 
            fg="#9d9eb5", 
            bg="#212234"
        )
        lbl_sub.pack()

        # Body container
        body = tk.Frame(root, bg="#161722", padx=15, pady=10)
        body.pack(fill="both", expand=True)

        # Partner Selector
        tk.Label(body, text="Pengirim Chat:", font=("Segoe UI", 9, "bold"), fg="#e0e0ff", bg="#161722").pack(anchor="w")
        self.sender_var = tk.StringVar(value="Bryan (@bryanadelson)")
        sender_cb = ttk.Combobox(body, textvariable=self.sender_var, values=["Bryan (@bryanadelson)", "Orang Asing / Lain"], state="readonly")
        sender_cb.pack(fill="x", pady=(2, 8))

        # Input Pesan Masuk
        tk.Label(body, text="Pesan Masuk (Bisa Copy-Paste dari IG):", font=("Segoe UI", 9, "bold"), fg="#e0e0ff", bg="#161722").pack(anchor="w")
        self.txt_incoming = tk.Text(body, height=3, font=("Segoe UI", 10), bg="#212234", fg="#ffffff", insertbackground="white", bd=0, padx=8, pady=6)
        self.txt_incoming.pack(fill="x", pady=(2, 8))

        # Tombol Buat Balasan
        btn_generate = tk.Button(
            body, 
            text="✨ Generate Balasan AI (@yii_aimao)", 
            font=("Segoe UI", 10, "bold"), 
            bg="#ff4d79", 
            fg="white", 
            activebackground="#ff3366", 
            activeforeground="white",
            bd=0, 
            pady=6, 
            cursor="hand2",
            command=self.generate_reply
        )
        btn_generate.pack(fill="x", pady=(0, 8))

        # Output Balasan AI
        tk.Label(body, text="Balasan Karakter (Otomatis Tersalin ke Clipboard):", font=("Segoe UI", 9, "bold"), fg="#e0e0ff", bg="#161722").pack(anchor="w")
        self.txt_reply = tk.Text(body, height=4, font=("Segoe UI", 10), bg="#212234", fg="#00ffcc", insertbackground="white", bd=0, padx=8, pady=6)
        self.txt_reply.pack(fill="x", pady=(2, 8))

        # Tombol Aksi: Auto Send
        btn_auto_type = tk.Button(
            body, 
            text="🚀 Kirim Otomatis ke Chat Instagram", 
            font=("Segoe UI", 10, "bold"), 
            bg="#00b894", 
            fg="white", 
            activebackground="#00a383", 
            activeforeground="white",
            bd=0, 
            pady=8, 
            cursor="hand2",
            command=self.auto_type_and_send
        )
        btn_auto_type.pack(fill="x", pady=(0, 4))

        self.lbl_status = tk.Label(
            body, 
            text="*Klik 'Kirim Otomatis', lalu dalam 2 detik klik kolom chat di Edge.\nPesan akan langsung terketik dan terkirim!", 
            font=("Segoe UI", 8), 
            fg="#ffaa00", 
            bg="#161722",
            justify="center"
        )
        self.lbl_status.pack()

    def generate_reply(self):
        msg = self.txt_incoming.get("1.0", "end").strip()
        if not msg:
            messagebox.showwarning("Peringatan", "Ketikkan atau tempelkan pesan masuk terlebih dahulu.")
            return

        sender = "Bryan" if "bryan" in self.sender_var.get().lower() else "Orang Asing"
        self.txt_reply.delete("1.0", "end")
        self.txt_reply.insert("end", "Sedang mengetik balasan...")
        self.root.update()

        reply = get_ai_reply(msg, sender_name=sender)
        self.txt_reply.delete("1.0", "end")
        self.txt_reply.insert("end", reply)
        pyperclip.copy(reply)
        self.lbl_status.config(text="✅ Balasan tersalin ke clipboard! Siap dikirim.", fg="#00ffcc")

    def auto_type_and_send(self):
        reply = self.txt_reply.get("1.0", "end").strip()
        if not reply or reply == "Sedang mengetik balasan...":
            messagebox.showwarning("Peringatan", "Klik 'Generate Balasan AI' terlebih dahulu.")
            return

        self.lbl_status.config(text="⏳ Klik kolom chat Instagram di Edge SEKARANG!", fg="#ff4d79")
        self.root.update()

        def task():
            pyperclip.copy(reply)
            time.sleep(2)  # Jeda 2 detik agar kursor diklik ke chat Instagram
            pyautogui.hotkey("ctrl", "v")
            time.sleep(0.3)
            pyautogui.press("enter")
            self.lbl_status.config(text="🎉 Pesan berhasil terkirim ke Instagram!", fg="#00ffcc")

        threading.Thread(target=task, daemon=True).start()

def main():
    root = tk.Tk()
    app = LocalAiCompanion(root)
    root.mainloop()

if __name__ == "__main__":
    main()

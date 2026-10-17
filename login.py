import os
import sys
from dotenv import load_dotenv
from instagrapi import Client
from instagrapi.exceptions import (
    BadPassword,
    TwoFactorRequired,
    ChallengeRequired,
    PleaseWaitFewMinutes
)

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

load_dotenv()

username = os.getenv("IG_USERNAME", "").strip()
password = os.getenv("IG_PASSWORD", "").strip()

if not username or not password:
    print("❌ Error: IG_USERNAME atau IG_PASSWORD belum diisi di file .env")
    sys.exit(1)

cl = Client()
cl.set_country("ID")
cl.set_locale("id_ID")
cl.set_timezone_offset(7 * 3600)

def challenge_code_handler(user, choice):
    print(f"\n=======================================================")
    print(f"📩 INSTAGRAM MENGIRIM KODE VERIFIKASI KE: {choice}")
    print(f"Silakan periksa Email atau SMS Anda sekarang.")
    print(f"=======================================================")
    code = input("👉 Masukkan 6 Digit Kode OTP: ").strip()
    return code

cl.challenge_code_handler = challenge_code_handler

print("=" * 55)
print(f"🔐 Memulai proses login ke Instagram untuk: @{username}")
print("=" * 55)

try:
    cl.login(username, password)
    cl.dump_settings("session_python.json")
    print("\n" + "=" * 55)
    print(f"🎉 LOGIN BERHASIL SEBAGAI @{username}!")
    print(f"💾 Sesi berhasil disimpan ke file: session_python.json")
    print("Sekarang bot dapat dijalankan kapan saja dengan: python app.py")
    print("=" * 55)
except TwoFactorRequired:
    print("\n[!] Akun mengaktifkan 2FA (Two Factor Authentication).")
    two_fa_code = input("👉 Masukkan kode 2FA (dari Authenticator App / SMS): ").strip()
    cl.login(username, password, verification_code=two_fa_code)
    cl.dump_settings("session_python.json")
    print(f"\n🎉 2FA Berhasil! Sesi disimpan ke session_python.json.")
except BadPassword:
    print("\n❌ Gagal: Password yang dimasukkan salah.")
except PleaseWaitFewMinutes:
    print("\n⏳ Instagram meminta menunggu beberapa menit karena terlalu banyak request.")
except Exception as e:
    print(f"\n❌ Terjadi kesalahan login: {str(e)}")

import os
import json
import base64
import sqlite3
import ctypes
from ctypes import wintypes
from Cryptodome.Cipher import AES

GENERIC_READ = 0x80000000
FILE_SHARE_READ = 0x00000001
FILE_SHARE_WRITE = 0x00000002
FILE_SHARE_DELETE = 0x00000004
OPEN_EXISTING = 3
FILE_ATTRIBUTE_NORMAL = 0x80

def copy_locked_file(src_path, dst_path):
    handle = ctypes.windll.kernel32.CreateFileW(
        src_path,
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        None,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        None
    )
    if handle == -1 or handle == 0xFFFFFFFF:
        raise ctypes.WinError()

    try:
        size = ctypes.windll.kernel32.GetFileSize(handle, None)
        buf = ctypes.create_string_buffer(size)
        bytes_read = wintypes.DWORD()
        ctypes.windll.kernel32.ReadFile(handle, buf, size, ctypes.byref(bytes_read), None)
        with open(dst_path, "wb") as f:
            f.write(buf.raw[:bytes_read.value])
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)

def extract_instagram_cookies():
    local_state_path = os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\User Data\Local State")
    if not os.path.exists(local_state_path):
        print("Local State not found")
        return []

    with open(local_state_path, "r", encoding="utf-8") as f:
        local_state = json.load(f)

    encrypted_key = base64.b64decode(local_state["os_crypt"]["encrypted_key"])[5:]

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    blob_in = DATA_BLOB(len(encrypted_key), ctypes.create_string_buffer(encrypted_key, len(encrypted_key)))
    blob_out = DATA_BLOB()
    ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out))
    master_key = ctypes.string_at(blob_out.pbData, blob_out.cbData)

    cookie_db = os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\User Data\Default\Network\Cookies")
    if not os.path.exists(cookie_db):
        print("Cookies DB not found")
        return []

    temp_db = os.path.join(os.path.dirname(__file__), "temp_cookies.db")
    copy_locked_file(cookie_db, temp_db)

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

    out_file = os.path.join(os.path.dirname(__file__), "playwright_cookies.json")
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(cookies, f, indent=2)

    print(f"✅ BERHASIL! Mengekstrak {len(cookies)} cookies Instagram asli langsung dari Edge!")
    for c in cookies:
        if c["name"] in ["sessionid", "ds_user_id", "csrftoken", "mid"]:
            print(f"   • {c['name']}: {c['value'][:20]}...")
    return cookies

if __name__ == "__main__":
    extract_instagram_cookies()

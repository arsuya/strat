"""
Test Telegram setup. Jalanin DULU sebelum scanner.py
"""
import os
import requests
from dotenv import load_dotenv

load_dotenv()
token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
chat_id = os.getenv("TELEGRAM_CHAT_ID", "").strip()

if not token or not chat_id:
    print("❌ TELEGRAM_BOT_TOKEN atau TELEGRAM_CHAT_ID kosong di .env")
    raise SystemExit(1)

r = requests.post(
    f"https://api.telegram.org/bot{token}/sendMessage",
    json={
        "chat_id": chat_id,
        "text": "✅ *DLMM Scanner v2 — test berhasil!*\n\nBot siap dipakai.",
        "parse_mode": "Markdown",
    },
    timeout=10,
)

if r.status_code == 200:
    print("✅ Berhasil! Cek Telegram kamu.")
else:
    print(f"❌ Error {r.status_code}: {r.text}")

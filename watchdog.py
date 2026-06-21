#!/usr/bin/env python3
"""
Scanner watchdog — cek apakah systemd unit aktif.
Kirim Telegram alert jika scanner mati.
"""
import subprocess, sys, os
from pathlib import Path

# === CONFIG ===
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID   = os.getenv("TELEGRAM_CHAT_ID")
SERVICE = "dlmm-scanner"

# === Load env if not set ===
if not TELEGRAM_BOT_TOKEN:
    env_file = Path(__file__).parent / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if "=" in line:
                k, _, v = line.partition("=")
                if k.strip() == "TELEGRAM_BOT_TOKEN":
                    TELEGRAM_BOT_TOKEN = v.strip().strip('"')
                elif k.strip() == "TELEGRAM_CHAT_ID":
                    TELEGRAM_CHAT_ID = v.strip().strip('"')

if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
    print("Telegram not configured", file=sys.stderr)
    sys.exit(1)

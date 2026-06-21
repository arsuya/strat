#!/usr/bin/env python3
"""
Proxy health check — cron script.
Test a few fresh proxies directly against GT, report via Telegram.
Takes <15 seconds.
"""
import os
import requests
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()
_GMGN_ENV = os.path.expanduser("~/.config/gmgn/.env")
if os.path.exists(_GMGN_ENV):
    load_dotenv(_GMGN_ENV, override=True)

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")

PROXY_LIST_FILE = Path(__file__).parent / "proxy_list.txt"
GT_TEST_URL = "https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price/So11111111111111111111111111111111111111112"


def send_telegram(text):
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("TG:", text)
        return
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
            json={"chat_id": TELEGRAM_CHAT_ID, "text": text, "disable_web_page_preview": True},
            timeout=10,
        )
        if r.status_code != 200:
            print(f"TG error: {r.status_code}")
    except Exception as e:
        print(f"TG error: {e}")


def main():
    now = datetime.now().strftime("%H:%M")

    # Load proxies from file
    try:
        if not PROXY_LIST_FILE.exists():
            send_telegram(f"⚠️ {now} Proxy Check FAILED\nNo proxy list file found: {PROXY_LIST_FILE}")
            return
        raw = PROXY_LIST_FILE.read_text().strip()
        proxies = [line.strip() for line in raw.split("\n") if "://" in line]
    except Exception as e:
        send_telegram(f"⚠️ {now} Proxy Check FAILED\nCannot fetch proxy list: {e}")
        return

    if not proxies:
        send_telegram(f"⚠️ {now} Proxy Check FAILED\nNo proxies available from source.")
        return

    # Test first 3
    working = 0
    for i, proxy in enumerate(proxies[:3]):
        try:
            resp = requests.get(GT_TEST_URL, proxies={"http": proxy, "https": proxy}, timeout=5)
            if resp.status_code == 200:
                working += 1
        except Exception:
            pass

    total = len(proxies)

    if working >= 2:
        send_telegram(f"🟢 {now} Proxy Pool OK\n{working}/3 proxies tested working.\n{total} in pool.")
    elif working == 1:
        send_telegram(f"🟡 {now} Proxy Pool DEGRADED\n{working}/3 proxies working.\n{total} in pool — may hit rate limits.")
    else:
        send_telegram(f"🔴 {now} Proxy Pool DEAD\n0/3 proxies working.\n{total} in pool — ATH checks may fail.")


if __name__ == "__main__":
    main()

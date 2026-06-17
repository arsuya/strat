"""
DLMM Pump.fun Scanner Bot v3
============================
Improvement vs v2:
- Pakai SERVER-SIDE filter dari `market trenches` (jauh lebih efisien)
- Fix mapping "Phishing" → entrapment_ratio (sebelumnya salah ke rat_trader)
- Hanya 1 API call per scan untuk filtering (vs 1+N di v2)

Flow:
  1. `gmgn-cli market trenches` dengan SEMUA filter sebagai parameter
     (MC, vol, age, pump.fun, top10, insider, dev, phishing, bundler)
  2. Hasil sudah pre-filtered → tinggal cek LP burn (1 field di response)
     dan dev rug history (1 API call opsional per kandidat)
  3. Lolos → notif Telegram

Run: python scanner.py
"""

import os
import json
import time
import shutil
import logging
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv()

# ============================================================
# CONFIG
# ============================================================
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID   = os.getenv("TELEGRAM_CHAT_ID", "")

SCAN_INTERVAL_SEC  = int(os.getenv("SCAN_INTERVAL_SEC", "60"))
HEARTBEAT_HOURS    = float(os.getenv("HEARTBEAT_HOURS", "6"))   # heartbeat tiap N jam

# === Server-side filter thresholds (akan dikirim ke gmgn-cli) ===
MIN_MARKET_CAP        = 250_000
MIN_VOLUME_24H        = 1_000_000
MIN_AGE               = "6h"          # GMGN duration format: "6h", "30m", dll
MAX_TOP_HOLDER_RATE   = 0.30          # Top 10 ≤ 30% (rasio 0-1)
MAX_INSIDER_RATIO     = 0.00          # Insider = 0%
MAX_CREATOR_BAL_RATE  = 0.01          # Dev ≤ 1%
MAX_ENTRAPMENT_RATIO  = 0.30          # Phishing ≤ 30%
MAX_BUNDLER_RATE      = 0.60          # Bundling ≤ 60%
MAX_RUG_RATIO         = 0.01          # Potensi rug ≤ 1%

# === Client-side filter (gak bisa server-side) ===
REQUIRE_LP_BURNT      = True          # Bakar pool wajib 100%

LAUNCHPAD                 = "Pump.fun"   # case-sensitive
GMGN_CLI                  = os.getenv("GMGN_CLI", "gmgn-cli")
STATE_FILE                = Path("notified.json")

# ============================================================
# LOGGING
# ============================================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# ============================================================
# STATE
# ============================================================
def load_state() -> dict:
    if STATE_FILE.exists():
        try:    return json.loads(STATE_FILE.read_text())
        except Exception: return {}
    return {}

def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2))

# ============================================================
# gmgn-cli wrapper
# ============================================================
def run_gmgn(args: list[str], timeout: int = 30) -> dict | list | None:
    cmd = [GMGN_CLI, *args, "--raw"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        log.error(f"`{GMGN_CLI}` tidak ketemu di PATH")
        return None
    except subprocess.TimeoutExpired:
        log.warning(f"timeout: {' '.join(args[:4])}...")
        return None

    if proc.returncode != 0:
        err = (proc.stderr or "")[:300].strip()
        log.warning(f"gmgn-cli error ({proc.returncode}) {' '.join(args[:4])}: {err}")
        return None

    out = (proc.stdout or "").strip()
    if not out:
        return None
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        log.warning(f"JSON parse fail: {out[:200]}")
        return None

    if isinstance(data, dict) and "data" in data:
        return data["data"]
    return data

# ============================================================
# STEP 1: fetch dengan SERVER-SIDE filter
# ============================================================
def fetch_filtered_candidates() -> list[dict]:
    """
    Fetch tokens yg sudah lolos SEMUA filter MC/vol/age/security
    di server. Tinggal cek LP burn dan dev rug history client-side.
    """
    args = [
        "market", "trenches",
        "--chain", "sol",
        "--type", "completed",
        "--launchpad-platform", LAUNCHPAD,
        "--limit", "80",
        # server-side filters:
        "--min-marketcap",         str(MIN_MARKET_CAP),
        "--min-volume-24h",        str(MIN_VOLUME_24H),
        "--min-created",           MIN_AGE,
        "--max-top-holder-rate",   str(MAX_TOP_HOLDER_RATE),
        "--max-insider-ratio",     str(MAX_INSIDER_RATIO),
        "--max-creator-balance-rate", str(MAX_CREATOR_BAL_RATE),
        "--max-entrapment-ratio",  str(MAX_ENTRAPMENT_RATIO),
        "--max-bundler-rate",      str(MAX_BUNDLER_RATE),
        "--max-rug-ratio",         str(MAX_RUG_RATIO),
    ]
    data = run_gmgn(args)
    if data is None:
        return []

    # Response trenches format: {"completed": [...], "new_creation": [...], "pump": [...]}
    # Karena kita --type completed, ambil dari key "completed"
    if isinstance(data, dict):
        items = data.get("completed") or data.get("list") or []
    elif isinstance(data, list):
        items = data
    else:
        items = []

    log.info(f"trenches pre-filtered: {len(items)} kandidat lolos server-side filter")
    return items

# ============================================================
# STEP 2: cek LP burn (client-side, dari response field)
# ============================================================
def lp_is_burnt(item: dict) -> bool:
    return (item.get("burn_status") or "").lower() == "burn"

# ============================================================
# Format helpers
# ============================================================
def _f(v, default=0.0) -> float:
    try: return float(v)
    except: return default

def _pct(v) -> float:
    """Ratio 0-1 → percent 0-100"""
    f = _f(v)
    return f * 100 if 0 <= f <= 1 else f

# ============================================================
# TELEGRAM
# ============================================================
def send_telegram(text: str) -> None:
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        log.warning("Telegram belum dikonfig — print saja")
        log.info(f"MESSAGE:\n{text}")
        return
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
            json={
                "chat_id": TELEGRAM_CHAT_ID,
                "text": text,
                "parse_mode": "Markdown",
                "disable_web_page_preview": True,
            },
            timeout=10,
        )
        if r.status_code != 200:
            log.error(f"Telegram error: {r.status_code} {r.text}")
    except Exception as e:
        log.error(f"Telegram exception: {e}")

def format_notification(item: dict) -> str:
    addr = item.get("address", "")
    sym  = item.get("symbol", "?")
    name = item.get("name", "?")
    mc   = _f(item.get("usd_market_cap"))
    vol  = _f(item.get("volume_24h"))
    liq  = _f(item.get("liquidity"))
    holders = int(item.get("holder_count") or 0)
    created = int(item.get("created_timestamp") or item.get("open_timestamp") or 0)
    age_h = (time.time() - created) / 3600 if created else 0
    smart = int(item.get("smart_degen_count") or 0)
    rug   = _f(item.get("rug_ratio"))

    return (
        f"🟢 *LOLOS FILTER* — `{sym}`\n"
        f"*Name:* {name}\n"
        f"*MC:* ${mc:,.0f}  |  *Vol 24h:* ${vol:,.0f}\n"
        f"*Liquidity:* ${liq:,.0f}  |  *Holders:* {holders:,}\n"
        f"*Age:* {age_h:.1f}h  |  *Smart Money:* {smart}\n\n"
        f"*Security:*\n"
        f"• Top10: {_pct(item.get('top_10_holder_rate')):.1f}%\n"
        f"• Insider (suspected): {_pct(item.get('suspected_insider_hold_rate')):.1f}%\n"
        f"• Dev: {_pct(item.get('creator_balance_rate')):.1f}%\n"
        f"• Phishing: {_pct(item.get('entrapment_ratio')):.1f}%\n"
        f"• Bundling: {_pct(item.get('bundler_trader_amount_rate')):.1f}%\n"
        f"• LP Burnt: ✅\n"
        f"• Rug Ratio: {rug:.2f}\n\n"
        f"*CA:* `{addr}`\n"
        f"[GMGN](https://gmgn.ai/sol/token/{addr}) | "
        f"[Dexscreener](https://dexscreener.com/solana/{addr})"
    )

def send_heartbeat(scans: int, notified: int, total_lifetime: int, uptime_h: float) -> None:
    """Bukti bot masih hidup. Kirim tiap HEARTBEAT_HOURS jam."""
    msg = (
        f"💚 *Scanner alive*\n"
        f"Uptime: {uptime_h:.1f}h\n"
        f"Scans {HEARTBEAT_HOURS:.0f}h terakhir: {scans}\n"
        f"Notif baru {HEARTBEAT_HOURS:.0f}h terakhir: {notified}\n"
        f"Total notif (all time): {total_lifetime}\n"
        f"Next heartbeat: ~{HEARTBEAT_HOURS:.0f}h lagi"
    )
    send_telegram(msg)

def send_startup() -> None:
    """Notif sekali saat bot start/restart."""
    msg = (
        f"🚀 *Scanner started*\n"
        f"Interval scan: {SCAN_INTERVAL_SEC}s\n"
        f"Heartbeat: tiap {HEARTBEAT_HOURS:.0f}h\n\n"
        f"Filter aktif:\n"
        f"• MC ≥ ${MIN_MARKET_CAP:,}\n"
        f"• Vol 24h ≥ ${MIN_VOLUME_24H:,}\n"
        f"• Age ≥ {MIN_AGE}\n"
        f"• Top10 ≤ {MAX_TOP_HOLDER_RATE*100:.0f}%\n"
        f"• Insider = {MAX_INSIDER_RATIO*100:.0f}%\n"
        f"• Dev ≤ {MAX_CREATOR_BAL_RATE*100:.0f}%\n"
        f"• Phishing ≤ {MAX_ENTRAPMENT_RATIO*100:.0f}%\n"
        f"• Bundling ≤ {MAX_BUNDLER_RATE*100:.0f}%\n"
        f"• Rug ≤ {MAX_RUG_RATIO*100:.0f}%\n"
        f"• LP burnt: wajib"
    )
    send_telegram(msg)

# ============================================================
# PREFLIGHT
# ============================================================
def preflight() -> bool:
    ok = True
    if not shutil.which(GMGN_CLI):
        log.error(f"❌ `{GMGN_CLI}` tidak di PATH. Install: npm i -g gmgn-cli")
        ok = False

    # test auth dengan request kecil
    test = run_gmgn(["market", "trending", "--chain", "sol",
                     "--interval", "1h", "--limit", "1"], timeout=15)
    if test is None:
        log.error("❌ gmgn-cli gagal. Cek GMGN_API_KEY di ~/.config/gmgn/.env")
        log.error("   IPv6 issue? Cek: curl ip.me (harus IPv4)")
        ok = False
    else:
        log.info("✅ gmgn-cli authenticated")

    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        log.warning("⚠️  Telegram belum dikonfig — notif ke console saja")
    else:
        log.info("✅ Telegram terkonfigurasi")

    return ok

# ============================================================
# MAIN LOOP
# ============================================================
def scan_once(state: dict) -> int:
    """Return jumlah token baru yang lolos & dinotifikasi di scan ini."""
    candidates = fetch_filtered_candidates()
    if not candidates:
        log.info("Tidak ada kandidat lolos server-side filter")
        return 0

    passed = 0
    for item in candidates:
        addr = item.get("address")
        if not addr or addr in state:
            continue

        sym = item.get("symbol") or addr[:8]

        # Client-side: LP burnt
        if REQUIRE_LP_BURNT and not lp_is_burnt(item):
            log.info(f"  ❌ {sym}: LP belum burnt (burn_status={item.get('burn_status')})")
            continue

        # SEMUA filter lolos
        send_telegram(format_notification(item))
        state[addr] = {
            "symbol": sym,
            "notified_at": datetime.now(timezone.utc).isoformat(),
        }
        save_state(state)
        passed += 1
        log.info(f"  ✅ {sym}: LOLOS — notif terkirim")

        time.sleep(0.3)  # rate limit safety

    log.info(f"Scan selesai. {passed} token baru lolos.")
    return passed

def main() -> None:
    log.info("=== DLMM Scanner v3 (server-side filter) ===")
    log.info(f"Filter: MC≥${MIN_MARKET_CAP:,} | Vol≥${MIN_VOLUME_24H:,} | Age≥{MIN_AGE} | "
             f"Top10≤{MAX_TOP_HOLDER_RATE*100:.0f}% | Insider≤{MAX_INSIDER_RATIO*100:.0f}% | "
             f"Dev≤{MAX_CREATOR_BAL_RATE*100:.0f}% | Phishing≤{MAX_ENTRAPMENT_RATIO*100:.0f}% | "
             f"Bundling≤{MAX_BUNDLER_RATE*100:.0f}% | RugRatio≤{MAX_RUG_RATIO*100:.0f}%")
    log.info(f"Client-side: LP burnt={REQUIRE_LP_BURNT}")

    if not preflight():
        return

    state = load_state()
    log.info(f"State: {len(state)} token sudah dinotif sebelumnya")

    send_startup()

    # Stats tracking untuk heartbeat
    started_at        = time.time()
    last_heartbeat_at = time.time()
    scans_since_hb    = 0
    notified_since_hb = 0
    hb_interval_sec   = HEARTBEAT_HOURS * 3600

    while True:
        try:
            passed = scan_once(state)
            scans_since_hb += 1
            notified_since_hb += passed

            # Heartbeat check
            if time.time() - last_heartbeat_at >= hb_interval_sec:
                uptime_h = (time.time() - started_at) / 3600
                send_heartbeat(scans_since_hb, notified_since_hb,
                               len(state), uptime_h)
                scans_since_hb = 0
                notified_since_hb = 0
                last_heartbeat_at = time.time()

        except KeyboardInterrupt:
            log.info("Stopped by user")
            send_telegram("🛑 *Scanner stopped* (manual)")
            break
        except Exception as e:
            log.exception(f"Error: {e}")
        time.sleep(SCAN_INTERVAL_SEC)

if __name__ == "__main__":
    main()

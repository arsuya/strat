"""
DLMM Scanner Bot v4 — ALL Solana DEXs
=====================================
Improvement vs v3:
- Hapus filter --launchpad-platform → deteksi SEMUA DEX (Pump.fun, Meteora, Raydium, dll)
- LAUNCHPAD dikosongkan (bisa diisi untuk filter spesifik)

Flow:
  1. `gmgn-cli market trenches` dengan SEMUA filter sebagai parameter
     (MC, vol, age, top10, insider, dev, phishing, bundler)
     TANPA filter launchpad → semua token dari semua DEX!
  2. Hasil sudah pre-filtered → tinggal cek LP burn (1 field di response)
     dan ATH 3-TF check
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

# Project modules
import proxy_pool

load_dotenv()

# PM2 kadang gak nerusin env variable ke subprocess → fallback manual
_GMGN_ENV = Path.home() / ".config" / "gmgn" / ".env"
if _GMGN_ENV.exists():
    load_dotenv(_GMGN_ENV, override=True)

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
MIN_AGE               = "360m"        # 6 jam dalam menit (GMGN format)
MAX_TOP_HOLDER_RATE   = 0.30          # Top 10 ≤ 30% (rasio 0-1)
MAX_INSIDER_RATIO     = 0.00          # Insider = 0%
MAX_CREATOR_BAL_RATE  = 0.01          # Dev ≤ 1%
MAX_ENTRAPMENT_RATIO  = 0.30          # Phishing ≤ 30%
MAX_BUNDLER_RATE      = 0.60          # Bundling ≤ 60%
MAX_RUG_RATIO         = 0.01          # Potensi rug ≤ 1%
MIN_TOTAL_FEE         = 30            # Total fee ≥ $30 (aktivitas on-chain nyata)

# === Client-side filter (gak bisa server-side) ===
REQUIRE_LP_BURNT      = True          # Bakar pool wajib 100%

# === ATH 3-TF check ===
ENABLE_ATH_CHECK      = True          # Aktifkan ATH triple-TF filter
ATH_CANDLE_LIMIT      = 1000          # Max candle per TF

# === Dedup ===
RE_NOTIFY_HOURS       = 1.0           # Token boleh dinotif lagi setelah N jam

LAUNCHPAD                 = ""           # empty = ALL launchpads (Pump.fun, Meteora, Raydium, etc.)
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
    cmd_str = " ".join([GMGN_CLI] + args + ["--raw"])
    env = os.environ.copy()
    if "GMGN_API_KEY" not in env:
        env["GMGN_API_KEY"] = os.getenv("GMGN_API_KEY", "")
    # Hapus PM2 env vars yang bikin Node.js crash
    for k in list(env.keys()):
        if k.startswith("PM2_") or k in ("pm_id", "NODE_APP_INSTANCE", "name", "instances", "exec_mode",
                                          "pm_exec_path", "pm_cwd", "pm_out_log_path", "pm_err_log_path",
                                          "pm_pid_path", "status", "unique_id", "namespace", "versioning"):
            del env[k]
    try:
        proc = subprocess.run(cmd_str, capture_output=True, text=True, timeout=timeout, env=env, shell=True)
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
# === GMGN Health ===
GMGN_MAX_STRIKES = 3      # alert after N consecutive failures
_gmgn_strikes    = 0      # consecutive failure counter
_gmgn_dead       = False  # already alerted, don't spam


def fetch_filtered_candidates() -> list[dict]:
    """Fetch tokens yg sudah lolos SEMUA filter — dengan health monitor."""
    global _gmgn_strikes, _gmgn_dead
    args = [
        "market", "trenches",
        "--chain", "sol",
        "--type", "completed",
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
        "--min-total-fee",         str(MIN_TOTAL_FEE),
    ]
    if LAUNCHPAD:
        args += ["--launchpad-platform", LAUNCHPAD]
    data = run_gmgn(args)
    if data is None:
        _gmgn_strikes += 1
        if _gmgn_strikes >= GMGN_MAX_STRIKES and not _gmgn_dead:
            _gmgn_dead = True
            send_telegram(
                f"🔴 URGENT: GMGN gagal {_gmgn_strikes}x berturut-turut! "
                f"Scanner tidak bisa fetch data. Cek API key / status GMGN."
            )
        return []

    # Sukses — reset strike
    if _gmgn_strikes > 0:
        if _gmgn_dead:
            send_telegram(f"✅ GMGN pulih. Scanner kembali normal.")
            _gmgn_dead = False
        _gmgn_strikes = 0

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
    bs = (item.get("burn_status") or "").lower()
    if not bs:
        return True   # field kosong → anggap lolos (GMGN gak selalu populate)
    return bs == "burn"

# ============================================================
# GeckoTerminal OHLC + ATH check
# ============================================================
GT_BASE = "https://api.geckoterminal.com/api/v2"

_gt_last_call = 0.0
_gt_ratelimited = False   # flag: once kena 429, skip semua GT call scan ini

def _gt_rate_limit() -> None:
    """Jaga rate limit GT: ~1 per 2 detik (proxy rotation handles bulk)."""
    global _gt_last_call
    elapsed = time.time() - _gt_last_call
    if elapsed < 2.0:
        time.sleep(2.0 - elapsed)
    _gt_last_call = time.time()

def _gt_get(path: str) -> dict | None:
    """GET GeckoTerminal dengan proxy rotation + rate-limit handling."""
    _gt_rate_limit()
    url = f"{GT_BASE}{path}"
    headers = {"accept": "application/json"}

    # Coba dengan proxy (max 3 per attempt)
    for attempt in range(3):
        proxy = proxy_pool.get_proxy()
        if not proxy:
            break
        try:
            proxies = {"http": proxy, "https": proxy}
            r = requests.get(url, headers=headers, proxies=proxies, timeout=15)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 429:
                proxy_pool.remove_bad(proxy)
                continue
            proxy_pool.remove_bad(proxy)
            continue
        except Exception:
            proxy_pool.remove_bad(proxy)
            continue

    # Proxy habis → fallback ke direct (last resort)
    try:
        r = requests.get(url, headers=headers, timeout=15)
        if r.status_code == 200:
            return r.json()
        if r.status_code == 429:
            global _gt_ratelimited
            _gt_ratelimited = True
            log.warning("GT rate limited (direct), disabling GT for this scan")
    except Exception:
        pass

    return None

def find_top_pool(token_address: str) -> str | None:
    """Cari pool utama untuk token di GeckoTerminal."""
    data = _gt_get(f"/networks/solana/tokens/{token_address}/pools?page=1")
    if not data:
        return None
    pools = data.get("data", [])
    if not pools:
        return None
    return pools[0]["attributes"]["address"]

def fetch_closes(pool: str, tf: str, aggregate: int, limit: int) -> list[float]:
    """
    Ambil close price dari OHLC — HANYA candle yang sudah CLOSED.
    tf: 'minute' atau 'hour'
    Returns: list[close] CHRONOLOGICAL (oldest first)
    """
    url = (f"/networks/solana/pools/{pool}/ohlcv/{tf}"
           f"?aggregate={aggregate}&limit={limit}&currency=usd&token=base")
    data = _gt_get(url)
    if not data:
        return []
    ohlcv = data.get("data", {}).get("attributes", {}).get("ohlcv_list", [])
    ohlcv.reverse()  # GT returns newest first → chronological

    # Drop candle yang masih berjalan (forming candle)
    # GT timestamp = start of bucket, candle closed saat now >= timestamp + period
    now = time.time()
    period_sec = aggregate * (3600 if tf == "hour" else 60)
    ohlcv = [c for c in ohlcv if c[0] + period_sec <= now]

    return [c[4] for c in ohlcv]

def aggregate_closes(closes_1m: list[float], n: int) -> list[float]:
    """Buat TF N-menit dari 1m closes (ambil close terakhir tiap grup)."""
    result = []
    for i in range(n - 1, len(closes_1m), n):
        result.append(closes_1m[i])
    return result

def is_ath(closes: list[float]) -> bool:
    """Apakah close terbaru ≥ semua close sebelumnya?"""
    if len(closes) < 2:
        return False
    return closes[-1] >= max(closes[:-1])

def check_ath_3tf(token_address: str, sym: str) -> tuple[bool, str]:
    """
    Cek ATH triple-TF untuk sebuah token.
    Returns: (lolos: bool, status_string: str)
    """
    if not ENABLE_ATH_CHECK:
        return True, "disabled"

    pool = find_top_pool(token_address)
    if not pool:
        return False, "no GT pool"

    # Fetch 3 TF
    closes_15m = fetch_closes(pool, "minute", 15, ATH_CANDLE_LIMIT)
    closes_1m  = fetch_closes(pool, "minute", 1, ATH_CANDLE_LIMIT)
    closes_1h  = fetch_closes(pool, "hour", 1, ATH_CANDLE_LIMIT)

    # Aggregate 30m dari 1m
    closes_30m = aggregate_closes(closes_1m, 30)

    ok_15m = is_ath(closes_15m)
    ok_30m = is_ath(closes_30m) if closes_30m else False
    ok_1h  = is_ath(closes_1h)

    status = (f"15m={'✅' if ok_15m else '❌'}({len(closes_15m)}) "
              f"30m={'✅' if ok_30m else '❌'}({len(closes_30m)}) "
              f"1h={'✅' if ok_1h else '❌'}({len(closes_1h)})")

    return (ok_15m and ok_30m and ok_1h), status
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
    fee  = _f(item.get("total_fee"))
    holders = int(item.get("holder_count") or 0)
    created = int(item.get("created_timestamp") or item.get("open_timestamp") or 0)
    age_h = (time.time() - created) / 3600 if created else 0
    smart = int(item.get("smart_degen_count") or 0)
    rug   = _f(item.get("rug_ratio"))

    burn_status = (item.get("burn_status") or "").lower()
    lp_label = "✅ Burnt" if burn_status == "burn" else ("⚠️ Unknown" if not burn_status else f"❌ {burn_status}")

    launchpad = item.get("launchpad") or item.get("launchpad_platform") or item.get("exchange") or "?"

    return (
        f"🟢 LOLOS FILTER — {sym}\n"
        f"Name: {name}\n"
        f"MC: ${mc:,.0f}  |  Vol 24h: ${vol:,.0f}\n"
        f"Total Fee: ${fee:,.0f}  |  Age: {age_h:.1f}h\n"
        f"Liquidity: ${liq:,.0f}  |  Holders: {holders:,}\n"
        f"Smart Money: {smart}  |  Launchpad: {launchpad}\n\n"
        f"ATH 3-TF: ✅ CONFIRMED (close=max di 15m+30m+1h)\n\n"
        f"Security:\n"
        f"• Top10: {_pct(item.get('top_10_holder_rate')):.1f}%\n"
        f"• Insider (suspected): {_pct(item.get('suspected_insider_hold_rate')):.1f}%\n"
        f"• Dev: {_pct(item.get('creator_balance_rate')):.1f}%\n"
        f"• Phishing: {_pct(item.get('entrapment_ratio')):.1f}%\n"
        f"• Bundling: {_pct(item.get('bundler_trader_amount_rate')):.1f}%\n"
        f"• LP Burnt: {lp_label}\n"
        f"• Rug Ratio: {rug:.2f}\n\n"
        f"CA: {addr}\n"
        f"https://gmgn.ai/sol/token/{addr} | "
        f"https://dexscreener.com/solana/{addr}"
    )

def send_heartbeat(scans: int, notified: int, total_lifetime: int, uptime_h: float) -> None:
    """Bukti bot masih hidup. Kirim tiap HEARTBEAT_HOURS jam."""
    msg = (
        f"💚 Scanner alive\n"
        f"Uptime: {uptime_h:.1f}h\n"
        f"Scans {HEARTBEAT_HOURS:.0f}h terakhir: {scans}\n"
        f"Notif baru {HEARTBEAT_HOURS:.0f}h terakhir: {notified}\n"
        f"Total notif (all time): {total_lifetime}\n"
        f"Next heartbeat: ~{HEARTBEAT_HOURS:.0f}h lagi"
    )
    send_telegram(msg)

def send_startup() -> None:
    """Notif sekali saat bot start/restart."""
    launchpad_line = f"• Launchpad: {LAUNCHPAD}\n" if LAUNCHPAD else "• Launchpad: ALL DEXs (Pump.fun + Meteora + Raydium + ...)\n"
    msg = (
        f"🚀 Scanner v4 (all-DEX) started\n"
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
        f"• Fee ≥ ${MIN_TOTAL_FEE} (aktivitas on-chain)\n"
        f"• LP burnt: wajib (skip jika unknown)\n"
        f"• ATH 3-TF: close = max di 15m/30m/1h (max {ATH_CANDLE_LIMIT} candle)\n"
        f"{launchpad_line}"
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

    # Skip trending test — kadang gagal di PM2 tapi trenches works fine
    log.info("✅ gmgn-cli found, skip preflight trending test")
    log.info(f"   GMGN_API_KEY loaded: {'YES' if os.getenv('GMGN_API_KEY') else 'NO'}")

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
        log.info("Scan: 0 kandidat lolos filter server-side.")
        return 0
    log.info(f"Scan: {len(candidates)} kandidat, proses SEMUA untuk ATH check")
    passed = 0
    ath_checked = 0

    # Hindari clash rate-limit dengan exit bot (panggil GT di :25 dan :55)
    sec_now = datetime.now().second
    if sec_now < 25 or (sec_now >= 40 and sec_now < 55):
        time.sleep(2)  # tunggu exit bot selesai

    for idx, item in enumerate(candidates):
        addr = item.get("address")
        if not addr:
            continue

        # Dedup time-based: skip kalau terakhir dinotif < RE_NOTIFY_HOURS jam lalu
        if addr in state:
            last = state[addr].get("notified_at", "")
            if last:
                try:
                    last_dt = datetime.fromisoformat(last)
                    age_h = (datetime.now(timezone.utc) - last_dt).total_seconds() / 3600
                    if age_h < RE_NOTIFY_HOURS:
                        continue  # masih fresh, skip
                except ValueError:
                    pass  # timestamp corrupt → reprocess

        sym = item.get("symbol") or addr[:8]

        # Client-side: LP burnt
        if REQUIRE_LP_BURNT and not lp_is_burnt(item):
            log.info(f"  ❌ {sym}: LP belum burnt (burn_status={item.get('burn_status')})")
            continue
        # ATH 3-TF check — semua token diproses, gak ada batasan
        ath_checked += 1
        ath_ok, ath_status = check_ath_3tf(addr, sym)
        if not ath_ok:
            log.info(f"  ❌ {sym}: ATH check failed [{ath_status}]")
            continue
        log.info(f"  ✅ {sym}: ATH confirmed [{ath_status}]")

        # SEMUA filter lolos (termasuk ATH)
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
    launchpad_info = f" | Launchpad={LAUNCHPAD}" if LAUNCHPAD else " | Launchpad=ALL (Pump.fun + Meteora + Raydium + ...)"
    log.info("=== DLMM Scanner v4 (all-DEX) ===")
    log.info(f"Filter: MC≥${MIN_MARKET_CAP:,} | Vol≥${MIN_VOLUME_24H:,} | Age≥{MIN_AGE} | "
             f"Top10≤{MAX_TOP_HOLDER_RATE*100:.0f}% | Insider≤{MAX_INSIDER_RATIO*100:.0f}% | "
             f"Dev≤{MAX_CREATOR_BAL_RATE*100:.0f}% | Phishing≤{MAX_ENTRAPMENT_RATIO*100:.0f}% | "
             f"Bundling≤{MAX_BUNDLER_RATE*100:.0f}% | RugRatio≤{MAX_RUG_RATIO*100:.0f}% | "
             f"Fee≥${MIN_TOTAL_FEE}"
             f"{launchpad_info}")
    log.info(f"Client-side: LP burnt={REQUIRE_LP_BURNT} | ATH 3-TF={ENABLE_ATH_CHECK}")

    if not preflight():
        return

    # Init proxy pool, tunggu minimal 10 proxy siap
    log.info("Proxy pool: initializing…")
    proxy_pool.set_notify(send_telegram)  # Telegram notifications for proxy status
    for _ in range(60):
        if proxy_pool.pool_size() >= 10:
            break
        time.sleep(1)
    log.info(f"Proxy pool: {proxy_pool.pool_size()} proxies ready")

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
            send_telegram("🛑 Scanner stopped (manual)")
            break
        except Exception as e:
            log.exception(f"Error: {e}")
        time.sleep(SCAN_INTERVAL_SEC)

if __name__ == "__main__":
    main()

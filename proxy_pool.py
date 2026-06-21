"""
Proxy pool from static list with SOCKS4/5 + HTTP support.
Tests all proxies at startup using thread pool, keeps working ones.
"""
from urllib.parse import urlparse
from collections.abc import Callable
import requests
import threading
import time
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

log = logging.getLogger(__name__)

PROXY_LIST_FILE = Path(__file__).parent / "proxy_list.txt"
MIN_POOL_SIZE = 5
PROXY_TEST_TIMEOUT = 2
GT_TEST_URL = "https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price/So11111111111111111111111111111111111111112"
REFRESH_COOLDOWN = 300
MAX_WORKERS = 30  # test 30 proxies concurrently
WARN_THRESHOLD = 10  # notify when pool drops to this

_pool: list[str] = []
_lock = threading.Lock()
_idx = 0
_last_refresh = 0.0
_refreshing = False
_notify_cb = None
_warned = False  # avoid repeated warnings
_last_known = 0


def set_notify(cb: Callable[[str], None]) -> None:
    """Register a callback for Telegram notifications."""
    global _notify_cb
    _notify_cb = cb


def pool_size() -> int:
    with _lock:
        return len(_pool)


def get_proxy() -> str | None:
    global _idx
    with _lock:
        if not _pool:
            return None
        p = _pool[_idx % len(_pool)]
        _idx = (_idx + 1) % len(_pool)
        return p


def remove_bad(proxy: str) -> None:
    global _refreshing, _warned
    with _lock:
        if proxy in _pool:
            _pool.remove(proxy)
            n = len(_pool)
            log.info(f"proxy_pool: removed bad proxy ({n} left)")
        else:
            n = len(_pool)
    # Notify user when pool drops to warning threshold
    if n <= WARN_THRESHOLD and not _warned and n > 0:
        _warned = True
        if _notify_cb:
            _notify_cb(f"⚠️ Proxy pool: hanya {n} proxy tersisa! "
                       f"Auto-refresh akan trigger saat < {MIN_POOL_SIZE}.")
    # Auto-refresh jika pool di bawah threshold
    if n < MIN_POOL_SIZE and not _refreshing:
        log.info(f"proxy_pool: pool low ({n}), triggering background refresh…")
        _refreshing = True
        threading.Thread(target=_bg_refresh, daemon=True).start()


def _bg_refresh() -> None:
    """Refresh in background, called by remove_bad when pool is low."""
    global _refreshing
    try:
        # Bypass cooldown for emergency refresh
        global _last_refresh
        _last_refresh = 0
        refresh()
    except Exception as e:
        log.warning(f"proxy_pool: bg refresh failed: {e}")
    finally:
        _refreshing = False


def _test_one(proxy: str) -> tuple[str, bool]:
    try:
        r = requests.get(
            GT_TEST_URL,
            proxies={"http": proxy, "https": proxy},
            timeout=PROXY_TEST_TIMEOUT,
        )
        return proxy, r.status_code == 200
    except Exception:
        return proxy, False


def _load_static() -> list[str]:
    if not PROXY_LIST_FILE.exists():
        return []
    proxies = []
    for line in PROXY_LIST_FILE.read_text().splitlines():
        line = line.strip()
        if line and "://" in line:
            proxies.append(line)
    return proxies


def refresh() -> int:
    global _last_refresh
    now = time.time()
    if now - _last_refresh < REFRESH_COOLDOWN:
        return len(_pool)
    _last_refresh = now

    all_proxies = _load_static()
    log.info(f"proxy_pool: testing {len(all_proxies)} proxies (parallel, {MAX_WORKERS} workers)…")

    working = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(_test_one, p): p for p in all_proxies}
        for future in as_completed(futures):
            proxy, ok = future.result()
            if ok:
                working.append(proxy)
                if len(working) % 20 == 0:
                    log.info(f"proxy_pool: {len(working)} working so far…")

    with _lock:
        _pool.clear()
        _pool.extend(working)

    # Reset warning flag when pool recovers above threshold
    if len(working) > WARN_THRESHOLD:
        global _warned
        _warned = False
        if _notify_cb:
            _notify_cb(f"✅ Proxy pool pulih: {len(working)} proxy aktif")

    log.info(f"proxy_pool: {len(working)}/{len(all_proxies)} working (pool={len(_pool)})")
    return len(working)


# Init in background
def _auto_init():
    try:
        refresh()
    except Exception as e:
        log.warning(f"proxy_pool: auto-init failed: {e}")

threading.Thread(target=_auto_init, daemon=True).start()

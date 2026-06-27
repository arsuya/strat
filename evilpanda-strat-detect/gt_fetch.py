#!/home/ubuntu/evilpanda-strat-detect/.venv/bin/python3
"""GT fetch via proxy pool — dipanggil exit bot via subprocess."""
import sys, json, time, requests
from proxy_pool import get_proxy, remove_bad, pool_size

url = sys.argv[1]
timeout = int(sys.argv[2]) if len(sys.argv) > 2 else 5  # proxies fast, 5s plenty

# Wait for proxy pool to initialise (fresh process, ~10s to test 100 proxies)
for _ in range(60):  # max 60s wait
    if pool_size() > 0:
        break
    time.sleep(0.5)

# Try 3 proxies
for attempt in range(3):
    proxy = get_proxy()
    if not proxy:
        break
    try:
        proxies = {"http": proxy, "https": proxy}
        r = requests.get(url, headers={"accept": "application/json"}, proxies=proxies, timeout=timeout)
        if r.status_code == 200:
            print(r.text)
            sys.exit(0)
        if r.status_code == 429:
            remove_bad(proxy)
            continue
        remove_bad(proxy)
    except Exception:
        remove_bad(proxy)
        continue

# Fallback direct
try:
    r = requests.get(url, headers={"accept": "application/json"}, timeout=timeout)
    print(r.text)
    sys.exit(0)
except Exception as e:
    print(f"ERROR:{e}", file=sys.stderr)
    sys.exit(1)

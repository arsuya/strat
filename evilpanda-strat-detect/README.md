# DLMM Pump.fun Scanner v3 (final)

Filter coin Solana pump.fun pakai GMGN Agent API resmi → notif Telegram.

## Filter yang aktif

| Kriteria | Threshold | API field | Tipe |
|---|---|---|---|
| Market Cap | ≥ $250,000 | `--min-marketcap` | Server-side |
| Volume 24h | ≥ $1,000,000 | `--min-volume-24h` | Server-side |
| Age | ≥ 6 jam | `--min-created` | Server-side |
| Source | Pump.fun (completed) | `--launchpad-platform` | Server-side |
| Top 10 holders | ≤ 30% | `--max-top-holder-rate` | Server-side |
| Insider | = 0% | `--max-insider-ratio` | Server-side |
| Dev | ≤ 1% | `--max-creator-balance-rate` | Server-side |
| Phishing | ≤ 30% | `--max-entrapment-ratio` | Server-side |
| Bundling | ≤ 60% | `--max-bundler-rate` | Server-side |
| Potensi rug | ≤ 1% | `--max-rug-ratio` | Server-side |
| LP Burnt | wajib `burn` | `burn_status` field | Client-side |

**1 API call = semua filter applied.** Sangat efisien.

---

## Setup di VPS (untuk Hermes agent)

### 1. Prerequisites

```bash
node --version      # harus v18+
python3 --version   # harus 3.10+
```

Install `gmgn-cli`:
```bash
npm install -g gmgn-cli
gmgn-cli --version
```

### 2. Disable IPv6 (WAJIB)

GMGN cuma support IPv4. Banyak VPS provider enable IPv6 default.

```bash
# Cek dulu
curl ip.me                  # harus IPv4
curl ipv6.icanhazip.com     # kalau ini return IPv6 → DISABLE

# Disable IPv6
sudo sysctl -w net.ipv6.conf.all.disable_ipv6=1
sudo sysctl -w net.ipv6.conf.default.disable_ipv6=1

# Permanen (edit /etc/sysctl.conf, tambahkan baris di atas tanpa "sudo sysctl -w")
```

### 3. Generate API key

Di VPS:
```bash
openssl genpkey -algorithm ed25519 -out ~/gmgn_private.pem
openssl pkey -in ~/gmgn_private.pem -pubout
```

Copy **public key** (output kedua) → buka https://gmgn.ai/ai → paste → create API Key.

**(Recommended) Whitelist IP VPS** di GMGN dashboard untuk security tambahan.

Save API key:
```bash
mkdir -p ~/.config/gmgn
echo 'GMGN_API_KEY=gmgn_xxx_your_actual_key' > ~/.config/gmgn/.env
chmod 600 ~/.config/gmgn/.env

# Test
gmgn-cli market trending --chain sol --interval 1h --limit 3
```

Kalau JSON keluar = CLI berfungsi.

### 4. Setup project

```bash
# Upload folder ini ke VPS
cd dlmm-scanner-v3

pip install -r requirements.txt

cp .env.example .env
nano .env
# Isi:
#   TELEGRAM_BOT_TOKEN=...
#   TELEGRAM_CHAT_ID=...
```

### 5. Bikin Telegram bot

1. Chat `@BotFather` di Telegram → `/newbot` → ikuti instruksi → catat bot token
2. Chat `@userinfobot` → catat chat ID
3. **Kirim `/start` ke bot kamu** (wajib, bot ga bisa initiate chat)

Test:
```bash
python test_telegram.py
```

### 6. Jalanin

```bash
python scanner.py
```

---

## Run 24/7 dengan systemd

```bash
sudo nano /etc/systemd/system/dlmm-scanner.service
```

Isi:
```ini
[Unit]
Description=DLMM Pump.fun Scanner
After=network.target

[Service]
Type=simple
User=YOUR_VPS_USER
WorkingDirectory=/home/YOUR_VPS_USER/dlmm-scanner-v3
ExecStart=/usr/bin/python3 /home/YOUR_VPS_USER/dlmm-scanner-v3/scanner.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable:
```bash
sudo systemctl daemon-reload
sudo systemctl enable dlmm-scanner
sudo systemctl start dlmm-scanner

# Cek logs
sudo journalctl -u dlmm-scanner -f
```

---

## Tweak threshold

Edit konstanta di atas `scanner.py`:

```python
MIN_MARKET_CAP        = 250_000
MIN_VOLUME_24H        = 1_000_000
MIN_AGE               = "6h"
MAX_TOP_HOLDER_RATE   = 0.30
MAX_INSIDER_RATIO     = 0.00
MAX_CREATOR_BAL_RATE  = 0.01
MAX_ENTRAPMENT_RATIO  = 0.30
MAX_BUNDLER_RATE      = 0.60
MAX_RUG_RATIO         = 0.01
REQUIRE_LP_BURNT      = True
```

Restart service:
```bash
sudo systemctl restart dlmm-scanner
```

---

## Troubleshooting

| Problem | Solusi |
|---|---|
| `gmgn-cli: command not found` | `npm install -g gmgn-cli` belum jalan, atau npm global path tidak di PATH. Cek `which gmgn-cli` |
| 401 / 403 dari gmgn-cli | IPv6 issue. Disable IPv6 (step 2 di atas) |
| 429 rate limit | Tunggu cooldown 5 menit. **JANGAN spam retry** — bisa extend ban |
| Tidak ada coin lolos seharian | Filter kamu ketat (Insider=0%, RugRatio≤1%). Wajar kalau sehari cuma 0-2 token lolos. Verify dengan longgarkan threshold sementara |
| Output field None / 0 | Mungkin GMGN ubah nama field. Print `json.dumps(item, indent=2)` di `fetch_filtered_candidates` untuk lihat raw response |

---

## Validasi mapping setelah deploy

Sebelum biarkan jalan 24/7:

1. Pilih 1 token yang kamu tahu **HARUSNYA LOLOS** (cek GMGN UI manual)
2. Pilih 1 token yang kamu tahu **HARUSNYA DITOLAK** (misal Top10 > 30%)
3. Run `python scanner.py` sekali
4. Bandingkan keputusan bot vs ekspektasi
5. Kalau cocok → mapping benar, deploy ke systemd
6. Kalau mismatch → screenshot UI + log bot, debug bareng

---

## Catatan untuk Hermes agent

- Self-contained, satu file `scanner.py`
- Python deps: cuma `requests` + `python-dotenv`
- Butuh `gmgn-cli` global (Node.js based)
- Config: `~/.config/gmgn/.env` (GMGN key) + project `.env` (Telegram)
- IPv4 only — disable IPv6 di VPS
- Idle resource: <100 MB RAM, near-0 CPU between scans

---

## Disclaimer

Screening tool only. Tidak ada jaminan akurasi. Selalu DYOR manual sebelum entry. Author tidak bertanggung jawab atas loss apapun.

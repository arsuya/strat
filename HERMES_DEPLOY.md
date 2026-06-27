# HERMES DEPLOY — Strat Trading Bot Suite

Instruksi untuk Hermes agent: install dan jalanin 3 bot di VPS Linux.

---

## 0. Ringkasan & temuan review

3 bot di repo ini:

| Bot | Stack | Fungsi | Wajib? |
|---|---|---|---|
| `evilpanda-strat-detect` | Python | Scanner DEX + proxy pool + GMGN alert | **WAJIB pertama** |
| `strat_exit` | TypeScript | Auto-close Meteora DLMM + control Telegram | **WAJIB kedua** |
| `solana-tg-bot` | Python | Bot trading sinyal RSI/BB/MACD standalone | Opsional |

### Temuan penting dari review kode (HARUS dipahami sebelum deploy)

1. **Hard dependency `strat_exit` → `evilpanda-strat-detect`**
   `strat_exit/src/ohlc-feed.ts` line 25 hardcode path:
   ```ts
   const GT_PROXY = "/home/ubuntu/evilpanda-strat-detect/gt_fetch.py";
   ```
   Artinya: `evilpanda-strat-detect` HARUS diinstall di `/home/ubuntu/evilpanda-strat-detect/` SEBELUM `strat_exit` bisa jalan. User Linux harus bernama `ubuntu`. Jangan diubah pathnya kecuali kamu juga edit konstanta ini di TypeScript.

2. **Shebang hardcoded** di `gt_fetch.py`:
   ```
   #!/home/ubuntu/evilpanda-strat-detect/.venv/bin/python3
   ```
   Konsekuensi: venv harus dibuat di path persis tersebut.

3. **Credentials terekspos di kode** — WAJIB pindahkan ke `.env`:
   - `evilpanda-strat-detect/ecosystem.config.js` → `GMGN_API_KEY` hardcoded
   - `evilpanda-strat-detect/run.sh` → `GMGN_API_KEY` hardcoded
   - `solana-tg-bot/config.py` → `WALLET_PRIVATE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` hardcoded
   
   **Jika repo ini sudah pernah di-push public**, anggap semua key tersebut sudah bocor. Rotate semua sebelum deploy.

4. **Konflik proxy pool** — kedua bot (`evilpanda` scanner + `strat_exit` exit) pakai proxy pool yang sama (`proxy_list.txt`) untuk hit GeckoTerminal. Scanner sudah punya clash avoidance built-in (sleep 2s di detik :25 dan :55). Tidak perlu diubah.

5. **`watchdog.py` di evilpanda incomplete** — file terpotong, cuma load env dan exit. Tidak ada logic actual check systemctl. **Skip file ini, jangan jadwalkan via cron.**

6. **`proxy_list.txt` dan `proxy_list_premium.txt` identik** — hanya satu yang dipakai (`proxy_list.txt`). Yang `_premium` tidak direferensikan kode manapun. Boleh diabaikan/hapus.

7. **`solana-tg-bot` WATCHLIST default kosong** — kalau dijalankan apa adanya, bot tidak akan monitor token apa pun. Tambahkan mint address ke `WATCHLIST` di `config.py` sebelum start, atau skip bot ini.

---

## 1. Prerequisites

VPS minimal: Ubuntu 22.04+, 2 GB RAM, IPv4 (penting — IPv6 harus disable untuk GMGN).

```bash
# Cek user
whoami        # WAJIB: ubuntu (kalau bukan, baca catatan di Section 0 nomor 1)

# Update + install tools dasar
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git python3 python3-pip python3-venv build-essential

# Node.js 20 (untuk gmgn-cli + strat_exit)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v       # harus v20.x
npm -v

# PM2 global (untuk run kedua bot)
sudo npm install -g pm2

# gmgn-cli global (untuk evilpanda scanner)
sudo npm install -g gmgn-cli
gmgn-cli --version
```

### Disable IPv6 (WAJIB untuk GMGN)

```bash
curl ipv6.icanhazip.com 2>/dev/null && echo "→ IPv6 AKTIF, harus disable" || echo "→ IPv6 sudah off"

# Disable
sudo sysctl -w net.ipv6.conf.all.disable_ipv6=1
sudo sysctl -w net.ipv6.conf.default.disable_ipv6=1

# Permanen
echo "net.ipv6.conf.all.disable_ipv6=1" | sudo tee -a /etc/sysctl.conf
echo "net.ipv6.conf.default.disable_ipv6=1" | sudo tee -a /etc/sysctl.conf
sudo sysctl -p

# Verify
curl ip.me                # harus IPv4
```

---

## 2. Generate kredensial yang dibutuhkan

Siapkan dulu sebelum mulai install. Simpan di password manager atau notes lokal.

### 2.1 GMGN API key (untuk evilpanda)

```bash
mkdir -p ~/.config/gmgn
openssl genpkey -algorithm ed25519 -out ~/gmgn_private.pem
openssl pkey -in ~/gmgn_private.pem -pubout
```

Copy output **public key** → buka https://gmgn.ai/ai → paste → create API key.
Recommended: whitelist IP VPS di dashboard GMGN.

Simpan API key untuk Step 3.2.

### 2.2 Telegram Bot

1. Chat `@BotFather` → `/newbot` → ikuti instruksi → catat **bot token**
2. Chat `@userinfobot` → catat **chat ID** (numeric)
3. **Kirim `/start` ke bot** kamu sendiri (wajib, bot tidak bisa initiate chat)

> Tip: Pakai 1 bot Telegram saja untuk semua, dengan chat_id sama. Notifikasi dari ketiga bot bakal jadi satu thread. Atau bikin bot terpisah kalau mau dipisah.

### 2.3 Solana RPC (untuk strat_exit)

Bikin akun di Helius / QuickNode / Triton. Free tier sudah cukup. Catat URL RPC mainnet.

### 2.4 Wallet Solana (HANYA jika strat_exit live mode)

Pakai wallet KHUSUS bot dengan saldo terbatas. Export private key dalam format:
- Base58 string, **atau**
- JSON byte array `[1,2,3,...]`

**JANGAN pakai wallet utama.** Jika cuma mau monitor (tidak auto-close), bisa pakai mode `MONITOR_ONLY_PUBKEY` (lihat Section 4.2).

---

## 3. Install `evilpanda-strat-detect` (PERTAMA — wajib)

### 3.1 Clone & venv

```bash
cd /home/ubuntu
# Asumsi repo sudah di-clone ke /home/ubuntu/strat
# Kalau belum:
#   git clone <repo-url> /home/ubuntu/strat

# Path WAJIB persis ini (lihat Section 0 nomor 1)
cp -r /home/ubuntu/strat/evilpanda-strat-detect /home/ubuntu/evilpanda-strat-detect
cd /home/ubuntu/evilpanda-strat-detect

# Buat venv di path yang persis sesuai shebang gt_fetch.py
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

# Bikin folder logs (referensi ecosystem.config.js)
mkdir -p logs
```

### 3.2 Configure GMGN

```bash
# GMGN config dir
mkdir -p ~/.config/gmgn
cat > ~/.config/gmgn/.env << 'EOF'
GMGN_API_KEY=gmgn_GANTI_DENGAN_KEY_DARI_STEP_2_1
EOF
chmod 600 ~/.config/gmgn/.env

# Test
gmgn-cli market trending --chain sol --interval 1h --limit 3
# Harus print JSON. Kalau error 401/403: cek IPv6 (Section 1)
```

### 3.3 Configure Telegram + scanner `.env`

Repo tidak menyertakan `.env.example`, jadi bikin manual:

```bash
cd /home/ubuntu/evilpanda-strat-detect
cat > .env << 'EOF'
TELEGRAM_BOT_TOKEN=GANTI_BOT_TOKEN_DARI_STEP_2_2
TELEGRAM_CHAT_ID=GANTI_CHAT_ID_DARI_STEP_2_2
SCAN_INTERVAL_SEC=60
HEARTBEAT_HOURS=6
EOF
chmod 600 .env

# Test Telegram
python test_telegram.py
# Cek HP kamu, harus dapat "DLMM Scanner v2 — test berhasil!"
```

### 3.4 Bersihin hardcoded secret di ecosystem.config.js + run.sh

Edit `/home/ubuntu/evilpanda-strat-detect/ecosystem.config.js`, ganti baris:
```js
GMGN_API_KEY: 'gmgn_28156921d7fc65f4eeb2824f4f525e8e',
```
jadi:
```js
GMGN_API_KEY: process.env.GMGN_API_KEY,
```

Edit `/home/ubuntu/evilpanda-strat-detect/run.sh`, hapus baris:
```bash
export GMGN_API_KEY="gmgn_28156921d7fc65f4eeb2824f4f525e8e"
```
Ganti dengan source dari `~/.config/gmgn/.env`:
```bash
source ~/.config/gmgn/.env
export GMGN_API_KEY
```

### 3.5 Test manual sebelum PM2

```bash
cd /home/ubuntu/evilpanda-strat-detect
source ~/.config/gmgn/.env
export GMGN_API_KEY
.venv/bin/python scanner.py
# Tunggu 1-2 menit, lihat log:
#  - "Proxy pool: N proxies ready"
#  - "trenches pre-filtered: ..."
#  - Telegram dapat notif "Scanner v4 (all-DEX) started"
# Ctrl+C untuk stop
```

### 3.6 Jalankan via PM2

```bash
cd /home/ubuntu/evilpanda-strat-detect
pm2 start ecosystem.config.js
pm2 logs dlmm-scanner --lines 50    # cek tidak ada error
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu
# jalanin command yang di-print PM2
```

---

## 4. Install `strat_exit` (KEDUA)

### 4.1 Setup project

```bash
cd /home/ubuntu/strat/strat_exit
# Atau pindahin ke lokasi lain — strat_exit TIDAK punya path requirement seperti evilpanda
# Contoh:
# cp -r /home/ubuntu/strat/strat_exit /home/ubuntu/strat_exit
# cd /home/ubuntu/strat_exit

npm install
mkdir -p logs
```

### 4.2 Buat `.env`

Repo tidak punya `.env.example`. Bikin manual:

```bash
cat > .env << 'EOF'
# === MODE ===
# DRY_RUN=true → monitor + notif only, tidak eksekusi close+swap (untuk test)
# DRY_RUN=false → live, eksekusi beneran
DRY_RUN=true

# === SOLANA ===
RPC_URL=https://mainnet.helius-rpc.com/?api-key=GANTI_KEY_KAMU

# Pakai SALAH SATU:
#  (A) Live mode: kasih private key (base58 atau JSON array)
WALLET_PRIVATE_KEY=GANTI_PRIVATE_KEY_BASE58
#  (B) Monitor-only: kasih pubkey saja (tanpa private key) — bot cuma monitor
# MONITOR_ONLY_PUBKEY=GANTI_PUBKEY

# Filter pool (opsional, comma-separated). Kosongkan = monitor SEMUA posisi DLMM
# POOL_FILTER=PoolAddr1,PoolAddr2

# === JUPITER ===
# Kosongkan untuk pakai lite-api (free)
JUPITER_API_KEY=

# === TELEGRAM ===
TELEGRAM_BOT_TOKEN=GANTI_BOT_TOKEN
TELEGRAM_CHAT_ID=GANTI_CHAT_ID

# === STRATEGY ===
RSI_LENGTH=2
RSI_THRESHOLD=90
BB_LENGTH=20
BB_MULT=2
MACD_FAST=12
MACD_SLOW=26
MACD_SIGNAL=9
POLL_INTERVAL_SECONDS=60
SLIPPAGE_BPS=100
SWAP_SLIPPAGE_BPS=100
EOF
chmod 600 .env
```

> **Catatan keamanan**: kalau cuma mau pengamatan dulu, set `MONITOR_ONLY_PUBKEY` saja tanpa `WALLET_PRIVATE_KEY`. Bot akan ke mode monitor-only — close+swap auto-skip.

### 4.3 Build & test

```bash
npm run build
# Test dry-run dulu
DRY_RUN=true npm start
# Cek:
#  - Log "Meteora Exit Bot starting"
#  - Telegram: "🚀 Meteora Exit Bot online"
#  - Kirim /status di Telegram → harus respon
#  - Kirim /positions di Telegram → harus list posisi (atau "No active DLMM positions.")
# Ctrl+C untuk stop
```

> Jika `/positions` error "GT fetch failed" — cek dulu `evilpanda-strat-detect/gt_fetch.py` exists di `/home/ubuntu/evilpanda-strat-detect/` dan venv-nya jalan.

### 4.4 PM2 (production)

Setelah dry-run OK, edit `.env` → `DRY_RUN=false` (kalau memang mau live). Lalu:

```bash
pm2 start ecosystem.config.js
pm2 logs meteora-exit-bot --lines 50
pm2 save
```

PM2 startup sudah di-setup di Step 3.6, tidak perlu ulang.

---

## 5. (Opsional) Install `solana-tg-bot`

Bot ini standalone, tidak terikat dua bot lain. Bisa di-skip.

> **PERINGATAN**: `config.py` di repo punya `WALLET_PRIVATE_KEY` dan `TELEGRAM_BOT_TOKEN` hardcoded di source code. **Anggap key tersebut bocor jika repo public** — rotate dulu sebelum dipakai produksi.

### 5.1 Setup

```bash
cd /home/ubuntu/strat/solana-tg-bot
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

### 5.2 Ubah `config.py` jadi pakai env (rekomendasi)

```bash
# Backup dulu
cp config.py config.py.bak
```

Edit `config.py`, ganti baris hardcoded jadi:
```python
import os
WALLET_PRIVATE_KEY = os.getenv("WALLET_PRIVATE_KEY", "")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = int(os.getenv("TELEGRAM_CHAT_ID", "0"))
RPC_URL = os.getenv("RPC_URL", "https://api.mainnet-beta.solana.com")
```

Lalu set `.env` (kalau pakai `python-dotenv`, atau export di shell):
```bash
cat > .env << 'EOF'
WALLET_PRIVATE_KEY=base58_key_kamu
TELEGRAM_BOT_TOKEN=token
TELEGRAM_CHAT_ID=12345
RPC_URL=https://mainnet.helius-rpc.com/?api-key=xxx
EOF
chmod 600 .env
```

### 5.3 Isi WATCHLIST

Di `config.py`, isi `WATCHLIST` dengan mint address yang mau dimonitor. **Default kosong = bot tidak monitor apa-apa.**

```python
WATCHLIST = [
    "So11111111111111111111111111111111111111112",  # contoh: WSOL
    # tambah mint lain...
]
```

### 5.4 Run

```bash
.venv/bin/python main.py
# atau pakai PM2:
pm2 start main.py --name solana-tg-bot --interpreter .venv/bin/python
pm2 save
```

---

## 6. Verifikasi gabungan

Setelah semua bot jalan, cek:

```bash
pm2 status
# Harus muncul (minimal):
#   dlmm-scanner       online
#   meteora-exit-bot   online
#   (solana-tg-bot)    online (kalau install)

pm2 logs --lines 30

# Verifikasi proxy pool sehat
cd /home/ubuntu/evilpanda-strat-detect
source .venv/bin/activate
python health_proxy.py
# Harus dapat notif Telegram "🟢 Proxy Pool OK"
```

### Setup cron untuk health_proxy.py (rekomendasi)

```bash
crontab -e
# Tambah baris (cek tiap 30 menit):
*/30 * * * * cd /home/ubuntu/evilpanda-strat-detect && .venv/bin/python health_proxy.py >> logs/health.log 2>&1
```

> **Jangan** jadwalkan `watchdog.py` — file ini incomplete (lihat Section 0 nomor 5).

---

## 7. Security hardening

```bash
# Permission ketat untuk semua .env
chmod 600 /home/ubuntu/evilpanda-strat-detect/.env
chmod 600 /home/ubuntu/evilpanda-strat-detect/run.sh
chmod 600 ~/.config/gmgn/.env
chmod 600 /home/ubuntu/strat_exit/.env       # sesuaikan path
chmod 600 /home/ubuntu/strat/solana-tg-bot/.env

# Firewall dasar
sudo ufw allow OpenSSH
sudo ufw enable

# Disable password login SSH (pakai key only)
sudo sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl reload ssh

# Unattended upgrade untuk security patch
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

---

## 8. Operasi sehari-hari (cheat sheet)

```bash
# Status
pm2 status
pm2 logs dlmm-scanner --lines 50
pm2 logs meteora-exit-bot --lines 50

# Restart kalau ada update
pm2 restart dlmm-scanner
pm2 restart meteora-exit-bot

# Stop sementara
pm2 stop meteora-exit-bot

# Tail real-time
pm2 logs

# Lihat resource
pm2 monit
```

Kontrol `strat_exit` via Telegram (chat ke bot kamu):

| Command | Fungsi |
|---|---|
| `/status` | Status bot (paused/running, last cycle) |
| `/positions` | List semua posisi DLMM aktif |
| `/pause` | Bot tetap monitor + notif tapi tidak auto-close |
| `/resume` | Aktifkan kembali auto-close |
| `/cycle` | Trigger 1 cycle SEKARANG |
| `/close <posAddr>` | Force-close posisi tertentu di cycle berikutnya |
| `/help` | List command |

---

## 9. Troubleshooting

| Gejala | Cek |
|---|---|
| `gmgn-cli: command not found` | `sudo npm install -g gmgn-cli`; cek `which gmgn-cli` |
| GMGN 401/403 | IPv6 belum disable. Lihat Section 1 |
| GMGN 429 | Rate limit. **Jangan retry** — tunggu 5 menit |
| `strat_exit` log "GT fetch failed" | `evilpanda-strat-detect/gt_fetch.py` tidak ada di `/home/ubuntu/evilpanda-strat-detect/`. Section 0 nomor 1 |
| `strat_exit` log "Permission denied" buat gt_fetch.py | `chmod +x /home/ubuntu/evilpanda-strat-detect/gt_fetch.py` |
| Proxy pool kosong terus | Cek `python health_proxy.py` — proxy mungkin expired |
| Telegram tidak respon command | Cek `TELEGRAM_CHAT_ID` benar (auth via chat_id whitelist) |
| Bot duplikat / dua proses | `pm2 delete <name>` lalu `pm2 start ecosystem.config.js` lagi |
| `removeLiquidity` gagal | Cek versi `@meteora-ag/dlmm` di package.json, mungkin SDK ada breaking change |
| Tidak ada notif scanner seharian | Wajar — filter sangat ketat (Insider=0%, RugRatio≤1%). Longgarkan threshold di `scanner.py` kalau perlu |

---

## 10. Checklist final sebelum live

- [ ] `pm2 status` semua bot `online`
- [ ] Telegram bot respon `/status` dari `strat_exit`
- [ ] Telegram dapat notif `🚀 Scanner v4 (all-DEX) started` dari evilpanda
- [ ] `health_proxy.py` return `🟢 Proxy Pool OK`
- [ ] Tidak ada secret hardcoded di file `.js`, `.sh`, `.py` (Section 0 nomor 3)
- [ ] Semua `.env` permission 600
- [ ] `strat_exit` dijalankan minimal 1 jam dalam `DRY_RUN=true` tanpa error sebelum switch ke live
- [ ] Kalau live: wallet bot punya saldo SOL minimal 0.05 untuk fee tx + ATA rent
- [ ] `pm2 save` + `pm2 startup` sudah dijalankan (auto-resume saat VPS reboot)
- [ ] SSH key-only login, IPv6 disabled, ufw enabled

---

## 11. Disclaimer

Bot ini eksekusi transaksi on-chain pakai dana real. Tidak ada jaminan profit, tidak ada jaminan akurasi sinyal. Selalu test `DRY_RUN=true` minimal beberapa jam dan baca kode `src/index.ts`, `src/meteora.ts`, `src/jupiter-swap.ts` (TypeScript) + `scanner.py` (Python) sampai paham sebelum live. Author tidak bertanggung jawab atas loss apapun.

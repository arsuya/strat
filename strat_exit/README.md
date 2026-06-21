# Meteora Exit Bot

Bot otomatis untuk monitor & **close posisi Meteora DLMM** dengan kontrol via **Telegram**, dijalankan di VPS pakai PM2.

- Auto-discovery semua posisi DLMM di wallet
- OHLC 15m dari GeckoTerminal (no warmup)
- Indikator RSI, BB, MACD dihitung lokal
- Close: Meteora DLMM SDK (`removeLiquidity + claim + close`)
- Sweep: Jupiter Swap V1 → SOL native
- **Telegram**: notif real-time + control 2-arah (/status, /pause, /resume, /close, /cycle)

## Kriteria Exit

Posisi ditutup jika salah satu terpenuhi:

1. **Out of range to the top** — active bin > upper bin
2. **Out of range to the bottom** — active bin < lower bin
3. **RSI(2) > 90 DAN price > BB upper** (bersamaan)
4. **RSI(2) > 90 DAN MACD first green histogram** (bersamaan)

## Arsitektur

```
┌────────────────────────────────────────────────────────────┐
│                  Main loop (every 60s)                     │
│  Discover positions → fetch OHLC → check exit → close+swap │
└────────────────────────────────────────────────────────────┘
          ↕ (shared state + mutex)
┌────────────────────────────────────────────────────────────┐
│                  Telegram bot (telegraf)                   │
│   commands: /status /pause /resume /positions /cycle /close│
│   notif: exit triggered, tx confirmed, errors              │
└────────────────────────────────────────────────────────────┘
```

Satu Node.js process, satu deployment. Bot logic deterministik (RSI/BB/MACD threshold) — tidak butuh LLM di trading loop. Kalau nanti mau natural-language commands, tinggal add LLM call sebagai handler fallback.

## Telegram Commands

| Command | Fungsi |
|---|---|
| `/start` | Show welcome + commands |
| `/status` | Status bot (paused/running, last cycle, position count) |
| `/positions` | List semua posisi aktif (pool, bins, range status) |
| `/pause` | Stop eksekusi close+swap (tetap monitor & notif) |
| `/resume` | Lanjut eksekusi |
| `/cycle` | Trigger 1 cycle SEKARANG (tidak nunggu 60s) |
| `/close <posAddr>` | Force-close posisi tertentu di cycle berikutnya |
| `/help` | List commands |

Auth: hanya `TELEGRAM_CHAT_ID` yang dikonfigurasi yang bisa kirim command. Chat lain di-ignore otomatis — bot tidak bisa dibajak orang random.

## Notifikasi yang Dikirim ke Telegram

- 🚀 Bot online (saat start)
- 🚨 Exit triggered (dengan reasons)
- ⏸ Skipped karena paused
- 🧪 Skipped karena DRY_RUN
- ✅ Posisi closed (dengan Solscan tx link)
- 💱 Swap ke SOL success (Solscan tx link)
- ❌ Close failed / Swap failed / Cycle error (dengan error message)

## Setup

### 1. Bikin Telegram Bot

1. Buka Telegram, chat ke **@BotFather**
2. Kirim `/newbot`, ikuti instruksi, copy HTTP API token
3. Chat ke **@userinfobot** untuk dapat numeric chat ID Anda

### 2. Setup VPS

```bash
# Install Node.js 20 (Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node -v   # should show v20+
npm -v
```

### 3. Deploy bot

```bash
# Clone / upload kode bot ke VPS
cd meteora-exit-bot
npm install

# Setup environment
cp .env.example .env
nano .env   # isi RPC_URL, WALLET_PRIVATE_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

# Compile TypeScript
npm run build
```

### 4. Test dengan DRY_RUN dulu

Di `.env`: `DRY_RUN=true`

```bash
npm run start
```

Cek:
- Telegram terima pesan `🚀 Meteora Exit Bot online`
- Kirim `/status` di Telegram → dapet balasan
- Kirim `/positions` → list posisi aktif
- Tunggu 1-2 cycle, pastikan tidak ada error

### 5. Run via PM2 (persistent + auto-restart)

```bash
npm install -g pm2

# di .env: DRY_RUN=false (kalau sudah yakin)
pm2 start ecosystem.config.js
pm2 save               # simpan list process
pm2 startup            # ikuti instruksi yang muncul untuk auto-start saat reboot

# Monitor
pm2 logs meteora-exit-bot       # tail logs
pm2 monit                        # dashboard CPU/RAM
pm2 status                       # status semua app
```

PM2 akan auto-restart kalau crash, auto-start saat VPS reboot, dan log ke `logs/`.

### 6. Operate via Telegram

Setelah running di VPS, kontrol semua via Telegram:
- Liburan dan mau bot tidak auto-close? `/pause`
- Liat status: `/status`
- Mau tutup posisi tertentu sekarang: `/close <posAddr>` lalu `/cycle`
- Cek posisi: `/positions`

## Struktur File

```
src/
├── index.ts          # Main loop + mutex + lifecycle
├── config.ts         # .env loader
├── state.ts          # Runtime state (paused, manual close queue)
├── telegram.ts       # Telegraf integration (commands + notifier)
├── discovery.ts      # Auto-find DLMM positions
├── ohlc-feed.ts      # GeckoTerminal OHLC fetcher
├── indicators.ts     # RSI, BB, MACD
├── meteora.ts        # DLMM close action
├── jupiter-swap.ts   # Token -> SOL swap
└── logger.ts
ecosystem.config.js   # PM2 process config
.env                  # Secrets (JANGAN commit)
logs/                 # PM2 logs (auto-created)
```

## Keamanan VPS

- File `.env` berisi private key + telegram token. **Set permission 600**: `chmod 600 .env`
- Telegram chat ID whitelist = perlindungan anti-takeover bot
- Pakai wallet khusus bot dengan saldo terbatas
- VPS: gunakan SSH key (bukan password), firewall (ufw), unattended-upgrades untuk security patches
- Backup `.env` di tempat aman terpisah dari VPS

## Troubleshooting

| Masalah | Solusi |
|---|---|
| Telegram tidak respon command | Cek `TELEGRAM_CHAT_ID` benar (kirim ke @userinfobot lagi). Cek `pm2 logs`. |
| `Telegram disabled` di log | `TELEGRAM_BOT_TOKEN` atau `TELEGRAM_CHAT_ID` kosong |
| Bot duplikat / dua proses berjalan | `pm2 delete meteora-exit-bot` lalu `pm2 start ecosystem.config.js` |
| `GeckoTerminal OHLC 404` | Pool baru, belum terindex. Tunggu beberapa jam. |
| `removeLiquidity ... failed` | Cek versi SDK Meteora di package.json |
| Telegram error 401 | Token salah. Bikin baru di @BotFather |
| `Cannot find module 'telegraf'` | Lupa `npm install` setelah pull |

## Integrasi dengan LLM Agent (Opsional, untuk Nanti)

Kalau mau nambah natural language commands (mis. "tutup posisi SOL saya", "kenapa exit semalam?"), pendekatannya:

1. Tambah handler `bot.on("text", ...)` di `telegram.ts` yang routing ke LLM API (OpenRouter/Anthropic)
2. LLM diberi context: list available commands + current state
3. LLM return structured action (mis. `{action: "close", pos: "ABC..."}`)
4. Bot eksekusi via fungsi yang sama dengan `/close`

Trading decision tetap deterministik — LLM cuma jadi UI layer.

## Disclaimer

Bot ini eksekusi transaksi on-chain pakai dana real. Selalu test DRY_RUN dulu, baca kode (`src/index.ts`, `src/meteora.ts`, `src/jupiter-swap.ts`) sampai paham, test dengan modal kecil sebelum production.

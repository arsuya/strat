# Bonus Stage Strat Detector

Notif-only companion untuk **evil panda strat**. Memantau pool Meteora DLMM
yang sedang ada posisi aktif (= pool yang lagi dipakai evil panda strat), lalu
kirim notif Telegram saat indikator **Supertrend(10, 3)** flip dari **HIJAU →
MERAH** pada candle 15m yang sudah closed.

User membuka posisi tambahan secara MANUAL setelah menerima notif. Tidak ada
transaksi on-chain di bot ini.

## Cara Kerja

```
┌──────────────────────────────────────────────────────────────────┐
│                  Main loop (every 60s)                           │
│                                                                  │
│  1. Discover posisi DLMM di wallet (DLMM SDK)                    │
│  2. Group per pool → set "pool yg lagi aktif evil panda"         │
│  3. Fetch OHLC 15m per pool dari GeckoTerminal                   │
│  4. Hitung Supertrend(length=10, factor=3)                       │
│  5. Bandingkan direction sebelumnya vs sekarang:                 │
│       HIJAU → MERAH = transition  →  notif Telegram              │
│  6. Persist state ke state.json                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Logika notifikasi

Per pool, state-nya disimpan: `lastDirection`, `notifiedAt`, `firstSeenAt`.

| Event | Aksi |
|---|---|
| Pool baru pertama kali muncul, supertrend GREEN | Init state, tidak notif |
| Pool baru pertama kali muncul, supertrend RED | Init state, **TIDAK notif** (anggap sudah lewat transition — safe behavior buat kasus restart) |
| Transisi GREEN → RED, belum pernah notif di lifetime ini | **Kirim notif** |
| Transisi GREEN → RED, sudah notif | Skip (kecuali `REPEAT_NOTIFICATIONS=true`) |
| Transisi RED → GREEN | Re-arm — siap notif lagi kalau RED lagi |
| Wallet sudah tidak punya posisi di pool tsb | State di-prune |

Persistence ke `state.json` memastikan PM2 restart di tengah cycle TIDAK
menyebabkan double-notif.

### Exit handling

**Tidak ada.** `strat_exit` sudah handle close per-pool: kalau exit condition
firing di sebuah pool, SEMUA posisi user di pool itu ikut ditutup — termasuk
posisi bonus stage yang ditambahkan manual. Jadi:

- **evil panda strat exit** = `strat_exit` close posisi evil panda
- **bonus stage strat exit** = otomatis ikut close karena di pool yg sama

Setelah pool kosong, state di sini ke-prune, dan kalau wallet masuk lagi ke
pool itu nanti, monitoring dimulai ulang dari awal.

## Setup di VPS

### 1. Prerequisites

- Node.js 20+ (sama seperti strat_exit)
- `evilpanda-strat-detect` sudah ter-deploy di `/home/ubuntu/evilpanda-strat-detect/`
  karena bot ini reuse `gt_fetch.py` untuk proxy GeckoTerminal. Kalau path-nya
  beda, set `GT_PROXY_PATH` di `.env`.
- PM2 (kalau mau jalan persistent)

### 2. Install

```bash
cd /home/ubuntu
# upload folder ini ke VPS

cd bonus-stage-strat-detect
npm install
cp .env.example .env
nano .env   # isi RPC_URL, MONITOR_ONLY_PUBKEY (atau WALLET_PRIVATE_KEY),
            # TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
chmod 600 .env

npm run build
```

### 3. Test dulu

```bash
npm run start
```

Cek:
- Console nampak `=== Bonus Stage Strat Detector starting ===`
- Telegram terima pesan `🚀 Bonus Stage detector online`
- Setiap 60s log nampak daftar pool yg ditemukan + supertrend color-nya
- Tunggu sampai ada transition HIJAU → MERAH → notif `🎯 BONUS STAGE`

### 4. Jalan permanen pakai PM2

```bash
npm install -g pm2   # kalau belum ada

pm2 start ecosystem.config.js
pm2 save
pm2 startup   # ikuti instruksi yg muncul

# monitor
pm2 logs bonus-stage-detect
pm2 status
```

## Konfigurasi

Semua via `.env`. Yang sering diutak-atik:

| Variable | Default | Fungsi |
|---|---|---|
| `SUPERTREND_LENGTH` | `10` | ATR length |
| `SUPERTREND_FACTOR` | `3` | Multiplier band |
| `REPEAT_NOTIFICATIONS` | `false` | `true` = notif tiap transisi (bisa noisy) |
| `POLL_INTERVAL_SECONDS` | `60` | Cek tiap N detik |
| `POOL_FILTER` | (empty) | Whitelist pool address dipisah koma; kosong = semua |
| `STATE_PATH` | `./state.json` | Lokasi file state |

## Reuse .env dari strat_exit

Bot ini sengaja didesain supaya bisa pakai `.env` yang sama dengan
`strat_exit`. Yang dibutuhkan tinggal:

- `RPC_URL` ✓
- `WALLET_PRIVATE_KEY` ✓ (pubkey diturunkan otomatis — private key tidak
  dipakai untuk sign apa pun di sini)
- `TELEGRAM_BOT_TOKEN` ✓ (aman dishare, bot ini tidak polling)
- `TELEGRAM_CHAT_ID` ✓
- `POOL_FILTER` ✓ (opsional)

Jadi cukup:
```bash
cp ../strat_exit/.env .env
```

Kalau ingin pakai bot Telegram terpisah, isi token berbeda.

## Format Notifikasi

```
🎯 BONUS STAGE — <symbol>
Pair: <baseSymbol> / <quoteSymbol>
Supertrend (10, 3) flipped GREEN → RED on closed 15m candle.

Price: $<lastClose>
Supertrend level: <stValue>
Active positions in pool: <count>

CA: <baseTokenAddress>
https://gmgn.ai/sol/token/<addr> | https://dexscreener.com/solana/<pool>

(Open a manual position now if you want to ride the bonus stage. strat_exit
will close it together with your evil panda entry.)
```

## Struktur File

```
bonus-stage-strat-detect/
├── README.md                    # file ini
├── package.json
├── tsconfig.json
├── ecosystem.config.js          # PM2 config
├── .env.example
└── src/
    ├── index.ts                 # main loop
    ├── config.ts                # .env loader
    ├── discovery.ts             # DLMM position discovery
    ├── ohlc-feed.ts             # GeckoTerminal 15m via gt_fetch.py proxy
    ├── indicators.ts            # Supertrend (TradingView-compatible)
    ├── state.ts                 # per-pool state + JSON persistence
    ├── telegram.ts              # direct HTTP notifier (no Telegraf)
    └── logger.ts
```

## Troubleshooting

| Problem | Solusi |
|---|---|
| `Missing MONITOR_ONLY_PUBKEY` | Isi `MONITOR_ONLY_PUBKEY` atau `WALLET_PRIVATE_KEY` di `.env` |
| `GT_PROXY_PATH not found` / `gt_fetch.py: command not found` | `evilpanda-strat-detect` belum ter-deploy, atau path beda. Set `GT_PROXY_PATH` |
| Tidak ada notif padahal yakin transisi terjadi | Cek `state.json` — kalau `notifiedAt` sudah terisi, berarti sudah pernah notif di lifetime pool itu. Set `REPEAT_NOTIFICATIONS=true` atau tunggu posisi tutup dulu |
| Notif ganda saat restart | Pastikan `state.json` writable dan tidak di-mount read-only |
| `insufficient candles` terus-menerus | Pool terlalu baru — GeckoTerminal belum index. Tunggu beberapa jam |
| Telegram disabled di log | `TELEGRAM_BOT_TOKEN` atau `TELEGRAM_CHAT_ID` kosong |

## Catatan Penting

- Detector ini **tidak menutup posisi** dan **tidak menyentuh on-chain**. Aman
  jalan paralel dengan `strat_exit`.
- Supertrend dievaluasi HANYA di candle yang sudah closed — tidak ada
  repaint, tidak ada false signal dari candle berjalan.
- Restart-safe: kalau bot start dan pool sudah dalam kondisi merah, notif
  ditahan (anggap sudah lewat transition). Kalau ini bermasalah di workflow
  kamu, hapus `state.json` dan restart.

## Disclaimer

Notif tool only. Tidak ada jaminan signal akurat. Selalu DYOR sebelum
membuka posisi tambahan. Author tidak bertanggung jawab atas loss apa pun.

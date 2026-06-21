"""
Solana Trading Bot — Configuration.

Credentials dan settings untuk wallet, RPC, Jupiter, dan Telegram.
"""

import os
import base58
from solders.keypair import Keypair

# ── Solana ─────────────────────────────────────────────────────
WALLET_PRIVATE_KEY = "BjULrghZ1rMWyCXXbsgDG8rD9d6HzYiScWiZYcbCXXTN"
RPC_URL = "https://mainnet.helius-rpc.com/?api-key=5223bf24-8b38-4302-8e62-7df5fe1ac1a8"

# ── Jupiter ────────────────────────────────────────────────────
# Set to None to use free lite-api; set a string to use paid api.jup.ag
JUPITER_API_KEY = None  # e.g. "your-api-key-here"

# ── Swap Settings ──────────────────────────────────────────────
SLIPPAGE_BPS = 100       # 1% slippage tolerance
DRY_RUN = False           # True = simulate only, don't send real txs

# ── Telegram ───────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN = "8913126974:AAFfg86LtCrxlbKmbK0QVj-PxIVha5LXmN8"
TELEGRAM_CHAT_ID = 1068617728

# ── Trading Strategy ───────────────────────────────────────────
# Token watchlist (mint addresses to monitor)
WATCHLIST = [
    # Add mint addresses here, e.g.:
    # "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  # USDC
]

# Indicator params (TradingView-style)
RSI_LENGTH = 14
RSI_OVERSOLD = 30
RSI_OVERBOUGHT = 70
BB_LENGTH = 20
BB_MULT = 2.0
MACD_FAST = 12
MACD_SLOW = 26
MACD_SIGNAL = 9

# Candle interval for price data (in seconds)
# Jupiter price API gives 1m, 5m, 15m, 1h, 4h, 1d candles
CANDLE_INTERVAL = "15m"   # 1m, 5m, 15m, 1h, 4h, 1d
CANDLE_COUNT = 100         # how many candles to fetch

# Check interval (seconds between each scan cycle)
SCAN_INTERVAL_SEC = 60

# ── Derived ────────────────────────────────────────────────────
def get_wallet() -> Keypair:
    """Load wallet from private key (32-byte seed in base58)."""
    seed = base58.b58decode(WALLET_PRIVATE_KEY)
    return Keypair.from_seed(seed)

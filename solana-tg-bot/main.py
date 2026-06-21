#!/usr/bin/env python3
"""
Solana Trading Bot — Main Entry Point.

Monitors tokens via DexScreener, calculates technical indicators,
generates buy/sell signals, and notifies via Telegram.
Can execute Jupiter swaps to close positions into SOL.
"""

import asyncio
import json
import logging
import math
import os
import signal
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import httpx
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solana.rpc.api import Client
from solana.rpc.commitment import Confirmed
from telegram import Bot
from telegram.error import TelegramError

import config
from indicators import rsi, bollinger_bands, macd
from jupiter_swap import swap_all_to_sol

# ── Logging ─────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("solana-bot")


# ── Data Structures ─────────────────────────────────────────────

@dataclass
class Candle:
    """Single OHLCV candle."""
    timestamp: float
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


@dataclass
class TokenState:
    """Runtime state for a watched token."""
    mint: str
    symbol: str = "???"
    name: str = "???"
    price_usd: float = 0.0
    candles: list[Candle] = field(default_factory=list)
    last_signal: Optional[str] = None  # "BUY" or "SELL"
    last_signal_time: float = 0.0
    position_open: bool = False


@dataclass
class Signal:
    """A trading signal."""
    token: str
    symbol: str
    direction: str  # "BUY" or "SELL"
    price: float
    reasons: list[str]
    timestamp: float


# ── Price Feed ──────────────────────────────────────────────────

async def fetch_token_data(
    http: httpx.AsyncClient, mint: str
) -> Optional[dict]:
    """Fetch token data from DexScreener."""
    url = f"https://api.dexscreener.com/latest/dex/tokens/{mint}"
    try:
        resp = await http.get(url, timeout=10.0)
        if resp.status_code != 200:
            return None
        data = resp.json()
        pairs = data.get("pairs", [])
        if not pairs:
            return None
        # Filter for Solana pairs only
        sol_pairs = [p for p in pairs if p.get("chainId") == "solana"]
        if not sol_pairs:
            return None
        # Use the pair with highest liquidity
        best = max(sol_pairs, key=lambda p: float(p.get("liquidity", {}).get("usd", 0) or 0))
        return best
    except Exception as e:
        logger.debug(f"fetch_token_data({mint[:8]}...): {e}")
        return None


def update_candles(state: TokenState, price: float, volume: float):
    """Update OHLCV candles with a new price tick."""
    now = time.time()
    interval_sec = _interval_seconds()

    if state.candles:
        last = state.candles[-1]
        # If within same candle interval, update high/low/close/volume
        if now - last.timestamp < interval_sec:
            last.high = max(last.high, price)
            last.low = min(last.low, price)
            last.close = price
            last.volume += volume
            return

    # New candle
    state.candles.append(Candle(
        timestamp=now,
        open=price,
        high=price,
        low=price,
        close=price,
        volume=volume,
    ))

    # Trim to max needed candles
    max_candles = max(
        config.BB_LENGTH,
        config.RSI_LENGTH + 1,
        config.MACD_SLOW + config.MACD_SIGNAL,
    ) + 20
    if len(state.candles) > max_candles:
        state.candles = state.candles[-max_candles:]


def _interval_seconds() -> int:
    """Convert config.CANDLE_INTERVAL to seconds."""
    mapping = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}
    return mapping.get(config.CANDLE_INTERVAL, 900)


# ── Signal Engine ───────────────────────────────────────────────

def analyze_token(state: TokenState) -> Optional[Signal]:
    """Run indicators on token state and generate signals."""
    closes = [c.close for c in state.candles]

    # Need enough candles for all indicators
    min_candles = max(config.BB_LENGTH, config.RSI_LENGTH + 1, config.MACD_SLOW + config.MACD_SIGNAL)
    if len(closes) < min_candles:
        return None

    reasons = []

    # ── RSI ──
    rsi_vals = rsi(closes, config.RSI_LENGTH)
    latest_rsi = rsi_vals[-1]
    if math.isnan(latest_rsi):
        return None

    if latest_rsi <= config.RSI_OVERSOLD:
        reasons.append(f"RSI={latest_rsi:.1f} (oversold <{config.RSI_OVERSOLD})")
    elif latest_rsi >= config.RSI_OVERBOUGHT:
        reasons.append(f"RSI={latest_rsi:.1f} (overbought >{config.RSI_OVERBOUGHT})")

    # ── Bollinger Bands ──
    bb = bollinger_bands(closes, config.BB_LENGTH, config.BB_MULT)
    latest_close = closes[-1]
    bb_lower = bb["lower"][-1]
    bb_upper = bb["upper"][-1]
    if not math.isnan(bb_lower) and latest_close <= bb_lower:
        reasons.append(f"Price={latest_close:.8f} <= BB lower={bb_lower:.8f}")
    if not math.isnan(bb_upper) and latest_close >= bb_upper:
        reasons.append(f"Price={latest_close:.8f} >= BB upper={bb_upper:.8f}")

    # ── MACD ──
    macd_data = macd(closes, config.MACD_FAST, config.MACD_SLOW, config.MACD_SIGNAL)
    macd_line = macd_data["macd_line"][-1]
    signal_line = macd_data["signal_line"][-1]
    prev_macd = macd_data["macd_line"][-2]
    prev_signal = macd_data["signal_line"][-2]

    if not math.isnan(macd_line) and not math.isnan(signal_line):
        # Bullish crossover
        if prev_macd <= prev_signal and macd_line > signal_line:
            reasons.append(f"MACD bullish crossover ({macd_line:.8f} > {signal_line:.8f})")
        # Bearish crossover
        elif prev_macd >= prev_signal and macd_line < signal_line:
            reasons.append(f"MACD bearish crossover ({macd_line:.8f} < {signal_line:.8f})")

    if not reasons:
        return None

    # Determine direction: count bullish vs bearish
    bullish = sum(1 for r in reasons if any(kw in r.lower() for kw in
        ["oversold", "<= bb lower", "bullish crossover"]))
    bearish = sum(1 for r in reasons if any(kw in r.lower() for kw in
        ["overbought", ">= bb upper", "bearish crossover"]))

    if bullish > bearish and not state.position_open:
        direction = "BUY"
    elif bearish > bullish and state.position_open:
        direction = "SELL"
    else:
        return None  # No actionable signal

    # Avoid repeated signals within cooldown
    now = time.time()
    if state.last_signal == direction and (now - state.last_signal_time) < 300:
        return None

    return Signal(
        token=state.mint,
        symbol=state.symbol,
        direction=direction,
        price=latest_close,
        reasons=reasons,
        timestamp=now,
    )


def format_signal(signal: Signal) -> str:
    """Format a trading signal for Telegram."""
    emoji = "🟢" if signal.direction == "BUY" else "🔴"
    dex_url = f"https://dexscreener.com/solana/{signal.token}"
    lines = [
        f"{emoji} *{signal.direction} Signal* — {signal.symbol}",
        f"",
        f"*Token:* `{signal.token}`",
        f"*Price:* ${signal.price:.8f}",
        f"*Reasons:*",
    ]
    for r in signal.reasons:
        lines.append(f"  • {r}")
    lines.append(f"")
    lines.append(f"[View on DexScreener]({dex_url})")
    lines.append(f"_{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}_")
    return "\n".join(lines)


# ── Bot Loop ────────────────────────────────────────────────────

class SolanaBot:
    """Main bot orchestrator."""

    def __init__(self):
        self.states: dict[str, TokenState] = {}
        self.running = True
        self.solana_client: Optional[Client] = None
        self.wallet: Optional[Keypair] = None
        self.tg_bot: Optional[Bot] = None

    async def setup(self):
        """Initialize connections."""
        self.solana_client = Client(config.RPC_URL)
        self.wallet = config.get_wallet()
        self.tg_bot = Bot(token=config.TELEGRAM_BOT_TOKEN)

        # Verify Solana connection
        try:
            balance_resp = self.solana_client.get_balance(self.wallet.pubkey())
            sol_balance = balance_resp.value / 1e9
            logger.info(f"Wallet: {self.wallet.pubkey()}")
            logger.info(f"SOL balance: {sol_balance:.4f}")
        except Exception as e:
            logger.error(f"Solana RPC error: {e}")
            raise

        # Verify Telegram connection (non-fatal)
        try:
            me = await self.tg_bot.get_me()
            logger.info(f"Telegram bot: @{me.username}")
            self._tg_ok = True
        except Exception as e:
            logger.warning(f"Telegram unavailable (notifications disabled): {e}")
            self._tg_ok = False

        # Initialize states for watchlist
        for mint in config.WATCHLIST:
            self.states[mint] = TokenState(mint=mint)

        logger.info(f"Watching {len(self.states)} tokens, scanning every {config.SCAN_INTERVAL_SEC}s")

    async def add_token(self, mint: str):
        """Add a token to the watchlist."""
        if mint in self.states:
            return False
        self.states[mint] = TokenState(mint=mint)
        config.WATCHLIST.append(mint)
        logger.info(f"Added token: {mint}")
        return True

    async def remove_token(self, mint: str):
        """Remove a token from the watchlist."""
        if mint not in self.states:
            return False
        del self.states[mint]
        config.WATCHLIST.remove(mint)
        logger.info(f"Removed token: {mint}")
        return True

    async def send_telegram(self, text: str):
        """Send a message to Telegram (no-op if unavailable)."""
        if not getattr(self, "_tg_ok", False):
            return
        try:
            await self.tg_bot.send_message(
                chat_id=config.TELEGRAM_CHAT_ID,
                text=text,
                parse_mode="Markdown",
                disable_web_page_preview=True,
            )
        except TelegramError as e:
            logger.error(f"Telegram send failed: {e}")

    async def scan_once(self):
        """Run one scan cycle across all watched tokens."""
        async with httpx.AsyncClient(timeout=15.0) as http:
            for mint, state in list(self.states.items()):
                try:
                    pair = await fetch_token_data(http, mint)
                    if not pair:
                        continue

                    # Update token info
                    base = pair.get("baseToken", {})
                    state.symbol = base.get("symbol", state.symbol)
                    state.name = base.get("name", state.name)
                    price = float(pair.get("priceUsd", 0))
                    vol_24h = float(pair.get("volume", {}).get("h24", 0))
                    state.price_usd = price

                    # Estimate tick volume from 24h volume
                    tick_vol = vol_24h / (86400 / config.SCAN_INTERVAL_SEC) if vol_24h > 0 else 0
                    update_candles(state, price, tick_vol)

                    # Run analysis if we have enough candles
                    signal = analyze_token(state)
                    if signal:
                        logger.info(
                            f"SIGNAL: {signal.direction} {signal.symbol} @ ${signal.price:.8f} "
                            f"({len(signal.reasons)} reasons)"
                        )
                        state.last_signal = signal.direction
                        state.last_signal_time = signal.timestamp

                        msg = format_signal(signal)
                        await self.send_telegram(msg)

                        # Auto-sell to SOL if configured
                        if signal.direction == "SELL":
                            await self._execute_sell(mint)

                except Exception as e:
                    logger.debug(f"Error scanning {mint[:8]}...: {e}")

    async def _execute_sell(self, mint: str):
        """Execute Jupiter swap to SOL for a token position."""
        try:
            input_mint = Pubkey.from_string(mint)
            sig = await swap_all_to_sol(
                client=self.solana_client,
                wallet=self.wallet,
                input_mint=input_mint,
                slippage_bps=config.SLIPPAGE_BPS,
                jupiter_api_key=config.JUPITER_API_KEY,
                dry_run=config.DRY_RUN,
            )
            if sig:
                await self.send_telegram(
                    f"✅ *Swap executed!*\n"
                    f"`{mint}` → SOL\n"
                    f"Tx: `{sig}`\n"
                    f"[View on Solscan](https://solscan.io/tx/{sig})",
                )
                self.states[mint].position_open = False
        except Exception as e:
            logger.error(f"Sell execution failed for {mint[:8]}...: {e}")
            await self.send_telegram(
                f"❌ *Swap FAILED* for `{mint[:8]}...`\nError: {e}",
            )

    async def run(self):
        """Main loop."""
        await self.setup()

        # Startup notification
        tokens_str = ", ".join(
            f"{s.symbol or m[:8]}..." for m, s in self.states.items()
        ) or "(empty)"
        await self.send_telegram(
            f"🤖 *Solana Trading Bot started*\n"
            f"Wallet: `{self.wallet.pubkey()}`\n"
            f"Watching: {tokens_str}\n"
            f"Scan interval: {config.SCAN_INTERVAL_SEC}s\n"
            f"Candle interval: {config.CANDLE_INTERVAL}\n"
            f"Dry run: {'ON ⚠️' if config.DRY_RUN else 'OFF ✅'}",
        )

        while self.running:
            cycle_start = time.time()
            try:
                await self.scan_once()
            except Exception as e:
                logger.error(f"Scan cycle error: {e}", exc_info=True)

            elapsed = time.time() - cycle_start
            sleep_time = max(1, config.SCAN_INTERVAL_SEC - elapsed)
            logger.debug(f"Cycle took {elapsed:.1f}s, sleeping {sleep_time:.1f}s")
            await asyncio.sleep(sleep_time)

    def stop(self):
        """Graceful shutdown."""
        self.running = False
        logger.info("Shutting down...")


# ── CLI ─────────────────────────────────────────────────────────

async def main():
    bot = SolanaBot()

    # Handle Ctrl+C gracefully
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, bot.stop)
        except NotImplementedError:
            # Windows doesn't support add_signal_handler
            pass

    try:
        await bot.run()
    except KeyboardInterrupt:
        pass
    finally:
        logger.info("Bot stopped.")


if __name__ == "__main__":
    asyncio.run(main())

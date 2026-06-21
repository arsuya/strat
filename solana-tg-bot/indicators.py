"""
Technical indicators: RSI, Bollinger Bands, MACD.

Implementations follow TradingView conventions:
 - RSI uses RMA (Wilder's smoothing): alpha = 1/length
 - EMA uses standard alpha = 2/(length+1), seeded with first value
 - BB uses population standard deviation (divides by N, not N-1)
 - MACD = EMA(fast) - EMA(slow), signal = EMA(macd, signalLen)
"""

import math
from typing import Literal


def sma(values: list[float], length: int) -> list[float]:
    """Simple moving average. Returns array same length as input; pre-warmup values are NaN."""
    out = [math.nan] * len(values)
    if length <= 0 or len(values) < length:
        return out
    s = sum(values[:length])
    out[length - 1] = s / length
    for i in range(length, len(values)):
        s += values[i] - values[i - length]
        out[i] = s / length
    return out


def ema(values: list[float], length: int) -> list[float]:
    """Exponential moving average (TradingView style: seeded with first value)."""
    out = [math.nan] * len(values)
    if len(values) == 0:
        return out
    alpha = 2 / (length + 1)
    out[0] = values[0]
    for i in range(1, len(values)):
        out[i] = alpha * values[i] + (1 - alpha) * out[i - 1]
    return out


def rma(values: list[float], length: int) -> list[float]:
    """
    Wilder's smoothed moving average (RMA).
    Used inside RSI. alpha = 1/length.
    Seeded with SMA of the first `length` values, then recursively smoothed.
    """
    out = [math.nan] * len(values)
    if len(values) < length:
        return out
    s = sum(values[:length])
    out[length - 1] = s / length
    for i in range(length, len(values)):
        out[i] = (out[i - 1] * (length - 1) + values[i]) / length
    return out


def rsi(closes: list[float], length: int) -> list[float]:
    """
    Relative Strength Index. Returns array aligned with `closes`.
    Standard formula: RSI = 100 - 100/(1 + RMA(gains)/RMA(losses))
    """
    out = [math.nan] * len(closes)
    if len(closes) < length + 1:
        return out

    gains = [0.0] * len(closes)
    losses = [0.0] * len(closes)
    for i in range(1, len(closes)):
        d = closes[i] - closes[i - 1]
        if d > 0:
            gains[i] = d
        else:
            losses[i] = -d

    # Skip index 0 since there is no change there; align RMA starting from index 1
    g = rma(gains[1:], length)
    l_ = rma(losses[1:], length)

    for i in range(len(g)):
        if math.isnan(g[i]) or math.isnan(l_[i]):
            continue
        if l_[i] == 0:
            out[i + 1] = 100.0
        else:
            rs = g[i] / l_[i]
            out[i + 1] = 100.0 - 100.0 / (1.0 + rs)
    return out


def bollinger_bands(
    closes: list[float], length: int, mult: float
) -> dict[str, list[float]]:
    """Bollinger Bands using population stdev (TradingView default)."""
    middle = sma(closes, length)
    upper = [math.nan] * len(closes)
    lower = [math.nan] * len(closes)

    for i in range(length - 1, len(closes)):
        m = middle[i]
        variance = 0.0
        for j in range(i - length + 1, i + 1):
            variance += (closes[j] - m) ** 2
        variance /= length
        std = math.sqrt(variance)
        upper[i] = m + mult * std
        lower[i] = m - mult * std

    return {"middle": middle, "upper": upper, "lower": lower}


def macd(
    closes: list[float], fast_len: int, slow_len: int, signal_len: int
) -> dict[str, list[float]]:
    """MACD with EMA-based signal line."""
    fast = ema(closes, fast_len)
    slow = ema(closes, slow_len)
    macd_line = [f - s for f, s in zip(fast, slow)]
    signal_line = ema(macd_line, signal_len)
    histogram = [m - s for m, s in zip(macd_line, signal_line)]
    return {"macd_line": macd_line, "signal_line": signal_line, "histogram": histogram}


def smoothing(
    values: list[float], type_: Literal["SMA"], length: int
) -> list[float]:
    """Apply a smoothing line on top of an existing series (currently only SMA)."""
    if type_ == "SMA":
        return sma(values, length)
    raise ValueError(f"Unsupported smoothing type: {type_}")

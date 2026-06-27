/**
 * Technical indicators: RSI, Bollinger Bands, MACD.
 *
 * Implementations follow TradingView conventions:
 *  - RSI uses RMA (Wilder's smoothing): alpha = 1/length
 *  - EMA uses standard alpha = 2/(length+1), seeded with first value
 *  - BB uses population standard deviation (divides by N, not N-1)
 *  - MACD = EMA(fast) - EMA(slow), signal = EMA(macd, signalLen)
 */

/** Simple moving average. Returns array same length as input; pre-warmup values are NaN. */
export function sma(values: number[], length: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (length <= 0 || values.length < length) return out;
  let sum = 0;
  for (let i = 0; i < length; i++) sum += values[i];
  out[length - 1] = sum / length;
  for (let i = length; i < values.length; i++) {
    sum += values[i] - values[i - length];
    out[i] = sum / length;
  }
  return out;
}

/** Exponential moving average (TradingView style: seeded with first value). */
export function ema(values: number[], length: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length === 0) return out;
  const alpha = 2 / (length + 1);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    out[i] = alpha * values[i] + (1 - alpha) * out[i - 1];
  }
  return out;
}

/**
 * Wilder's smoothed moving average (RMA).
 * Used inside RSI. alpha = 1/length.
 * Seeded with SMA of the first `length` values, then recursively smoothed.
 */
export function rma(values: number[], length: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length < length) return out;
  let sum = 0;
  for (let i = 0; i < length; i++) sum += values[i];
  out[length - 1] = sum / length;
  for (let i = length; i < values.length; i++) {
    out[i] = (out[i - 1] * (length - 1) + values[i]) / length;
  }
  return out;
}

/**
 * Relative Strength Index. Returns array aligned with `closes`.
 * Standard formula: RSI = 100 - 100/(1 + RMA(gains)/RMA(losses))
 */
export function rsi(closes: number[], length: number): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < length + 1) return out;
  const gains: number[] = new Array(closes.length).fill(0);
  const losses: number[] = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains[i] = d > 0 ? d : 0;
    losses[i] = d < 0 ? -d : 0;
  }
  // skip index 0 since there is no change there; align RMA starting from index 1
  const g = rma(gains.slice(1), length);
  const l = rma(losses.slice(1), length);
  for (let i = 0; i < g.length; i++) {
    if (Number.isNaN(g[i]) || Number.isNaN(l[i])) continue;
    if (l[i] === 0) {
      out[i + 1] = 100;
    } else {
      const rs = g[i] / l[i];
      out[i + 1] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

/** Bollinger Bands using population stdev (TradingView default). */
export function bollingerBands(
  closes: number[],
  length: number,
  mult: number
): { middle: number[]; upper: number[]; lower: number[] } {
  const middle = sma(closes, length);
  const upper: number[] = new Array(closes.length).fill(NaN);
  const lower: number[] = new Array(closes.length).fill(NaN);
  for (let i = length - 1; i < closes.length; i++) {
    const m = middle[i];
    let variance = 0;
    for (let j = i - length + 1; j <= i; j++) {
      variance += (closes[j] - m) ** 2;
    }
    variance /= length;
    const std = Math.sqrt(variance);
    upper[i] = m + mult * std;
    lower[i] = m - mult * std;
  }
  return { middle, upper, lower };
}

/** MACD with EMA-based signal line. */
export function macd(
  closes: number[],
  fastLen: number,
  slowLen: number,
  signalLen: number
): { macdLine: number[]; signalLine: number[]; histogram: number[] } {
  const fast = ema(closes, fastLen);
  const slow = ema(closes, slowLen);
  const macdLine = fast.map((f, i) => f - slow[i]);
  const signalLine = ema(macdLine, signalLen);
  const histogram = macdLine.map((m, i) => m - signalLine[i]);
  return { macdLine, signalLine, histogram };
}

/**
 * Apply a smoothing line on top of an existing series (used for RSI's MA overlay).
 * `type` currently only supports SMA (user spec).
 */
export function smoothing(
  values: number[],
  type: "SMA",
  length: number
): number[] {
  if (type === "SMA") return sma(values, length);
  throw new Error(`Unsupported smoothing type: ${type}`);
}

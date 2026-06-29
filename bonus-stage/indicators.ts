/**
 * Supertrend indicator — TradingView-compatible implementation.
 *
 * Matches the behavior of Pine Script's built-in `ta.supertrend(factor, length)`:
 *
 *   src = hl2
 *   upperBand = src + factor * ta.atr(length)
 *   lowerBand = src - factor * ta.atr(length)
 *
 *   lowerBand := lowerBand > prevLower or close[1] < prevLower
 *                ? lowerBand : prevLower
 *   upperBand := upperBand < prevUpper or close[1] > prevUpper
 *                ? upperBand : prevUpper
 *
 *   direction :=
 *     na(atr[1])                ? +1
 *     : prevSt == prevUpperBand ? (close > upperBand ? -1 : +1)
 *     :                           (close < lowerBand ? +1 : -1)
 *
 *   supertrend := direction == -1 ? lowerBand : upperBand
 *
 * direction == -1  → uptrend (TradingView plots GREEN)
 * direction == +1  → downtrend (TradingView plots RED)
 *
 * ATR uses Wilder's RMA: alpha = 1/length, seeded with SMA of the first
 * `length` TR values. This matches Pine's `ta.atr`.
 */

export type SupertrendDirection = -1 | 1 | 0; // 0 = warmup / undefined

export interface SupertrendPoint {
  value: number;          // the plotted supertrend level (NaN during warmup)
  direction: SupertrendDirection;
}

/** True Range: max(H-L, |H - prevC|, |L - prevC|). */
function trueRange(highs: number[], lows: number[], closes: number[]): number[] {
  const n = closes.length;
  const tr: number[] = new Array(n).fill(NaN);
  if (n === 0) return tr;
  tr[0] = highs[0] - lows[0];
  for (let i = 1; i < n; i++) {
    const a = highs[i] - lows[i];
    const b = Math.abs(highs[i] - closes[i - 1]);
    const c = Math.abs(lows[i] - closes[i - 1]);
    tr[i] = Math.max(a, b, c);
  }
  return tr;
}

/** Average True Range using Wilder's smoothing (same as Pine's ta.atr). */
function atrWilder(tr: number[], length: number): number[] {
  const n = tr.length;
  const out: number[] = new Array(n).fill(NaN);
  if (n < length) return out;
  let sum = 0;
  for (let i = 0; i < length; i++) sum += tr[i];
  out[length - 1] = sum / length;
  for (let i = length; i < n; i++) {
    out[i] = (out[i - 1] * (length - 1) + tr[i]) / length;
  }
  return out;
}

export function supertrend(
  highs: number[],
  lows: number[],
  closes: number[],
  length: number,
  factor: number
): SupertrendPoint[] {
  const n = closes.length;
  const out: SupertrendPoint[] = new Array(n)
    .fill(null)
    .map(() => ({ value: NaN, direction: 0 as SupertrendDirection }));

  if (n < length + 1) return out;

  const tr = trueRange(highs, lows, closes);
  const atr = atrWilder(tr, length);

  const upperBand: number[] = new Array(n).fill(NaN);
  const lowerBand: number[] = new Array(n).fill(NaN);

  // First valid index is `length - 1` (first ATR bar).
  for (let i = length - 1; i < n; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    let upper = hl2 + factor * atr[i];
    let lower = hl2 - factor * atr[i];

    const prevUpper = upperBand[i - 1];
    const prevLower = lowerBand[i - 1];

    // Band carry-over rule.
    if (!Number.isNaN(prevUpper)) {
      // upper stays where it was unless price broke above it on prev bar,
      // or the freshly-computed upper is lower
      if (!(upper < prevUpper || closes[i - 1] > prevUpper)) {
        upper = prevUpper;
      }
    }
    if (!Number.isNaN(prevLower)) {
      if (!(lower > prevLower || closes[i - 1] < prevLower)) {
        lower = prevLower;
      }
    }
    upperBand[i] = upper;
    lowerBand[i] = lower;

    // Direction
    let direction: SupertrendDirection;
    if (i === length - 1 || Number.isNaN(atr[i - 1])) {
      // Pine: na(atr[1]) ? +1
      direction = 1;
    } else {
      const prevSt = out[i - 1].value;
      // Floating-point equality is fine here because prevSt was assigned
      // directly from upperBand[i-1] or lowerBand[i-1] — no arithmetic
      // between assignment and comparison.
      if (prevSt === prevUpper) {
        direction = closes[i] > upper ? -1 : 1;
      } else {
        direction = closes[i] < lower ? 1 : -1;
      }
    }

    out[i] = {
      value: direction === -1 ? lower : upper,
      direction,
    };
  }

  return out;
}

/**
 * Convenience: return the supertrend value/direction for the LAST closed bar.
 * Returns null if there isn't enough data yet.
 */
export function supertrendLast(
  highs: number[],
  lows: number[],
  closes: number[],
  length: number,
  factor: number
): SupertrendPoint | null {
  const arr = supertrend(highs, lows, closes, length, factor);
  if (arr.length === 0) return null;
  const last = arr[arr.length - 1];
  if (last.direction === 0 || Number.isNaN(last.value)) return null;
  return last;
}

/** Human-readable color label for log/notification output. */
export function colorLabel(dir: SupertrendDirection): "GREEN" | "RED" | "?" {
  if (dir === -1) return "GREEN";
  if (dir === 1) return "RED";
  return "?";
}

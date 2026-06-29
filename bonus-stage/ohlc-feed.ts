/**
 * GeckoTerminal OHLCV fetcher.
 *
 * Reuses the proxy-rotation helper installed alongside the evilpanda scanner
 * (`/home/ubuntu/evilpanda-strat-detect/gt_fetch.py`) so we share the same
 * proxy pool and respect the global rate limit.
 *
 * Returns 15-minute candles for the requested Meteora pool. The currently-
 * forming candle is dropped so the supertrend evaluates only on settled bars.
 */
import { execSync } from "child_process";
import { log } from "./logger";

const GT_PROXY = process.env.GT_PROXY_PATH || "/home/ubuntu/evilpanda-strat-detect/gt_fetch.py";

async function gtGet(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    try {
      const raw = execSync(`${GT_PROXY} "${url}"`, {
        timeout: 45_000,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
      const data = JSON.parse(raw);
      resolve(data);
    } catch (e: any) {
      const stderr = e.stderr?.toString() ?? "";
      if (stderr.startsWith("ERROR:")) {
        reject(new Error(stderr.slice(6).trim()));
      } else {
        reject(e);
      }
    }
  });
}

export interface Candle {
  t: number; // unix seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number; // volume in USD
}

const BUCKET_SECONDS_15M = 15 * 60;

/**
 * Fetch CLOSED 15-minute candles for a Meteora pool.
 *
 * The supertrend implementation needs high/low/close — all present in the
 * GeckoTerminal payload — so no transformation beyond column mapping is
 * needed.
 */
export async function fetchPoolOhlc15m(opts: {
  poolAddress: string;
  limit?: number;
}): Promise<Candle[]> {
  const limit = opts.limit ?? 200;
  const url =
    `https://api.geckoterminal.com/api/v2/networks/solana/pools/${opts.poolAddress}` +
    `/ohlcv/minute?aggregate=15&limit=${limit}&currency=usd&token=base`;

  const res = await gtGet(url);
  const json: any = res;
  const list = json?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) {
    throw new Error(
      `Unexpected GeckoTerminal response shape: ${JSON.stringify(json).slice(0, 200)}`
    );
  }

  // GeckoTerminal returns NEWEST first; reverse to chronological order.
  const candles: Candle[] = list
    .map((row: any[]) => ({
      t: Number(row[0]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: Number(row[5] ?? 0),
    }))
    .reverse();

  // Drop the currently-forming candle.
  const now = Math.floor(Date.now() / 1000);
  const closed = candles.filter((c) => c.t + BUCKET_SECONDS_15M <= now);

  log.info(
    `GT OHLC pool=${opts.poolAddress.slice(0, 8)}…: ${closed.length} closed 15m candle(s)`
  );
  return closed;
}

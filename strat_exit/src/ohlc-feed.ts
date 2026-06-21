/**
 * GeckoTerminal OHLCV fetcher.
 *
 * One HTTP call returns up to N historical candles for a Meteora pool — no
 * warmup, no local aggregation, no persistence. Data comes from actual swaps
 * in THIS pool, so it matches what an LP cares about.
 *
 * Docs: https://apiguide.geckoterminal.com/
 *
 * Endpoint:
 *   GET https://api.geckoterminal.com/api/v2/networks/solana/pools/<pool>/ohlcv/minute
 *       ?aggregate=15&limit=200&currency=usd&token=base
 *
 * Response shape:
 *   { data: { attributes: { ohlcv_list: [[ts, o, h, l, c, vol], ...] } } }
 * The list is NEWEST FIRST — we reverse it to chronological order.
 *
 * Rate limit (free tier): 30 req/min per IP. With 60s strategy poll and a
 * handful of pools we sit well under that.
 */
import { execSync } from "child_process";
import { log } from "./logger";

const GT_PROXY = "/home/ubuntu/evilpanda-strat-detect/gt_fetch.py";

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
 * Fetch closed 15-minute candles for a Meteora pool. Drops the currently-
 * forming candle so indicators evaluate on settled bars only.
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

  // GeckoTerminal returns NEWEST first; reverse to chronological order
  // (oldest -> newest) which is what the indicator functions expect.
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

  // Drop the currently-forming candle: if its bucket end is still in the
  // future, it's not settled yet.
  const now = Math.floor(Date.now() / 1000);
  const closed = candles.filter((c) => c.t + BUCKET_SECONDS_15M <= now);

  log.info(
    `GT OHLC pool=${opts.poolAddress.slice(0, 8)}…: ${closed.length} closed 15m candle(s)`
  );
  return closed;
}

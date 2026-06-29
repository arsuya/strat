/**
 * Telegram notifier — direct HTTP, no long-polling.
 *
 * Notification-only (no commands), so we deliberately avoid Telegraf. This
 * means the same TELEGRAM_BOT_TOKEN can be safely shared with strat_exit
 * (which DOES long-poll) — only one process is allowed to consume updates,
 * but multiple processes can call sendMessage.
 *
 * Also caches pool → token-name lookups so notifications can show readable
 * names without hammering GeckoTerminal.
 */
import { log } from "./logger";

export interface Notifier {
  notify(msg: string): Promise<void>;
}

export const noopNotifier: Notifier = {
  notify: async (msg: string) => {
    log.info(`[notify-disabled] ${msg.replace(/\n/g, " | ")}`);
  },
};

export function makeHttpNotifier(token: string, chatId: string): Notifier {
  if (!token || !chatId) {
    log.warn("Telegram disabled (token or chat ID missing). Notifications will log to stdout.");
    return noopNotifier;
  }
  return {
    notify: async (msg: string) => {
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: msg,
            disable_web_page_preview: true,
          }),
        });
        if (!r.ok) {
          const body = await r.text().catch(() => "");
          log.error(`Telegram error ${r.status}: ${body.slice(0, 200)}`);
        }
      } catch (e) {
        log.error(`Telegram notify failed: ${(e as Error).message}`);
      }
    },
  };
}

/* ---------------- Pool/token name resolution ---------------- */

interface PoolMeta {
  nameX: string;
  nameY: string;
  baseAddress: string;   // mint address of the "base" (non-quote) token
}

const poolMetaCache = new Map<string, PoolMeta>();

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

/** Pick the non-quote token from a pair (the "interesting" one). */
function pickBase(tokenX: string, tokenY: string): string {
  if (QUOTE_MINTS.has(tokenY)) return tokenX;
  if (QUOTE_MINTS.has(tokenX)) return tokenY;
  return tokenX; // fallback: first token
}

export async function resolvePoolMeta(
  poolAddress: string,
  tokenXMint: string,
  tokenYMint: string
): Promise<PoolMeta> {
  const cached = poolMetaCache.get(poolAddress);
  if (cached) return cached;

  let nameX = "?";
  let nameY = "?";

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}`,
      { signal: ctrl.signal, headers: { accept: "application/json" } }
    );
    clearTimeout(t);
    if (r.ok) {
      const j: any = await r.json();
      const attrs = j?.data?.attributes;
      const parts = (attrs?.name as string | undefined)?.split("/");
      if (parts && parts.length >= 2) {
        nameX = parts[0].trim() || "?";
        nameY = parts[1].trim() || "?";
      }
    }
  } catch {
    /* fall through with "?" names */
  }

  const baseAddress = pickBase(tokenXMint, tokenYMint);
  const meta: PoolMeta = { nameX, nameY, baseAddress };
  poolMetaCache.set(poolAddress, meta);
  return meta;
}

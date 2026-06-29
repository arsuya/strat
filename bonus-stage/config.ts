/**
 * Configuration loader for the Bonus Stage Strat detector.
 *
 * The detector is notification-only — it does NOT need a private key to sign
 * transactions. The wallet pubkey is sufficient to discover open DLMM
 * positions on-chain.
 *
 * If WALLET_PRIVATE_KEY is provided, we derive the pubkey from it (so the
 * user can share .env with strat_exit). Otherwise MONITOR_ONLY_PUBKEY must
 * be set.
 */
import "dotenv/config";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

function required(key: string): string {
  const v = process.env[key];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${key}`);
  }
  return v.trim();
}

function optional(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

function asInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v || v.trim() === "") return fallback;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`${key} is not an integer: ${v}`);
  return n;
}

function asFloat(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v || v.trim() === "") return fallback;
  const n = parseFloat(v);
  if (Number.isNaN(n)) throw new Error(`${key} is not a number: ${v}`);
  return n;
}

function asBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (!v) return fallback;
  return v.trim().toLowerCase() === "true";
}

/**
 * Resolve the wallet pubkey we want to monitor.
 *
 * Priority:
 *   1. MONITOR_ONLY_PUBKEY (explicit)
 *   2. derived from WALLET_PRIVATE_KEY (so .env can be reused from strat_exit)
 */
function loadMonitorPubkey(): PublicKey {
  const monitorRaw = optional("MONITOR_ONLY_PUBKEY", "");
  if (monitorRaw) {
    return new PublicKey(monitorRaw);
  }

  const raw = optional("WALLET_PRIVATE_KEY", "");
  if (!raw) {
    throw new Error(
      "Missing MONITOR_ONLY_PUBKEY (and no WALLET_PRIVATE_KEY to derive it from)"
    );
  }

  try {
    let keypair: Keypair;
    if (raw.startsWith("[")) {
      const bytes = Uint8Array.from(JSON.parse(raw));
      keypair = Keypair.fromSecretKey(bytes);
    } else {
      keypair = Keypair.fromSecretKey(bs58.decode(raw));
    }
    return keypair.publicKey;
  } catch (e) {
    throw new Error(
      "Could not parse WALLET_PRIVATE_KEY. Expected base58 string or JSON byte array."
    );
  }
}

function loadPoolFilter(): PublicKey[] | null {
  const raw = optional("POOL_FILTER", "");
  if (!raw) return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => new PublicKey(s));
}

export const config = (() => {
  return {
    rpcUrl: required("RPC_URL"),
    monitorPubkey: loadMonitorPubkey(),
    poolFilter: loadPoolFilter(),

    // Telegram. Leave both blank to disable (will log to stdout only).
    telegramBotToken: optional("TELEGRAM_BOT_TOKEN", ""),
    telegramChatId: optional("TELEGRAM_CHAT_ID", ""),

    // Supertrend parameters (TradingView defaults from user spec).
    supertrend: {
      length: asInt("SUPERTREND_LENGTH", 10),
      factor: asFloat("SUPERTREND_FACTOR", 3),
    },

    // Re-notify behavior:
    //   false (default) = ONE notification per pool lifetime. Once all
    //                     positions in that pool close, the slate resets.
    //   true            = notify on EVERY green→red transition while
    //                     positions remain open.
    repeatNotifications: asBool("REPEAT_NOTIFICATIONS", false),

    // Persist state across restarts so we don't re-notify if the bot
    // restarts mid-cycle. Stored as JSON in the cwd.
    statePath: optional("STATE_PATH", "./state.json"),

    pollIntervalSeconds: asInt("POLL_INTERVAL_SECONDS", 60),
  };
})();

export type Config = typeof config;

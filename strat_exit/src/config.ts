/**
 * Configuration loader.
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

function loadWallet(): { keypair: Keypair | null; monitorPubkey: PublicKey | null } {
  const raw = optional("WALLET_PRIVATE_KEY", "");
  const monitorRaw = optional("MONITOR_ONLY_PUBKEY", "");

  // Monitor-only mode: watch a wallet without private key
  if (!raw && monitorRaw) {
    return { keypair: null, monitorPubkey: new PublicKey(monitorRaw) };
  }

  if (!raw) {
    throw new Error("Missing WALLET_PRIVATE_KEY or MONITOR_ONLY_PUBKEY");
  }

  let keypair: Keypair;
  try {
    if (raw.startsWith("[")) {
      const bytes = Uint8Array.from(JSON.parse(raw));
      keypair = Keypair.fromSecretKey(bytes);
    } else {
      keypair = Keypair.fromSecretKey(bs58.decode(raw));
    }
  } catch (e) {
    throw new Error(
      "Could not parse WALLET_PRIVATE_KEY. Expected base58 string or JSON byte array."
    );
  }

  // If MONITOR_ONLY_PUBKEY is also set with a private key, validate it matches
  if (monitorRaw) {
    const monitorPubkey = new PublicKey(monitorRaw);
    if (!monitorPubkey.equals(keypair.publicKey)) {
      // Use the monitor pubkey, ignore the derived one
      return { keypair, monitorPubkey };
    }
  }

  return { keypair, monitorPubkey: null };
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
  const walletInfo = loadWallet();

  return {
    dryRun: asBool("DRY_RUN", true),
    monitorOnly: walletInfo.keypair === null,

    rpcUrl: required("RPC_URL"),
    wallet: walletInfo.keypair,
    monitorPubkey: walletInfo.monitorPubkey ?? walletInfo.keypair?.publicKey ?? null,

    poolFilter: loadPoolFilter(),

    jupiterApiKey: optional("JUPITER_API_KEY", ""),

    // Telegram. Leave both blank to disable.
    telegramBotToken: optional("TELEGRAM_BOT_TOKEN", ""),
    telegramChatId: optional("TELEGRAM_CHAT_ID", ""),

    rsi: {
      length: asInt("RSI_LENGTH", 2),
      smoothingLength: asInt("RSI_SMOOTHING_LENGTH", 14),
      threshold: asFloat("RSI_THRESHOLD", 90),
    },
    bb: {
      length: asInt("BB_LENGTH", 20),
      mult: asFloat("BB_MULT", 2),
    },
    macd: {
      fast: asInt("MACD_FAST", 12),
      slow: asInt("MACD_SLOW", 26),
      signal: asInt("MACD_SIGNAL", 9),
    },

    pollIntervalSeconds: asInt("POLL_INTERVAL_SECONDS", 60),
    slippageBps: asInt("SLIPPAGE_BPS", 100),
    swapSlippageBps: asInt("SWAP_SLIPPAGE_BPS", 100),
  };
})();

export type Config = typeof config;

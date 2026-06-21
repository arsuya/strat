/**
 * Telegram bot integration.
 *
 * Two responsibilities:
 *  1. RECEIVE: handle /status, /pause, /resume, /positions, /close, /cycle, /help
 *  2. SEND:    push events (close triggered, tx confirmed, errors) to user
 *
 * Auth: only the chat ID configured in TELEGRAM_CHAT_ID can issue commands.
 * Other chats are silently ignored — prevents anyone who guesses the bot
 * from hijacking it.
 *
 * Polling mode (no public URL needed). Bot connects outbound to Telegram.
 */
import { Telegraf } from "telegraf";
import { PublicKey } from "@solana/web3.js";
import DLMM from "@meteora-ag/dlmm";
import { BotState } from "./state";
import { log } from "./logger";

export interface Notifier {
  notify(msg: string): Promise<void>;
}

export const noopNotifier: Notifier = { notify: async () => {} };

export interface TelegramDeps {
  state: BotState;
  /** Fetch current positions for /positions command (lazy / async). */
  getPositions: () => Promise<
    {
      positionAddress: PublicKey;
      poolAddress: PublicKey;
      activeBinId: number;
      lowerBinId: number;
      upperBinId: number;
      tokenXMint: PublicKey;
      tokenYMint: PublicKey;
      binStep: number | null;
    }[]
  >;
  /** Trigger a strategy cycle on demand. Should serialize with the main loop. */
  triggerCycle: () => Promise<void>;
}

function shortKey(s: string): string {
  return s.length < 12 ? s : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function rangeOf(activeBinId: number, lower: number, upper: number): string {
  if (activeBinId > upper) return "out_top";
  if (activeBinId < lower) return "out_bottom";
  return "in_range";
}

// In-memory cache: pool address → token names (populated lazily on /positions)
const poolNameCache = new Map<string, { nameX: string; nameY: string }>();

async function resolveTokenNames(poolAddr: string): Promise<{ nameX: string; nameY: string }> {
  const cached = poolNameCache.get(poolAddr);
  if (cached) return cached;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddr}`,
      { signal: ctrl.signal, headers: { accept: "application/json" } }
    );
    clearTimeout(t);
    if (r.ok) {
      const j: any = await r.json();
      const attrs = j?.data?.attributes;
      const nameX = attrs?.name?.split("/")[0]?.trim() ?? "Token X";
      const nameY = attrs?.name?.split("/")[1]?.trim() ?? "Token Y";
      const result = { nameX, nameY };
      poolNameCache.set(poolAddr, result);
      return result;
    }
  } catch { /* fall through */ }
  return { nameX: "?", nameY: "?" };
}

export interface TelegramBot {
  start(): Promise<void>;
  stop(): void;
  notifier: Notifier;
}

/**
 * Build and return a Telegram bot. If `token` is empty, returns a no-op
 * implementation — the rest of the bot continues to work, just without
 * Telegram I/O.
 */
export function makeTelegramBot(opts: {
  token: string;
  allowedChatId: string;
  deps: TelegramDeps;
}): TelegramBot {
  const { token, allowedChatId, deps } = opts;

  if (!token || !allowedChatId) {
    log.info("Telegram disabled (token or chat ID missing).");
    return {
      start: async () => {},
      stop: () => {},
      notifier: noopNotifier,
    };
  }

  const bot = new Telegraf(token);

  // Auth: only the configured chat ID can use commands. Everyone else is
  // silently dropped before any handler runs.
  bot.use(async (ctx, next) => {
    const id = ctx.chat?.id;
    if (id == null || id.toString() !== allowedChatId) {
      log.warn(`Telegram: unauthorized chat ${id} tried to use the bot`);
      return;
    }
    return next();
  });

  bot.command("start", (ctx) =>
    ctx.reply(
      "Meteora Exit Bot online.\n\n" +
        "Commands:\n" +
        "/status — current state\n" +
        "/positions — list open positions\n" +
        "/pause — stop executing close+swap (still monitors)\n" +
        "/resume — resume executing\n" +
        "/cycle — run a cycle now\n" +
        "/close <positionAddress> — force close a specific position\n" +
        "/help — this list"
    )
  );

  bot.command("help", (ctx) =>
    ctx.reply(
      "/status /positions /pause /resume /cycle /close <pos> /help"
    )
  );

  bot.command("status", (ctx) => {
    const s = deps.state;
    let msg = `Status: ${s.paused ? "⏸ PAUSED (will not execute close)" : "▶️ RUNNING"}\n`;
    if (s.lastCycle) {
      const ageSec = Math.floor(Date.now() / 1000) - s.lastCycle.at;
      msg += `Last cycle: ${ageSec}s ago\n`;
      msg += `Positions: ${s.lastCycle.positionCount} in ${s.lastCycle.poolCount} pool(s)\n`;
      if (s.lastCycle.error) msg += `Last error: ${s.lastCycle.error}\n`;
    } else {
      msg += "Last cycle: (none yet)\n";
    }
    if (s.manualCloseQueue.size > 0) {
      msg += `Manual close queue: ${s.manualCloseQueue.size}\n`;
    }
    ctx.reply(msg);
  });

  bot.command("pause", (ctx) => {
    deps.state.paused = true;
    ctx.reply("⏸ Paused. Bot still monitors and notifies but will NOT execute close+swap.");
  });

  bot.command("resume", (ctx) => {
    deps.state.paused = false;
    ctx.reply("▶️ Resumed. Close+swap will execute when exit criteria fire.");
  });

  bot.command("positions", async (ctx) => {
    try {
      const positions = await deps.getPositions();
      if (positions.length === 0) {
        await ctx.reply("No active DLMM positions.");
        return;
      }
      const lines: string[] = [];
      for (const p of positions) {
        const r = rangeOf(p.activeBinId, p.lowerBinId, p.upperBinId);
        const poolAddr = p.poolAddress.toBase58();
        const names = await resolveTokenNames(poolAddr);
        const tokX = p.tokenXMint.toBase58();
        const tokY = p.tokenYMint.toBase58();

        // Bin prices
        let binLine = `Bins: [${p.lowerBinId}..${p.upperBinId}] active=${p.activeBinId} (${r})`;
        if (p.binStep !== null) {
          try {
            const priceLow = (DLMM as any).getPriceOfBinByBinId(p.lowerBinId, p.binStep);
            const priceUp = (DLMM as any).getPriceOfBinByBinId(p.upperBinId, p.binStep);
            const priceAct = (DLMM as any).getPriceOfBinByBinId(p.activeBinId, p.binStep);
            const fmtPrice = (n: any) => {
              const s = n.toString();
              if (s.length > 10) return s.slice(0, 10);
              return s;
            };
            binLine = `Range: ${fmtPrice(priceLow)} → ${fmtPrice(priceUp)}` +
              ` | Active: ${fmtPrice(priceAct)} (${r})`;
          } catch { /* keep bin IDs as fallback */ }
        }

        lines.push(
          `Position: ${shortKey(p.positionAddress.toBase58())}\n` +
          `Pool: ${shortKey(poolAddr)}\n` +
          `Tokens: ${names.nameX} | ${names.nameY}\n` +
          binLine + `\n` +
          `DexScreener: https://dexscreener.com/solana/${poolAddr}\n` +
          `GMGN (${names.nameX}): https://gmgn.ai/sol/token/${tokX}\n` +
          `GMGN (${names.nameY}): https://gmgn.ai/sol/token/${tokY}`
        );
      }
      await ctx.reply(lines.join("\n\n"));
    } catch (e) {
      await ctx.reply(`❌ Error: ${(e as Error).message}`);
    }
  });

  bot.command("cycle", async (ctx) => {
    await ctx.reply("Triggering cycle now…");
    try {
      await deps.triggerCycle();
      await ctx.reply("✅ Cycle complete.");
    } catch (e) {
      await ctx.reply(`❌ Cycle failed: ${(e as Error).message}`);
    }
  });

  bot.command("close", async (ctx) => {
    const arg = ctx.message.text.trim().split(/\s+/)[1];
    if (!arg) {
      await ctx.reply("Usage: /close <positionAddress>");
      return;
    }
    try {
      new PublicKey(arg); // validate
    } catch {
      await ctx.reply(`❌ Not a valid Solana address: ${arg}`);
      return;
    }
    deps.state.manualCloseQueue.add(arg);
    await ctx.reply(
      `Queued ${shortKey(arg)} for forced close on next cycle. Run /cycle to execute now.`
    );
  });

  // Catch-all for unknown commands
  bot.on("text", (ctx) => {
    if (ctx.message.text.startsWith("/")) {
      ctx.reply("Unknown command. Try /help");
    }
  });

  const notifier: Notifier = {
    notify: async (msg: string) => {
      try {
        await bot.telegram.sendMessage(allowedChatId, msg, {
          link_preview_options: { is_disabled: true },
        });
      } catch (e) {
        log.error(`Telegram notify failed: ${(e as Error).message}`);
      }
    },
  };

  return {
    start: async () => {
      // Register command menu
      await bot.telegram.setMyCommands([
        { command: "start",     description: "Show welcome + commands" },
        { command: "status",    description: "Bot status (paused/running, last cycle)" },
        { command: "positions", description: "List all active DLMM positions" },
        { command: "pause",     description: "Stop executing close+swap (still monitors)" },
        { command: "resume",    description: "Resume executing close+swap" },
        { command: "cycle",     description: "Trigger a cycle now" },
        { command: "close",     description: "Force-close a specific position" },
        { command: "help",      description: "List all commands" },
      ]);
      // launch() returns a promise that resolves on stop; fire-and-forget.
      void bot.launch({ dropPendingUpdates: true });
      log.info("Telegram bot listening (long polling).");
    },
    stop: () => {
      bot.stop("SIGTERM");
    },
    notifier,
  };
}

/** Helper to format a Solscan tx link in Markdown. */
export function solscanTx(sig: string): string {
  return `[${sig.slice(0, 8)}…](https://solscan.io/tx/${sig})`;
}

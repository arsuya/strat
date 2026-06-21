/**
 * Main entry point.
 *
 *  - Main loop runs runCycle() every POLL_INTERVAL_SECONDS
 *  - Telegram /cycle command can also trigger runCycle() on demand
 *  - Both share a mutex so two cycles never overlap
 *  - state.paused controls whether close+swap actually executes
 *  - state.manualCloseQueue forces a specific position to close next cycle
 *  - All exec events (close, swap, errors) are notified to Telegram
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "./config";
import { log } from "./logger";
import { fetchPoolOhlc15m, Candle } from "./ohlc-feed";
import { rsi, bollingerBands, macd, smoothing } from "./indicators";
import { rangeStatus, closeDiscoveredPosition, RangeStatus } from "./meteora";
import { discoverPositions, DiscoveredPosition } from "./discovery";
import { swapAllToSol, SOL_MINT } from "./jupiter-swap";
import { BotState } from "./state";
import { makeTelegramBot, Notifier, solscanTx } from "./telegram";

interface IndicatorSnapshot {
  lastClose: number;
  rsiVal: number;
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  macdHist: number;
  macdHistPrev: number;
}

function minBarsForIndicators(): number {
  return (
    Math.max(
      config.bb.length,
      config.macd.slow + config.macd.signal,
      config.rsi.length + config.rsi.smoothingLength,
    ) + 2
  );
}

function computeIndicators(candles: Candle[]): IndicatorSnapshot | null {
  const closes = candles.map((c) => c.c);
  if (closes.length < minBarsForIndicators()) return null;
  const rsiRaw = rsi(closes, config.rsi.length);
  const rsiArr = smoothing(rsiRaw, "SMA", config.rsi.smoothingLength);
  const bb = bollingerBands(closes, config.bb.length, config.bb.mult);
  const m = macd(closes, config.macd.fast, config.macd.slow, config.macd.signal);
  const last = closes.length - 1;
  return {
    lastClose: closes[last],
    rsiVal: rsiArr[last],
    bbUpper: bb.upper[last],
    bbMiddle: bb.middle[last],
    bbLower: bb.lower[last],
    macdHist: m.histogram[last],
    macdHistPrev: m.histogram[last - 1],
  };
}

interface ExitDecision {
  shouldClose: boolean;
  reasons: string[];
}

function evaluateExit(
  range: RangeStatus,
  ind: IndicatorSnapshot | null
): ExitDecision {
  const reasons: string[] = [];
  if (range === "out_top") reasons.push("OUT_OF_RANGE_TOP");
  if (range === "out_bottom") reasons.push("OUT_OF_RANGE_BOTTOM");

  if (ind) {
    const rsiOver = ind.rsiVal > config.rsi.threshold;
    const priceAboveBB = ind.lastClose > ind.bbUpper;
    const macdJustGreen = ind.macdHist > 0 && ind.macdHistPrev <= 0;

    if (rsiOver && priceAboveBB) {
      reasons.push(
        `RSI_OVERBOUGHT_AND_PRICE_GT_BB_UPPER (rsi=${ind.rsiVal.toFixed(2)}, ` +
          `close=${ind.lastClose}, bbU=${ind.bbUpper.toFixed(6)})`
      );
    }
    if (rsiOver && macdJustGreen) {
      reasons.push(
        `RSI_OVERBOUGHT_AND_MACD_FIRST_GREEN (rsi=${ind.rsiVal.toFixed(2)}, ` +
          `hist=${ind.macdHist.toFixed(6)}, prev=${ind.macdHistPrev.toFixed(6)})`
      );
    }
  }
  return { shouldClose: reasons.length > 0, reasons };
}

function getMonitorPubkey(): PublicKey {
  return config.monitorPubkey!;
}

function shortKey(m: string | PublicKey): string {
  const s = typeof m === "string" ? m : m.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function formatSnapshot(
  p: DiscoveredPosition,
  range: RangeStatus,
  ind: IndicatorSnapshot | null,
  candleCount: number
): string {
  const indStr = ind
    ? `close=${ind.lastClose.toFixed(6)} rsi=${ind.rsiVal.toFixed(2)} ` +
      `bbU=${ind.bbUpper.toFixed(6)} hist=${ind.macdHist.toFixed(6)} ` +
      `histPrev=${ind.macdHistPrev.toFixed(6)}`
    : `(insufficient OHLC: ${candleCount}/${minBarsForIndicators()} candles)`;
  return (
    `  position=${shortKey(p.positionAddress)} ` +
    `pool=${shortKey(p.poolAddress)} ` +
    `bins=[${p.lowerBinId}..${p.upperBinId}] active=${p.activeBinId} ` +
    `range=${range} | ${indStr}`
  );
}

async function sweepPositionTokensToSol(
  connection: Connection,
  position: DiscoveredPosition,
  notifier: Notifier
): Promise<void> {
  for (const mint of [position.tokenXMint, position.tokenYMint]) {
    if (mint.toBase58() === SOL_MINT) continue;
    try {
      const sig = await swapAllToSol({
        connection,
        wallet: config.wallet!,
        inputMint: mint,
        slippageBps: config.swapSlippageBps,
        apiKey: config.jupiterApiKey || undefined,
        dryRun: config.dryRun,
      });
      if (sig) {
        await notifier.notify(
          `💱 Swapped to SOL ${shortKey(mint.toBase58())}\nTx: ${solscanTx(sig)}`
        );
      }
    } catch (e) {
      const msg = (e as Error).message;
      log.error(`swap-to-SOL failed for ${mint.toBase58()}: ${msg}`);
      await notifier.notify(
        `❌ Swap failed for ${shortKey(mint.toBase58())}\n${msg}`
      );
    }
  }
}

async function runCycle(
  connection: Connection,
  state: BotState,
  notifier: Notifier
): Promise<void> {
  const cycleStart = Math.floor(Date.now() / 1000);

  const positions = await discoverPositions({
    connection,
    walletPubkey: getMonitorPubkey(),
    poolFilter: config.poolFilter,
  });

  const uniquePools = Array.from(
    new Set(positions.map((p) => p.poolAddress.toBase58()))
  );

  state.lastCycle = {
    at: cycleStart,
    positionCount: positions.length,
    poolCount: uniquePools.length,
  };

  if (positions.length === 0) {
    log.info("No DLMM positions found.");
    return;
  }
  log.info(
    `Found ${positions.length} position(s) across ${uniquePools.length} pool(s).`
  );

  // Fetch OHLC per pool — gunakan pool Meteora sendiri (akurat)
  const ohlcByPool = new Map<string, Candle[]>();
  await Promise.all(
    uniquePools.map(async (poolAddr) => {
      try {
        const candles = await fetchPoolOhlc15m({ poolAddress: poolAddr });
        ohlcByPool.set(poolAddr, candles);
      } catch (e) {
        log.error(`OHLC fetch failed for pool ${poolAddr}: ${(e as Error).message}`);
        ohlcByPool.set(poolAddr, []);
      }
    })
  );

  for (const p of positions) {
    const candles = ohlcByPool.get(p.poolAddress.toBase58()) ?? [];
    const ind = computeIndicators(candles);
    const range = rangeStatus(p);
    log.info(formatSnapshot(p, range, ind, candles.length));

    const decision = evaluateExit(range, ind);

    // Telegram /close override
    const posKey = p.positionAddress.toBase58();

    // ---- Warmup: require 1 candle (15 min) before close can execute ----
    const CANDLE_SEC = 15 * 60;
    if (!state.positionFirstSeen.has(posKey)) {
      state.positionFirstSeen.set(posKey, cycleStart);
      log.info(`    -> WARMUP: position first seen, close locked for ${CANDLE_SEC}s`);
    }
    const firstSeen = state.positionFirstSeen.get(posKey)!;
    const ageSec = cycleStart - firstSeen;
    if (ageSec < CANDLE_SEC) {
      const remaining = CANDLE_SEC - ageSec;
      log.info(`    -> WARMUP: ${remaining}s remaining before close is allowed`);
      if (decision.shouldClose) {
        // Notify ONCE per position per warmup period
        if (!state.warmupSignalNotified.has(posKey)) {
          state.warmupSignalNotified.add(posKey);
          await notifier.notify(
            `🕐 Exit signal detected but position in warmup (${Math.ceil(remaining / 60)}m remaining)\n` +
            `position: ${shortKey(posKey)}\n` +
            `reasons: ${decision.reasons.join(", ")}`
          );
        }
        decision.shouldClose = false;
        decision.reasons = [];
      }
      continue;
    }

    if (state.manualCloseQueue.has(posKey)) {
      decision.shouldClose = true;
      decision.reasons.push("MANUAL_CLOSE_VIA_TELEGRAM");
      state.manualCloseQueue.delete(posKey);
    }

    if (!decision.shouldClose) {
      log.info(`    -> HOLD`);
      continue;
    }

    log.signal(`    -> CLOSE triggered for ${posKey}`);
    for (const r of decision.reasons) log.signal(`       reason: ${r}`);

    const reasonList = decision.reasons.map((r) => `• ${r}`).join("\n");
    await notifier.notify(
      `🚨 Exit triggered\nposition: ${shortKey(posKey)}\npool: ${shortKey(
        p.poolAddress.toBase58()
      )}\n${reasonList}`
    );

    if (state.paused) {
      log.warn(`    -> Bot paused. Skipping execution.`);
      await notifier.notify(
        `⏸ Bot is paused — execution skipped. Send /resume to enable.`
      );
      continue;
    }

    if (config.monitorOnly) {
      log.warn(`    -> MONITOR_ONLY mode. Skipping execution.`);
      await notifier.notify(`👁 MONITOR_ONLY — execution skipped.`);
      continue;
    }

    if (config.dryRun) {
      log.warn(`    -> DRY_RUN=true. Skipping execution.`);
      await notifier.notify(`🧪 DRY_RUN=true — execution skipped.`);
      continue;
    }

    try {
      const sigs = await closeDiscoveredPosition({
        connection,
        wallet: config.wallet!,
        position: p,
        slippageBps: config.slippageBps,
      });
      log.info(`    -> Closed. tx(s): ${sigs.join(", ")}`);
      const txLinks = sigs.map(solscanTx).join("\n");
      await notifier.notify(
        `✅ Position closed ${shortKey(posKey)}\n${txLinks}`
      );
    } catch (e) {
      const msg = (e as Error).message;
      log.error(`    -> Close failed: ${msg}`);
      await notifier.notify(
        `❌ Close failed ${shortKey(posKey)}\n${msg}`
      );
      continue;
    }

    await new Promise((r) => setTimeout(r, 2000));
    log.info(`    -> Sweeping pool tokens to SOL via Jupiter...`);
    await sweepPositionTokensToSol(connection, p, notifier);
  }

  // Clean up stale position entries (positions that no longer exist)
  const activeKeys = new Set(positions.map((p) => p.positionAddress.toBase58()));
  for (const key of state.positionFirstSeen.keys()) {
    if (!activeKeys.has(key)) {
      state.positionFirstSeen.delete(key);
      state.warmupSignalNotified.delete(key);
    }
  }
}

/** Run a cycle, capturing errors into state.lastCycle.error. */
async function runCycleSafe(
  connection: Connection,
  state: BotState,
  notifier: Notifier
): Promise<void> {
  try {
    await runCycle(connection, state, notifier);
  } catch (e) {
    const msg = (e as Error).message;
    log.error(`Cycle failed: ${msg}`);
    if (state.lastCycle) state.lastCycle.error = msg;
    await notifier.notify(`❌ Cycle error\n${msg}`);
  }
}

async function main(): Promise<void> {
  log.info("=== Meteora Exit Bot starting ===");
  log.info(`Mode: ${config.monitorOnly ? "MONITOR_ONLY (no private key)" : config.dryRun ? "DRY_RUN (no transactions)" : "LIVE"}`);
  log.info(`Wallet: ${getMonitorPubkey().toBase58()}`);
  log.info(
    `Discovery: ${
      config.poolFilter
        ? `whitelist [${config.poolFilter.map((p) => shortKey(p)).join(", ")}]`
        : "ALL pools where wallet has DLMM positions"
    }`
  );
  log.info(`OHLC source: GeckoTerminal (15m candles)`);
  log.info(
    `Exit: RSI(${config.rsi.length}, sma${config.rsi.smoothingLength}) > ${config.rsi.threshold}, ` +
      `BB(${config.bb.length}, ${config.bb.mult}), ` +
      `MACD(${config.macd.fast},${config.macd.slow},${config.macd.signal}).`
  );

  const connection = new Connection(config.rpcUrl, "confirmed");
  const state = new BotState();

  // ---- Mutex: only one cycle at a time ----
  let cycleInFlight: Promise<void> | null = null;

  // Build the trigger that both the main loop and /cycle command call.
  // Stage a placeholder so we can pass it into Telegram setup; we'll fill in
  // `notifier` once the Telegram bot is built.
  let notifier: Notifier;

  const triggerCycle = async (): Promise<void> => {
    if (cycleInFlight) {
      // A cycle is already running. Wait for it and return — don't start a
      // second one.
      await cycleInFlight;
      return;
    }
    cycleInFlight = runCycleSafe(connection, state, notifier);
    try {
      await cycleInFlight;
    } finally {
      cycleInFlight = null;
    }
  };

  // ---- Telegram setup ----
  const tg = makeTelegramBot({
    token: config.telegramBotToken,
    allowedChatId: config.telegramChatId,
    deps: {
      state,
      getPositions: () =>
        discoverPositions({
          connection,
          walletPubkey: getMonitorPubkey(),
          poolFilter: config.poolFilter,
        }),
      triggerCycle,
    },
  });
  notifier = tg.notifier;

  await tg.start();
  await notifier.notify(
    `🚀 Meteora Exit Bot online\nmode: ${config.monitorOnly ? "MONITOR_ONLY" : config.dryRun ? "DRY_RUN" : "LIVE"}\nwallet: ${shortKey(
      getMonitorPubkey().toBase58()
    )}`
  );

  // ---- Graceful shutdown ----
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log.info("Shutdown signal received, exiting after current cycle...");
    tg.stop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // ---- Main loop ----
  while (!stopping) {
    await triggerCycle();
    if (stopping) break;
    await new Promise((r) => setTimeout(r, config.pollIntervalSeconds * 1000));
  }
  log.info("Bot stopped.");
}

main().catch((e) => {
  log.error("Fatal:", e);
  process.exit(1);
});

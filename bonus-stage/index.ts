/**
 * Bonus Stage Strat detector — main entry.
 *
 * High level:
 *   1. Every POLL_INTERVAL_SECONDS, discover the wallet's open DLMM positions.
 *   2. Reduce to unique pools (= pools where the user has at least one
 *      position, i.e. evil-panda-strat active pools).
 *   3. For each such pool, fetch CLOSED 15m candles from GeckoTerminal.
 *   4. Compute supertrend(length=10, factor=3) on those candles.
 *   5. Compare last direction (cached per pool) to current direction:
 *        - First observation of a pool:
 *            * If current = RED, treat as "already past the transition" and
 *              mark notifiedAt=now (suppresses notification). This is the
 *              restart-safe behavior — we can't prove this was a fresh
 *              green→red, so we stay silent.
 *            * If current = GREEN, store and wait.
 *        - Subsequent observations:
 *            * If lastDirection=GREEN and current=RED and not yet notified
 *              (or REPEAT_NOTIFICATIONS=true) → fire Telegram notification.
 *   6. Save state. Prune entries for pools that no longer have positions
 *      (they'll be re-armed if the wallet re-enters them later).
 *
 * Exit handling: NONE. When strat_exit closes a position in a pool, it closes
 * ALL of the wallet's positions in that pool — including any bonus-stage
 * adds. So this detector does not need to track exits.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "./config";
import { log } from "./logger";
import { fetchPoolOhlc15m, Candle } from "./ohlc-feed";
import { supertrendLast, colorLabel, SupertrendDirection } from "./indicators";
import { discoverPositions, DiscoveredPosition } from "./discovery";
import { BotState, PoolState } from "./state";
import { makeHttpNotifier, resolvePoolMeta, Notifier } from "./telegram";

function shortKey(s: string | PublicKey): string {
  const str = typeof s === "string" ? s : s.toBase58();
  return str.length < 12 ? str : `${str.slice(0, 4)}…${str.slice(-4)}`;
}

interface PoolInfo {
  poolAddress: PublicKey;
  positions: DiscoveredPosition[];
  tokenXMint: PublicKey;
  tokenYMint: PublicKey;
}

function groupByPool(positions: DiscoveredPosition[]): Map<string, PoolInfo> {
  const map = new Map<string, PoolInfo>();
  for (const p of positions) {
    const key = p.poolAddress.toBase58();
    const existing = map.get(key);
    if (existing) {
      existing.positions.push(p);
    } else {
      map.set(key, {
        poolAddress: p.poolAddress,
        positions: [p],
        tokenXMint: p.tokenXMint,
        tokenYMint: p.tokenYMint,
      });
    }
  }
  return map;
}

async function formatNotification(
  poolAddress: string,
  tokenXMint: string,
  tokenYMint: string,
  price: number,
  supertrendValue: number,
  positionCount: number
): Promise<string> {
  const meta = await resolvePoolMeta(poolAddress, tokenXMint, tokenYMint);

  // Pick which name corresponds to the base token (the one that's not SOL/USDC/USDT).
  const baseName = meta.baseAddress === tokenXMint ? meta.nameX : meta.nameY;
  const quoteName = meta.baseAddress === tokenXMint ? meta.nameY : meta.nameX;

  const priceStr = price > 0 && price < 0.01
    ? price.toExponential(4)
    : price.toFixed(price < 1 ? 6 : 4);

  return (
    `🎯 BONUS STAGE — ${baseName}\n` +
    `Pair: ${baseName} / ${quoteName}\n` +
    `Supertrend (10, 3) flipped GREEN → RED on closed 15m candle.\n` +
    `\n` +
    `Price: $${priceStr}\n` +
    `Supertrend level: ${supertrendValue.toExponential(4)}\n` +
    `Active positions in pool: ${positionCount}\n` +
    `\n` +
    `CA: ${meta.baseAddress}\n` +
    `https://gmgn.ai/sol/token/${meta.baseAddress} | ` +
    `https://dexscreener.com/solana/${poolAddress}\n` +
    `\n` +
    `(Open a manual position now if you want to ride the bonus stage. ` +
    `strat_exit will close it together with your evil panda entry.)`
  );
}

async function processPool(
  pool: PoolInfo,
  state: BotState,
  notifier: Notifier,
  cycleStart: number
): Promise<void> {
  const poolKey = pool.poolAddress.toBase58();

  let candles: Candle[] = [];
  try {
    candles = await fetchPoolOhlc15m({ poolAddress: poolKey });
  } catch (e) {
    log.error(`OHLC fetch failed for pool ${poolKey}: ${(e as Error).message}`);
    return;
  }

  if (candles.length < config.supertrend.length + 2) {
    log.info(
      `  pool=${shortKey(poolKey)} insufficient candles (${candles.length}/${config.supertrend.length + 2}), skip`
    );
    return;
  }

  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const closes = candles.map((c) => c.c);

  const st = supertrendLast(
    highs,
    lows,
    closes,
    config.supertrend.length,
    config.supertrend.factor
  );
  if (!st) {
    log.info(`  pool=${shortKey(poolKey)} supertrend not yet defined, skip`);
    return;
  }

  const currentDir = st.direction as -1 | 1;
  const currentColor = colorLabel(currentDir);
  const lastClose = closes[closes.length - 1];

  log.info(
    `  pool=${shortKey(poolKey)} positions=${pool.positions.length} ` +
      `close=${lastClose} st=${st.value.toExponential(3)} color=${currentColor}`
  );

  const existing = state.pools.get(poolKey);

  // ----- First observation of this pool in current lifetime -----
  if (!existing) {
    const initial: PoolState = {
      lastDirection: currentDir,
      // If we're seeing RED right at first observation, we can't prove this
      // was a fresh green→red transition (the bot might have started up after
      // the transition already happened). Suppress to avoid duplicates.
      notifiedAt: currentDir === 1 ? cycleStart : null,
      firstSeenAt: cycleStart,
    };
    state.pools.set(poolKey, initial);
    state.save();
    log.info(
      `    -> first observation, init lastDirection=${currentColor}` +
        (initial.notifiedAt ? " (suppressed — already red at startup)" : "")
    );
    return;
  }

  // ----- Subsequent observation -----
  const wasGreen = existing.lastDirection === -1;
  const isRed = currentDir === 1;
  const transitioned = wasGreen && isRed;

  // Update lastDirection regardless of notification logic.
  existing.lastDirection = currentDir;

  // If we went from RED back to GREEN, this means the pool's "lifetime"
  // has cycled. Re-arm so the next green→red can fire again.
  if (currentDir === -1 && existing.notifiedAt !== null) {
    log.info(`    -> direction returned to GREEN, re-arming notifier`);
    existing.notifiedAt = null;
  }

  if (transitioned) {
    const canNotify = existing.notifiedAt === null || config.repeatNotifications;
    if (canNotify) {
      log.signal(`    -> GREEN→RED transition on ${shortKey(poolKey)}, NOTIFYING`);
      try {
        const msg = await formatNotification(
          poolKey,
          pool.tokenXMint.toBase58(),
          pool.tokenYMint.toBase58(),
          lastClose,
          st.value,
          pool.positions.length
        );
        await notifier.notify(msg);
        existing.notifiedAt = cycleStart;
      } catch (e) {
        log.error(`    -> notify failed: ${(e as Error).message}`);
      }
    } else {
      log.info(`    -> GREEN→RED transition but already notified this lifetime, skip`);
    }
  } else {
    log.info(`    -> no transition (${colorLabel(existing.lastDirection)}→${currentColor})`);
  }

  state.save();
}

async function runCycle(
  connection: Connection,
  state: BotState,
  notifier: Notifier
): Promise<void> {
  const cycleStart = Math.floor(Date.now() / 1000);

  const positions = await discoverPositions({
    connection,
    walletPubkey: config.monitorPubkey,
    poolFilter: config.poolFilter,
  });

  if (positions.length === 0) {
    log.info("No DLMM positions found.");
    // Prune all state — no active pools.
    const pruned = state.pruneInactive(new Set());
    if (pruned > 0) log.info(`Pruned ${pruned} stale pool state(s).`);
    return;
  }

  const pools = groupByPool(positions);
  log.info(
    `Found ${positions.length} position(s) across ${pools.size} pool(s) — checking supertrend.`
  );

  // Process pools sequentially. GeckoTerminal calls go through gt_fetch.py
  // which has its own rate-limit handling; staying sequential keeps the proxy
  // pool happy.
  for (const pool of pools.values()) {
    await processPool(pool, state, notifier, cycleStart);
  }

  // Drop state for pools where the wallet no longer has positions.
  const activePoolSet = new Set(pools.keys());
  const pruned = state.pruneInactive(activePoolSet);
  if (pruned > 0) log.info(`Pruned ${pruned} stale pool state(s).`);
}

async function runCycleSafe(
  connection: Connection,
  state: BotState,
  notifier: Notifier
): Promise<void> {
  try {
    await runCycle(connection, state, notifier);
  } catch (e) {
    log.error(`Cycle failed: ${(e as Error).message}`);
    await notifier.notify(`❌ Bonus Stage detector cycle error\n${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  log.info("=== Bonus Stage Strat Detector starting ===");
  log.info(`Wallet (monitor): ${config.monitorPubkey.toBase58()}`);
  log.info(
    `Pool filter: ${
      config.poolFilter
        ? `whitelist [${config.poolFilter.map((p) => shortKey(p)).join(", ")}]`
        : "ALL pools where wallet has DLMM positions"
    }`
  );
  log.info(`OHLC source: GeckoTerminal (15m candles, closed only)`);
  log.info(
    `Signal: Supertrend(length=${config.supertrend.length}, factor=${config.supertrend.factor}) green → red`
  );
  log.info(
    `Re-notify policy: ${
      config.repeatNotifications
        ? "every green→red transition"
        : "once per pool lifetime"
    }`
  );
  log.info(`State file: ${config.statePath}`);

  const connection = new Connection(config.rpcUrl, "confirmed");
  const state = new BotState(config.statePath);
  const notifier = makeHttpNotifier(config.telegramBotToken, config.telegramChatId);

  await notifier.notify(
    `🚀 Bonus Stage detector online\n` +
      `wallet: ${shortKey(config.monitorPubkey.toBase58())}\n` +
      `supertrend: length=${config.supertrend.length}, factor=${config.supertrend.factor}`
  );

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log.info("Shutdown signal received, exiting after current cycle…");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    await runCycleSafe(connection, state, notifier);
    if (stopping) break;
    await new Promise((r) => setTimeout(r, config.pollIntervalSeconds * 1000));
  }
  log.info("Bot stopped.");
}

main().catch((e) => {
  log.error("Fatal:", e);
  process.exit(1);
});

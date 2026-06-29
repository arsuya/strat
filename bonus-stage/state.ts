/**
 * Runtime state for the Bonus Stage Strat detector.
 *
 * Tracked per POOL (not per position) because:
 *   - The signal is a property of the pool's price action, not a specific
 *     position.
 *   - User may open multiple positions in the same pool (the original evil
 *     panda entry + the bonus stage entry). We don't want to multi-notify.
 *
 * Persisted to disk so a restart doesn't lose track of which pools we've
 * already notified for. Without persistence, a PM2 restart mid-cycle would
 * re-notify the same pool.
 */
import fs from "fs";
import { log } from "./logger";

export interface PoolState {
  /**
   * Last observed supertrend direction on a CLOSED 15m candle.
   * -1 = green (uptrend), +1 = red (downtrend).
   */
  lastDirection: -1 | 1;

  /**
   * Unix timestamp of when we sent the bonus-stage notification for the
   * current "lifetime" of this pool (= since the wallet last had zero
   * positions in this pool). null if not yet notified.
   */
  notifiedAt: number | null;

  /** Unix timestamp when we first observed this pool with an active position. */
  firstSeenAt: number;
}

interface SerializedState {
  pools: Record<string, PoolState>;
}

export class BotState {
  /** Map: pool address (base58) → state. */
  public pools: Map<string, PoolState> = new Map();

  private path: string;

  constructor(path: string) {
    this.path = path;
    this.load();
  }

  /** Load state from disk if the file exists. */
  private load(): void {
    try {
      if (!fs.existsSync(this.path)) return;
      const raw = fs.readFileSync(this.path, "utf-8");
      const parsed = JSON.parse(raw) as SerializedState;
      if (parsed && parsed.pools) {
        this.pools = new Map(Object.entries(parsed.pools));
        log.info(`State loaded: ${this.pools.size} pool(s) tracked`);
      }
    } catch (e) {
      log.warn(`Could not load state from ${this.path}: ${(e as Error).message}`);
    }
  }

  /** Persist state to disk. Called after any mutation. */
  save(): void {
    try {
      const obj: SerializedState = { pools: Object.fromEntries(this.pools) };
      // Atomic-ish write: write to temp then rename.
      const tmp = `${this.path}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
      fs.renameSync(tmp, this.path);
    } catch (e) {
      log.warn(`Could not save state to ${this.path}: ${(e as Error).message}`);
    }
  }

  /**
   * Remove entries for pools the wallet no longer has any position in.
   * Returns the number of entries pruned.
   */
  pruneInactive(activePools: Set<string>): number {
    let pruned = 0;
    for (const key of Array.from(this.pools.keys())) {
      if (!activePools.has(key)) {
        this.pools.delete(key);
        pruned++;
      }
    }
    if (pruned > 0) this.save();
    return pruned;
  }
}

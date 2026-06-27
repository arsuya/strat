/**
 * Runtime state shared between the main loop and the Telegram command
 * handlers. Kept in memory; restarting the bot resets these.
 */
export interface LastCycleStats {
  at: number;          // unix seconds
  positionCount: number;
  poolCount: number;
  error?: string;
}

export class BotState {
  /** When true: bot still monitors and notifies, but does NOT execute close+swap. */
  paused = false;

  /** Position addresses queued for forced close on next cycle, regardless of indicators. */
  manualCloseQueue: Set<string> = new Set();

  /** Stats from the last completed cycle, surfaced by /status. */
  lastCycle: LastCycleStats | null = null;

  /**
   * Track when each position was first detected (unix seconds).
   * Close logic only activates after 1 candle (15 min) of observation.
   */
  positionFirstSeen: Map<string, number> = new Map();

  /** Positions that already received a warmup-signal notification — prevents spam. */
  warmupSignalNotified: Set<string> = new Set();
}

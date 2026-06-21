/**
 * Meteora DLMM helpers: range check + close position.
 *
 * Position discovery now lives in src/discovery.ts. This file only handles
 * actions performed on a specific position.
 */
import DLMM from "@meteora-ag/dlmm";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { DiscoveredPosition } from "./discovery";
import { log } from "./logger";

export type RangeStatus = "in_range" | "out_top" | "out_bottom";

export function rangeStatus(p: DiscoveredPosition): RangeStatus {
  if (p.activeBinId > p.upperBinId) return "out_top";
  if (p.activeBinId < p.lowerBinId) return "out_bottom";
  return "in_range";
}

/**
 * Close a position: remove 100% of liquidity, claim fees/rewards, close the
 * position account in one go using `shouldClaimAndClose: true`.
 *
 * Creates a fresh DLMM instance for the position's pool — lazy is fine since
 * we only do this when we actually fire an exit.
 */
export async function closeDiscoveredPosition(opts: {
  connection: Connection;
  wallet: Keypair;
  position: DiscoveredPosition;
  slippageBps: number;
}): Promise<string[]> {
  const { connection, wallet, position, slippageBps } = opts;

  const dlmm = await (DLMM as any).create(connection, position.poolAddress);

  const binIds = position.binIds.length
    ? position.binIds
    : Array.from(
        { length: position.upperBinId - position.lowerBinId + 1 },
        (_, i) => position.lowerBinId + i
      );

  let rawTxResult: any;
  try {
    rawTxResult = await dlmm.removeLiquidity({
      position: position.positionAddress,
      user: wallet.publicKey,
      binIds,
      bps: new BN(100 * 100),
      shouldClaimAndClose: true,
      slippage: slippageBps / 100,
    });
    log.info(`  removeLiquidity (binIds) returned: ${JSON.stringify(Array.isArray(rawTxResult) ? `[${rawTxResult.length} tx(s)]` : typeof rawTxResult)}`);
  } catch (e) {
    log.warn("removeLiquidity (binIds) threw, will retry:", (e as Error).message);
    rawTxResult = [];  // force empty → retry
  }

  // If binIds returned empty, retry with fromBinId/toBinId
  if (Array.isArray(rawTxResult) && rawTxResult.length === 0) {
    log.info("  binIds returned 0 tx(s), retrying with fromBinId/toBinId...");
    rawTxResult = await dlmm.removeLiquidity({
      position: position.positionAddress,
      user: wallet.publicKey,
      fromBinId: position.lowerBinId,
      toBinId: position.upperBinId,
      bps: new BN(100 * 100),
      shouldClaimAndClose: true,
      slippage: slippageBps / 100,
    });
    log.info(`  removeLiquidity (fromBinId/toBinId) returned: ${JSON.stringify(Array.isArray(rawTxResult) ? `[${rawTxResult.length} tx(s)]` : typeof rawTxResult)}`);
  }

  const txs: Transaction[] = Array.isArray(rawTxResult) ? rawTxResult : [rawTxResult];

  if (txs.length === 0 || (txs.length === 1 && !txs[0])) {
    throw new Error("removeLiquidity returned empty — position may have no liquidity or is already closed");
  }

  const signatures: string[] = [];
  for (const tx of txs) {
    if (!tx) throw new Error("removeLiquidity returned null transaction");
    tx.feePayer = wallet.publicKey;
    // DLMM SDK already includes compute budget — don't add another
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet], {
      skipPreflight: false,
      commitment: "confirmed",
    });
    signatures.push(sig);
    log.info(`  tx confirmed: ${sig}`);
  }
  return signatures;
}

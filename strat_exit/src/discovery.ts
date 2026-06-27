/**
 * Auto-discover all Meteora DLMM positions owned by the wallet.
 *
 * Note: since OHLC now comes from GeckoTerminal per-pool, we no longer need
 * to pick a "base token" for price tracking — GeckoTerminal returns USD
 * price for the pool's base token automatically.
 */
import DLMM from "@meteora-ag/dlmm";
import { Connection, PublicKey } from "@solana/web3.js";
import { log } from "./logger";

export interface DiscoveredPosition {
  poolAddress: PublicKey;
  activeBinId: number;
  positionAddress: PublicKey;
  lowerBinId: number;
  upperBinId: number;
  binIds: number[];
  tokenXMint: PublicKey;
  tokenYMint: PublicKey;
  binStep: number | null;
  raw: any;
}

/**
 * Find every DLMM position the wallet owns.
 */
export async function discoverPositions(opts: {
  connection: Connection;
  walletPubkey: PublicKey;
  poolFilter: PublicKey[] | null; // null = no filter
}): Promise<DiscoveredPosition[]> {
  const { connection, walletPubkey, poolFilter } = opts;

  // Map<lbPairAddress(base58), { lbPair, lbPairPositionsData, tokenX, tokenY, ... }>
  const map: Map<string, any> = await (DLMM as any).getAllLbPairPositionsByUser(
    connection,
    walletPubkey
  );

  const out: DiscoveredPosition[] = [];

  for (const [poolAddrStr, entry] of map.entries()) {
    const poolAddress = new PublicKey(poolAddrStr);
    if (poolFilter && !poolFilter.some((p) => p.equals(poolAddress))) continue;

    const lbPair = entry.lbPair ?? entry;
    const tokenXMint: PublicKey | undefined =
      entry.tokenX?.publicKey ??
      entry.tokenX?.mint ??
      lbPair?.tokenXMint;
    const tokenYMint: PublicKey | undefined =
      entry.tokenY?.publicKey ??
      entry.tokenY?.mint ??
      lbPair?.tokenYMint;
    if (!tokenXMint || !tokenYMint) {
      log.warn(`discovery: could not resolve token mints for pool ${poolAddrStr}, skipping`);
      continue;
    }

    const activeBinId: number =
      lbPair?.activeId ?? entry.activeId ?? entry.activeBin?.binId;
    if (typeof activeBinId !== "number") {
      log.warn(`discovery: could not resolve active bin for pool ${poolAddrStr}, skipping`);
      continue;
    }

    const binStep: number | null =
      lbPair?.binStep ?? lbPair?.parameters?.binStep ?? null;

    const positions = entry.lbPairPositionsData ?? entry.positions ?? [];
    for (const pos of positions) {
      const data = pos.positionData ?? pos;
      const lower: number = data.lowerBinId;
      const upper: number = data.upperBinId;
      const binIds: number[] = (data.positionBinData ?? [])
        .map((b: any) => b.binId as number)
        .sort((a: number, b: number) => a - b);

      out.push({
        poolAddress,
        activeBinId,
        positionAddress: pos.publicKey,
        lowerBinId: lower,
        upperBinId: upper,
        binIds,
        tokenXMint,
        tokenYMint,
        binStep,
        raw: pos,
      });
    }
  }

  return out;
}

/**
 * Jupiter Swap V1 — swap token balances back to SOL after a position is closed.
 *
 * Flow:
 *   1. Look up the wallet's ATA balance for the input token.
 *   2. Fetch a quote from /swap/v1/quote.
 *   3. POST /swap/v1/swap to get a serialized versioned transaction.
 *   4. Sign and send.
 *
 * `wrapAndUnwrapSol: true` ensures that when outputMint is the WSOL mint, the
 * received WSOL is unwrapped back into native SOL (and any temporary WSOL ATA
 * is closed, returning rent).
 */
import fetch from "node-fetch";
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { log } from "./logger";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Get the raw token balance (smallest units) the wallet holds for `tokenMint`.
 * Returns "0" if the ATA doesn't exist or has no balance.
 */
async function getTokenBalanceRaw(
  connection: Connection,
  owner: PublicKey,
  tokenMint: PublicKey
): Promise<string> {
  // Try both standard SPL token and Token-2022 programs.
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const ata = await getAssociatedTokenAddress(
        tokenMint,
        owner,
        true,
        programId
      );
      const info = await connection.getTokenAccountBalance(ata, "confirmed");
      if (info?.value?.amount && info.value.amount !== "0") {
        return info.value.amount;
      }
    } catch {
      // ATA may not exist or wrong program; try the next.
    }
  }
  return "0";
}

/**
 * Swap the wallet's entire balance of `inputMint` into SOL.
 * Returns the transaction signature, or null if nothing to swap.
 */
export async function swapAllToSol(opts: {
  connection: Connection;
  wallet: Keypair;
  inputMint: PublicKey;
  slippageBps: number;
  apiKey?: string;
  dryRun: boolean;
}): Promise<string | null> {
  const { connection, wallet, inputMint, slippageBps, apiKey, dryRun } = opts;

  if (inputMint.toBase58() === SOL_MINT) {
    log.info(`  swap: ${inputMint.toBase58()} is already SOL, skipping.`);
    return null;
  }

  // We retry the balance lookup a few times because RPC can lag right after
  // a position-close transaction.
  let amount = "0";
  for (let attempt = 0; attempt < 5; attempt++) {
    amount = await getTokenBalanceRaw(connection, wallet.publicKey, inputMint);
    if (amount !== "0") break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (amount === "0") {
    log.info(`  swap: no balance found for ${inputMint.toBase58()}, skipping.`);
    return null;
  }
  log.info(
    `  swap: ${inputMint.toBase58()} amount=${amount} (raw) -> SOL (slippage ${slippageBps}bps)`
  );

  const base = apiKey ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    accept: "application/json",
  };
  if (apiKey) headers["x-api-key"] = apiKey;

  // 1. Quote
  const quoteUrl =
    `${base}/quote?inputMint=${inputMint.toBase58()}` +
    `&outputMint=${SOL_MINT}` +
    `&amount=${amount}` +
    `&slippageBps=${slippageBps}` +
    `&restrictIntermediateTokens=true`;
  const quoteRes = await fetch(quoteUrl, { headers });
  if (!quoteRes.ok) {
    throw new Error(`Jupiter quote ${quoteRes.status}: ${await quoteRes.text()}`);
  }
  const quote: any = await quoteRes.json();
  log.info(
    `  swap: quote outAmount=${quote.outAmount} priceImpact=${quote.priceImpactPct}`
  );

  if (dryRun) {
    log.warn(`  swap: DRY_RUN=true, not sending swap tx.`);
    return null;
  }

  // 2. Swap-tx build
  const swapRes = await fetch(`${base}/swap`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      // Let Jupiter pick a reasonable priority fee
      prioritizationFeeLamports: "auto",
    }),
  });
  if (!swapRes.ok) {
    throw new Error(`Jupiter swap ${swapRes.status}: ${await swapRes.text()}`);
  }
  const { swapTransaction } = (await swapRes.json()) as { swapTransaction: string };
  if (!swapTransaction) {
    throw new Error("Jupiter /swap did not return a swapTransaction");
  }

  // 3. Sign + send
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([wallet]);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  log.info(`  swap: tx sent ${sig}, confirming...`);
  const conf = await connection.confirmTransaction(sig, "confirmed");
  if (conf.value.err) {
    throw new Error(`Swap tx failed: ${JSON.stringify(conf.value.err)}`);
  }
  log.info(`  swap: tx confirmed ${sig}`);
  return sig;
}

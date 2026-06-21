"""
Jupiter Swap — swap token balances back to SOL after a position is closed.

Flow:
  1. Look up the wallet's ATA balance for the input token.
  2. Fetch a quote from /swap/v1/quote.
  3. POST /swap/v1/swap to get a serialized versioned transaction.
  4. Sign and send.

`wrapAndUnwrapSol: true` ensures that when outputMint is the WSOL mint, the
received WSOL is unwrapped back into native SOL (and any temporary WSOL ATA
is closed, returning rent).
"""

import asyncio
import base64
import logging
from typing import Optional

import httpx
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.transaction import VersionedTransaction
from solana.rpc.api import Client
from solana.rpc.commitment import Confirmed
from solana.rpc.types import TxOpts
from spl.token.constants import TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID
from spl.token.instructions import get_associated_token_address

logger = logging.getLogger(__name__)

SOL_MINT = "So11111111111111111111111111111111111111112"


async def _get_token_balance_raw(
    client: Client, owner: Pubkey, token_mint: Pubkey
) -> str:
    """Get the raw token balance (smallest units) the wallet holds for `token_mint`.

    Returns "0" if the ATA doesn't exist or has no balance.
    """
    for program_id in (TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID):
        try:
            ata = get_associated_token_address(owner, token_mint, program_id)
            resp = client.get_token_account_balance(ata, commitment=Confirmed)
            amount = resp.value.amount if resp.value else "0"
            if amount and amount != "0":
                return amount
        except Exception:
            # ATA may not exist or wrong program; try the next.
            pass
    return "0"


async def swap_all_to_sol(
    client: Client,
    wallet: Keypair,
    input_mint: Pubkey,
    slippage_bps: int = 100,
    jupiter_api_key: Optional[str] = None,
    dry_run: bool = False,
) -> Optional[str]:
    """
    Swap the wallet's entire balance of `input_mint` into SOL.

    Returns the transaction signature, or None if nothing to swap.
    """
    if str(input_mint) == SOL_MINT:
        logger.info(f"  swap: {input_mint} is already SOL, skipping.")
        return None

    # Retry balance lookup — RPC can lag after a position-close tx
    amount = "0"
    for attempt in range(5):
        amount = await _get_token_balance_raw(client, wallet.pubkey(), input_mint)
        if amount != "0":
            break
        await asyncio.sleep(1.5)

    if amount == "0":
        logger.info(f"  swap: no balance found for {input_mint}, skipping.")
        return None

    logger.info(
        f"  swap: {input_mint} amount={amount} (raw) -> SOL (slippage {slippage_bps}bps)"
    )

    base_url = (
        "https://api.jup.ag/swap/v1"
        if jupiter_api_key
        else "https://lite-api.jup.ag/swap/v1"
    )
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if jupiter_api_key:
        headers["x-api-key"] = jupiter_api_key

    async with httpx.AsyncClient(timeout=30.0) as http:
        # 1. Quote
        quote_params = (
            f"inputMint={input_mint}"
            f"&outputMint={SOL_MINT}"
            f"&amount={amount}"
            f"&slippageBps={slippage_bps}"
            f"&restrictIntermediateTokens=true"
        )
        quote_url = f"{base_url}/quote?{quote_params}"
        quote_resp = await http.get(quote_url, headers=headers)
        if quote_resp.status_code != 200:
            raise RuntimeError(
                f"Jupiter quote {quote_resp.status_code}: {quote_resp.text}"
            )
        quote = quote_resp.json()
        logger.info(
            f"  swap: quote outAmount={quote.get('outAmount')} "
            f"priceImpact={quote.get('priceImpactPct')}"
        )

        if dry_run:
            logger.warning("  swap: DRY_RUN=true, not sending swap tx.")
            return None

        # 2. Swap-tx build
        swap_payload = {
            "quoteResponse": quote,
            "userPublicKey": str(wallet.pubkey()),
            "wrapAndUnwrapSol": True,
            "dynamicComputeUnitLimit": True,
            "prioritizationFeeLamports": "auto",
        }
        swap_resp = await http.post(f"{base_url}/swap", json=swap_payload, headers=headers)
        if swap_resp.status_code != 200:
            raise RuntimeError(
                f"Jupiter swap {swap_resp.status_code}: {swap_resp.text}"
            )
        swap_data = swap_resp.json()
        swap_transaction = swap_data.get("swapTransaction")
        if not swap_transaction:
            raise RuntimeError("Jupiter /swap did not return a swapTransaction")

    # 3. Sign + send
    tx_bytes = base64.b64decode(swap_transaction)
    tx = VersionedTransaction.from_bytes(tx_bytes)
    # Sign the message
    sig = wallet.sign_message(bytes(tx.message))
    signed_tx = VersionedTransaction.populate(tx.message, [sig])

    opts = TxOpts(skip_preflight=False, max_retries=3)
    send_resp = client.send_raw_transaction(bytes(signed_tx), opts)
    tx_sig = str(send_resp.value)
    logger.info(f"  swap: tx sent {tx_sig}, confirming...")

    conf = client.confirm_transaction(send_resp.value, commitment=Confirmed)
    if conf.value and conf.value.err:
        raise RuntimeError(f"Swap tx failed: {conf.value.err}")

    logger.info(f"  swap: tx confirmed {tx_sig}")
    return tx_sig

/**
 * One-time deep candle backfill — run from Jessica's Mac (same machine as the indexer daemon;
 * needs no Vercel function timeout, so it can just scan for as long as it takes).
 *
 *   npm run backfill-candles
 *   # or, for one token only:
 *   npm run backfill-candles -- 0x19209E55049bc613c5cC8b66B7DF7824096e78CF
 *
 * For every indexed token, scans Uniswap V3 Swap logs from its pool's createdBlock (resuming
 * from arc_candle_backfill_state.scanned_up_to_block on a rerun) up to the chain head at the time
 * this script started, folding them into 1-minute candles in the durable Supabase store — see
 * lib/arc-candle-store.ts. This is what actually recovers a token's pre-existing history (e.g.
 * EVE's Aug 21 → Sep 3 run); the live indexer cycle already keeps *new* history forever on its
 * own via recordTrades1m, it just never had anything to backfill the past with.
 *
 * Reuses resolvePool/scanSwapRange straight from lib/arc-trades.ts — the exact same pool
 * orientation and swap→trade conversion the live path uses — and recordTrades1m for the actual
 * write, so a backfilled candle can never disagree with what a live cycle would have computed for
 * the same blocks. Touches ONLY the arc_candles_1m / arc_candle_backfill_state tables — never the
 * KV trade tape, never its cursor. Safe to interrupt (Ctrl+C) and rerun; each token resumes from
 * its last completed chunk instead of rescanning from createdBlock.
 */
import type { Address } from 'viem'
import { arcLogsClient } from '@/lib/contracts-arc'
import { resolvePool, scanSwapRange } from '@/lib/arc-trades'
import { listIndexedTokens } from '@/lib/arc-indexer/store'
import { candleStoreConfigured, getBackfillState, recordTrades1m, setBackfillState } from '@/lib/arc-candle-store'
import { summarizeRpcError } from '@/lib/rpc-error'

/** Per-iteration scan width — small enough that a crash mid-token loses at most this much
 *  re-scanned work, large enough that a 17-day-old token like EVE finishes in a handful of
 *  iterations. ~1.6 days of chain time at Arc's ~0.71s/block. */
const CHUNK_BLOCKS = 200_000n

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function backfillToken(token: Address, createdBlock: bigint | null, head: bigint): Promise<void> {
  const orient = await resolvePool(token)
  if (!orient) {
    console.warn(`[backfill] ${token} — no pool, skipping`)
    return
  }
  const { pool, tokenIs0, tokenDecimals, quoteDecimals } = orient
  const client = arcLogsClient()

  const state = await getBackfillState(token)
  if (state?.done) {
    console.log(`[backfill] ${token} — already done as of block ${state.scannedUpToBlock}, skipping`)
    return
  }
  let from = state ? state.scannedUpToBlock + 1n : createdBlock ?? 0n
  if (from > head) {
    await setBackfillState(token, pool, head, true)
    console.log(`[backfill] ${token} — nothing to scan (from ${from} > head ${head}), marked done`)
    return
  }

  const rangeStart = from // fixed, for progress % below — `from` itself advances each iteration
  console.log(`[backfill] ${token} — scanning ${from} → ${head} (pool ${pool})`)
  while (from <= head) {
    const to = from + CHUNK_BLOCKS - 1n > head ? head : from + CHUNK_BLOCKS - 1n
    let found: Awaited<ReturnType<typeof scanSwapRange>>
    try {
      found = await scanSwapRange(client, pool, tokenIs0, tokenDecimals, from, to, quoteDecimals)
    } catch (e) {
      console.warn(`[backfill] ${token} — scan ${from}-${to} failed, will retry next run:`, summarizeRpcError(e))
      return
    }
    if (found.trades.length > 0) {
      await recordTrades1m(token, found.trades)
    }
    await setBackfillState(token, pool, found.scannedTo, false)
    const pct = (Number(found.scannedTo - rangeStart) / Number(head - rangeStart + 1n)) * 100
    console.log(`[backfill] ${token} — ${from}-${found.scannedTo} (${found.trades.length} trades) [${pct.toFixed(1)}%]`)
    from = found.scannedTo + 1n
    // Be polite to the RPC between chunks — this is a background job, not a page load.
    await sleep(150)
  }
  await setBackfillState(token, pool, head, true)
  console.log(`[backfill] ${token} — done, caught up to ${head}`)
}

async function main() {
  if (!candleStoreConfigured()) {
    console.error('[backfill] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — nothing to do.')
    process.exit(1)
  }

  const only = process.argv[2]?.trim().toLowerCase()
  const tokens = await listIndexedTokens()
  const targets = only ? tokens.filter((t) => t.token.toLowerCase() === only) : tokens
  if (targets.length === 0) {
    console.error(only ? `[backfill] ${only} is not an indexed token` : '[backfill] no indexed tokens found')
    process.exit(1)
  }

  const client = arcLogsClient()
  const head = await client.getBlockNumber()
  console.log(`[backfill] ${targets.length} token(s), chain head ${head}`)

  for (const t of targets) {
    try {
      await backfillToken(t.token as Address, t.createdBlock != null ? BigInt(t.createdBlock) : null, head)
    } catch (e) {
      console.warn(`[backfill] ${t.token} — unexpected error, moving on:`, summarizeRpcError(e))
    }
  }
  console.log('[backfill] all tokens processed')
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[backfill] fatal', e)
    process.exit(1)
  })

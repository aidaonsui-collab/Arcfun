/**
 * Pure helpers for the Instant trade-tape cursor. Kept out of arc-trades.ts so
 * node --test can import them without pulling next/server.
 */

const REWIND_BLOCKS = 12_000n
const REWIND_AFTER_SEC = 20 * 60

/** How far back a stale-tape rescan starts. Prefer the last persisted fill's
 *  block — a fixed 12k-block window (PR 130) sat *inside* EVE's 24k-block gap
 *  and never reached the missed Swaps. */
export function staleTapeRewindFrom(opts: {
  head: bigint
  lastTradeBlock: number
  lastTradeTs: number
  nowSec: number
  rewindAfterSec?: number
  fallbackBlocks?: bigint
}): bigint | null {
  const after = opts.rewindAfterSec ?? REWIND_AFTER_SEC
  if (opts.lastTradeTs > 0 && opts.nowSec - opts.lastTradeTs < after) return null
  const last = BigInt(opts.lastTradeBlock || 0)
  if (last > 0n && last < opts.head) return last + 1n
  const fallback = opts.fallbackBlocks ?? REWIND_BLOCKS
  return opts.head > fallback ? opts.head - fallback + 1n : 0n
}

/** Empty getLogs while the tape is already stale must not park the cursor at
 *  `head` — that is how a public RPC answering `[]` froze EVE. */
export function shouldPersistScanCursor(opts: {
  foundTrades: number
  scannedTo: bigint
  from: bigint
  tapeIsStale: boolean
}): boolean {
  if (opts.scannedTo < opts.from) return false
  if (opts.foundTrades > 0) return true
  return !opts.tapeIsStale
}

export function tapeIsStaleTs(newestTs: number, nowSec = Math.floor(Date.now() / 1000)): boolean {
  return newestTs > 0 && nowSec - newestTs >= REWIND_AFTER_SEC
}

export { REWIND_AFTER_SEC, REWIND_BLOCKS }

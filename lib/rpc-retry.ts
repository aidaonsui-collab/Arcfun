/**
 * Shared RPC rate-limit retry helper. Extracted from rh4663-trades.ts (the first module that needed
 * it, for the InstaDEX trade-log scanner) so every RH4663-RPC caller can survive the chain's
 * aggressive throttling the same way instead of each hand-rolling its own retry loop.
 */

/** True for a rate-limited RPC response (HTTP 429 / "Too Many Requests") — the throttling this
 *  codebase has repeatedly hit on both the public 4663 RPC and the Alchemy endpoint under bursty
 *  sequential call patterns. */
export function isRateLimitedError(err: unknown): boolean {
  const e = err as { code?: number; status?: number; details?: string; message?: string } | undefined
  if (!e) return false
  if (e.code === 429 || e.status === 429) return true
  const text = `${e.details ?? ''} ${e.message ?? ''}`
  return /too many requests|rate limit/i.test(text)
}

const RETRY_DELAYS_MS = [300, 900, 2700]

/** Retry a rate-limited RPC call with exponential backoff + jitter (bounded, ~4s worst case). Any
 *  other error rethrows immediately — only 429s are worth waiting out. Purely in-process, so this
 *  adds zero KV/Upstash bandwidth regardless of how many times it retries. */
export async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length || !isRateLimitedError(err)) throw err
      const jitter = Math.random() * 150
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt] + jitter))
    }
  }
}

// ─── Money-send variant ───────────────────────────────────────────────────────────────────────────
//
// withRateLimitRetry above is shaped for READS: quick bounded backoff, 429s only, several attempts.
// Keeper SENDS fail differently. Found live on $ROBIN 2026-07-28: the buyback-burn's wrap/approve/
// swap died mid-sequence on "Rate Limit Hit" (a hard 60s-reset window that a ~4s backoff retries
// straight back into), "nonce too low" and an "exceeds the balance" simulation (load-balanced public
// nodes lagging a block behind a send the same tick just landed) — while the HL funding leg, running
// seconds later with fresh state, bridged the very ETH the burn was holding. A send retry must wait
// LONG (past the limit window / node lag) and run ONCE — each extra attempt multiplies the ambiguity
// of an error that arrives after broadcast.
//
// Money safety of one retry: the dangerous case is an error AFTER broadcast (response lost). The
// retry re-reads the nonce and re-simulates from scratch — if the first send actually landed, the
// second attempt fails simulation (balance/allowance consumed, nonce advanced) and that failure
// propagates. Nothing is ever sent twice; worst case is a wasted attempt and the caller's own
// next-tick recovery.

/** Transient-error signatures observed from the public rh4663 RPC on the keeper money path. Wider
 *  than isRateLimitedError on purpose: stale-node nonce/balance errors and lost-receipt reads are
 *  the same "try again with fresh state" class for a send. */
export function isTransientSendError(err: unknown): boolean {
  if (isRateLimitedError(err)) return true
  const e = err as { details?: string; message?: string } | undefined
  const text = `${e?.details ?? ''} ${e?.message ?? ''}`
  if (/nonce too low|nonce provided|exceeds the balance|insufficient funds|rpc request failed|could not be found/i.test(text)) {
    return true
  }
  // Uppercase \bSTF\b: Uniswap TransferHelper's safeTransferFrom revert. Seen live when the swap
  // simulates on a load-balanced node that hasn't caught up to the approve sent 2s earlier — the
  // allowance IS on chain, the node just can't see it yet. A genuine STF wastes exactly one retry.
  return /\bSTF\b/.test(text)
}

/** Rate-limit window is a hard 60s reset — anything shorter retries into the same wall. */
const SEND_RATE_LIMIT_WAIT_MS = 65_000
/** Stale-node state (nonce, balance) catches up within a couple of blocks. */
const SEND_STALE_STATE_WAIT_MS = 6_000

/** Run a money send and, on a transient RPC failure, retry it exactly once after a pause sized to
 *  the failure. Non-transient errors throw immediately. */
export async function withMoneySendRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!isTransientSendError(err)) throw err
    const waitMs = isRateLimitedError(err) ? SEND_RATE_LIMIT_WAIT_MS : SEND_STALE_STATE_WAIT_MS
    console.warn(
      `[rpc-retry] ${label}: transient send failure, retrying once in ${waitMs / 1000}s: ${((err as Error).message ?? String(err)).slice(0, 160)}`,
    )
    await new Promise((r) => setTimeout(r, waitMs))
    return fn()
  }
}

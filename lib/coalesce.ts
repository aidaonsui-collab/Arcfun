/**
 * coalesceAsync — collapse concurrent callers keyed by `key` into one shared in-flight Promise.
 *
 * Server-side analogue of coalescedFetch (same herd problem, different tier): a single token
 * page load fires /api/arc/[token]/trades?limit=400, /trades?limit=25, and /ohlcv, and the last
 * two both call fetchArcTrades() internally. On a cold or stale-cursor token each of those
 * independently paid for its own resolvePool + getBlockNumber + eth_getLogs catch-up scan and
 * raced to write the same KV cursor — measured live: a single token-page view took ~5s per
 * request, four times over, for what should be one scan's worth of RPC work.
 *
 * Only the work passed to `fn` is shared; each caller still gets its own return value from that
 * one execution. The entry clears the moment the call settles (success or failure), so the next
 * call after that starts fresh — this coalesces a burst, it is not a cache.
 */
const inflight = new Map<string, Promise<unknown>>()

export function coalesceAsync<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key)
  if (existing) return existing as Promise<T>
  const p = fn()
  inflight.set(key, p)
  const clear = () => inflight.delete(key)
  p.then(clear, clear)
  return p
}

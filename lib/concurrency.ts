/**
 * Run an async function over an array with a fixed concurrency cap.
 *
 * `Promise.all(items.map(fn))` spawns ALL items in flight at once. For our
 * catalog routes that's hundreds of parallel `sui_getObject` / `suix_getCoins`
 * RPC calls per request, which spikes Vercel function memory (each fetch
 * holds connection state, response buffers, etc.) and gives no real
 * throughput benefit once the upstream RPC is the bottleneck.
 *
 * This helper runs at most `concurrency` workers in parallel, each pulling
 * the next item from the input as it finishes the previous one. Same
 * total throughput in practice (Sui RPC isn't faster with 200 concurrent
 * calls than with 8), drastically lower peak memory.
 *
 * Returns results in input order. Thrown errors propagate the same as
 * `Promise.all` (first rejection cancels the awaiter).
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const limit = Math.max(1, Math.min(concurrency, items.length))
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const i = nextIndex++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

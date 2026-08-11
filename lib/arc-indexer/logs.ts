/**
 * Chunked eth_getLogs with Arc-friendly 9k ranges + retry.
 */
import type { Address, Log } from 'viem'

export const LOG_CHUNK = 9_000n
const CONCURRENCY = 4

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= attempts - 1) throw e
      await new Promise((r) => setTimeout(r, 400 + i * 600))
    }
  }
}

type GetLogsClient = {
  // Loose typing — viem PublicClient variants differ by account config.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getLogs: (args: any) => Promise<Log[]>
}

/**
 * Scan [from, to] ascending. Returns logs + last fully scanned block
 * (may be < toBlock if maxChunks hit).
 */
export async function scanLogsChunked(
  client: GetLogsClient,
  opts: {
    address: Address | Address[]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    event: any
    fromBlock: bigint
    toBlock: bigint
    maxChunks?: number
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args?: any
  },
): Promise<{ logs: Log[]; scannedTo: bigint; chunks: number; failed: number }> {
  const { address, event, fromBlock, toBlock, maxChunks = 40, args } = opts
  if (fromBlock > toBlock) return { logs: [], scannedTo: toBlock, chunks: 0, failed: 0 }

  const ranges: { from: bigint; to: bigint }[] = []
  for (let from = fromBlock; from <= toBlock; ) {
    const to = from + LOG_CHUNK - 1n > toBlock ? toBlock : from + LOG_CHUNK - 1n
    ranges.push({ from, to })
    from = to + 1n
    if (ranges.length >= maxChunks) break
  }

  const all: Log[] = []
  let failed = 0
  let ok = 0
  let scannedTo = fromBlock > 0n ? fromBlock - 1n : 0n

  for (let i = 0; i < ranges.length; i += CONCURRENCY) {
    const batch = ranges.slice(i, i + CONCURRENCY)
    const part = await Promise.all(
      batch.map(({ from, to }) =>
        withRetry(() =>
          client.getLogs({
            address,
            event,
            fromBlock: from,
            toBlock: to,
            ...(args ? { args } : {}),
          }),
        )
          .then((logs) => {
            ok++
            scannedTo = to > scannedTo ? to : scannedTo
            return logs as Log[]
          })
          .catch((err) => {
            failed++
            console.warn(
              `[arc-indexer] getLogs ${from}-${to}:`,
              (err as Error)?.message ?? err,
            )
            return [] as Log[]
          }),
      ),
    )
    for (const logs of part) all.push(...logs)
  }

  if (ok === 0 && failed > 0) {
    throw new Error(`Arc RPC failed all ${failed} log chunks`)
  }

  return { logs: all, scannedTo, chunks: ranges.length, failed }
}

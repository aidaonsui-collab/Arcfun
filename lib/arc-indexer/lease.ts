/**
 * Dedicated-indexer lease. A home-Mac loop (Jessica) renews this every cycle.
 * The Vercel 2-minute cron skips while the lease is live, and takes over ~60s
 * after the Air sleeps or the process dies.
 */
export const INDEXER_LEASE_KEY = 'arcfun:idx:lease'
export const INDEXER_LEASE_TTL_SEC = 60
/** Cron treats a lease younger than this as "dedicated worker is alive". */
export const INDEXER_LEASE_LIVE_MS = 45_000

export type IndexerLease = {
  owner: string
  host: string
  pid: number
  at: number
}

export function indexerWorkerName(): string {
  return (process.env.INDEXER_WORKER || 'vercel-cron').trim() || 'vercel-cron'
}

export function isDedicatedLeaseLive(
  lease: IndexerLease | null | undefined,
  now = Date.now(),
): boolean {
  if (!lease?.owner || !lease.at) return false
  if (lease.owner === 'vercel-cron') return false
  return now - lease.at < INDEXER_LEASE_LIVE_MS
}

export async function readIndexerLease(): Promise<IndexerLease | null> {
  try {
    const { kv } = await import('@vercel/kv')
    const row = await kv.get<IndexerLease>(INDEXER_LEASE_KEY)
    if (row?.owner && row.at) return row
  } catch (e) {
    const { summarizeRpcError } = await import('../rpc-error')
    console.warn('[arc-indexer] lease read', summarizeRpcError(e))
  }
  return null
}

export async function renewIndexerLease(owner: string, host: string, pid: number): Promise<void> {
  const row: IndexerLease = { owner, host, pid, at: Date.now() }
  try {
    const { kv } = await import('@vercel/kv')
    await kv.set(INDEXER_LEASE_KEY, row, { ex: INDEXER_LEASE_TTL_SEC })
  } catch (e) {
    const { summarizeRpcError } = await import('../rpc-error')
    console.warn('[arc-indexer] lease renew', summarizeRpcError(e))
  }
}

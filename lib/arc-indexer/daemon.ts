/**
 * Always-on Arc indexer loop for a home Mac (Jessica).
 *
 * Writes the same Vercel KV the site reads. Renews a lease so the 2-minute
 * Vercel cron skips while this process is alive.
 *
 *   npm run indexer
 *   # keep the Air awake:
 *   caffeinate -dims npm run indexer
 */
import { hostname } from 'node:os'
import { runArcIndexerCycle } from './run'
import { indexerWorkerName, renewIndexerLease } from './lease'

const SLEEP_MS = Math.max(1_000, Number(process.env.INDEXER_SLEEP_MS) || 4_000)

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function main(): Promise<void> {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error('[arc-indexer] missing KV_REST_API_URL / KV_REST_API_TOKEN')
    process.exit(1)
  }
  const host = hostname()
  const owner = indexerWorkerName() === 'vercel-cron' ? `jessica:${host}` : indexerWorkerName()
  process.env.INDEXER_WORKER = owner
  console.log(`[arc-indexer] dedicated loop owner=${owner} sleep=${SLEEP_MS}ms`)

  for (;;) {
    const t0 = Date.now()
    await renewIndexerLease(owner, host, process.pid)
    try {
      const result = await runArcIndexerCycle()
      const lag = result.ok
        ? `ok factories=${result.factories} swaps=${result.swapsTokens} tokens=${result.tokenCount} ${result.ms}ms`
        : `FAIL ${result.error || 'unknown'} ${result.ms}ms`
      console.log(`[arc-indexer] ${new Date().toISOString()} ${lag}`)
    } catch (e) {
      console.error('[arc-indexer] cycle', e instanceof Error ? e.message : e)
    }
    const wait = Math.max(500, SLEEP_MS - (Date.now() - t0))
    await sleep(wait)
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('daemon.ts')) {
  void main()
}

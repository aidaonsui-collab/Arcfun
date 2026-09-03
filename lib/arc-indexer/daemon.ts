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

/**
 * Renewing only once per loop iteration — before runArcIndexerCycle(), not during it — let the
 * KV lease expire and vanish mid-cycle. INDEXER_LEASE_TTL_SEC is 60s, but a cycle routinely
 * takes well past that under Arc RPC flakiness: confirmed live 2026-09-03, two status fetches
 * 3s apart on the SAME jessica worker read lease:null then lease:{...}, with lastRun.ms of
 * 109730 and 122274 (an earlier session measured 308707ms on a heavier tick). Every time that
 * happens, the Vercel cron's liveness check sees Jessica as dead mid-cycle and can start a
 * fully concurrent one — both racing loadState()/saveState() with no optimistic-concurrency
 * check, silently clobbering whichever cursor commits last (same bug class as the OTC cursor
 * race fixed in #124).
 *
 * Renew on a timer independent of cycle duration instead — comfortably inside the 60s TTL even
 * if a tick or two is missed.
 */
const LEASE_RENEW_MS = 15_000

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
  console.log(`[arc-indexer] dedicated loop owner=${owner} sleep=${SLEEP_MS}ms renew=${LEASE_RENEW_MS}ms`)

  setInterval(() => {
    void renewIndexerLease(owner, host, process.pid)
  }, LEASE_RENEW_MS)

  for (;;) {
    const t0 = Date.now()
    // Still renew at the top of each iteration too — immediate freshness right after the
    // inter-cycle sleep, rather than waiting for the next timer tick.
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

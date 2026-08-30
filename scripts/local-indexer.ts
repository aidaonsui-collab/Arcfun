#!/usr/bin/env npx tsx
/**
 * local-indexer.ts — SKETCH. Proactively catches every active token's trade cursor up to head,
 * on an outbound-only loop, meant to run on a machine you keep around (a home Mac) rather than
 * as paid always-on cloud compute.
 *
 * WHAT THIS IS
 * A standalone Node process — never deployed to Vercel, never part of the Next.js build. It
 * calls the exact same syncTradesToHead() that /api/arc/[token]/trades already calls on demand
 * (lib/arc-trades.ts) — same coalescing, same cursor semantics, same KV keys — just triggered on
 * a timer instead of by a page view. There is no second scanning implementation to keep in sync
 * with the first; this is a different caller of the same function.
 *
 * WHY THIS IS SAFE TO RUN FROM A HOME MACHINE
 * Both connections this process makes are OUTBOUND: to the Arc RPC, and to Vercel KV's REST API.
 * Nothing needs to reach IN to wherever this runs, so there's no port-forwarding, no CGNAT
 * problem, no exposing a home network. And it is additive, not load-bearing: if this process is
 * asleep, offline, or never started, every route that reads trade data keeps working exactly as
 * it does today — syncTradesToHead's own on-demand path in the live API is untouched, coalesced
 * (lib/coalesce.ts), and stays the fallback. This process can only make things fresher when it's
 * up; it is never a new single point of failure.
 *
 * WHAT THIS IS NOT (YET)
 * Not hardened for unattended, walk-away production use. Before leaving it running 24/7:
 *   - SIGINT/SIGTERM abort the wait BETWEEN passes and BETWEEN tokens within a pass immediately
 *     (via AbortSignal, not polling), and the loop checks for shutdown before starting a new pass
 *     too — not just after one finishes. What's left un-abortable is a single network call
 *     already in flight at the moment the signal arrives: plain async/await can't cancel an
 *     in-progress fetch without threading the signal into every RPC/KV call, which this sketch
 *     doesn't do. So the true worst case on Ctrl+C is one in-flight call's own latency, not a
 *     whole --interval or an extra pass — both of those were real bugs caught by actually running
 *     this and sending SIGINT mid-sleep, not assumed away.
 *   - Wrap it in a launchd agent (see local-indexer.launchd.plist.example in this directory) so
 *     it restarts on crash and survives reboots/logout.
 *   - Keep the Mac from sleeping (`caffeinate`, or `pmset -a disablesleep 1` while it's meant to
 *     stay up) — a sleeping Mac simply stops writing, which is safe but silently stale.
 *   - Add real alerting if you care about noticing extended downtime; today the only signal is
 *     this process's own stdout.
 *
 * USAGE
 *   npx tsx --env-file=.env.local scripts/local-indexer.ts             # loop forever
 *   npx tsx --env-file=.env.local scripts/local-indexer.ts --once      # one pass, then exit
 *   npx tsx --env-file=.env.local scripts/local-indexer.ts --interval=15   # seconds between passes
 *
 * Needs the same KV_REST_API_URL / KV_REST_API_TOKEN / ARC_RPC (or NEXT_PUBLIC_ARC_RPC) your
 * .env.local already has for the Next.js app — this talks to the identical KV store and chain.
 */
import type { Address } from 'viem'
import { setTimeout as delay } from 'node:timers/promises'
import { listTokenAddresses } from '@/lib/arc-indexer/store'
import { syncTradesToHead } from '@/lib/arc-trades'

const DEFAULT_INTERVAL_SEC = 10
/** Gap between each token's sync within one pass — spreads RPC load instead of bursting it. */
const PER_TOKEN_DELAY_MS = 400

function parseArgs(argv: string[]) {
  const once = argv.includes('--once')
  const intervalArg = argv.find((a) => a.startsWith('--interval='))
  const intervalSec = intervalArg ? Number(intervalArg.split('=')[1]) : DEFAULT_INTERVAL_SEC
  return { once, intervalSec: Number.isFinite(intervalSec) && intervalSec > 0 ? intervalSec : DEFAULT_INTERVAL_SEC }
}

function requireEnv() {
  const missing = ['KV_REST_API_URL', 'KV_REST_API_TOKEN'].filter((k) => !process.env[k])
  if (missing.length) {
    console.error(
      `[local-indexer] missing ${missing.join(', ')} — same credentials your .env.local already ` +
        `has for the Next.js app. Run with: npx tsx --env-file=.env.local scripts/local-indexer.ts`,
    )
    process.exit(1)
  }
}

// A real AbortController, not a polled boolean — so the wait BETWEEN passes and BETWEEN tokens
// can be cancelled immediately on signal instead of running to completion regardless. sleep()
// resolves early (never throws) when aborted, so callers don't need their own try/catch for it.
const shutdown = new AbortController()
async function sleep(ms: number): Promise<void> {
  try {
    await delay(ms, undefined, { signal: shutdown.signal })
  } catch {
    /* aborted — that's the point, fall through to the caller's own shuttingDown check */
  }
}

let shuttingDown = false
function requestShutdown(signal: string) {
  console.log(`\n[local-indexer] shutting down (${signal}) — finishing in-flight work, then exiting`)
  shuttingDown = true
  shutdown.abort()
}
process.on('SIGINT', () => requestShutdown('SIGINT'))
process.on('SIGTERM', () => requestShutdown('SIGTERM'))

async function runOnePass(): Promise<{ tokens: number; ok: number; failed: number; ms: number }> {
  const t0 = Date.now()
  let tokens: string[] = []
  try {
    tokens = await listTokenAddresses()
  } catch (e) {
    console.error('[local-indexer] could not list tokens, skipping this pass:', (e as Error).message)
    return { tokens: 0, ok: 0, failed: 0, ms: Date.now() - t0 }
  }
  if (shuttingDown) return { tokens: 0, ok: 0, failed: 0, ms: Date.now() - t0 }

  let ok = 0
  let failed = 0
  for (const token of tokens) {
    if (shuttingDown) break
    try {
      await syncTradesToHead(token as Address)
      ok++
    } catch (e) {
      failed++
      console.warn(`[local-indexer] sync failed for ${token}:`, (e as Error).message)
    }
    await sleep(PER_TOKEN_DELAY_MS)
  }

  return { tokens: tokens.length, ok, failed, ms: Date.now() - t0 }
}

async function main() {
  const { once, intervalSec } = parseArgs(process.argv.slice(2))
  requireEnv()

  console.log(
    `[local-indexer] starting — ${once ? 'single pass' : `looping every ${intervalSec}s`}, ` +
      `${PER_TOKEN_DELAY_MS}ms between tokens`,
  )

  for (;;) {
    // Checked BEFORE starting a pass, not just after: an abort that lands during sleep() below
    // wakes the loop back up here, and without this check it would still run one full extra pass
    // before the after-pass check ever saw shuttingDown — confirmed live before this fix, ~5s of
    // avoidable work per Ctrl+C.
    if (shuttingDown) break
    const result = await runOnePass()
    console.log(
      `[local-indexer] pass complete — ${result.tokens} tokens, ${result.ok} ok, ` +
        `${result.failed} failed, ${(result.ms / 1000).toFixed(1)}s`,
    )
    if (once) break
    await sleep(intervalSec * 1000)
  }

  console.log('[local-indexer] stopped')
}

main().catch((e) => {
  console.error('[local-indexer] fatal:', e)
  process.exit(1)
})

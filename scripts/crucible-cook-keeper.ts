#!/usr/bin/env npx tsx
/**
 * crucible-cook-keeper.ts — SKETCH. Calls Crucible.cook() (buy $EVE with the accrued USDC slice,
 * burn it) on a timer, meant to run on a machine you keep around (a home Mac) rather than as
 * paid always-on cloud compute — same reasoning as scripts/local-indexer.ts (never merged,
 * sketch/local-mac-indexer), applied to a different gap: nothing in this repo has ever called
 * cook(). The Crucible sink accrues USDC correctly on every CrucibleLock collect (verified on
 * mainnet, 5 collects, every split landed at exactly 50/25/10/10/5) — it just never gets spent.
 *
 * WHAT THIS IS
 * A standalone Node process — never deployed to Vercel, never part of the Next.js build. Reads
 * the Crucible sink address live off CrucibleLock.crucible() (ARC.INSTANT_LOCKER) rather than
 * hardcoding it, so it keeps working if the sink is ever rotated. Each pass: read the sink's
 * USDC balance, skip below --min-usdc, otherwise quote USDC→EVE on the same Quoter the app
 * already uses (lib/arc-swap.ts's ABI/pattern, reused not reimplemented), apply a slippage
 * buffer with the app's own minOutFromSlippage, and call cook(amountIn, minEveOut) as the
 * keeper. cook() itself enforces the balance and a non-zero minOut (ZeroMinOut / InsufficientUsdc
 * reverts) — this script's job is picking a real, quote-derived minOut instead of the "pass 1"
 * anti-pattern that CrucibleLock's own audit already called out and fixed for projectBurn.
 *
 * UNLIKE local-indexer.ts, THIS SCRIPT MOVES REAL FUNDS. Differences that follow from that:
 *   - Dry-run by default. Every pass computes and logs exactly what it would do; nothing is
 *     signed or broadcast unless you pass --live. Watch a few dry-run passes before trusting it
 *     unattended — same reasoning as confirming before an irreversible action, just applied to
 *     "before turning on the autopilot" instead of a single click.
 *   - Needs a keeper's private key. Use a DEDICATED keeper key, not the platform/deploy wallet —
 *     call `crucible.setKeeper(<new address>, true)` (owner-only) once from the platform wallet,
 *     then only that narrower key ever needs to sit in an env file on this machine. A keeper can
 *     only call cook()/is otherwise gated by onlyKeeper — it cannot change owner, platform
 *     wallet, or the sink itself. Still real key material sitting unattended 24/7; scope it down.
 *   - In-process lock against overlapping passes (a slow RPC + a short --interval could otherwise
 *     fire two cooks against the same balance — the second would just revert InsufficientUsdc
 *     after the first drains it, wasting its gas, not a double-spend, but wasted gas on a
 *     script that's supposed to be cheap to run is exactly the kind of bug worth not shipping).
 *   - Every action this script takes is logged with amounts and tx hash — this handles money,
 *     "what did it do" needs to be answerable from stdout alone.
 *
 * WHAT THIS IS NOT (YET), same caveats as local-indexer.ts:
 *   - SIGINT/SIGTERM abort the wait between passes immediately (AbortController, not a polled
 *     flag — that distinction was a real bug caught by actually running local-indexer.ts and
 *     sending SIGINT mid-sleep, not assumed away). A cook transaction already broadcasting when
 *     the signal arrives is not cancelled — plain async/await can't un-send a transaction; the
 *     worst case is this process waits out that one confirmation before exiting.
 *   - No retry/backoff tuning beyond "log and try again next pass." A cook() revert (stale
 *     quote, sink balance moved) is not fatal — it's just skipped and re-evaluated next pass
 *     with a fresh quote.
 *   - Wrap it in a launchd agent (see crucible-cook-keeper.launchd.plist.example) so it restarts
 *     on crash and survives reboots/logout. Keep the Mac from sleeping while it's meant to stay
 *     up (`caffeinate`, or `pmset -a disablesleep 1`) — asleep, it simply stops running, which is
 *     safe but silently stale, same as the indexer.
 *
 * USAGE
 *   npx tsx --env-file=.env.local scripts/crucible-cook-keeper.ts                  # dry run, loop forever
 *   npx tsx --env-file=.env.local scripts/crucible-cook-keeper.ts --once           # one dry-run pass, then exit
 *   npx tsx --env-file=.env.local scripts/crucible-cook-keeper.ts --live           # actually broadcasts
 *   npx tsx --env-file=.env.local scripts/crucible-cook-keeper.ts --live --once
 *   npx tsx --env-file=.env.local scripts/crucible-cook-keeper.ts --interval=300   # seconds between passes (default 600)
 *   npx tsx --env-file=.env.local scripts/crucible-cook-keeper.ts --min-usdc=5     # USDC threshold to bother cooking (default 1)
 *   npx tsx --env-file=.env.local scripts/crucible-cook-keeper.ts --slippage=300   # bps, default 300 (3%)
 *
 * Needs CRUCIBLE_KEEPER_PRIVATE_KEY (0x-prefixed) and the same ARC_RPC / NEXT_PUBLIC_ARC_RPC
 * your .env.local already has for the Next.js app. Does not need Vercel KV — everything here is
 * a direct chain read/write, no shared cache with the web app.
 */
import { setTimeout as delay } from 'node:timers/promises'
import { erc20Abi, type Address } from 'viem'
import { ARC, arcPublicClient, arcServerWalletClient } from '@/lib/contracts-arc'
import { minOutFromSlippage } from '@/lib/arc-swap'

const DEFAULT_INTERVAL_SEC = 600
const DEFAULT_MIN_USDC = 1_000_000n // 1 USDC, 6dp
const DEFAULT_SLIPPAGE_BPS = 300 // 3%
const EVE_POOL_FEE = 10_000 // 1% tier — matches DeployInstantCrucibleMainnet.s.sol's EVE_POOL_FEE

const CRUCIBLE_ABI = [
  { type: 'function', name: 'crucible', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const

const CRUCIBLE_SINK_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    name: 'keepers',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  { type: 'function', name: 'cookPaused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'eve', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    name: 'cook',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'minEveOut', type: 'uint256' },
    ],
    outputs: [{ name: 'eveOut', type: 'uint256' }],
  },
] as const

const QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const

function parseArgs(argv: string[]) {
  const once = argv.includes('--once')
  const live = argv.includes('--live')
  const num = (flag: string, fallback: number) => {
    const arg = argv.find((a) => a.startsWith(`--${flag}=`))
    const v = arg ? Number(arg.split('=')[1]) : NaN
    return Number.isFinite(v) && v > 0 ? v : fallback
  }
  return {
    once,
    live,
    intervalSec: num('interval', DEFAULT_INTERVAL_SEC),
    minUsdc: BigInt(Math.round(num('min-usdc', 1) * 1e6)),
    slippageBps: num('slippage', DEFAULT_SLIPPAGE_BPS),
  }
}

function requireKey(): `0x${string}` {
  const key = process.env.CRUCIBLE_KEEPER_PRIVATE_KEY?.trim()
  if (!key || !key.startsWith('0x')) {
    console.error(
      '[cook-keeper] missing CRUCIBLE_KEEPER_PRIVATE_KEY (0x-prefixed). Use a dedicated keeper ' +
        'key granted via crucible.setKeeper(addr, true) from the platform wallet — not the ' +
        'platform wallet itself. Run with: npx tsx --env-file=.env.local scripts/crucible-cook-keeper.ts',
    )
    process.exit(1)
  }
  return key as `0x${string}`
}

// Real AbortController, not a polled boolean — see local-indexer.ts's header for why that
// distinction mattered in practice (SIGINT during a plain sleep() didn't abort at all until
// fixed). sleep() resolves early (never throws) when aborted.
const shutdown = new AbortController()
async function sleep(ms: number): Promise<void> {
  try {
    await delay(ms, undefined, { signal: shutdown.signal })
  } catch {
    /* aborted — fall through to the caller's own shuttingDown check */
  }
}

let shuttingDown = false
function requestShutdown(signal: string) {
  console.log(`\n[cook-keeper] shutting down (${signal}) — finishing in-flight work, then exiting`)
  shuttingDown = true
  shutdown.abort()
}
process.on('SIGINT', () => requestShutdown('SIGINT'))
process.on('SIGTERM', () => requestShutdown('SIGTERM'))

// Prevents two overlapping passes from both trying to cook the same balance (a slow RPC plus a
// short --interval could otherwise fire pass N+1 before pass N's cook() has even confirmed).
let cookInFlight = false

async function runOnePass(opts: ReturnType<typeof parseArgs>, keeperAddress: Address): Promise<void> {
  const client = arcPublicClient()

  const sinkAddr = (await client.readContract({
    address: ARC.INSTANT_LOCKER,
    abi: CRUCIBLE_ABI,
    functionName: 'crucible',
  })) as Address

  const [balance, paused, isKeeper, eve] = await Promise.all([
    client.readContract({ address: ARC.USDC, abi: erc20Abi, functionName: 'balanceOf', args: [sinkAddr] }),
    client.readContract({ address: sinkAddr, abi: CRUCIBLE_SINK_ABI, functionName: 'cookPaused' }),
    client.readContract({
      address: sinkAddr,
      abi: CRUCIBLE_SINK_ABI,
      functionName: 'keepers',
      args: [keeperAddress],
    }),
    client.readContract({ address: sinkAddr, abi: CRUCIBLE_SINK_ABI, functionName: 'eve' }),
  ])

  const usdcLabel = (v: bigint) => (Number(v) / 1e6).toFixed(6)
  console.log(`[cook-keeper] sink=${sinkAddr} balance=${usdcLabel(balance)} USDC paused=${paused} keeper=${isKeeper}`)

  if (paused) {
    console.log('[cook-keeper] cookPaused=true on-chain — skipping (not this script’s call to override)')
    return
  }
  if (!isKeeper) {
    console.error(
      `[cook-keeper] ${keeperAddress} is not an authorized keeper on ${sinkAddr}. Have the ` +
        'owner call crucible.setKeeper(this address, true) once, then restart.',
    )
    return
  }
  if (balance < opts.minUsdc) {
    console.log(`[cook-keeper] below --min-usdc (${usdcLabel(opts.minUsdc)}) — waiting for more to accrue`)
    return
  }
  if (cookInFlight) {
    console.log('[cook-keeper] a cook is already in flight from a previous pass — skipping this tick')
    return
  }

  const quote = (await client.readContract({
    address: ARC.UNI_QUOTER,
    abi: QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: ARC.USDC, tokenOut: eve, amountIn: balance, fee: EVE_POOL_FEE, sqrtPriceLimitX96: 0n }],
  })) as readonly [bigint, bigint, number, bigint]
  const quotedOut = quote[0]
  if (quotedOut <= 0n) {
    console.log('[cook-keeper] quote came back 0 — no route/liquidity right now, skipping this tick')
    return
  }
  const minEveOut = minOutFromSlippage(quotedOut, opts.slippageBps)

  console.log(
    `[cook-keeper] would cook ${usdcLabel(balance)} USDC → quoted ${quotedOut} EVE (min ${minEveOut}, ` +
      `${opts.slippageBps}bps slippage)`,
  )

  if (!opts.live) {
    console.log('[cook-keeper] dry run (pass --live to actually broadcast) — not sending')
    return
  }

  cookInFlight = true
  try {
    const wallet = arcServerWalletClient(requireKey())
    const hash = await wallet.writeContract({
      address: sinkAddr,
      abi: CRUCIBLE_SINK_ABI,
      functionName: 'cook',
      args: [balance, minEveOut],
      chain: wallet.chain,
    })
    console.log(`[cook-keeper] sent ${hash} — waiting for confirmation`)
    const receipt = await client.waitForTransactionReceipt({ hash })
    console.log(
      `[cook-keeper] confirmed in block ${receipt.blockNumber} status=${receipt.status} — ` +
        `cooked ${usdcLabel(balance)} USDC, min ${minEveOut} EVE guaranteed`,
    )
  } catch (e) {
    console.error('[cook-keeper] cook() failed:', e instanceof Error ? e.message : String(e))
  } finally {
    cookInFlight = false
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const key = requireKey()
  const keeperAddress = arcServerWalletClient(key).account.address

  console.log(
    `[cook-keeper] keeper=${keeperAddress} live=${opts.live} interval=${opts.intervalSec}s ` +
      `min-usdc=${(Number(opts.minUsdc) / 1e6).toFixed(2)} slippage=${opts.slippageBps}bps` +
      (opts.live ? '' : ' — DRY RUN, pass --live to actually broadcast'),
  )

  for (;;) {
    if (shuttingDown) break
    try {
      await runOnePass(opts, keeperAddress)
    } catch (e) {
      console.error('[cook-keeper] pass failed:', e instanceof Error ? e.message : String(e))
    }
    if (opts.once || shuttingDown) break
    await sleep(opts.intervalSec * 1000)
  }
  console.log('[cook-keeper] exited cleanly')
}

main().catch((e) => {
  console.error('[cook-keeper] fatal:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})

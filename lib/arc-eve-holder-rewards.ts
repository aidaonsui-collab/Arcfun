/**
 * EVE holder-rewards experiment — 2 weeks, started 2026-09-04.
 *
 * Context: $EVE's locked LP position (MonLock tokenId 4695) splits every USDC fee collection
 * 70% creator / 30% platform beneficiary. The creator leg is immutable — MonLock stamps
 * `creatorSplits[tokenId]` once at lock time and exposes no setter for it afterward (see
 * lib/arc-creator-fees.ts's module doc and MonLock.sol's repeated "immutable after stamp"
 * comments). The platform's own 30% beneficiary leg is the only part we can move, via
 * `setLockBeneficiary` — callable only by the CURRENT beneficiary.
 *
 * This module is the automation for that: a dedicated keeper wallet was made the beneficiary of
 * position 4695 (platform owner ran `setLockBeneficiary(4695, keeper)` once, by hand — see
 * docs/EVE-HOLDER-REWARDS.md). From then on, every cron tick this file:
 *
 *   1. Past the 2-week window (or if the beneficiary has already been moved off this keeper by
 *      someone else) — revert `setLockBeneficiary` back to the platform treasury, pay out
 *      whatever the keeper is still holding, and mark the program ended. One-way: once ended,
 *      every later tick is a no-op.
 *   2. Otherwise — collect the LP position's accrued USDC fees (permissionless `collectFees`),
 *      swap the collected USDC into the reward token (Uni V3, quoted + slippage-bounded — see
 *      REWARD_TOKEN below), then pro-rata disperse the resulting balance across every current EVE
 *      holder (weighted by raw ledger balance from lib/evm-holders.ts) via the already-deployed
 *      ArcDisperse contract.
 *
 * Native gas and the ERC-20 USDC balance at the same address are the same underlying value on
 * Arc (see lib/arc-reflection-keeper.ts's maybeTopUpKeeperGas doc) — a small buffer is reserved
 * out of every swap so the keeper always has enough left to pay for its own next
 * collect/approve/swap/disperse/revert calls without a separate top-up wallet.
 */
import { kv } from '@vercel/kv'
import { type Address, erc20Abi, maxUint256 } from 'viem'
import { ARC, ARC_INSTANT_LOCKER_MONLOCK, arcPublicClient, arcServerWalletClient } from './contracts-arc'
import { minOutFromSlippage } from './arc-swap'
import { getRawHolderBalances } from './evm-holders'
import cycle1Backfill from './eve-rewards-cycle1-backfill.json'

export const EVE_TOKEN = '0x19209E55049bc613c5cC8b66B7DF7824096e78CF' as Address
const EVE_POSITION_ID = 4695n
const EVE_LOCKER = ARC_INSTANT_LOCKER_MONLOCK
const EVE_UNI_POOL = '0xA4B5318c06447b64203c98EBB9547C4baE2BabcD' as Address
/** Original MonLock beneficiary — where the 30% leg reverts to when the program ends. */
const TREASURY_WALLET = '0x26bD491560b5175ee8bD1DA4998Fe260FfC413c9' as Address

/** $COOL — the reward token holders actually receive (swapped from the collected USDC leg each
 *  cycle). Not an ArcFun launch (not in our own catalog); verified directly on-chain instead:
 *  18dp ERC20, and a live Uni V3 pool against ARC.USDC at the 1% tier with ~$138k USDC-side
 *  reserves as of 2026-09-04 (checked via UniswapV3Factory.getPool — no pool exists at the
 *  0.01/0.05/0.3% tiers, only 1%). */
const REWARD_TOKEN = '0xeb64987643db71c76b2a2be7e723decc995e5b37' as Address
const REWARD_POOL_FEE = 10_000
/** Slippage tolerance on the USDC→COOL swap. Matches the Reflection keeper's custom-CA reflect
 *  slippage (lib/arc-reflection-keeper.ts REFLECT_SLIPPAGE_BPS) — same trade shape. */
const REWARD_SLIPPAGE_BPS = 500

const PROGRAM_DAYS = 14

/** Leave this much native-equivalent balance untouched so the keeper can always afford its next
 *  few calls (collect + approve + swap + a disperse batch or two). ~$0.30 at Arc's 1:1 USDC gas
 *  peg. */
const GAS_RESERVE_USDC_6DP = 300_000n
/** Don't bother swapping+dispersing below this — not worth the gas of a swap plus several batch
 *  disperse txs. */
const MIN_DISTRIBUTE_USDC_6DP = 5_000_000n // $5
/** Skip collectFees entirely when the simulated claim is this small — an empty/dust collect
 *  still costs a real tx; let fees accrue another cycle instead. */
const MIN_COLLECT_USDC_6DP = 50_000n // $0.05
/** Recipients per disperseToken call — keeps each tx comfortably under any reasonable block gas
 *  limit even as EVE's holder count grows well past today's ~260. */
const MAX_RECIPIENTS_PER_BATCH = 75

const STATE_KEY = 'arcfun:everewards:state'
const LOG_KEY = 'arcfun:everewards:log'
const LOG_CAP = 200
/** Redis hash: lowercased holder address -> cumulative atomic REWARD_TOKEN (18dp) actually sent
 *  to them so far. Same shape as the holder ledger in lib/evm-holders.ts (raw units, hash keyed
 *  by address) — lets a wallet's profile page show "how much $COOL have I earned" with a single
 *  hget instead of re-deriving it from disperse-batch history on every page view. */
const CLAIMED_KEY = 'arcfun:everewards:claimed'

export interface EveRewardsState {
  /** True once a tick has actually observed the on-chain beneficiary equal to this keeper. Before
   *  that, a beneficiary mismatch means "setup isn't done yet," not "someone pulled the safety
   *  net" — see the armed-gate comment in runEveHolderRewardsCycle for why conflating those two
   *  used to be able to permanently brick the program on a mistimed first tick. */
  armed: boolean
  /** Set the moment `armed` flips true — not at KV-state creation — so the 14-day clock starts
   *  from the real redirect, not from whatever tick happened to run first. */
  startedAt?: number
  expiresAt?: number
  ended: boolean
  endedAt?: number
  endedReason?: string
  revertTx?: string
  cycles: number
  /** Cumulative atomic USDC (6dp) collected from the LP position — kept as a string so KV
   *  round-trips exactly. */
  totalCollectedUsdc: string
  /** Cumulative atomic REWARD_TOKEN (18dp) actually sent to holders. */
  totalDistributedReward: string
  rewardToken: Address
  lastRunAt?: number
  lastError?: string
  keeper: Address
}

interface CycleLogEntry {
  at: number
  collectTx?: string
  collectSkipped?: string
  swapTx?: string
  distributed?: string
  recipients?: number
  disperseTxs?: string[]
  ended?: boolean
  revertTx?: string
  error?: string
}

const MONLOCK_ABI = [
  {
    type: 'function',
    name: 'collectFees',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'setLockBeneficiary',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'next', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'locks',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'beneficiary', type: 'address' },
      { name: 'unlockTime', type: 'uint64' },
      { name: 'withdrawn', type: 'bool' },
      { name: 'backingWallet', type: 'address' },
      { name: 'backingBps', type: 'uint16' },
    ],
  },
] as const

const POOL_TOKEN0_ABI = [
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
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

const SWAP_ROUTER_ABI = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const

const DISPERSE_ABI = [
  {
    type: 'function',
    name: 'disperseToken',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'recipients', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
    ],
    outputs: [],
  },
] as const

async function loadState(keeper: Address): Promise<EveRewardsState> {
  const existing = await kv.get<EveRewardsState>(STATE_KEY)
  if (existing) {
    // Migrate state written before the `armed` flag existed. Anything with cycles already run or
    // a stamped startedAt was already live and correctly armed under the old logic — treat it as
    // armed as-is, WITHOUT touching its existing startedAt/expiresAt (the live program's 14-day
    // clock must not reset just because this field didn't exist yet when it started).
    if (existing.armed == null) {
      existing.armed = existing.cycles > 0 || existing.startedAt != null
      await saveState(existing)
    }
    return existing
  }
  const fresh: EveRewardsState = {
    armed: false,
    ended: false,
    cycles: 0,
    totalCollectedUsdc: '0',
    totalDistributedReward: '0',
    rewardToken: REWARD_TOKEN,
    keeper,
  }
  await kv.set(STATE_KEY, fresh)
  return fresh
}

async function saveState(state: EveRewardsState): Promise<void> {
  await kv.set(STATE_KEY, state)
}

async function appendLog(entry: CycleLogEntry): Promise<void> {
  try {
    await kv.lpush(LOG_KEY, JSON.stringify(entry))
    await kv.ltrim(LOG_KEY, 0, LOG_CAP - 1)
  } catch {
    /* audit trail only — never block the cycle on it */
  }
}

/** Add one successfully-sent batch's amounts onto each recipient's running total. Called only
 *  after disperseToken's tx has actually confirmed — never for a batch that failed or wasn't
 *  attempted, so this can't overstate what a wallet has really received. Same
 *  read-current/apply-delta/write-back shape as evm-holders.ts's ledger, for the same reason: a
 *  full-hash read/write here would cost more the longer the holder list grows, for no benefit
 *  when only a handful of addresses changed. */
async function creditClaimed(batch: { address: Address; amount: bigint }[]): Promise<void> {
  if (!batch.length) return
  try {
    const addrs = batch.map((r) => r.address.toLowerCase())
    const current = (await kv.hmget<Record<string, string>>(CLAIMED_KEY, ...addrs)) ?? {}
    const updates: Record<string, string> = {}
    for (const { address, amount } of batch) {
      const a = address.toLowerCase()
      const prev = current[a] ? BigInt(current[a]) : 0n
      updates[a] = (prev + amount).toString()
    }
    await kv.hset(CLAIMED_KEY, updates)
  } catch (e) {
    // Best-effort tracking only — never let a KV hiccup here undo or retry a disperse that
    // already succeeded on-chain.
    console.warn('[arc-eve-holder-rewards] creditClaimed', (e as Error).message?.slice(0, 200))
  }
}

/** How much REWARD_TOKEN a wallet has actually been sent by this program so far, atomic units. */
export async function getClaimedCoolRewards(wallet: Address): Promise<bigint> {
  try {
    const raw = await kv.hget<string>(CLAIMED_KEY, wallet.toLowerCase())
    return raw ? BigInt(raw) : 0n
  } catch {
    return 0n
  }
}

const BACKFILL_DONE_KEY = 'arcfun:everewards:claimed:backfilled'

/**
 * One-time seed for the very first disperse cycle (2026-09-04, 4 batches, 260 recipients), which
 * ran before per-wallet tracking (creditClaimed above) existed. Sourced from the underlying
 * ERC-20 Transfer logs on $COOL from ArcDisperse for that cycle's exact block range — verified to
 * sum to 2118206219140240659049, which matches that cycle's EveRewardsState.totalDistributedReward
 * exactly. Every cycle since has been tracked incrementally as it happened; this fills the one
 * gap before that existed. Guarded by BACKFILL_DONE_KEY so calling this more than once (or
 * concurrently) never double-credits.
 */
export async function backfillCycle1Claimed(): Promise<{ ok: boolean; applied: boolean }> {
  try {
    if (await kv.get<boolean>(BACKFILL_DONE_KEY)) return { ok: true, applied: false }
    const entries = Object.entries(cycle1Backfill as Record<string, string>).map(([address, amount]) => ({
      address: address as Address,
      amount: BigInt(amount),
    }))
    await creditClaimed(entries)
    await kv.set(BACKFILL_DONE_KEY, true)
    return { ok: true, applied: true }
  } catch (e) {
    console.warn('[arc-eve-holder-rewards] backfillCycle1Claimed', (e as Error).message?.slice(0, 200))
    return { ok: false, applied: false }
  }
}

/** Cached for the process lifetime — EVE's pool token0/token1 order never changes. */
let usdcIs0Cache: boolean | null = null
async function usdcIsToken0(client: ReturnType<typeof arcPublicClient>): Promise<boolean> {
  if (usdcIs0Cache != null) return usdcIs0Cache
  const token0 = (await client.readContract({
    address: EVE_UNI_POOL,
    abi: POOL_TOKEN0_ABI,
    functionName: 'token0',
  })) as Address
  usdcIs0Cache = token0.toLowerCase() === ARC.USDC.toLowerCase()
  return usdcIs0Cache
}

/** eth_call collectFees first; skip the paid tx if the claim is dust. */
async function simulateCollect(
  client: ReturnType<typeof arcPublicClient>,
  account: Address,
): Promise<{ skip: string | null; usdcAmount: bigint }> {
  try {
    const [sim, usdcIs0] = await Promise.all([
      client.simulateContract({
        account,
        address: EVE_LOCKER,
        abi: MONLOCK_ABI,
        functionName: 'collectFees',
        args: [EVE_POSITION_ID],
      }),
      usdcIsToken0(client),
    ])
    const [amount0, amount1] = sim.result as readonly [bigint, bigint]
    const usdcAmount = usdcIs0 ? amount0 : amount1
    if (usdcAmount < MIN_COLLECT_USDC_6DP) return { skip: `dust collect ${amount0}/${amount1}`, usdcAmount }
    return { skip: null, usdcAmount }
  } catch {
    // Simulate failing doesn't mean the real call will — try it for real.
    return { skip: null, usdcAmount: 0n }
  }
}

/** Quote USDC → REWARD_TOKEN on the one pool that actually exists for this pair (1% tier — see
 *  REWARD_TOKEN's comment). Returns null rather than a zero/garbage quote so the caller never
 *  swaps blind. */
async function quoteUsdcToReward(
  client: ReturnType<typeof arcPublicClient>,
  usdcIn: bigint,
): Promise<{ amountOut: bigint } | null> {
  if (usdcIn <= 0n || !ARC.UNI_QUOTER) return null
  try {
    const res = (await client.readContract({
      address: ARC.UNI_QUOTER,
      abi: QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn: ARC.USDC,
          tokenOut: REWARD_TOKEN,
          amountIn: usdcIn,
          fee: REWARD_POOL_FEE,
          sqrtPriceLimitX96: 0n,
        },
      ],
    })) as readonly [bigint, bigint, number, bigint]
    return res[0] > 0n ? { amountOut: res[0] } : null
  } catch {
    return null
  }
}

/** Pro-rata split of `pool` across `balances`, floor-rounded. Leftover dust from rounding just
 *  stays in the keeper's balance for next cycle — never lost, never double-counted. */
function splitProRata(pool: bigint, balances: Map<string, bigint>): { address: Address; amount: bigint }[] {
  let total = 0n
  for (const b of balances.values()) total += b
  if (total <= 0n) return []
  const out: { address: Address; amount: bigint }[] = []
  for (const [addr, bal] of balances) {
    const amount = (pool * bal) / total
    if (amount > 0n) out.push({ address: addr as Address, amount })
  }
  return out
}

export interface EveRewardsCycleResult {
  ok: boolean
  ended?: boolean
  revertTx?: string
  collectTx?: string
  collectSkipped?: string
  swapTx?: string
  distributed?: string
  recipients?: number
  disperseTxs?: string[]
  skippedDistribute?: string
  error?: string
  state: EveRewardsState
}

export async function runEveHolderRewardsCycle(privateKey: `0x${string}`): Promise<EveRewardsCycleResult> {
  const client = arcPublicClient()
  const wallet = arcServerWalletClient(privateKey)
  const keeper = wallet.account.address

  const state = await loadState(keeper)
  const now = Date.now()

  // No-ops after the first successful run (BACKFILL_DONE_KEY-guarded) — self-heals the one gap
  // in per-wallet tracking (the cycle that ran before creditClaimed existed) on whatever cron
  // tick happens to run this code first, rather than needing a separate manual trigger.
  await backfillCycle1Claimed()

  if (state.ended) {
    return { ok: true, ended: true, state }
  }

  let onChainBeneficiary: Address | null = null
  try {
    const lock = (await client.readContract({
      address: EVE_LOCKER,
      abi: MONLOCK_ABI,
      functionName: 'locks',
      args: [EVE_POSITION_ID],
    })) as readonly [Address, bigint, boolean, Address, number]
    onChainBeneficiary = lock[0]
  } catch (e) {
    state.lastError = `locks() read failed: ${(e as Error).message?.slice(0, 200)}`
    await saveState(state)
    return { ok: false, error: state.lastError, state }
  }

  const beneficiaryIsKeeper = onChainBeneficiary.toLowerCase() === keeper.toLowerCase()

  if (!beneficiaryIsKeeper && !state.armed) {
    // Manual setLockBeneficiary hasn't landed yet — this is the pre-arming state, not the
    // "someone pulled the safety net" state below. Conflating the two used to be the bug here: a
    // tick landing even one cron cycle before the manual redirect would stamp startedAt/expiresAt
    // and then immediately mark the whole program permanently ended, having never actually run
    // (see docs/EVE-HOLDER-REWARDS.md's "point of no return" warning, added after that was
    // caught before it happened live). Wait quietly instead — no clock started, no cycle
    // counted, nothing ended, every future tick just checks again.
    state.lastRunAt = now
    await saveState(state)
    await appendLog({ at: now, error: 'not armed yet — on-chain beneficiary is not the keeper' })
    return { ok: true, state, skippedDistribute: 'not armed yet — on-chain beneficiary is not the keeper' }
  }

  if (beneficiaryIsKeeper && !state.armed) {
    // First tick to actually see the redirect live — start the 14-day clock from here, not from
    // whichever earlier (premature) tick happened to create the KV state.
    state.armed = true
    state.startedAt = now
    state.expiresAt = now + PROGRAM_DAYS * 24 * 60 * 60 * 1000
  }

  // Once armed, a beneficiary that's no longer the keeper means someone used the manual
  // cast-send safety net (docs/EVE-HOLDER-REWARDS.md) — treat exactly like reaching the expiry:
  // pay out whatever's left, mark ended, never call setLockBeneficiary ourselves again (we no
  // longer have the right to).
  const externallyReverted = !beneficiaryIsKeeper
  const expired = state.expiresAt != null && now >= state.expiresAt

  let revertTx: string | undefined
  if (expired && !externallyReverted) {
    try {
      const hash = await wallet.writeContract({
        address: EVE_LOCKER,
        abi: MONLOCK_ABI,
        functionName: 'setLockBeneficiary',
        args: [EVE_POSITION_ID, TREASURY_WALLET],
        chain: wallet.chain,
      })
      await client.waitForTransactionReceipt({ hash })
      revertTx = hash
    } catch (e) {
      state.lastError = `setLockBeneficiary revert failed: ${(e as Error).message?.slice(0, 200)}`
      await saveState(state)
      await appendLog({ at: now, error: state.lastError })
      return { ok: false, error: state.lastError, state }
    }
  }

  const endingNow = expired || externallyReverted

  // Collect (unless we're already past the beneficiary — either someone else moved it, or we
  // just did above — in which case a new collect would send the platform's leg to the treasury,
  // not to us, and crediting it to totalCollectedUsdc would overstate what this keeper actually
  // received).
  let collectTx: string | undefined
  let collectSkipped: string | undefined
  if (!externallyReverted && !revertTx) {
    const sim = await simulateCollect(client, keeper)
    if (sim.skip) {
      collectSkipped = sim.skip
    } else {
      try {
        const hash = await wallet.writeContract({
          address: EVE_LOCKER,
          abi: MONLOCK_ABI,
          functionName: 'collectFees',
          args: [EVE_POSITION_ID],
          chain: wallet.chain,
        })
        await client.waitForTransactionReceipt({ hash })
        collectTx = hash
        state.totalCollectedUsdc = (BigInt(state.totalCollectedUsdc) + sim.usdcAmount).toString()
      } catch (e) {
        collectSkipped = `collect failed: ${(e as Error).message?.slice(0, 200)}`
      }
    }
  }

  // Swap the USDC leg into the reward token — gated on the USDC-side dust floor, since that's
  // what decides whether a swap is worth its own gas. Best-effort: a failed/skipped swap still
  // falls through to the disperse step below, which pays out whatever REWARD_TOKEN the keeper
  // already holds (e.g. left over from a prior cycle's swap whose disperse batch failed) rather
  // than stranding it.
  const usdcBalance = (await client
    .readContract({ address: ARC.USDC, abi: erc20Abi, functionName: 'balanceOf', args: [keeper] })
    .catch(() => 0n)) as bigint
  const distributable = usdcBalance > GAS_RESERVE_USDC_6DP ? usdcBalance - GAS_RESERVE_USDC_6DP : 0n
  const floor = endingNow ? 0n : MIN_DISTRIBUTE_USDC_6DP

  let swapTx: string | undefined
  let distributed: string | undefined
  let recipients: number | undefined
  let disperseTxs: string[] | undefined
  let skippedDistribute: string | undefined

  if (distributable > floor && distributable > 0n) {
    const quote = await quoteUsdcToReward(client, distributable)
    if (!quote) {
      skippedDistribute = 'no Uni V3 USDC→COOL quote — leaving USDC for next cycle'
    } else {
      const minOut = minOutFromSlippage(quote.amountOut, REWARD_SLIPPAGE_BPS)
      try {
        const allowance = (await client.readContract({
          address: ARC.USDC,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [keeper, ARC.UNI_ROUTER],
        })) as bigint
        if (allowance < distributable) {
          const approveHash = await wallet.writeContract({
            address: ARC.USDC,
            abi: erc20Abi,
            functionName: 'approve',
            args: [ARC.UNI_ROUTER, maxUint256],
            chain: wallet.chain,
          })
          await client.waitForTransactionReceipt({ hash: approveHash })
        }
        const hash = await wallet.writeContract({
          address: ARC.UNI_ROUTER,
          abi: SWAP_ROUTER_ABI,
          functionName: 'exactInputSingle',
          args: [
            {
              tokenIn: ARC.USDC,
              tokenOut: REWARD_TOKEN,
              fee: REWARD_POOL_FEE,
              recipient: keeper,
              amountIn: distributable,
              amountOutMinimum: minOut,
              sqrtPriceLimitX96: 0n,
            },
          ],
          chain: wallet.chain,
        })
        await client.waitForTransactionReceipt({ hash })
        swapTx = hash
      } catch (e) {
        skippedDistribute = `swap failed: ${(e as Error).message?.slice(0, 200)}`
      }
    }
  }

  // Disperse whatever REWARD_TOKEN the keeper is holding right now (this cycle's swap output
  // plus any carryover) — not just this cycle's delta, so a prior cycle's failed disperse batch
  // still gets paid out here instead of sitting stranded. Always attempt this on the final
  // (ending) cycle even with no fresh swap, so nothing is left behind when the program ends.
  if (swapTx || endingNow) {
    const rewardPool = (await client
      .readContract({ address: REWARD_TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [keeper] })
      .catch(() => 0n)) as bigint
    if (rewardPool <= 0n) {
      skippedDistribute = skippedDistribute ?? 'no reward-token balance to distribute'
    } else {
      // EVE_UNI_POOL isn't in instantProtocolAddresses() (that list is static/per-factory, pools
      // are per-token) and currently holds ~20% of EVE's supply as LP reserve — confirmed live
      // 2026-09-04. Left in, it would be paid a fifth of every distribution for a contract that
      // can't do anything with an un-swapped inbound transfer. The general holders route
      // (app/api/arc/[token]/holders/route.ts) excludes this same address for the same reason.
      const balances = await getRawHolderBalances(EVE_TOKEN, { excludeAddresses: [keeper, EVE_UNI_POOL] })
      const shares = splitProRata(rewardPool, balances)
      if (!shares.length) {
        skippedDistribute = 'no eligible holders'
      } else {
        const txs: string[] = []
        let totalSent = 0n
        for (let i = 0; i < shares.length; i += MAX_RECIPIENTS_PER_BATCH) {
          const batch = shares.slice(i, i + MAX_RECIPIENTS_PER_BATCH)
          const batchTotal = batch.reduce((s, r) => s + r.amount, 0n)
          try {
            const allowance = (await client.readContract({
              address: REWARD_TOKEN,
              abi: erc20Abi,
              functionName: 'allowance',
              args: [keeper, ARC.DISPERSE],
            })) as bigint
            if (allowance < batchTotal) {
              const approveHash = await wallet.writeContract({
                address: REWARD_TOKEN,
                abi: erc20Abi,
                functionName: 'approve',
                args: [ARC.DISPERSE, maxUint256],
                chain: wallet.chain,
              })
              await client.waitForTransactionReceipt({ hash: approveHash })
            }
            const hash = await wallet.writeContract({
              address: ARC.DISPERSE,
              abi: DISPERSE_ABI,
              functionName: 'disperseToken',
              args: [REWARD_TOKEN, batch.map((r) => r.address), batch.map((r) => r.amount)],
              chain: wallet.chain,
            })
            await client.waitForTransactionReceipt({ hash })
            txs.push(hash)
            totalSent += batchTotal
            await creditClaimed(batch)
          } catch (e) {
            // Stop on the first failed batch — funds for the remaining batches stay in the
            // keeper wallet and are simply retried (re-split against then-current balances)
            // next cycle, rather than risking a partial send we can't cleanly account for.
            skippedDistribute = `batch ${i / MAX_RECIPIENTS_PER_BATCH} failed: ${(e as Error).message?.slice(0, 200)}`
            break
          }
        }
        if (txs.length) {
          distributed = totalSent.toString()
          recipients = Math.min(shares.length, txs.length * MAX_RECIPIENTS_PER_BATCH)
          disperseTxs = txs
          state.totalDistributedReward = (BigInt(state.totalDistributedReward) + totalSent).toString()
        }
      }
    }
  }

  state.cycles += 1
  state.lastRunAt = now
  state.lastError = undefined
  if (endingNow) {
    state.ended = true
    state.endedAt = now
    state.endedReason = externallyReverted ? 'beneficiary moved off keeper externally' : 'expired'
    if (revertTx) state.revertTx = revertTx
  }
  await saveState(state)
  await appendLog({
    at: now,
    collectTx,
    collectSkipped,
    swapTx,
    distributed,
    recipients,
    disperseTxs,
    ended: endingNow || undefined,
    revertTx,
  })

  return {
    ok: true,
    ended: endingNow,
    revertTx,
    collectTx,
    collectSkipped,
    swapTx,
    distributed,
    recipients,
    disperseTxs,
    skippedDistribute,
    state,
  }
}

export async function getEveHolderRewardsStatus(): Promise<{
  state: EveRewardsState | null
  recentCycles: CycleLogEntry[]
}> {
  const [state, rawLog] = await Promise.all([
    kv.get<EveRewardsState>(STATE_KEY),
    kv.lrange<string>(LOG_KEY, 0, 19).catch(() => [] as string[]),
  ])
  const recentCycles = rawLog
    .map((s) => {
      try {
        return JSON.parse(s) as CycleLogEntry
      } catch {
        return null
      }
    })
    .filter((x): x is CycleLogEntry => x != null)
  return { state: state ?? null, recentCycles }
}

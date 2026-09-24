/**
 * What the bot's session key is allowed to sign: exactly [approve USDC → router, router buy of
 * $EVE] for the amounts in the quote the user said YES to. Off-chain gate run before signing; the
 * Phase 2 on-chain Kernel permission must encode the same rules.
 */
import { decodeFunctionData, erc20Abi, formatUnits, type Abi, type Address, type Hex } from 'viem'
import type { Call } from './kernel'

export type BuyRouter =
  | { kind: 'referral'; address: Address }
  | { kind: 'fee'; address: Address; uniRouter: Address }

export type BuyPolicy = {
  usdc: Address
  token: Address
  poolFee: number
  router: BuyRouter
  minUsdc: bigint
  maxPerBuy: bigint
  maxPerDay: bigint
  maxSlippageBps: number
}

/**
 * Live Arc mainnet values, pinned. Deliberately not read from ARC.* env: the env is what builds
 * the calls, so checking against it would pass anything. The live site sets
 * NEXT_PUBLIC_ARC_REFERRAL_ROUTER, so buildArcBuy emits ReferralRouter.buy (which routes through
 * FeeRouter 0x8d05…3394 at 1%). Run without that env and the helpers fall back to the stale
 * in-code FeeRouter 0x6795…f088 — this policy rejects that.
 */
export const DEFAULT_BUY_POLICY: BuyPolicy = {
  usdc: '0x3600000000000000000000000000000000000000',
  token: '0x19209E55049bc613c5cC8b66B7DF7824096e78CF',
  poolFee: 10_000,
  router: { kind: 'referral', address: '0xe65eE188f8FaB172CaA981b9bf4b8B71a3E8dC06' },
  minUsdc: 1_000_000n,
  maxPerBuy: 25_000_000n,
  maxPerDay: 100_000_000n,
  maxSlippageBps: 300,
}

const REFERRAL_BUY_ABI = [
  {
    type: 'function',
    name: 'buy',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenOut', type: 'address' },
      { name: 'poolFee', type: 'uint24' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMinimum', type: 'uint256' },
      { name: 'code', type: 'string' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const

const FEE_ROUTER_SWAP_ABI = [
  {
    type: 'function',
    name: 'swapExactInput',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'router', type: 'address' },
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'poolFee', type: 'uint24' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMinimum', type: 'uint256' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const

export type QuotedBuy = { usdcIn: bigint; quotedOut: bigint; minOut: bigint }

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
export const usd = (v: bigint) => `$${Number(formatUnits(v, 6)).toFixed(2)}`

/** User-facing limit check. Null when the amount is allowed. */
export function capViolation(usdcIn: bigint, policy: BuyPolicy, spentToday: bigint): string | null {
  if (usdcIn < policy.minUsdc) return `Minimum buy is ${usd(policy.minUsdc)}.`
  if (usdcIn > policy.maxPerBuy) return `Max per buy is ${usd(policy.maxPerBuy)}.`
  if (spentToday + usdcIn > policy.maxPerDay) {
    const left = policy.maxPerDay > spentToday ? policy.maxPerDay - spentToday : 0n
    return `Daily limit is ${usd(policy.maxPerDay)} — ${usd(left)} left today.`
  }
  return null
}

function decodeOrNull(abi: Abi, data: Hex): { functionName: string; args: readonly unknown[] } | null {
  try {
    const d = decodeFunctionData({ abi, data })
    return { functionName: d.functionName, args: d.args ?? [] }
  } catch {
    return null
  }
}

/** Every reason these calls must not be signed. Empty array = allowed. */
export function checkBuyCalls(calls: Call[], q: QuotedBuy, policy: BuyPolicy, spentToday: bigint): string[] {
  const bad: string[] = []
  const cap = capViolation(q.usdcIn, policy, spentToday)
  if (cap) bad.push(cap)
  if (q.minOut <= 0n) bad.push('minOut is zero (no slippage protection)')
  else if (q.minOut * 10_000n < q.quotedOut * BigInt(10_000 - policy.maxSlippageBps)) {
    bad.push(`minOut is looser than ${policy.maxSlippageBps} bps slippage`)
  }
  if (calls.length < 1 || calls.length > 2) {
    bad.push(`expected 1–2 calls (approve?, buy), got ${calls.length}`)
    return bad
  }
  for (const c of calls) if (c.value !== 0n) bad.push(`call to ${c.target} sends value`)

  const router = policy.router
  const buy = calls[calls.length - 1]
  if (!same(buy.target, router.address)) {
    bad.push(
      `buy targets ${buy.target}, only ${router.kind === 'referral' ? 'ReferralRouter' : 'FeeRouter'} ` +
        `${router.address} is allowed (is NEXT_PUBLIC_ARC_* env loaded?)`,
    )
  } else if (router.kind === 'referral') {
    const d = decodeOrNull(REFERRAL_BUY_ABI, buy.data)
    if (!d) bad.push('buy call is not ReferralRouter.buy')
    else {
      const [tokenOut, poolFee, amountIn, minOut, code] = d.args as [Address, number, bigint, bigint, string]
      if (!same(tokenOut, policy.token)) bad.push(`buy tokenOut ${tokenOut} is not $EVE`)
      if (Number(poolFee) !== policy.poolFee) bad.push(`buy pool fee ${poolFee} ≠ ${policy.poolFee}`)
      if (amountIn !== q.usdcIn) bad.push('buy amountIn ≠ quote')
      if (minOut !== q.minOut) bad.push('buy minOut ≠ quote')
      if (code !== '') bad.push('referral codes are not accepted from chat')
    }
  } else {
    const d = decodeOrNull(FEE_ROUTER_SWAP_ABI, buy.data)
    if (!d) bad.push('buy call is not FeeRouter.swapExactInput')
    else {
      const [uni, tokenIn, tokenOut, poolFee, amountIn, minOut] = d.args as [
        Address, Address, Address, number, bigint, bigint,
      ]
      if (!same(uni, router.uniRouter)) bad.push(`swap router ${uni} is not SwapRouter02`)
      if (!same(tokenIn, policy.usdc)) bad.push('swap tokenIn is not USDC')
      if (!same(tokenOut, policy.token)) bad.push(`swap tokenOut ${tokenOut} is not $EVE`)
      if (Number(poolFee) !== policy.poolFee) bad.push(`swap pool fee ${poolFee} ≠ ${policy.poolFee}`)
      if (amountIn !== q.usdcIn) bad.push('swap amountIn ≠ quote')
      if (minOut !== q.minOut) bad.push('swap minOut ≠ quote')
    }
  }

  if (calls.length === 2) {
    const approve = calls[0]
    const d = same(approve.target, policy.usdc) ? decodeOrNull(erc20Abi, approve.data) : null
    if (!d || d.functionName !== 'approve') bad.push('first call must be USDC.approve')
    else {
      const [spender, amount] = d.args as [Address, bigint]
      if (!same(spender, router.address)) bad.push(`approve spender ${spender} is not the buy router`)
      if (amount !== q.usdcIn) bad.push(`approve amount ${usd(amount)} ≠ quote ${usd(q.usdcIn)}`)
    }
  }
  return bad
}

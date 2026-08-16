/**
 * Arc Instant swap helpers — TOKEN ↔ USDC (6dp) via Uni V3 Quoter + FeeRouter/SwapRouter02.
 */
import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
} from 'viem'
import { ARC, ARC_CHAIN_ID, arcPublicClient, arcRobinSwapEnabled } from './contracts-arc'

const ZERO = '0x0000000000000000000000000000000000000000' as Address
const POOL_FEE = ARC.UNI_POOL_FEE // 10000 — ArcFun's own launch tier, and the fallback

/**
 * Every Uni V3 fee tier, cheapest first. ArcFun launches at 1%, but the Arc factory is shared —
 * DyorSwap's frontend ships this same factory address, and its launches sit at the 0.01% tier.
 * Enumerated PoolCreated on 0xf0db7b58…c653918 (2026-08-16): 163 pools, 132 at 1% and 31 at 0.01%.
 * Hardcoding 1% meant every one of those 31 pools reverted here rather than quoting.
 */
const POOL_FEE_TIERS = [100, 500, 3000, 10000] as const

const UNI_V3_FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ type: 'address' }],
  },
] as const

const UNI_V3_POOL_ABI = [
  {
    type: 'function',
    name: 'liquidity',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint128' }],
  },
] as const

/**
 * token -> fee tier. A pool's tier never changes once created, so a positive hit is cached for
 * the process lifetime. Misses are NOT cached: a token can get its first pool at any moment
 * (that's every ArcFun launch), and caching "no pool" would make a fresh launch untradeable
 * until redeploy.
 */
const poolFeeCache = new Map<string, number>()

/**
 * Which fee tier actually holds the TOKEN/USDC pool. Returns null when no tier has one.
 * All four getPool reads go out in a single multicall3 batch — Arc's public RPCs rate-limit
 * under burst, so this must not become four round trips per quote.
 */
export async function findArcPoolFee(token: Address): Promise<number | null> {
  const key = token.toLowerCase()
  const cached = poolFeeCache.get(key)
  if (cached != null) return cached
  if (token.toLowerCase() === ARC.USDC.toLowerCase()) return null

  const client = arcPublicClient()
  let pools: (Address | null)[]
  try {
    const res = await client.multicall({
      contracts: POOL_FEE_TIERS.map((fee) => ({
        address: ARC.UNI_FACTORY,
        abi: UNI_V3_FACTORY_ABI,
        functionName: 'getPool' as const,
        args: [ARC.USDC, token, fee] as const,
      })),
      allowFailure: true,
    })
    pools = res.map((r) => (r.status === 'success' ? (r.result as Address) : null))
  } catch {
    return null
  }

  const found: { fee: number; pool: Address }[] = []
  POOL_FEE_TIERS.forEach((fee, i) => {
    const pool = pools[i]
    if (pool && pool !== ZERO) found.push({ fee, pool })
  })
  if (found.length === 0) return null
  if (found.length === 1) {
    poolFeeCache.set(key, found[0].fee)
    return found[0].fee
  }

  // Rare on Arc today (no token has two tiers), but a token can be pooled at several. Pick the
  // deepest by in-range liquidity rather than assuming a tier, so quotes follow the real book.
  try {
    const liq = await client.multicall({
      contracts: found.map((c) => ({
        address: c.pool,
        abi: UNI_V3_POOL_ABI,
        functionName: 'liquidity' as const,
      })),
      allowFailure: true,
    })
    let best = found[0].fee
    let bestLiq = -1n
    liq.forEach((r, i) => {
      const v = r.status === 'success' ? (r.result as bigint) : 0n
      if (v > bestLiq) {
        bestLiq = v
        best = found[i].fee
      }
    })
    poolFeeCache.set(key, best)
    return best
  } catch {
    poolFeeCache.set(key, found[0].fee)
    return found[0].fee
  }
}

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

const FEE_ROUTER_ABI = [
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
  {
    type: 'function',
    name: 'feeBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint16' }],
  },
] as const

export function arcSwapConfigured(): boolean {
  return arcRobinSwapEnabled()
}

export function useFeeRouter(): boolean {
  return ARC.FEE_ROUTER !== ZERO
}

export function parseUsdc(v: string | number): bigint {
  return parseUnits(String(v || '0'), 6)
}

export function formatUsdc(v: bigint): string {
  const n = Number(formatUnits(v, 6))
  if (n === 0) return '0'
  if (n < 0.000001) return n.toExponential(3)
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 })
}

export function minOutFromSlippage(amountOut: bigint, slippageBps: number): bigint {
  if (amountOut <= 0n) return 0n
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n
}

async function feeBps(): Promise<number> {
  if (!useFeeRouter()) return 0
  try {
    const bps = (await arcPublicClient().readContract({
      address: ARC.FEE_ROUTER,
      abi: FEE_ROUTER_ABI,
      functionName: 'feeBps',
    })) as number
    return Number(bps) || 0
  } catch {
    return ARC.FEE_BPS || 100
  }
}

/** Gross amountIn for quote — FeeRouter skims fee first, so quote on net. */
function netAfterFee(amountIn: bigint, bps: number): bigint {
  if (bps <= 0) return amountIn
  return amountIn - (amountIn * BigInt(bps)) / 10_000n
}

export async function quoteArcBuy(token: Address, usdcIn: bigint): Promise<bigint | null> {
  if (usdcIn <= 0n || !arcSwapConfigured()) return null
  const bps = await feeBps()
  const swapIn = netAfterFee(usdcIn, bps)
  if (swapIn <= 0n) return null
  const fee = (await findArcPoolFee(token)) ?? POOL_FEE
  try {
    const res = (await arcPublicClient().readContract({
      address: ARC.UNI_QUOTER,
      abi: QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn: ARC.USDC,
          tokenOut: token,
          amountIn: swapIn,
          fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    })) as readonly [bigint, bigint, number, bigint]
    return res[0] > 0n ? res[0] : null
  } catch {
    return null
  }
}

export async function quoteArcSell(token: Address, tokenIn: bigint): Promise<bigint | null> {
  if (tokenIn <= 0n || !arcSwapConfigured()) return null
  const bps = await feeBps()
  const swapIn = netAfterFee(tokenIn, bps)
  if (swapIn <= 0n) return null
  const fee = (await findArcPoolFee(token)) ?? POOL_FEE
  try {
    const res = (await arcPublicClient().readContract({
      address: ARC.UNI_QUOTER,
      abi: QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn: token,
          tokenOut: ARC.USDC,
          amountIn: swapIn,
          fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    })) as readonly [bigint, bigint, number, bigint]
    return res[0] > 0n ? res[0] : null
  } catch {
    return null
  }
}

export type ArcSwapWrite = {
  address: Address
  abi: readonly unknown[]
  functionName: string
  args: unknown[]
  chainId: number
}

/** Spender to approve for the given side (FeeRouter or Uni router). */
export function arcSwapSpender(): Address {
  return useFeeRouter() ? ARC.FEE_ROUTER : ARC.UNI_ROUTER
}

/**
 * `fee` must be the tier the quote came from — pass `await findArcPoolFee(token)`. Quoting one
 * tier and swapping another reverts (or fills against a different book), so callers resolve it
 * once and hand it to both. Defaults to ArcFun's 1% launch tier when omitted.
 */
export function buildArcBuy(
  token: Address,
  usdcIn: bigint,
  amountOutMin: bigint,
  fee: number = POOL_FEE,
): ArcSwapWrite {
  if (useFeeRouter()) {
    return {
      address: ARC.FEE_ROUTER,
      abi: FEE_ROUTER_ABI,
      functionName: 'swapExactInput',
      args: [ARC.UNI_ROUTER, ARC.USDC, token, fee, usdcIn, amountOutMin],
      chainId: ARC_CHAIN_ID,
    }
  }
  return {
    address: ARC.UNI_ROUTER,
    abi: SWAP_ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: ARC.USDC,
        tokenOut: token,
        fee,
        recipient: ZERO, // filled by caller with user address
        amountIn: usdcIn,
        amountOutMinimum: amountOutMin,
        sqrtPriceLimitX96: 0n,
      },
    ],
    chainId: ARC_CHAIN_ID,
  }
}

/** See buildArcBuy — `fee` must match the tier the quote used. */
export function buildArcSell(
  token: Address,
  tokenIn: bigint,
  amountOutMin: bigint,
  recipient: Address,
  fee: number = POOL_FEE,
): ArcSwapWrite {
  if (useFeeRouter()) {
    return {
      address: ARC.FEE_ROUTER,
      abi: FEE_ROUTER_ABI,
      functionName: 'swapExactInput',
      args: [ARC.UNI_ROUTER, token, ARC.USDC, fee, tokenIn, amountOutMin],
      chainId: ARC_CHAIN_ID,
    }
  }
  return {
    address: ARC.UNI_ROUTER,
    abi: SWAP_ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: token,
        tokenOut: ARC.USDC,
        fee,
        recipient,
        amountIn: tokenIn,
        amountOutMinimum: amountOutMin,
        sqrtPriceLimitX96: 0n,
      },
    ],
    chainId: ARC_CHAIN_ID,
  }
}

/** Patch recipient on direct-router buy (fee router always sends to msg.sender). */
export function withRecipient(call: ArcSwapWrite, recipient: Address): ArcSwapWrite {
  if (call.functionName !== 'exactInputSingle') return call
  const params = { ...(call.args[0] as Record<string, unknown>), recipient }
  return { ...call, args: [params] }
}

export function encodeApprove(token: Address, spender: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, amount],
  })
}

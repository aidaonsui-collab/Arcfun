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
const POOL_FEE = ARC.UNI_POOL_FEE // 10000

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
          fee: POOL_FEE,
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
          fee: POOL_FEE,
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

export function buildArcBuy(token: Address, usdcIn: bigint, amountOutMin: bigint): ArcSwapWrite {
  if (useFeeRouter()) {
    return {
      address: ARC.FEE_ROUTER,
      abi: FEE_ROUTER_ABI,
      functionName: 'swapExactInput',
      args: [ARC.UNI_ROUTER, ARC.USDC, token, POOL_FEE, usdcIn, amountOutMin],
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
        fee: POOL_FEE,
        recipient: ZERO, // filled by caller with user address
        amountIn: usdcIn,
        amountOutMinimum: amountOutMin,
        sqrtPriceLimitX96: 0n,
      },
    ],
    chainId: ARC_CHAIN_ID,
  }
}

export function buildArcSell(
  token: Address,
  tokenIn: bigint,
  amountOutMin: bigint,
  recipient: Address,
): ArcSwapWrite {
  if (useFeeRouter()) {
    return {
      address: ARC.FEE_ROUTER,
      abi: FEE_ROUTER_ABI,
      functionName: 'swapExactInput',
      args: [ARC.UNI_ROUTER, token, ARC.USDC, POOL_FEE, tokenIn, amountOutMin],
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
        fee: POOL_FEE,
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

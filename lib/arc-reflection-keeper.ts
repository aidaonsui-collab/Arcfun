/**
 * Arc LP-fee keeper — Instant collect + Instant Reflection sweep.
 * Cron: app/api/arc/keeper/reflect/route.ts + vercel.json (every 15m).
 *
 * Instant (TOKEN/USDC):
 *   collectFees(positionId) on the locker for that factory. MonLock 70/30 for
 *   retired Instant factories; CrucibleLock 50/25/10/10/5 for new creates. No reflect step.
 *
 * Instant Reflection:
 *   1. MonLock.collectFees(positionId) — 25% creator / 50% holder-sink / 25% platform;
 *      launch-token side burns.
 *   2. feeSink.forwardFees() — USDC into pendingReflectionQuote[token].
 *   3. factory.reflect(token, amountOutMinimum) — distribute + pushRewards.
 *
 * For rewardToken === USDC, amountOutMinimum is 0 (pass-through, no swap).
 * For custom reward CAs, the keeper quotes Uni V3 USDC→reward (same fee tiers as the factory:
 * 1% / 0.3% / 0.05% / 0.01%), applies REFLECT_SLIPPAGE_BPS, and passes that minOut.
 */
import { type Address, erc20Abi, parseEther } from 'viem'
import {
  ARC,
  ARC_CHAIN_ID,
  ARC_PLATFORM_WALLET,
  arcInstantEnabled,
  arcPublicClient,
  arcReflectionEnabled,
  arcServerWalletClient,
  instantCatalogFactories,
  instantLockerForFactory,
} from './contracts-arc'
import { INSTANT_REFLECTION_FACTORY_ABI } from './arc-reflection-launchpad'
import { INSTANT_QUOTE_FACTORY_ABI } from './instant-quote-launchpad'
import { minOutFromSlippage } from './arc-swap'

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
] as const

const FEE_SINK_ABI = [
  {
    type: 'function',
    name: 'forwardFees',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ name: 'amount', type: 'uint256' }],
  },
] as const

const REFLECTION_EXTRA_ABI = [
  {
    type: 'function',
    name: 'pools',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      { name: 'creator', type: 'address' },
      { name: 'rewardToken', type: 'address' },
      { name: 'feeSink', type: 'address' },
      { name: 'uniPool', type: 'address' },
      { name: 'positionId', type: 'uint256' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' },
    ],
  },
  {
    type: 'function',
    name: 'pendingReflectionQuote',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'reflect',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amountOutMinimum', type: 'uint256' },
    ],
    outputs: [{ name: 'rewardOut', type: 'uint256' }],
  },
] as const

/** Skip reflect() below this — not worth the gas. $0.25 USDC (6dp). */
const MIN_REFLECT_USDC = 250_000n
/**
 * Skip collectFees when both legs are dust. Empty collects still cost ~0.01–0.05 USDC
 * of Arc gas; nanopayments cannot pay that (they batch USDC transfers, not L1 Uni collect).
 * $0.05 quote / 0.01 launch-token is well under one collect tx.
 */
const MIN_COLLECT_USDC = 50_000n
const MIN_COLLECT_TOKEN = 10n ** 16n // 0.01 token (18dp)

const POOL_TOKEN0_ABI = [
  {
    type: 'function',
    name: 'token0',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const

function collectIsDust(amount0: bigint, amount1: bigint, token0: Address): boolean {
  const usdcIs0 = token0.toLowerCase() === ARC.USDC.toLowerCase()
  const quote = usdcIs0 ? amount0 : amount1
  const tok = usdcIs0 ? amount1 : amount0
  return quote < MIN_COLLECT_USDC && tok < MIN_COLLECT_TOKEN
}

/**
 * eth_call collectFees first. Skip the paid tx when the locker would move dust.
 * If simulate fails, collect anyway — the write path already swallows reverts.
 */
async function skipDustCollect(opts: {
  client: ReturnType<typeof arcPublicClient>
  locker: Address
  positionId: bigint
  uniPool: Address
  account: Address
}): Promise<string | null> {
  try {
    const [sim, token0] = await Promise.all([
      opts.client.simulateContract({
        account: opts.account,
        address: opts.locker,
        abi: MONLOCK_ABI,
        functionName: 'collectFees',
        args: [opts.positionId],
      }),
      opts.client.readContract({
        address: opts.uniPool,
        abi: POOL_TOKEN0_ABI,
        functionName: 'token0',
      }) as Promise<Address>,
    ])
    const [amount0, amount1] = sim.result as readonly [bigint, bigint]
    if (collectIsDust(amount0, amount1, token0)) {
      return `dust collect ${amount0.toString()}/${amount1.toString()}`
    }
  } catch {
    /* simulate failed — try the live collect */
  }
  return null
}

/**
 * Fee tiers the factory's `_swapQuoteForReward` walks (InstantReflectionUsdcFactory).
 * Keeper must quote the same order so minOut matches the pool reflect() will use.
 */
const REFLECT_FEE_TIERS = [10_000, 3_000, 500, 100] as const

/** Slippage on USDC→reward swap for custom CA reflections (5%). */
const REFLECT_SLIPPAGE_BPS = 500

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

/**
 * Quote USDC → reward across factory fee tiers. Returns first successful tier (matches
 * factory loop order so amountOutMinimum aligns with the pool reflect() will pick).
 */
async function quoteUsdcToReward(
  rewardToken: Address,
  usdcIn: bigint,
): Promise<{ amountOut: bigint; fee: number } | null> {
  if (usdcIn <= 0n || !ARC.UNI_QUOTER) return null
  const client = arcPublicClient()
  for (const fee of REFLECT_FEE_TIERS) {
    try {
      const res = (await client.readContract({
        address: ARC.UNI_QUOTER,
        abi: QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            tokenIn: ARC.USDC,
            tokenOut: rewardToken,
            amountIn: usdcIn,
            fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      })) as readonly [bigint, bigint, number, bigint]
      if (res[0] > 0n) return { amountOut: res[0], fee }
    } catch {
      /* try next tier */
    }
  }
  return null
}

export interface KeeperTokenResult {
  token: Address
  kind: 'instant' | 'reflection'
  collectFeesTx?: `0x${string}`
  collectFeesError?: string
  collectSkippedReason?: string
  forwardFeesTx?: `0x${string}`
  forwardFeesError?: string
  reflectTx?: `0x${string}`
  reflectSkippedReason?: string
  reflectError?: string
  /** USDC pending at reflect time (6dp). */
  pendingUsdc?: string
  rewardToken?: Address
  /** minOut passed to reflect (0 for USDC pass-through). */
  amountOutMinimum?: string
  quoteFeeTier?: number
}

export interface KeeperGasTopUpResult {
  attempted: boolean
  topped: boolean
  nativeBalanceWei: string
  txHash?: `0x${string}`
  reason?: string
}

export interface KeeperRunResult {
  ranAt: number
  tokensChecked: number
  instantChecked: number
  reflectionChecked: number
  results: KeeperTokenResult[]
  gasTopUp: KeeperGasTopUpResult
}

/** Below this native balance, pull a top-up before doing the token sweep (so the sweep itself
 *  doesn't run out of gas mid-cycle). Arc's native currency is USDC-pegged 1:1 (see module doc),
 *  so this is genuinely "$0.50 worth of gas headroom", not an arbitrary wei number. */
const MIN_KEEPER_NATIVE_BALANCE = parseEther('0.5')
/** Pulled from the platform beneficiary's balance per top-up event — $2, bounded by whatever
 *  allowance the platform owner has approved for the keeper wallet (their call entirely; the
 *  keeper can never pull more than that approved total, and the owner can revoke it anytime). */
const TOP_UP_USDC_6DP = 2_000_000n

/**
 * Keep the keeper wallet funded from the platform's own 25% fee leg — no swap needed. Arc's
 * native gas currency and the ERC-20 "USDC" interface at ARC.USDC are the SAME underlying
 * balance, just exposed at different decimals (confirmed on-chain: balanceOf() for a given
 * address == floor(nativeBalance / 1e12) for that same address, to the observed precision). So a
 * plain ERC-20 `transferFrom` here moves real, immediately-spendable native balance — no
 * WETH-style wrap/unwrap, no DEX swap, no slippage exposure at all.
 *
 * Requires the platform owner to have approved the keeper wallet as a spender once:
 *   cast send $ARC_USDC "approve(address,uint256)" $KEEPER_WALLET <allowance> \
 *     --private-key $PLATFORM_OWNER_KEY --rpc-url $ARC_RPC_URL
 * If no allowance (or an exhausted one) exists, `transferFrom` reverts and this is a no-op —
 * the keeper cycle still proceeds with whatever native balance it already has.
 */
export async function maybeTopUpKeeperGas(privateKey: `0x${string}`): Promise<KeeperGasTopUpResult> {
  const client = arcPublicClient()
  const wallet = arcServerWalletClient(privateKey)
  const keeperAddress = wallet.account.address

  const nativeBalance = await client.getBalance({ address: keeperAddress })
  if (nativeBalance >= MIN_KEEPER_NATIVE_BALANCE) {
    return { attempted: false, topped: false, nativeBalanceWei: nativeBalance.toString() }
  }

  try {
    const hash = await wallet.writeContract({
      address: ARC.USDC,
      abi: erc20Abi,
      functionName: 'transferFrom',
      args: [ARC_PLATFORM_WALLET, keeperAddress, TOP_UP_USDC_6DP],
      chain: wallet.chain,
    })
    await client.waitForTransactionReceipt({ hash })
    return { attempted: true, topped: true, nativeBalanceWei: nativeBalance.toString(), txHash: hash }
  } catch (e) {
    return {
      attempted: true,
      topped: false,
      nativeBalanceWei: nativeBalance.toString(),
      reason: (e as Error).message?.slice(0, 200),
    }
  }
}

async function listFactoryTokens(
  factory: Address,
  abi: typeof INSTANT_QUOTE_FACTORY_ABI | typeof INSTANT_REFLECTION_FACTORY_ABI,
): Promise<Address[]> {
  const client = arcPublicClient()
  const count = Number(
    await client.readContract({
      address: factory,
      abi,
      functionName: 'allTokensLength',
    }),
  )
  if (!Number.isFinite(count) || count <= 0) return []
  const out: Address[] = []
  for (let i = 0; i < count; i++) {
    const t = (await client.readContract({
      address: factory,
      abi,
      functionName: 'allTokens',
      args: [BigInt(i)],
    })) as Address
    if (t && t !== '0x0000000000000000000000000000000000000000') out.push(t)
  }
  return out
}

async function collectInstantPositions(
  privateKey: `0x${string}`,
): Promise<KeeperTokenResult[]> {
  if (!arcInstantEnabled()) return []
  const client = arcPublicClient()
  const wallet = arcServerWalletClient(privateKey)
  const seen = new Set<string>()
  const results: KeeperTokenResult[] = []

  for (const factory of instantCatalogFactories()) {
    const locker = instantLockerForFactory(factory)
    let tokens: Address[] = []
    try {
      tokens = await listFactoryTokens(factory, INSTANT_QUOTE_FACTORY_ABI)
    } catch (e) {
      results.push({
        token: factory,
        kind: 'instant',
        collectFeesError: `list ${factory.slice(0, 10)}: ${(e as Error).message?.slice(0, 160)}`,
      })
      continue
    }

    for (const token of tokens) {
      const key = token.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const r: KeeperTokenResult = { token, kind: 'instant' }
      try {
        const pool = (await client.readContract({
          address: factory,
          abi: INSTANT_QUOTE_FACTORY_ABI,
          functionName: 'getPool',
          args: [token],
        })) as {
          creator: Address
          uniPool: Address
          positionId: bigint
          liquidity: bigint
          tickLower: number
          tickUpper: number
        }
        const positionId = pool.positionId
        const uniPool = pool.uniPool
        if (positionId <= 0n) {
          r.collectFeesError = 'no position'
          results.push(r)
          continue
        }
        const skip = await skipDustCollect({
          client,
          locker,
          positionId,
          uniPool,
          account: wallet.account.address,
        })
        if (skip) {
          r.collectSkippedReason = skip
          results.push(r)
          continue
        }
        try {
          const hash = await wallet.writeContract({
            address: locker,
            abi: MONLOCK_ABI,
            functionName: 'collectFees',
            args: [positionId],
            chain: wallet.chain,
          })
          r.collectFeesTx = hash
          await client.waitForTransactionReceipt({ hash })
        } catch (e) {
          r.collectFeesError = (e as Error).message?.slice(0, 200)
        }
      } catch (e) {
        r.collectFeesError = (e as Error).message?.slice(0, 200)
      }
      results.push(r)
    }
  }
  return results
}

export async function runReflectionKeeperCycle(privateKey: `0x${string}`): Promise<KeeperRunResult> {
  const client = arcPublicClient()
  const wallet = arcServerWalletClient(privateKey)
  const factory = ARC.REFLECTION_FACTORY
  const locker = ARC.REFLECTION_LOCKER

  // Top up first — if the keeper is running low, better to fund before the sweep than have it
  // die mid-cycle on some token N of M.
  const gasTopUp = await maybeTopUpKeeperGas(privateKey)

  const instantResults = await collectInstantPositions(privateKey)

  const tokens: Address[] = arcReflectionEnabled()
    ? await listFactoryTokens(factory, INSTANT_REFLECTION_FACTORY_ABI).catch(() => [] as Address[])
    : []

  const results: KeeperTokenResult[] = [...instantResults]

  for (const token of tokens) {
    const r: KeeperTokenResult = { token, kind: 'reflection' }
    try {
      const pool = (await client.readContract({
        address: factory,
        abi: REFLECTION_EXTRA_ABI,
        functionName: 'pools',
        args: [token],
      })) as readonly [Address, Address, Address, Address, bigint, bigint, number, number]
      const [, rewardToken, feeSink, uniPool, positionId] = pool

      // 1. Sweep the locked LP position's accrued swap fees.
      const skip = await skipDustCollect({
        client,
        locker,
        positionId,
        uniPool,
        account: wallet.account.address,
      })
      if (skip) {
        r.collectSkippedReason = skip
      } else {
        try {
          const hash = await wallet.writeContract({
            address: locker,
            abi: MONLOCK_ABI,
            functionName: 'collectFees',
            args: [positionId],
            chain: wallet.chain,
          })
          r.collectFeesTx = hash
          await client.waitForTransactionReceipt({ hash })
        } catch (e) {
          r.collectFeesError = (e as Error).message?.slice(0, 200)
        }
      }

      // 2. Push whatever the fee sink is holding into the factory's pending accounting.
      try {
        const hash = await wallet.writeContract({
          address: feeSink,
          abi: FEE_SINK_ABI,
          functionName: 'forwardFees',
          chain: wallet.chain,
        })
        r.forwardFeesTx = hash
        await client.waitForTransactionReceipt({ hash })
      } catch (e) {
        r.forwardFeesError = (e as Error).message?.slice(0, 200)
      }

      // 3. Pay holders via reflect(). USDC rewards: pass-through minOut=0.
      //    Custom CA: quote Uni V3 USDC→reward, apply slippage, pass minOut.
      const pending = (await client.readContract({
        address: factory,
        abi: REFLECTION_EXTRA_ABI,
        functionName: 'pendingReflectionQuote',
        args: [token],
      })) as bigint
      r.pendingUsdc = pending.toString()
      r.rewardToken = rewardToken

      if (pending < MIN_REFLECT_USDC) {
        r.reflectSkippedReason = `pending ${pending.toString()} below dust floor`
      } else {
        let amountOutMinimum = 0n
        const isUsdcReward = rewardToken.toLowerCase() === ARC.USDC.toLowerCase()

        if (!isUsdcReward) {
          const q = await quoteUsdcToReward(rewardToken, pending)
          if (!q) {
            r.reflectSkippedReason =
              'no Uni V3 USDC→reward quote (missing pool or quoter failed) — needs pool or manual reflect()'
          } else {
            amountOutMinimum = minOutFromSlippage(q.amountOut, REFLECT_SLIPPAGE_BPS)
            r.quoteFeeTier = q.fee
            if (amountOutMinimum <= 0n) {
              r.reflectSkippedReason = 'quoted amountOut too small after slippage'
            }
          }
        }

        if (!r.reflectSkippedReason) {
          r.amountOutMinimum = amountOutMinimum.toString()
          try {
            const hash = await wallet.writeContract({
              address: factory,
              abi: REFLECTION_EXTRA_ABI,
              functionName: 'reflect',
              args: [token, amountOutMinimum],
              chain: wallet.chain,
            })
            r.reflectTx = hash
            await client.waitForTransactionReceipt({ hash })
          } catch (e) {
            r.reflectError = (e as Error).message?.slice(0, 200)
          }
        }
      }
    } catch (e) {
      r.collectFeesError = r.collectFeesError ?? (e as Error).message?.slice(0, 200)
    }
    results.push(r)
  }

  return {
    ranAt: Date.now(),
    tokensChecked: results.length,
    instantChecked: instantResults.length,
    reflectionChecked: tokens.length,
    results,
    gasTopUp,
  }
}

// Re-exported for the API route's env-sanity checks.
export const REFLECTION_KEEPER_CHAIN_ID = ARC_CHAIN_ID

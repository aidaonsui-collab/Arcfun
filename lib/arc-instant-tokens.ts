/**
 * Arc InstantErc20QuoteFactory + ArcBondingCurveFactory → PoolToken (USDC-quoted).
 */
import { formatUnits, type Address } from 'viem'
import { ARC, ARC_UNI_V3, arcInstantEnabled, arcCurveEnabled, arcReflectionEnabled, arcPublicClient } from './contracts-arc'
import { INSTANT_QUOTE_FACTORY_ABI } from './instant-quote-launchpad'
import { erc20Abi as ERC20_ABI } from 'viem'
import { getArcTokenMeta, getArcTokenMetas } from './arc-token-meta'
import { type PoolToken } from './tokens'
import { summarizeRpcError } from './rpc-error'

/** InstantReflectionUsdcFactory.pools(token) — same shape the keeper reads (arc-reflection-keeper.ts). */
const REFLECTION_POOL_ABI = [
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
    name: 'allTokensLength',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allTokens',
    stateMutability: 'view',
    inputs: [{ name: 'i', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
] as const

// Auto-generated Solidity mapping-getter for a struct returns multiple top-level values, not a
// wrapped tuple — viem decodes that as a labeled array, so this must be destructured by position
// (same as arc-reflection-keeper.ts's REFLECTION_EXTRA_ABI.pools), never accessed by `.creator` etc.
type ReflectionPoolTuple = readonly [
  creator: Address,
  rewardToken: Address,
  feeSink: Address,
  uniPool: Address,
  positionId: bigint,
  liquidity: bigint,
  tickLower: number,
  tickUpper: number,
]

/** ArcBondingCurveFactory.Pool — no dex-seed tail (unlike RH FACTORY_ABI). */
const ARC_CURVE_GET_POOL_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'creator', type: 'address' },
          { name: 'backingWallet', type: 'address' },
          { name: 'isMarginBacked', type: 'bool' },
          { name: 'completed', type: 'bool' },
          { name: 'virtualQuote', type: 'uint256' },
          { name: 'virtualToken', type: 'uint256' },
          { name: 'virtualQuoteInit', type: 'uint256' },
          { name: 'realQuote', type: 'uint256' },
          { name: 'feesAccrued', type: 'uint256' },
          { name: 'lastDistribute', type: 'uint64' },
          { name: 'isRwaBacked', type: 'bool' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'allTokens',
    stateMutability: 'view',
    inputs: [{ name: 'i', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'allTokensLength',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const

const UNI_GET_POOL_ABI = [
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

type ArcCurvePool = {
  creator: Address
  backingWallet: Address
  isMarginBacked: boolean
  completed: boolean
  virtualQuote: bigint
  virtualToken: bigint
  virtualQuoteInit: bigint
  realQuote: bigint
  feesAccrued: bigint
  lastDistribute: bigint
  isRwaBacked: boolean
}

const ZERO = '0x0000000000000000000000000000000000000000' as Address
/** FDV always uses full mint (1B human tokens) — same as RadarDEX / pump-style pads. */
const TOTAL_SUPPLY_HUMAN = 1_000_000_000
/** USDC quote decimals on Arc Instant / curve. */
const USDC_DECIMALS = 6
/** LaunchToken18 virtuals (18dp). Old Instant used 6dp LaunchToken. */
const VIRTUAL_TOKEN_INIT_18 = ARC.VIRTUAL_TOKEN_INIT
const VIRTUAL_TOKEN_INIT_6 = 1_066_666_666_666_666n
/** Pre–LaunchToken18 Instant factory (still holds live 6dp tokens). */
const ARC_INSTANT_FACTORY_LEGACY = '0x607bff9EB2ff1494AC8f0b545502Ce49ee2Ae42B' as Address

type InstantQuotePool = {
  creator: Address
  uniPool: Address
  positionId: bigint
  liquidity: bigint
  tickLower: number
  tickUpper: number
}

const SLOT0_ABI = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
] as const

const T0_ABI = [{ type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const

/**
 * Uni V3 human price: USDC per 1 whole launch token.
 * Uses bigint math so 18dp-token / 6dp-USDC pools don't overflow JS Number
 * (sqrtPriceX96 can be ~1e39 when the meme is token1) and don't underflow
 * when the meme is token0 (raw ~1e-20 floors away if scaled too early).
 *
 * raw_t1_per_t0 = sqrtPriceX96² / 2^192
 * human_usdc_per_token:
 *   token is token0 → raw * 10^(tokenDec - usdcDec)
 *   token is token1 → (1/raw) * 10^(tokenDec - usdcDec)
 */
export function usdcPerTokenFromSqrtX96(
  sqrtPriceX96: bigint,
  tokenIsToken0: boolean,
  tokenDecimals: number,
  quoteDecimals: number = USDC_DECIMALS,
): number {
  if (sqrtPriceX96 <= 0n) return 0
  const Q192 = 1n << 192n
  const sqrt2 = sqrtPriceX96 * sqrtPriceX96
  // Extra 1e18 fixed-point so tiny Instant prices (~1e-9..1e-8) survive integer division.
  const OUT_SCALE = 18
  const decDiff = tokenDecimals - quoteDecimals // +12 for LaunchToken18; 0 for old 6dp
  // Fold decimal adjust + output scale into one power of 10.
  const exp = decDiff + OUT_SCALE

  let scaled: bigint
  if (tokenIsToken0) {
    // human * 1e18 = sqrt² * 10^exp / 2^192
    if (exp >= 0) {
      scaled = (sqrt2 * 10n ** BigInt(exp)) / Q192
    } else {
      scaled = sqrt2 / (Q192 * 10n ** BigInt(-exp))
    }
  } else {
    // human * 1e18 = 2^192 * 10^exp / sqrt²
    if (sqrt2 === 0n) return 0
    if (exp >= 0) {
      scaled = (Q192 * 10n ** BigInt(exp)) / sqrt2
    } else {
      scaled = Q192 / (sqrt2 * 10n ** BigInt(-exp))
    }
  }
  const human = Number(scaled) / 1e18
  return Number.isFinite(human) && human > 0 ? human : 0
}

function virtualTokenInitForDecimals(tokenDecimals: number): bigint {
  return tokenDecimals >= 18 ? VIRTUAL_TOKEN_INIT_18 : VIRTUAL_TOKEN_INIT_6
}

/** Default launch price from factory virtuals (matches on-chain Instant init). */
export function defaultArcInstantPriceUsdc(launchVirtualQuote: bigint, tokenDecimals: number): number {
  const vti = virtualTokenInitForDecimals(tokenDecimals)
  const q = Number(formatUnits(launchVirtualQuote, USDC_DECIMALS))
  const t = Number(formatUnits(vti, tokenDecimals))
  if (!(q > 0) || !(t > 0)) return 0
  return q / t
}

/** FDV = price × full 1B supply (RadarDEX / standard meme convention). */
export function arcMarketCapUsd(priceUsdc: number): number {
  if (!(priceUsdc > 0) || !Number.isFinite(priceUsdc)) return 0
  return priceUsdc * TOTAL_SUPPLY_HUMAN
}

/** Price of 1 whole token in USDC, from Uni V3 slot0. Reads token.decimals() for 6 vs 18 dp. */
export async function getArcLivePriceUsdc(token: Address, uniPool?: Address): Promise<number | null> {
  try {
    const client = arcPublicClient()
    let pool = uniPool
    if (!pool || pool === ZERO) {
      // Prefer current factory; fall back to legacy Instant for pre–LaunchToken18 pools.
      for (const factory of [ARC.INSTANT_FACTORY, ARC_INSTANT_FACTORY_LEGACY]) {
        try {
          const row = (await client.readContract({
            address: factory,
            abi: INSTANT_QUOTE_FACTORY_ABI,
            functionName: 'getPool',
            args: [token],
          })) as InstantQuotePool
          if (row?.uniPool && row.uniPool !== ZERO) {
            pool = row.uniPool
            break
          }
        } catch {
          /* try next */
        }
      }
    }
    if (!pool || pool === ZERO) return null

    const [slot0, token0, tokenDecimals] = await Promise.all([
      client.readContract({ address: pool, abi: SLOT0_ABI, functionName: 'slot0' }) as Promise<readonly [bigint, ...unknown[]]>,
      client.readContract({ address: pool, abi: T0_ABI, functionName: 'token0' }) as Promise<Address>,
      client
        .readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' })
        .then((d) => Number(d))
        .catch(() => ARC.TOKEN_DECIMALS) as Promise<number>,
    ])
    const sqrt = slot0[0]
    if (sqrt <= 0n) return null
    const tokenIs0 = token0.toLowerCase() === token.toLowerCase()
    const dec = Number.isFinite(tokenDecimals) && tokenDecimals > 0 ? tokenDecimals : ARC.TOKEN_DECIMALS
    const usdcPerToken = usdcPerTokenFromSqrtX96(sqrt, tokenIs0, dec, USDC_DECIMALS)
    if (!(usdcPerToken > 0)) return null
    return usdcPerToken
  } catch {
    return null
  }
}

/** Pool TVL: ERC-20 USDC in the Uni V3 pool + launch-token inventory × spot. */
export async function getArcPoolLiquidityUsdc(
  token: Address,
  uniPool: Address | undefined,
  priceUsdc: number,
): Promise<{ tvlUsd: number; usdc: number } | null> {
  if (!uniPool || uniPool === ZERO) return null
  try {
    const client = arcPublicClient()
    const [usdcRaw, tokRaw, tokenDecimals] = await Promise.all([
      client.readContract({
        address: ARC.USDC,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [uniPool],
      }) as Promise<bigint>,
      client.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [uniPool],
      }) as Promise<bigint>,
      client
        .readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' })
        .then((d) => Number(d))
        .catch(() => ARC.TOKEN_DECIMALS) as Promise<number>,
    ])
    const dec = Number.isFinite(tokenDecimals) && tokenDecimals > 0 ? tokenDecimals : ARC.TOKEN_DECIMALS
    const usdc = Number(formatUnits(usdcRaw, USDC_DECIMALS))
    const tok = Number(formatUnits(tokRaw, dec))
    const quote = Number.isFinite(usdc) ? usdc : 0
    const tokenUsd = Number.isFinite(tok) && priceUsdc > 0 ? tok * priceUsdc : 0
    return { tvlUsd: quote + tokenUsd, usdc: quote }
  } catch {
    return null
  }
}

function toPoolToken(
  token: Address,
  p: InstantQuotePool,
  name: string,
  symbol: string,
  priceUsdc: number,
  meta: Awaited<ReturnType<typeof getArcTokenMeta>>,
  launchVirtualQuote: bigint,
  createdAt?: number,
  factoryOverride?: Address,
): PoolToken {
  const creator = p.creator
  // PoolToken.currentPrice is "native" units; on Arc native ≈ USDC, so priceUsdc works as currentPrice.
  const priceNative = priceUsdc
  const priceUsd = priceUsdc // USDC ~ $1
  const factory = (factoryOverride ?? ARC.INSTANT_FACTORY).toLowerCase()
  const isReflectionFactory = factory === ARC.REFLECTION_FACTORY.toLowerCase()
  return {
    id: token,
    chain: 'arc',
    poolId: token,
    coinType: token,
    name: name || meta?.name || symbol,
    symbol: symbol || meta?.symbol || '',
    description: meta?.description ?? '',
    imageUrl: meta?.imageUrl ?? '',
    logoUrl: meta?.imageUrl ?? '',
    twitter: meta?.twitter ?? '',
    telegram: meta?.telegram ?? '',
    website: meta?.website ?? '',
    streamUrl: meta?.streamUrl ?? '',
    creator,
    creatorShort: `${creator.slice(0, 6)}…${creator.slice(-4)}`,
    creatorFull: creator,
    currentPrice: priceNative,
    realSuiRaised: 0,
    threshold: 0,
    progress: 100,
    bondingProgress: 100,
    isCompleted: true,
    instantLaunch: true,
    instant: true,
    reflection: isReflectionFactory,
    launchKind: isReflectionFactory ? 'reflection' : 'instant',
    instantMeta: {
      uniPool: p.uniPool,
      positionId: p.positionId.toString(),
      isMeme: true,
      isRwaBacked: false,
      isMarginBacked: false,
      dexId: 0,
      quote: 'USDC',
    },
    dexVenue: 'v3',
    virtualSuiReserves: launchVirtualQuote,
    virtualTokenReserves: VIRTUAL_TOKEN_INIT_18,
    moonbagsPackageId: factoryOverride ?? ARC.INSTANT_FACTORY,
    volume1h: 0,
    priceChange24h: 0,
    age: '',
    // FDV = spot price × full 1B mint (not free float / LP residual) — matches RadarDEX.
    marketCap: arcMarketCapUsd(priceUsd),
    totalSupply: TOTAL_SUPPLY_HUMAN,
    createdAt,
  }
}

export async function fetchArcInstantPoolToken(token: Address): Promise<PoolToken | null> {
  if (!arcInstantEnabled()) return null
  // Same two factories the catalog (fetchArcInstantPoolTokens) merges — current first, then the
  // pre–LaunchToken18 legacy factory. Without this fallback, any token whose pool lives only on
  // the legacy factory shows fine in the home-grid catalog but 404s on its own /token page, since
  // this single-lookup path used to check only ARC.INSTANT_FACTORY.
  for (const factory of [ARC.INSTANT_FACTORY, ARC_INSTANT_FACTORY_LEGACY]) {
    const row = await fetchArcInstantPoolTokenFromFactory(token, factory)
    if (row) return row
  }
  return null
}

async function fetchArcInstantPoolTokenFromFactory(token: Address, factory: Address): Promise<PoolToken | null> {
  const client = arcPublicClient()
  try {
    const p = (await client.readContract({
      address: factory,
      abi: INSTANT_QUOTE_FACTORY_ABI,
      functionName: 'getPool',
      args: [token],
    })) as InstantQuotePool
    if (!p?.creator || p.creator === ZERO || !p.uniPool || p.uniPool === ZERO) return null

    const [name, symbol, launchVq, tokenDecimals, meta] = await Promise.all([
      client.readContract({ address: token, abi: ERC20_ABI, functionName: 'name' }).catch(() => '') as Promise<string>,
      client.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => '') as Promise<string>,
      client
        .readContract({
          address: factory,
          abi: INSTANT_QUOTE_FACTORY_ABI,
          functionName: 'launchVirtualQuote',
        })
        .catch(() => 5_500_000_000n) as Promise<bigint>, // $5500 virtual → ~$5.2k launch FDV
      client
        .readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' })
        .then((d) => Number(d))
        .catch(() => ARC.TOKEN_DECIMALS) as Promise<number>,
      getArcTokenMeta(token).catch(() => null),
    ])

    const dec = Number.isFinite(tokenDecimals) && tokenDecimals > 0 ? tokenDecimals : ARC.TOKEN_DECIMALS
    const defaultPrice = defaultArcInstantPriceUsdc(launchVq, dec)
    const live = await getArcLivePriceUsdc(token, p.uniPool)
    const priceUsdc = live != null && live > 0 ? live : defaultPrice > 0 ? defaultPrice : 0

    return toPoolToken(token, p, name, symbol, priceUsdc, meta, launchVq)
  } catch (e) {
    console.error('[arc-instant-tokens]', summarizeRpcError(e))
    return null
  }
}

export async function isArcInstantToken(token: Address): Promise<boolean> {
  if (!arcInstantEnabled()) return false
  try {
    const p = (await arcPublicClient().readContract({
      address: ARC.INSTANT_FACTORY,
      abi: INSTANT_QUOTE_FACTORY_ABI,
      functionName: 'getPool',
      args: [token],
    })) as InstantQuotePool
    return !!(p?.creator && p.creator !== ZERO && p.uniPool && p.uniPool !== ZERO)
  } catch {
    return false
  }
}

/**
 * Arc Instant Reflection token (InstantReflectionUsdcFactory). Same single-tx, full-supply,
 * straight-onto-Uniswap-V3 launch as plain Instant, plus a fee-sink/reward-token pair the plain
 * Instant factory doesn't have — hence its own `pools` read here instead of `getPool`.
 */
export async function fetchArcReflectionPoolToken(token: Address): Promise<PoolToken | null> {
  if (!arcReflectionEnabled()) return null
  const client = arcPublicClient()
  const factory = ARC.REFLECTION_FACTORY
  try {
    const p = (await client.readContract({
      address: factory,
      abi: REFLECTION_POOL_ABI,
      functionName: 'pools',
      args: [token],
    })) as ReflectionPoolTuple
    const [creator, , , uniPool, positionId, liquidity, tickLower, tickUpper] = p
    if (!creator || creator === ZERO || !uniPool || uniPool === ZERO) return null
    const pool = { creator, uniPool, positionId, liquidity, tickLower, tickUpper } as InstantQuotePool

    const [name, symbol, tokenDecimals, meta] = await Promise.all([
      client.readContract({ address: token, abi: ERC20_ABI, functionName: 'name' }).catch(() => '') as Promise<string>,
      client.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => '') as Promise<string>,
      client
        .readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' })
        .then((d) => Number(d))
        .catch(() => ARC.TOKEN_DECIMALS) as Promise<number>,
      getArcTokenMeta(token).catch(() => null),
    ])

    const dec = Number.isFinite(tokenDecimals) && tokenDecimals > 0 ? tokenDecimals : ARC.TOKEN_DECIMALS
    // Reflection factory has no launchVirtualQuote getter; reuse the Instant default (same seeding
    // scheme) as a fallback for the brief window before the pool has traded and slot0 is live.
    const launchVq = 5_500_000_000n
    const defaultPrice = defaultArcInstantPriceUsdc(launchVq, dec)
    const live = await getArcLivePriceUsdc(token, uniPool)
    const priceUsdc = live != null && live > 0 ? live : defaultPrice > 0 ? defaultPrice : 0

    return toPoolToken(token, pool, name, symbol, priceUsdc, meta, launchVq, undefined, factory)
  } catch (e) {
    console.error('[arc-reflection-tokens]', summarizeRpcError(e))
    return null
  }
}

type McContract = {
  address: Address
  abi: readonly unknown[]
  functionName: string
  args?: readonly unknown[]
}

async function multicallChunked(
  client: ReturnType<typeof arcPublicClient>,
  contracts: McContract[],
  size = 80,
): Promise<{ status: 'success' | 'failure'; result?: unknown }[]> {
  const out: { status: 'success' | 'failure'; result?: unknown }[] = []
  for (let i = 0; i < contracts.length; i += size) {
    const part = (await client.multicall({
      contracts: contracts.slice(i, i + size) as never,
      allowFailure: true,
    })) as { status: 'success' | 'failure'; result?: unknown }[]
    out.push(...part)
  }
  return out
}

function mcOk<T>(row: { status: 'success' | 'failure'; result?: unknown } | undefined): T | null {
  if (!row || row.status !== 'success') return null
  return row.result as T
}

function asInstantPool(raw: unknown): InstantQuotePool | null {
  if (!raw) return null
  if (Array.isArray(raw)) {
    const [creator, uniPool, positionId, liquidity, tickLower, tickUpper] = raw as [
      Address,
      Address,
      bigint,
      bigint,
      number,
      number,
    ]
    if (!creator || creator === ZERO || !uniPool || uniPool === ZERO) return null
    return { creator, uniPool, positionId, liquidity, tickLower, tickUpper }
  }
  const p = raw as InstantQuotePool
  if (!p.creator || p.creator === ZERO || !p.uniPool || p.uniPool === ZERO) return null
  return p
}

/** Hydrate Instant-shaped rows (name/symbol/decimals/slot0/token0 + KV meta) in a few RPC batches. */
async function hydrateInstantRows(
  rows: { token: Address; factory: Address; launchVq: bigint; pool: InstantQuotePool }[],
): Promise<PoolToken[]> {
  if (rows.length === 0) return []
  const client = arcPublicClient()
  const metas = await getArcTokenMetas(rows.map((r) => r.token)).catch(() => new Map())
  const extra = await multicallChunked(
    client,
    rows.flatMap(({ token, pool }) => [
      { address: token, abi: ERC20_ABI, functionName: 'name' },
      { address: token, abi: ERC20_ABI, functionName: 'symbol' },
      { address: token, abi: ERC20_ABI, functionName: 'decimals' },
      { address: pool.uniPool, abi: SLOT0_ABI, functionName: 'slot0' },
      { address: pool.uniPool, abi: T0_ABI, functionName: 'token0' },
    ]),
  )
  const out: PoolToken[] = []
  for (let i = 0; i < rows.length; i++) {
    const { token, factory, launchVq, pool } = rows[i]
    const base = i * 5
    const name = mcOk<string>(extra[base]) || ''
    const symbol = mcOk<string>(extra[base + 1]) || ''
    const tokenDecimals = Number(mcOk<number>(extra[base + 2]) ?? ARC.TOKEN_DECIMALS)
    const slot0 = mcOk<readonly [bigint, ...unknown[]]>(extra[base + 3])
    const token0 = mcOk<Address>(extra[base + 4])
    const dec = Number.isFinite(tokenDecimals) && tokenDecimals > 0 ? tokenDecimals : ARC.TOKEN_DECIMALS
    const defaultPrice = defaultArcInstantPriceUsdc(launchVq, dec)
    let live: number | null = null
    if (slot0 && token0 && slot0[0] > 0n) {
      const tokenIs0 = token0.toLowerCase() === token.toLowerCase()
      const usdc = usdcPerTokenFromSqrtX96(slot0[0], tokenIs0, dec, USDC_DECIMALS)
      if (usdc > 0) live = usdc
    }
    const priceUsdc = live != null && live > 0 ? live : defaultPrice > 0 ? defaultPrice : 0
    const meta = metas.get(token.toLowerCase()) ?? null
    out.push(toPoolToken(token, pool, name, symbol, priceUsdc, meta, launchVq, undefined, factory))
  }
  return out
}

/** Full Reflection catalog for home grid — mirrors listInstantFactoryTokens below. */
export async function fetchArcReflectionPoolTokens(): Promise<PoolToken[]> {
  if (!arcReflectionEnabled()) return []
  const client = arcPublicClient()
  const factory = ARC.REFLECTION_FACTORY
  try {
    const count = Number(
      await client.readContract({
        address: factory,
        abi: REFLECTION_POOL_ABI,
        functionName: 'allTokensLength',
      }),
    )
    if (!Number.isFinite(count) || count <= 0) return []

    const n = Math.min(count, 200)
    const listed = await multicallChunked(
      client,
      Array.from({ length: n }, (_, i) => ({
        address: factory,
        abi: REFLECTION_POOL_ABI,
        functionName: 'allTokens',
        args: [BigInt(count - 1 - i)],
      })),
    )
    const addrs = listed
      .map((r) => mcOk<Address>(r))
      .filter((a): a is Address => !!a && a !== ZERO)
    if (addrs.length === 0) return []

    const poolRows = await multicallChunked(
      client,
      addrs.map((token) => ({
        address: factory,
        abi: REFLECTION_POOL_ABI,
        functionName: 'pools',
        args: [token],
      })),
    )
    const launchVq = 5_500_000_000n
    const rows: { token: Address; factory: Address; launchVq: bigint; pool: InstantQuotePool }[] = []
    for (let i = 0; i < addrs.length; i++) {
      const p = mcOk<ReflectionPoolTuple>(poolRows[i])
      if (!p) continue
      const [creator, , , uniPool, positionId, liquidity, tickLower, tickUpper] = p
      if (!creator || creator === ZERO || !uniPool || uniPool === ZERO) continue
      rows.push({
        token: addrs[i],
        factory,
        launchVq,
        pool: { creator, uniPool, positionId, liquidity, tickLower, tickUpper },
      })
    }
    return hydrateInstantRows(rows)
  } catch (e) {
    console.error('[arc-reflection-tokens] catalog', summarizeRpcError(e))
    return []
  }
}

/** Enumerate Instant tokens from one factory (newest first, capped). */
async function listInstantFactoryTokens(
  factory: Address,
  max = 200,
): Promise<{ addrs: Address[]; launchVq: bigint }> {
  const client = arcPublicClient()
  const count = Number(
    await client.readContract({
      address: factory,
      abi: INSTANT_QUOTE_FACTORY_ABI,
      functionName: 'allTokensLength',
    }),
  )
  if (!Number.isFinite(count) || count <= 0) return { addrs: [], launchVq: 5_500_000_000n }

  const n = Math.min(count, max)
  const listed = await multicallChunked(
    client,
    Array.from({ length: n }, (_, i) => ({
      address: factory,
      abi: INSTANT_QUOTE_FACTORY_ABI,
      functionName: 'allTokens',
      args: [BigInt(count - 1 - i)],
    })),
  )
  const addrs = listed
    .map((r) => mcOk<Address>(r))
    .filter((a): a is Address => !!a && a !== ZERO)
  const launchVq = (await client
    .readContract({
      address: factory,
      abi: INSTANT_QUOTE_FACTORY_ABI,
      functionName: 'launchVirtualQuote',
    })
    .catch(() => 5_500_000_000n)) as bigint
  return { addrs, launchVq }
}

/**
 * Full Instant catalog for home grid. Merges current + legacy factories so
 * 6dp (pre–LaunchToken18) and 18dp Instant tokens both show correct MC.
 */
export async function fetchArcInstantPoolTokens(): Promise<PoolToken[]> {
  if (!arcInstantEnabled()) return []
  const client = arcPublicClient()
  try {
    const factories = [ARC.INSTANT_FACTORY, ARC_INSTANT_FACTORY_LEGACY]
    const listed = await Promise.all(
      factories.map((f) => listInstantFactoryTokens(f).catch(() => ({ addrs: [] as Address[], launchVq: 5_500_000_000n }))),
    )

    // Dedupe by token address (prefer first = current factory).
    const seen = new Set<string>()
    const entries: { token: Address; factory: Address; launchVq: bigint }[] = []
    for (let fi = 0; fi < factories.length; fi++) {
      const { addrs, launchVq } = listed[fi]
      for (const token of addrs) {
        const k = token.toLowerCase()
        if (seen.has(k)) continue
        seen.add(k)
        entries.push({ token, factory: factories[fi], launchVq })
      }
    }
    if (entries.length === 0) return []

    const poolRows = await multicallChunked(
      client,
      entries.map(({ token, factory }) => ({
        address: factory,
        abi: INSTANT_QUOTE_FACTORY_ABI,
        functionName: 'getPool',
        args: [token],
      })),
    )
    const rows: { token: Address; factory: Address; launchVq: bigint; pool: InstantQuotePool }[] = []
    for (let i = 0; i < entries.length; i++) {
      const p = asInstantPool(mcOk(poolRows[i]))
      if (!p) continue
      rows.push({ ...entries[i], pool: p })
    }
    return hydrateInstantRows(rows)
  } catch (e) {
    console.error('[arc-instant-tokens] catalog', summarizeRpcError(e))
    return []
  }
}

/**
 * Arc bonding-curve token (pre- or post-grad). Price from curve virtuals pre-grad, Uni slot0 post-grad.
 */
export async function fetchArcCurvePoolToken(token: Address): Promise<PoolToken | null> {
  if (!arcCurveEnabled()) return null
  const client = arcPublicClient()
  const factory = ARC.FACTORY
  try {
    const p = (await client.readContract({
      address: factory,
      abi: ARC_CURVE_GET_POOL_ABI,
      functionName: 'getPool',
      args: [token],
    })) as ArcCurvePool
    if (!p?.creator || p.creator === ZERO) return null

    const [name, symbol, meta, tokenDecimals] = await Promise.all([
      client.readContract({ address: token, abi: ERC20_ABI, functionName: 'name' }).catch(() => '') as Promise<string>,
      client.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => '') as Promise<string>,
      getArcTokenMeta(token).catch(() => null),
      client
        .readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' })
        .then((d) => Number(d))
        .catch(() => ARC.TOKEN_DECIMALS) as Promise<number>,
    ])
    const dec = Number.isFinite(tokenDecimals) && tokenDecimals > 0 ? tokenDecimals : ARC.TOKEN_DECIMALS

    // Threshold: vQ0 = threshold * R / (I - R) = threshold / 3 → threshold = 3 * vQ0
    const thresholdUsdc6 = p.virtualQuoteInit * 3n
    const thresholdHuman = Number(formatUnits(thresholdUsdc6, 6))
    const raisedHuman = Number(formatUnits(p.realQuote, 6))
    const progress =
      thresholdHuman > 0 ? Math.min(100, Math.max(0, (raisedHuman / thresholdHuman) * 100)) : p.completed ? 100 : 0

    // Curve price (USDC per token): vQ is 6dp USDC, vT is token raw (6 or 18 dp)
    let priceUsdc = 0
    if (p.virtualToken > 0n) {
      priceUsdc =
        Number(formatUnits(p.virtualQuote, USDC_DECIMALS)) / Number(formatUnits(p.virtualToken, dec))
    }

    let uniPool: Address | undefined
    if (p.completed) {
      uniPool = (await client
        .readContract({
          address: ARC_UNI_V3.FACTORY,
          abi: UNI_GET_POOL_ABI,
          functionName: 'getPool',
          args: [token, ARC.USDC, ARC_UNI_V3.POOL_FEE],
        })
        .catch(() => ZERO)) as Address
      if (uniPool && uniPool !== ZERO) {
        const live = await getArcLivePriceUsdc(token, uniPool)
        if (live != null && live > 0) priceUsdc = live
      }
    }

    const creator = p.creator
    const priceUsd = priceUsdc // USDC ≈ $1
    return {
      id: token,
      chain: 'arc',
      poolId: token,
      coinType: token,
      name: name || meta?.name || symbol,
      symbol: symbol || meta?.symbol || '',
      description: meta?.description ?? '',
      imageUrl: meta?.imageUrl ?? '',
      logoUrl: meta?.imageUrl ?? '',
      twitter: meta?.twitter ?? '',
      telegram: meta?.telegram ?? '',
      website: meta?.website ?? '',
      streamUrl: meta?.streamUrl ?? '',
      creator,
      creatorShort: `${creator.slice(0, 6)}…${creator.slice(-4)}`,
      creatorFull: creator,
      currentPrice: priceUsdc,
      realSuiRaised: raisedHuman,
      threshold: thresholdHuman,
      progress,
      bondingProgress: progress,
      isCompleted: p.completed,
      instantLaunch: false,
      instant: false,
      reflection: false,
      launchKind: 'curve',
      instantMeta: uniPool && uniPool !== ZERO
        ? {
            uniPool,
            positionId: '0',
            isMeme: true,
            isRwaBacked: false,
            isMarginBacked: false,
            dexId: 0,
            quote: 'USDC',
          }
        : {
            uniPool: ZERO,
            positionId: '0',
            isMeme: true,
            isRwaBacked: false,
            isMarginBacked: false,
            dexId: 0,
            quote: 'USDC',
          },
      dexVenue: p.completed ? 'v3' : undefined,
      virtualSuiReserves: p.virtualQuote,
      virtualTokenReserves: p.virtualToken,
      moonbagsPackageId: factory,
      volume1h: 0,
      priceChange24h: 0,
      age: '',
      marketCap: arcMarketCapUsd(priceUsd),
      totalSupply: TOTAL_SUPPLY_HUMAN,
    }
  } catch (e) {
    console.error('[arc-curve-tokens]', summarizeRpcError(e))
    return null
  }
}

/** Instant, then Reflection, then bonding-curve factory. */
export async function fetchArcPoolToken(token: Address): Promise<PoolToken | null> {
  const instant = await fetchArcInstantPoolToken(token)
  if (instant) return instant
  const reflection = await fetchArcReflectionPoolToken(token)
  if (reflection) return reflection
  return fetchArcCurvePoolToken(token)
}

export async function fetchArcCurvePoolTokens(): Promise<PoolToken[]> {
  if (!arcCurveEnabled()) return []
  const client = arcPublicClient()
  const factory = ARC.FACTORY
  try {
    const count = Number(
      await client.readContract({
        address: factory,
        abi: ARC_CURVE_GET_POOL_ABI,
        functionName: 'allTokensLength',
      }),
    )
    if (!Number.isFinite(count) || count <= 0) return []
    const max = Math.min(count, 200)
    const out: PoolToken[] = []
    for (let i = count - 1; i >= count - max && i >= 0; i--) {
      const addr = (await client
        .readContract({
          address: factory,
          abi: ARC_CURVE_GET_POOL_ABI,
          functionName: 'allTokens',
          args: [BigInt(i)],
        })
        .catch(() => null)) as Address | null
      if (!addr || addr === ZERO) continue
      const row = await fetchArcCurvePoolToken(addr)
      if (row) out.push(row)
    }
    return out
  } catch (e) {
    console.error('[arc-curve-tokens] catalog', summarizeRpcError(e))
    return []
  }
}

export async function buildArcCatalog(): Promise<{ tokens: PoolToken[]; source: string }> {
  const [instant, reflection, curve] = await Promise.all([
    fetchArcInstantPoolTokens().catch(() => [] as PoolToken[]),
    fetchArcReflectionPoolTokens().catch(() => [] as PoolToken[]),
    fetchArcCurvePoolTokens().catch(() => [] as PoolToken[]),
  ])
  const byId = new Map<string, PoolToken>()
  for (const t of [...instant, ...reflection, ...curve]) {
    const id = (t.coinType || t.poolId || t.id || '').toLowerCase()
    if (id) byId.set(id, t)
  }
  const sources = ['arc-instant', reflection.length ? 'reflection' : '', curve.length ? 'curve' : '']
    .filter(Boolean)
    .join('+')
  return {
    tokens: [...byId.values()],
    source: sources || 'arc-instant-factory',
  }
}

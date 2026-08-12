/**
 * Arc OTC — maker/taker desk (complementary to CCTP).
 * Buy USDC on Arc: pay ERC-20 USDC on Ethereum / Base / Arbitrum, receive Arc USDC from maker liquidity.
 */
import {
  createPublicClient,
  encodeEventTopics,
  formatUnits,
  http,
  parseAbi,
  parseUnits,
  type Address,
  type Chain,
  type Hex,
} from 'viem'
import { arbitrum, base, mainnet } from 'viem/chains'
import { ARC, ARC_CHAIN_ID, arcPublicClient } from '@/lib/contracts-arc'

const ZERO = '0x0000000000000000000000000000000000000000' as Address

/** Live mainnet defaults (env overrides). Baked in so client UI works even if build missed NEXT_PUBLIC_*. */
export const OTC_DEFAULTS = {
  /** v3 liquidity: hard reserve on Arc (anti over-fill). */
  liquidity: '0xBD06241e272d05449A034abc0cfd558905c4aE3e' as Address,
  /** v4 payment: reservationId + lock-before-deliver (H1 refund race closed) */
  paymentBase: '0xac79DD3FE3C0cCD1ba91c925697b8A8fec1E9Bcb' as Address,
  paymentArb: '0xc476968FB376b9f1Bc4011De3EFA6d466a765B4B' as Address,
  /** ETH payment not live yet — leave zero until deployed. */
  paymentEth: ZERO,
} as const

/** Default Arc reserve TTL for fills (must be within 5m–2h on-chain). */
export const OTC_RESERVE_TTL_SEC = 30 * 60

/**
 * Minimum buy size, in destAmount (Arc USDC, 6dp) — 1.00 USDC. Below this, gas + keeper overhead
 * on a fill start eating a disproportionate share of the trade, and it's not worth a reservation
 * slot. Enforced both client-side (InstantOtcPanel disables the CTA / shows the floor) and
 * server-side (app/api/otc/reserve rejects it) — the server check is the one that actually matters
 * since the client one is just UX, not a security boundary.
 */
export const OTC_MIN_BUY_USDC = 1_000_000n

/**
 * EIP-712 domain/types for a buyer-authorized Arc reserve() — verified server-side by
 * app/api/otc/reserve/route.ts, NOT on-chain (RobinOtcLiquidity.reserve() has no signature check
 * of its own; this is purely an app-layer gate on who the keeper wallet will spend gas for).
 *
 * 2026-08-12: added to cut the buyer's OTC purchase flow from 3 on-chain signatures to 2, matching
 * competitor flows (unstabletrade.com does the equivalent in a single payment-chain tx). Instead of
 * the buyer switching to Arc and signing reserve() themselves, they sign this free off-chain
 * message and the already-funded keeper wallet (ARC_OTC_KEEPER_KEY) submits reserve() on their
 * behalf. The on-chain hard-reserve anti-oversell protection in RobinOtcLiquidity.sol — the actual
 * reason this step exists at all (see OTC_DEFAULTS.liquidity's "v3 liquidity: hard reserve on Arc"
 * comment) — is completely unchanged; this only moves who signs/pays gas for that call, not what
 * the contract enforces before payment.
 *
 * `salt` makes each authorization single-use (server-side replay guard); `deadline` bounds how
 * long a signed authorization stays valid before it can be redeemed.
 */
export const RESERVE_AUTH_TYPES = {
  ReserveRequest: [
    { name: 'offerId', type: 'bytes32' },
    { name: 'amount', type: 'uint256' },
    { name: 'buyer', type: 'address' },
    { name: 'deadline', type: 'uint256' },
    { name: 'salt', type: 'bytes32' },
  ],
} as const

export type ReserveAuthMessage = {
  offerId: Hex
  amount: bigint
  buyer: Address
  deadline: bigint
  salt: Hex
}

/** verifyingContract is the liquidity escrow even though verification happens off-chain here —
 *  standard EIP-712 domain separation practice, and keeps the signed payload chain-scoped. */
export function reserveAuthDomain(verifyingContract: Address, chainId: number = ARC_CHAIN_ID) {
  return {
    name: 'ArcFun OTC Reserve',
    version: '1',
    chainId,
    verifyingContract,
  } as const
}

/** Default platform fee (2%). On-chain payment escrow is source of truth via feeBps(). */
export const OTC_DEFAULT_FEE_BPS = 200
/** Discounted fee for ≥0.01% $ROBIN supply holders (when oracle voucher is used). */
export const OTC_ROBIN_FEE_BPS = 100

function envAddr(...keys: string[]): Address {
  for (const k of keys) {
    const v = (process.env[k] || '').trim().replace(/[\r\n]+/g, '')
    if (v && v.toLowerCase() !== ZERO) return v as Address
  }
  return ZERO
}

function envOrDefault(fallback: Address, ...keys: string[]): Address {
  const fromEnv = envAddr(...keys)
  return fromEnv !== ZERO ? fromEnv : fallback
}

export const ROBIN_OTC_LIQUIDITY = envOrDefault(
  OTC_DEFAULTS.liquidity,
  'NEXT_PUBLIC_ROBIN_OTC_LIQUIDITY_ESCROW',
)
export const ARC_USDC = ARC.USDC

/** @deprecated Prefer paymentChains / getPaymentChain — ETH-only alias. */
export const ROBIN_OTC_PAYMENT = envOrDefault(
  OTC_DEFAULTS.paymentEth,
  'NEXT_PUBLIC_ROBIN_OTC_PAYMENT_ETH',
  'NEXT_PUBLIC_ROBIN_OTC_PAYMENT_ESCROW',
)

/** @deprecated Prefer paymentChains — ETH mainnet USDC. */
export const ETH_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address

export type OtcPaymentChainId = 'eth' | 'base' | 'arb'

export type OtcPaymentChain = {
  id: OtcPaymentChainId
  chainId: number
  name: string
  shortName: string
  usdc: Address
  payment: Address
  rpc: string
  viemChain: Chain
  explorer: string
}

/**
 * Payment spokes: native Circle USDC on each chain.
 * Base + ARB live by default; ETH when env / OTC_DEFAULTS.paymentEth is set.
 */
export const OTC_PAYMENT_CHAINS: OtcPaymentChain[] = [
  {
    id: 'eth',
    chainId: 1,
    name: 'Ethereum',
    shortName: 'ETH',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    payment: envOrDefault(
      OTC_DEFAULTS.paymentEth,
      'NEXT_PUBLIC_ROBIN_OTC_PAYMENT_ETH',
      'NEXT_PUBLIC_ROBIN_OTC_PAYMENT_ESCROW',
    ),
    rpc: process.env.NEXT_PUBLIC_ETH_RPC || 'https://ethereum.publicnode.com',
    viemChain: mainnet,
    explorer: 'https://etherscan.io',
  },
  {
    id: 'base',
    chainId: 8453,
    name: 'Base',
    shortName: 'Base',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payment: envOrDefault(OTC_DEFAULTS.paymentBase, 'NEXT_PUBLIC_ROBIN_OTC_PAYMENT_BASE'),
    rpc: process.env.NEXT_PUBLIC_BASE_RPC || 'https://mainnet.base.org',
    viemChain: base,
    explorer: 'https://basescan.org',
  },
  {
    id: 'arb',
    chainId: 42161,
    name: 'Arbitrum',
    shortName: 'ARB',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    payment: envOrDefault(OTC_DEFAULTS.paymentArb, 'NEXT_PUBLIC_ROBIN_OTC_PAYMENT_ARB'),
    rpc: process.env.NEXT_PUBLIC_ARB_RPC || process.env.NEXT_PUBLIC_ARBITRUM_RPC || 'https://arb1.arbitrum.io/rpc',
    viemChain: arbitrum,
    explorer: 'https://arbiscan.io',
  },
]

export function livePaymentChains(): OtcPaymentChain[] {
  return OTC_PAYMENT_CHAINS.filter((c) => c.payment !== ZERO)
}

export function getPaymentChain(id: OtcPaymentChainId | number): OtcPaymentChain | undefined {
  if (typeof id === 'number') return OTC_PAYMENT_CHAINS.find((c) => c.chainId === id)
  return OTC_PAYMENT_CHAINS.find((c) => c.id === id)
}

export function robinOtcEnabled(): boolean {
  // Default ON when live defaults exist; set NEXT_PUBLIC_ROBIN_OTC_ENABLED=0 to force off.
  if (process.env.NEXT_PUBLIC_ROBIN_OTC_ENABLED === '0') return false
  return ROBIN_OTC_LIQUIDITY !== ZERO && livePaymentChains().length > 0
}

/** Total open depth across active offers (USDC 6dp) — uses available when present. */
export function sumOfferDepth(offers: { remaining: bigint; available?: bigint }[]): bigint {
  return offers.reduce((a, o) => a + (o.available ?? o.remaining), 0n)
}

/** Prefer Base (cheap), then ARB, then ETH. */
export function defaultPaymentChainId(): OtcPaymentChainId {
  const live = livePaymentChains()
  const prefer: OtcPaymentChainId[] = ['base', 'arb', 'eth']
  for (const id of prefer) {
    if (live.some((c) => c.id === id)) return id
  }
  return live[0]?.id ?? 'base'
}

export const PAYMENT_ABI = parseAbi([
  'function feeBps() view returns (uint16)',
  'function robinFeeBps() view returns (uint16)',
  'function feeOracle() view returns (address)',
  'function refundDelay() view returns (uint64)',
  'function quote(uint256 destAmount, uint32 premiumBps) view returns (uint256 sellerProceeds, uint256 serviceFee, uint256 total)',
  'function quoteRobin(uint256 destAmount, uint32 premiumBps) view returns (uint256 sellerProceeds, uint256 serviceFee, uint256 total)',
  'function fillOffer(bytes32 offerId, uint256 destAmount, address destRecipient, address sellerPayment, uint32 premiumBps, bytes32 reservationId) returns (bytes32 fillId)',
  'function fillOfferRobin(bytes32 offerId, uint256 destAmount, address destRecipient, address sellerPayment, uint32 premiumBps, bytes32 reservationId, uint256 deadline, bytes signature) returns (bytes32 fillId)',
  'function refund(bytes32 fillId)',
  'function lock(bytes32 fillId)',
  'function unlock(bytes32 fillId)',
  'function fills(bytes32 fillId) view returns (address buyer, bytes32 offerId, uint256 destAmount, address destRecipient, address sellerPayment, uint32 premiumBps, uint256 sellerProceeds, uint256 serviceFee, uint64 createdAt, uint8 status, bytes32 reservationId)',
  'function settle(bytes32 fillId)',
  'event FillCreated(bytes32 indexed fillId, address indexed buyer, bytes32 indexed offerId, uint256 destAmount, address destRecipient, address sellerPayment, uint32 premiumBps, uint256 sellerProceeds, uint256 serviceFee, bytes32 reservationId)',
  'event FillSettled(bytes32 indexed fillId, address indexed sellerPayment, uint256 proceeds, uint256 fee)',
  'event FillRefunded(bytes32 indexed fillId, address indexed buyer, uint256 amount)',
  'event FillLocked(bytes32 indexed fillId)',
  'event FillUnlocked(bytes32 indexed fillId)',
])

export const LIQUIDITY_ABI = parseAbi([
  'function createOffer(uint32 premiumBps, address sellerPayment, uint256 amount) returns (bytes32 offerId)',
  'function cancelOffer(bytes32 offerId)',
  'function reserve(bytes32 offerId, uint256 amount, uint32 ttlSeconds) returns (bytes32 reservationId)',
  'function releaseReservation(bytes32 reservationId)',
  'function offers(bytes32 offerId) view returns (address maker, address sellerPayment, uint32 premiumBps, uint256 remaining, bool active)',
  'function reservations(bytes32 reservationId) view returns (bytes32 offerId, address reserver, uint256 amount, uint64 expiresAt, bool consumed, bool released)',
  'function deliver(bytes32 offerId, bytes32 fillId, uint256 amount, address recipient, address sellerPayment, uint32 premiumBps, bytes32 reservationId)',
  'function delivered(bytes32 fillId) view returns (bool)',
  'event OfferCreated(bytes32 indexed offerId, address indexed maker, address sellerPayment, uint32 premiumBps, uint256 amount)',
  'event OfferCancelled(bytes32 indexed offerId, uint256 refunded)',
  'event Reserved(bytes32 indexed reservationId, bytes32 indexed offerId, address indexed reserver, uint256 amount, uint64 expiresAt)',
  'event ReservationReleased(bytes32 indexed reservationId, uint256 amount)',
  'event Delivered(bytes32 indexed offerId, bytes32 indexed fillId, address indexed recipient, uint256 amount, uint256 remaining, bytes32 reservationId)',
])

export const ERC20_MIN_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
])

export type OtcOffer = {
  offerId: Hex
  maker: Address
  sellerPayment: Address
  premiumBps: number
  /**
   * Free inventory on Arc (`offers.remaining`).
   * Hard-reserved amounts are already deducted; maker cancel only refunds this free residual.
   */
  remaining: bigint
  active: boolean
  /** All-in multiplier for 1 dest USDC (includes platform fee estimate at current feeBps). */
  allInMult?: number
  /** Pending payment-chain fills not yet settled (UX / cancel gate). */
  pendingReserved?: bigint
  /** Free inventory available to buy (= remaining after hard reserve). */
  available?: bigint
  /** True when there is at least one pending fill against this offer. */
  hasPending?: boolean
}

/** 'locked' = keeper began Arc delivery; self-refund blocked until unlock/settle. */
export type OtcFillStatus = 'none' | 'pending' | 'locked' | 'settled' | 'refunded'

export type OtcFill = {
  fillId: Hex
  offerId: Hex
  buyer: Address
  destAmount: bigint
  destRecipient: Address
  sellerPayment: Address
  premiumBps: number
  sellerProceeds: bigint
  serviceFee: bigint
  createdAt: number
  /** 0 none, 1 pending, 2 locked, 3 settled, 4 refunded */
  status: 0 | 1 | 2 | 3 | 4
  statusLabel: OtcFillStatus
  paymentChainId: OtcPaymentChainId
  paymentChainName: string
  paymentEscrow: Address
  explorer: string
  refundDelaySec?: number
  reservationId?: Hex
  /** Arc liquidity delivered[fillId] — false with status=settled means bad path (maker paid, no Arc credit). */
  arcDelivered?: boolean
}

const FILL_STATUS_LABEL: Record<number, OtcFillStatus> = {
  0: 'none',
  1: 'pending',
  2: 'locked',
  3: 'settled',
  4: 'refunded',
}

const LOCAL_FILLS_KEY = 'robin_otc_fill_ids_v1'

export function rememberLocalFill(fillId: Hex, paymentChainId: OtcPaymentChainId) {
  if (typeof window === 'undefined') return
  try {
    const raw = localStorage.getItem(LOCAL_FILLS_KEY)
    const list: { fillId: string; chain: string; at: number }[] = raw ? JSON.parse(raw) : []
    if (!list.some((x) => x.fillId.toLowerCase() === fillId.toLowerCase())) {
      list.unshift({ fillId, chain: paymentChainId, at: Date.now() })
      localStorage.setItem(LOCAL_FILLS_KEY, JSON.stringify(list.slice(0, 100)))
    }
  } catch {
    /* ignore */
  }
}

export function loadLocalFillIds(): { fillId: Hex; chain: OtcPaymentChainId }[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(LOCAL_FILLS_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as { fillId: string; chain: string }[]
    return list
      .filter((x) => x.fillId && x.chain)
      .map((x) => ({ fillId: x.fillId as Hex, chain: x.chain as OtcPaymentChainId }))
  } catch {
    return []
  }
}

export function paymentClient(chain: OtcPaymentChain) {
  return createPublicClient({
    chain: chain.viemChain,
    transport: http(chain.rpc),
  })
}

/**
 * Shared Arc RPC client with multi-endpoint fallback (baracat / Infura / theleak).
 * RobinBridge used a single `NEXT_PUBLIC_ARC_RPC || ''` transport — empty URL or a
 * quota-exhausted Infura project made OfferCreated scans return empty and offers
 * "disappear" until a hard refresh hit a working node.
 */
const arcClient = () => arcPublicClient()

/** Local quote (matches PaymentEscrow._quote). */
export function quoteFill(
  destAmount: bigint,
  premiumBps: number,
  feeBps: number,
): { sellerProceeds: bigint; serviceFee: bigint; total: bigint } {
  if (destAmount <= 0n) return { sellerProceeds: 0n, serviceFee: 0n, total: 0n }
  const sellerProceeds = (destAmount * (10_000n + BigInt(premiumBps))) / 10_000n
  let serviceFee = (sellerProceeds * BigInt(feeBps)) / 10_000n
  if (feeBps > 0 && serviceFee === 0n && sellerProceeds > 0n) serviceFee = 1n
  return { sellerProceeds, serviceFee, total: sellerProceeds + serviceFee }
}

export function premiumLabel(premiumBps: number): string {
  if (premiumBps === 0) return '0% (par)'
  if (premiumBps % 100 === 0) return `${premiumBps / 100}%`
  return `${(premiumBps / 100).toFixed(2)}%`
}

export function allInMultiplier(premiumBps: number, feeBps: number): number {
  const dest = 1_000_000n // $1
  const { total } = quoteFill(dest, premiumBps, feeBps)
  return Number(total) / Number(dest)
}

/** feeBps from first live payment escrow (should match across deploys). */
export async function fetchOtcFeeBps(): Promise<number> {
  const live = livePaymentChains()
  for (const c of live) {
    try {
      const f = await paymentClient(c).readContract({
        address: c.payment,
        abi: PAYMENT_ABI,
        functionName: 'feeBps',
      })
      return Number(f)
    } catch {
      /* try next */
    }
  }
  return OTC_DEFAULT_FEE_BPS
}

export type OtcDeskStats = {
  /** Number of FillSettled events across payment chains. */
  settledTrades: number
  /** Total USDC (6dp) paid on settle = sum(proceeds + fee). */
  volumeUsdc: bigint
}

const STATS_CACHE_KEY = 'robin_otc_desk_stats_v1'

type StatsCache = {
  settledTrades: number
  volumeUsdc: string
  cursor: Record<string, string> // chainId -> last exclusive-to block scanned
}

/**
 * Aggregate settled trades + volume from FillSettled logs (chunked).
 * Uses session cache + incremental scan so refreshes stay cheap.
 */
export async function fetchOtcDeskStats(opts?: {
  /** Max blocks to scan per call when no cache (default ~1d Base @ 2s — keep first paint light). */
  maxBlocks?: bigint
  chunkSize?: bigint
}): Promise<OtcDeskStats> {
  if (!robinOtcEnabled()) return { settledTrades: 0, volumeUsdc: 0n }

  // Cold first load used to scan ~500k blocks on every payment chain (~minutes). Cap to ~1 day.
  const maxBlocks = opts?.maxBlocks ?? 50_000n
  const chunkSize = opts?.chunkSize ?? PAYMENT_LOG_LOOKBACK

  let settledTrades = 0
  let volumeUsdc = 0n
  let cursor: Record<string, string> = {}

  if (typeof window !== 'undefined') {
    try {
      const raw = sessionStorage.getItem(STATS_CACHE_KEY)
      if (raw) {
        const c = JSON.parse(raw) as StatsCache
        settledTrades = c.settledTrades || 0
        volumeUsdc = BigInt(c.volumeUsdc || '0')
        cursor = c.cursor || {}
      }
    } catch {
      /* fresh */
    }
  }

  await Promise.all(
    livePaymentChains().map(async (chain) => {
      try {
        const client = paymentClient(chain)
        const latest = await client.getBlockNumber()
        const key = String(chain.chainId)
        const cachedTo = cursor[key] ? BigInt(cursor[key]) : null
        // Resume after last scanned block; otherwise scan maxBlocks back
        let fromStart = cachedTo != null ? cachedTo + 1n : latest > maxBlocks ? latest - maxBlocks : 0n
        if (fromStart > latest) {
          cursor[key] = latest.toString()
          return
        }

        let to = latest
        while (to >= fromStart) {
          const from = to >= chunkSize ? to - chunkSize + 1n : fromStart
          const rangeFrom = from < fromStart ? fromStart : from
          try {
            const logs = await client.getContractEvents({
              address: chain.payment,
              abi: PAYMENT_ABI,
              eventName: 'FillSettled',
              fromBlock: rangeFrom,
              toBlock: to,
            })
            for (const log of logs) {
              const proceeds = (log.args.proceeds as bigint) ?? 0n
              const fee = (log.args.fee as bigint) ?? 0n
              settledTrades += 1
              volumeUsdc += proceeds + fee
            }
          } catch {
            /* chunk fail — skip */
          }
          if (rangeFrom <= fromStart) break
          to = rangeFrom - 1n
        }
        cursor[key] = latest.toString()
      } catch {
        /* chain fail */
      }
    }),
  )

  if (typeof window !== 'undefined') {
    try {
      const payload: StatsCache = {
        settledTrades,
        volumeUsdc: volumeUsdc.toString(),
        cursor,
      }
      sessionStorage.setItem(STATS_CACHE_KEY, JSON.stringify(payload))
    } catch {
      /* ignore */
    }
  }

  return { settledTrades, volumeUsdc }
}

/**
 * A fixed lookback window silently hides any offer older than the window — not "no offer",
 * indistinguishable in the UI from one that was never made or already cancelled. Found live
 * 2026-08-07: a maker's $50 offer (11.4h old) vanished from "My liquidity offers" because
 * fetchMakerOffers only scanned the last 50_000 blocks (~83 min at Arc's ~0.1s block time) — the
 * offer itself was untouched on chain the whole time.
 *
 * Fix: scan every chunk back to block 0 rather than guess a depth. block 0 is the one floor that
 * needs no guessing and is always exactly correct.
 *
 * That "to block 0" scan was originally meant to stop early at the contract's own deployment
 * block, found via binary search on eth_getCode. Built, then dropped after live testing
 * (2026-08-07): baracat throws -32005 "Request exceeds defined limit" on eth_getCode at an
 * arbitrary historical block — confirmed reproducible even in complete isolation (a single call,
 * no burst, no concurrent requests from anything else in this process) — while eth_getLogs at
 * equally old block ranges succeeded 5/5 in the same test. Whatever baracat is rate-limiting,
 * it's specifically archive-style getCode-at-a-past-block reads, not getLogs range scans — so
 * the fix here is built entirely on the operation confirmed to actually work, not the elegant one
 * that happened to fail on this particular RPC's quirks.
 */
/**
 * Deployment floor for known-live RobinOtcLiquidity addresses, keyed by lowercased address.
 *
 * The 90k→9k chunk-size fix (see ARC_LOG_CHUNK_BLOCKS below) turned this into a ~1,655-chunk
 * scan instead of ~166 — found live 2026-08-10 tuning this fix: even at low concurrency with
 * generous retry backoff, that volume of requests against baracat's public endpoint reliably
 * triggers 429s and multi-minute load times on what's meant to be a normal page load. This is
 * the other half of the fix, not an optional nicety.
 *
 * Verified live via paced eth_getLogs spot checks (unfiltered, no maker topic): zero events at
 * 14.2M/13.5M/13M/12M/10M/5M, first events appearing ~14.3–14.4M. 14,000,000 is a wide margin
 * below that — cuts the scan back to ~100 chunks, comfortably faster than the original fix.
 *
 * 🛑 Gated on an EXACT address match, not "whatever ROBIN_OTC_LIQUIDITY resolves to" — a future
 * redeploy (this has already happened once this session) must add its own entry here, or that
 * new contract silently falls through to the safe `0n` default below and just scans everything,
 * slow but correct. Never assume; a wrong floor here is a repeat of the exact bug this file's
 * block-0 rewrite exists to prevent, just shaped as a floor instead of a fixed window.
 */
const KNOWN_LIQUIDITY_DEPLOY_FLOOR: Readonly<Record<string, bigint>> = {
  '0xbd06241e272d05449a034abc0cfd558905c4ae3e': 14_000_000n,
}

async function withArcRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i >= attempts - 1) throw err
      // Longer backoff than the old 4-attempt/~2s-total version: the 9k-chunk scan makes ~10x
      // more requests than the 90k one did, so baracat's 429s show up for real now (found live
      // tuning this fix) — give each retry room to land outside the rate-limit window instead of
      // burning through attempts in under 2s.
      await new Promise((r) => setTimeout(r, 800 + i * 800))
    }
  }
}

/** Regression found live 2026-08-10: baracat's eth_getLogs cap has since tightened to 10,000
 *  blocks/request ("eth_getLogs is limited to a 10,000 range") — 90k silently failed on EVERY
 *  chunk (caught below, so the whole offer list rendered permanently empty for everyone, not
 *  just one maker). Confirmed live: 9,000 succeeds, matching the margin robinlock-keeper already
 *  uses against the same RPC. Re-verify against baracat directly before raising this again —
 *  don't trust a comment (including this one) over a live request. */
const ARC_LOG_CHUNK_BLOCKS = 9_000n
/** Bounds how many chunk requests run at once. Tried 16 first (naive "10x more chunks now, so
 *  raise it") and it immediately started 429ing baracat — more chunks means more total requests
 *  in the same window even at the SAME concurrency, so the old value of 8 was already tuned for
 *  a much smaller chunk count. Backed off to 6 and re-verified live before shipping. */
const ARC_LOG_CHUNK_CONCURRENCY = 6

/**
 * OfferCreated logs for RobinOtcLiquidity, from block 0 to `latest`. Replaces the old fixed-window
 * scan in both fetchMakerOffers and fetchOtcOffers — same root cause, same fix, one shared
 * implementation so there is only one lookback bug to ever fix again.
 *
 * Arc's current height is ~14.4M blocks (~160 chunks at 90k each) — a real cost, paid here rather
 * than on a hot path: this backs "my offers" and the offer browser, not an auto-refreshing ticker.
 * As Arc's height grows this cost grows with it; past some point a real indexer (subgraph or a
 * cron-fed cache) replaces this scan rather than the chunk count being pushed further.
 */
export type OfferCreatedLog = {
  args: {
    offerId?: Hex
    maker?: Address
    sellerPayment?: Address
    premiumBps?: number
    amount?: bigint
  }
}

async function fetchAllOfferCreatedLogs(
  client: ReturnType<typeof arcClient>,
  maker?: Address,
): Promise<OfferCreatedLog[]> {
  const latest = await withArcRetry(() => client.getBlockNumber())
  const earliest = KNOWN_LIQUIDITY_DEPLOY_FLOOR[ROBIN_OTC_LIQUIDITY.toLowerCase()] ?? 0n

  const ranges: { from: bigint; to: bigint }[] = []
  for (let to = latest; to >= earliest; ) {
    const from = to > earliest + ARC_LOG_CHUNK_BLOCKS - 1n ? to - ARC_LOG_CHUNK_BLOCKS + 1n : earliest
    ranges.push({ from, to })
    if (from === earliest) break
    to = from - 1n
  }

  const results: OfferCreatedLog[] = []
  let failedChunks = 0
  let okChunks = 0
  for (let i = 0; i < ranges.length; i += ARC_LOG_CHUNK_CONCURRENCY) {
    const batch = ranges.slice(i, i + ARC_LOG_CHUNK_CONCURRENCY)
    const batchLogs = await Promise.all(
      batch.map(({ from, to }) =>
        withArcRetry(() =>
          client.getContractEvents({
            address: ROBIN_OTC_LIQUIDITY,
            abi: LIQUIDITY_ABI,
            eventName: 'OfferCreated',
            fromBlock: from,
            toBlock: to,
            ...(maker ? { args: { maker } } : {}),
          }),
        )
          .then((logs) => {
            okChunks++
            return logs as unknown as OfferCreatedLog[]
          })
          .catch((err) => {
            // A chunk that fails after every retry used to vanish silently into an empty array —
            // exactly how the 2026-08-10 chunk-size regression hid EVERY offer for days with no
            // signal anywhere. Still degrade gracefully (one bad chunk shouldn't blank the whole
            // list), but log it so a systemic failure like that one is visible, not silent.
            failedChunks++
            console.warn(
              `[arc-otc] OfferCreated scan chunk ${from}-${to} failed:`,
              (err as Error)?.message ?? err,
            )
            return [] as OfferCreatedLog[]
          }),
      ),
    )
    for (const logs of batchLogs) results.push(...logs)
  }
  // If the RPC rate-limited / rejected the entire scan, do not return a clean [] —
  // callers treat that as "no offers" and wipe the UI. Surface as a hard error so
  // the panel keeps prior state.
  if (okChunks === 0 && failedChunks > 0) {
    throw new Error(
      `Arc RPC failed all ${failedChunks} OfferCreated log chunks — try again or switch RPC`,
    )
  }
  if (failedChunks > 0 && failedChunks >= okChunks) {
    console.warn(
      `[arc-otc] OfferCreated scan degraded: ${failedChunks} failed / ${okChunks} ok chunks`,
    )
  }
  return results
}

const PAYMENT_LOG_LOOKBACK = 8_000n

/** In-flight dest amounts keyed by offerId (pending + locked fills). */
export async function fetchPendingReservedByOffer(): Promise<Map<string, bigint>> {
  const map = new Map<string, bigint>()
  // status filter is single-value; pull recent and sum pending(1) + locked(2)
  const fills = await fetchRecentFills()
  for (const f of fills) {
    if (f.status !== 1 && f.status !== 2) continue
    const k = f.offerId.toLowerCase()
    map.set(k, (map.get(k) ?? 0n) + f.destAmount)
  }
  return map
}

export async function fetchRecentFills(opts?: {
  /** 1 pending, 2 locked, 3 settled, 4 refunded */
  status?: 1 | 2 | 3 | 4
  buyer?: Address
  /** Total blocks to scan backward (chunked to respect RPC getLogs limits). */
  maxBlocks?: bigint
  /** Chunk size per eth_getLogs (Base public ≈ 10k). */
  chunkSize?: bigint
}): Promise<OtcFill[]> {
  if (!robinOtcEnabled()) return []
  // ~3 days on Base (2s blocks) when looking up a buyer's history
  const maxBlocks = opts?.maxBlocks ?? (opts?.buyer ? 120_000n : PAYMENT_LOG_LOOKBACK)
  const chunkSize = opts?.chunkSize ?? PAYMENT_LOG_LOOKBACK
  const out: OtcFill[] = []
  const seen = new Set<string>()

  await Promise.all(
    livePaymentChains().map(async (chain) => {
      try {
        const client = paymentClient(chain)
        const latest = await client.getBlockNumber()
        let refundDelay = 30 * 60
        try {
          refundDelay = Number(
            await client.readContract({
              address: chain.payment,
              abi: PAYMENT_ABI,
              functionName: 'refundDelay',
            }),
          )
        } catch {
          /* default */
        }

        let to = latest
        const earliest = latest > maxBlocks ? latest - maxBlocks : 0n
        while (to >= earliest) {
          const from = to > chunkSize ? to - chunkSize + 1n : earliest
          const rangeFrom = from < earliest ? earliest : from
          try {
            const logs = await client.getContractEvents({
              address: chain.payment,
              abi: PAYMENT_ABI,
              eventName: 'FillCreated',
              fromBlock: rangeFrom,
              toBlock: to,
              ...(opts?.buyer ? { args: { buyer: opts.buyer } } : {}),
            })

            // Batch the per-fill `fills()` reads via multicall instead of one sequential
            // readContract per log. Found live 2026-08-12: a buyer filled successfully (settled
            // on-chain, Arc-delivered) within seconds of checking "My orders" and it didn't show —
            // most likely explanation is exactly this loop: N fills in a chunk meant N sequential
            // round trips against a public RPC (mainnet.base.org) that already warns about 429s
            // under polling in this file's other comments. allowFailure:true keeps the existing
            // per-fill "skip on error" behavior — one bad fillId can't drop the whole batch.
            const newIds = logs
              .map((log) => log.args.fillId as Hex | undefined)
              .filter((fillId): fillId is Hex => {
                if (!fillId) return false
                const sk = `${chain.id}:${fillId.toLowerCase()}`
                if (seen.has(sk)) return false
                seen.add(sk)
                return true
              })
            if (newIds.length > 0) {
              const results = await client.multicall({
                contracts: newIds.map((fillId) => ({
                  address: chain.payment,
                  abi: PAYMENT_ABI,
                  functionName: 'fills' as const,
                  args: [fillId] as const,
                })),
                allowFailure: true,
              })
              for (let i = 0; i < newIds.length; i++) {
                const fillId = newIds[i]
                const r = results[i]
                if (r.status !== 'success') continue
                const row = r.result as readonly [
                  Address,
                  Hex,
                  bigint,
                  Address,
                  Address,
                  number,
                  bigint,
                  bigint,
                  bigint,
                  number,
                  Hex,
                ]
                const status = Number(row[9]) as 0 | 1 | 2 | 3 | 4
                if (opts?.status != null && status !== opts.status) continue
                if (opts?.buyer && (row[0] as string).toLowerCase() !== opts.buyer.toLowerCase()) continue

                out.push({
                  fillId,
                  buyer: row[0] as Address,
                  offerId: row[1] as Hex,
                  destAmount: row[2] as bigint,
                  destRecipient: row[3] as Address,
                  sellerPayment: row[4] as Address,
                  premiumBps: Number(row[5]),
                  sellerProceeds: row[6] as bigint,
                  serviceFee: row[7] as bigint,
                  createdAt: Number(row[8]),
                  status,
                  statusLabel: FILL_STATUS_LABEL[status] ?? 'none',
                  paymentChainId: chain.id,
                  paymentChainName: chain.shortName,
                  paymentEscrow: chain.payment,
                  explorer: chain.explorer,
                  refundDelaySec: refundDelay,
                  reservationId: (row[10] as Hex | undefined) ?? undefined,
                })
              }
            }
          } catch {
            /* chunk failed — continue older chunks */
          }
          if (rangeFrom === 0n || rangeFrom <= earliest) break
          to = rangeFrom - 1n
        }
      } catch {
        /* chain failed */
      }
    }),
  )

  out.sort((a, b) => b.createdAt - a.createdAt)

  // Enrich settled fills with Arc delivered[] so UI does not claim "Arc USDC delivered" falsely.
  if (out.some((f) => f.status === 3)) {
    try {
      const arc = arcClient()
      await Promise.all(
        out
          .filter((f) => f.status === 3)
          .map(async (f) => {
            try {
              f.arcDelivered = (await arc.readContract({
                address: ROBIN_OTC_LIQUIDITY,
                abi: LIQUIDITY_ABI,
                functionName: 'delivered',
                args: [f.fillId],
              })) as boolean
            } catch {
              f.arcDelivered = undefined
            }
          }),
      )
    } catch {
      /* optional */
    }
  }

  return out
}

export async function fetchFillById(
  fillId: Hex,
  chainId?: OtcPaymentChainId,
): Promise<OtcFill | null> {
  const chains = chainId
    ? livePaymentChains().filter((c) => c.id === chainId)
    : livePaymentChains()

  for (const chain of chains) {
    try {
      const client = paymentClient(chain)
      const row = await client.readContract({
        address: chain.payment,
        abi: PAYMENT_ABI,
        functionName: 'fills',
        args: [fillId],
      })
      const status = Number(row[9]) as 0 | 1 | 2 | 3 | 4
      if (status === 0) continue
      let refundDelay = 30 * 60
      try {
        refundDelay = Number(
          await client.readContract({
            address: chain.payment,
            abi: PAYMENT_ABI,
            functionName: 'refundDelay',
          }),
        )
      } catch {
        /* */
      }
      return {
        fillId,
        buyer: row[0] as Address,
        offerId: row[1] as Hex,
        destAmount: row[2] as bigint,
        destRecipient: row[3] as Address,
        sellerPayment: row[4] as Address,
        premiumBps: Number(row[5]),
        sellerProceeds: row[6] as bigint,
        serviceFee: row[7] as bigint,
        createdAt: Number(row[8]),
        status,
        statusLabel: FILL_STATUS_LABEL[status] ?? 'none',
        paymentChainId: chain.id,
        paymentChainName: chain.shortName,
        paymentEscrow: chain.payment,
        explorer: chain.explorer,
        refundDelaySec: refundDelay,
        reservationId: (row[10] as Hex | undefined) ?? undefined,
      }
    } catch {
      /* try next */
    }
  }
  return null
}

/**
 * Maker offers on Arc (active or residual). Scans from the liquidity contract's own deployment
 * block — see fetchAllOfferCreatedLogs — so an offer never silently vanishes from "my offers" for
 * being older than a guessed window; it can only be missing because it genuinely doesn't exist.
 */
export async function fetchMakerOffers(maker: Address): Promise<OtcOffer[]> {
  if (!robinOtcEnabled()) return []
  const client = arcClient()
  const feeBps = await fetchOtcFeeBps()

  const logs = await fetchAllOfferCreatedLogs(client, maker)

  const out: OtcOffer[] = []
  const pending = await fetchPendingReservedByOffer()
  for (const log of logs) {
    const offerId = log.args.offerId as Hex
    if (!offerId) continue
    try {
      const row = (await client.readContract({
        address: ROBIN_OTC_LIQUIDITY,
        abi: LIQUIDITY_ABI,
        functionName: 'offers',
        args: [offerId],
      })) as readonly [Address, Address, number, bigint, boolean]
      const [m, sellerPayment, premiumBps, remaining, active] = row
      // remaining is free inventory (hard reserves already deducted on Arc).
      const softPending = pending.get(offerId.toLowerCase()) ?? 0n
      out.push({
        offerId,
        maker: m,
        sellerPayment,
        premiumBps: Number(premiumBps),
        remaining,
        active,
        allInMult: allInMultiplier(Number(premiumBps), feeBps),
        pendingReserved: softPending,
        available: remaining,
        hasPending: softPending > 0n,
      })
    } catch {
      /* skip */
    }
  }
  return out
}

/** Load active offers from OfferCreated logs + on-chain free remaining. Same block-0 scan as
 *  fetchMakerOffers — an old-but-still-open offer from any maker is real tradable liquidity, and a
 *  fixed lookback window hiding it here means takers can't see or fill it at all, not just a
 *  cosmetic gap on someone's own dashboard. */
export async function fetchOtcOffers(): Promise<OtcOffer[]> {
  if (!robinOtcEnabled()) return []
  const client = arcClient()

  const [logs, feeBps, pending] = await Promise.all([
    fetchAllOfferCreatedLogs(client),
    fetchOtcFeeBps(),
    fetchPendingReservedByOffer(),
  ])

  const byId = new Map<string, OtcOffer>()
  for (const log of logs) {
    const offerId = log.args.offerId as Hex
    if (!offerId) continue
    byId.set(offerId.toLowerCase(), {
      offerId,
      maker: log.args.maker as Address,
      sellerPayment: log.args.sellerPayment as Address,
      premiumBps: Number(log.args.premiumBps ?? 0),
      remaining: (log.args.amount as bigint) ?? 0n,
      active: true,
    })
  }

  const out: OtcOffer[] = []
  for (const o of byId.values()) {
    try {
      const row = (await client.readContract({
        address: ROBIN_OTC_LIQUIDITY,
        abi: LIQUIDITY_ABI,
        functionName: 'offers',
        args: [o.offerId],
      })) as readonly [Address, Address, number, bigint, boolean]
      const [maker, sellerPayment, premiumBps, remaining, active] = row
      // Free inventory only — hard-reserved liquidity is not listed as available.
      if (!active || remaining === 0n) continue
      const softPending = pending.get(o.offerId.toLowerCase()) ?? 0n
      out.push({
        offerId: o.offerId,
        maker,
        sellerPayment,
        premiumBps: Number(premiumBps),
        remaining,
        active,
        allInMult: allInMultiplier(Number(premiumBps), feeBps),
        pendingReserved: softPending,
        available: remaining,
        hasPending: softPending > 0n,
      })
    } catch {
      /* skip */
    }
  }

  // Best price first; hide fully reserved at end or still show as pending
  out.sort(
    (a, b) =>
      (a.allInMult ?? 99) - (b.allInMult ?? 99) ||
      Number((b.available ?? b.remaining) - (a.available ?? a.remaining)),
  )
  return out
}

export function formatUsdc6(raw: bigint): string {
  return formatUnits(raw, 6)
}

export function parseUsdc6(v: string): bigint {
  return parseUnits(String(v || '0'), 6)
}

export function paymentSpokesLabel(): string {
  const live = livePaymentChains()
  if (live.length === 0) return 'no payment chains'
  return live.map((c) => c.shortName).join(' · ')
}

export { encodeEventTopics }

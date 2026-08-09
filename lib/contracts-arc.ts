/**
 * Arc (Circle) — testnet 5042002, mainnet 5042.
 *
 * Product path (2026-08-02): **Uniswap V3 only** — Instant pad + RobinSwap fee UI.
 * Do NOT deploy RobinSwap V3 core/fork on Arc for product. See docs/ARC_LAUNCHPAD_SPEC.md.
 *
 * Native gas = USDC (18dp msg.value). ERC-20 USDC interface at 0x3600…000 (6dp).
 *
 * RPCs (mainnet): MetaMask Arc uses Infura (`arc-mainnet.infura.io`). Full URL needs a project
 * id with Arc enabled on the Infura dashboard:
 *   NEXT_PUBLIC_ARC_CHAIN_ID=5042
 *   NEXT_PUBLIC_ARC_RPC=https://arc-mainnet.infura.io/v3/<PROJECT_ID>
 *   # or set NEXT_PUBLIC_INFURA_API_KEY and we build the URL
 *   NEXT_PUBLIC_ARC_EXPLORER=https://arcscan.app
 *   NEXT_PUBLIC_ARC_ENABLED=1
 *
 * 2026-08-03: Railway fortest RPC is DEAD. Public baracat rate-limits under burst (Cloudflare
 * 1015 / -32005). Prefer MetaMask Infura Arc via NEXT_PUBLIC_ARC_RPC or NEXT_PUBLIC_INFURA_API_KEY;
 * baracat remains the only working unauthenticated fallback.
 *
 * 2026-08-06: thirdweb (`https://5042.rpc.thirdweb.com`) is BANNED as an Arc endpoint — see the
 * block above ARC_RPC_URLS. It is not a weak fallback, it is a poisoned one.
 */
import { createPublicClient, defineChain, fallback, http, isAddress, type Address } from 'viem'

/** Strip whitespace / newlines from env addresses (Vercel `echo | env add` can bake in `\n`). */
function envAddr(raw: string | undefined, fallback: Address): Address {
  const v = (raw ?? '').trim()
  if (v && isAddress(v)) return v as Address
  return fallback
}

export const ARC_TESTNET_CHAIN_ID = 5042002
export const ARC_MAINNET_CHAIN_ID = 5042

const ARC_TESTNET_RPC = 'https://rpc.testnet.arc.network'
const ARC_TESTNET_EXPLORER = 'https://testnet.arcscan.app'

/** Active Arc chain id. Defaults to **mainnet 5042** (Instant pad is live). Set 5042002 for testnet. */
export const ARC_CHAIN_ID: number = (() => {
  const raw = Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID)
  return Number.isInteger(raw) && raw > 0 ? raw : ARC_MAINNET_CHAIN_ID
})()

export const ARC_IS_TESTNET = ARC_CHAIN_ID === ARC_TESTNET_CHAIN_ID

/**
 * Client-safe public RPC. The testnet default applies ONLY on the testnet chain id — pointing a
 * mainnet config at the testnet endpoint would read a different chain's state under a mainnet
 * label, so off-testnet this stays empty until NEXT_PUBLIC_ARC_RPC is supplied and `arcEnabled()`
 * keeps the UI dark.
 *
 * Mainnet default: MetaMask’s Arc Infura host (UI label `arc-mainnet.infura.io`).
 * Infura JSON-RPC requires `/v3/<PROJECT_ID>` with Arc enabled on the project.
 * Override with NEXT_PUBLIC_ARC_RPC, or set NEXT_PUBLIC_INFURA_API_KEY to build the URL.
 * Public fallback: baracat only (rate-limits under burst, but its eth_call is sound).
 * thirdweb is filtered out unconditionally — see BANNED_ARC_RPC_HOSTS below.
 */
/** MetaMask built-in Arc mainnet RPC host (Infura). */
export const ARC_INFURA_HOST = 'https://arc-mainnet.infura.io'

const ARC_INFURA_KEY =
  process.env.NEXT_PUBLIC_INFURA_API_KEY ||
  process.env.NEXT_PUBLIC_INFURA_KEY ||
  process.env.NEXT_PUBLIC_ARC_INFURA_KEY ||
  ''

/**
 * Full Infura Arc JSON-RPC URL — same host MetaMask shows for Arc (`arc-mainnet.infura.io`).
 * Requires `/v3/<PROJECT_ID>` with Arc enabled on the Infura project (bare host / empty id → 401).
 */
const ARC_INFURA_RPC = ARC_INFURA_KEY ? `${ARC_INFURA_HOST}/v3/${ARC_INFURA_KEY}` : ''

/** Public unauthenticated fallbacks when Infura is unset / project lacks Arc / rate-limited. */
const ARC_BARACAT_RPC = 'https://arc-mainnet-rpc.baracat.meme'

/**
 * Endpoints that must never serve Arc, no matter who configures them.
 *
 * thirdweb (`5042.rpc.thirdweb.com`) has Arc in its chain registry but no working node behind it.
 * It answers `eth_chainId` and `net_version` convincingly — so it passes every liveness probe and
 * looks like the healthiest endpoint in the list — then fails EVERY node-backed method with
 * `-32603 "We are not able to process your request at this time. Please contact thirdweb support
 * <uuid>"`. Verified 2026-08-06 against both Arc factories: chainId OK, `CREATION_FEE()` -32603.
 *
 * That combination is worse than having no fallback at all. viem receives a well-formed JSON-RPC
 * error and renders it as `The contract function "CREATION_FEE" reverted with the following
 * reason: …`, so a dead transport is reported to the user as a reverting contract — sending
 * whoever debugs it after the contract instead of after the RPC.
 *
 * Enforced as a filter rather than "just don't put it in the defaults list" because it reached
 * production through `NEXT_PUBLIC_ARC_RPC`, which overrides the defaults entirely.
 */
const BANNED_ARC_RPC_HOSTS = ['rpc.thirdweb.com']

function isBannedArcRpc(url: string): boolean {
  return BANNED_ARC_RPC_HOSTS.some((h) => url.includes(h))
}

/**
 * Does this error mean "the RPC is unusable", as opposed to "the contract rejected the call"?
 *
 * These arrive as well-formed JSON-RPC error responses, so viem treats them as an answer from the
 * node and renders them as `The contract function "X" reverted with the following reason: …`. The
 * contract is not involved at all. Without this distinction the UI blames a healthy contract and
 * sends whoever debugs it in entirely the wrong direction — which is exactly what happened with
 * thirdweb on both dyorv3.org and Arc creates.
 *
 * Deliberately NOT a host ban, unlike BANNED_ARC_RPC_HOSTS above. A quota-exhausted Infura project
 * is the same URL that works perfectly once the quota resets or the plan is upgraded, so the host
 * is fine and only this moment is broken. Banning `infura.io` would break every healthy key.
 */
export function isArcRpcInfraError(err: unknown): boolean {
  const e = err as { message?: string; shortMessage?: string; details?: string } | undefined
  const raw = `${e?.shortMessage ?? ''} ${e?.message ?? ''} ${e?.details ?? ''} ${String(err ?? '')}`.toLowerCase()
  return (
    raw.includes('exceeded quota') || // Infura: project ID exceeded quota (-32600)
    raw.includes('not able to process your request') || // thirdweb: no node behind the chain (-32603)
    raw.includes('contact thirdweb support') ||
    raw.includes('project id') ||
    raw.includes('-32600')
  )
}

/** User-facing guidance when isArcRpcInfraError matches. Names no specific vendor as a fix. */
export const ARC_RPC_INFRA_HINT =
  'Your Arc RPC is not serving contract reads right now (out of quota, or the endpoint has no Arc node behind it) — ' +
  'the contract itself is fine. In MetaMask → Settings → Networks → Arc, set Chain ID 5042 with an Arc RPC that ' +
  'answers eth_call, then hard-refresh and retry.'

/**
 * Primary mainnet default: MetaMask Infura Arc when keyed; otherwise baracat until
 * NEXT_PUBLIC_ARC_RPC or NEXT_PUBLIC_INFURA_API_KEY is set in deploy env.
 */
const ARC_MAINNET_RPC_DEFAULT = ARC_INFURA_RPC || ARC_BARACAT_RPC

/** Ordered public/mainnet RPC candidates for wagmi fallback transports. */
export const ARC_RPC_URLS: string[] = (() => {
  const primary =
    process.env.NEXT_PUBLIC_ARC_RPC ||
    (ARC_IS_TESTNET
      ? ARC_TESTNET_RPC
      : ARC_MAINNET_CHAIN_ID === ARC_CHAIN_ID
        ? ARC_MAINNET_RPC_DEFAULT
        : '')
  const extras = (process.env.NEXT_PUBLIC_ARC_RPC_FALLBACKS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  // Infura first (MetaMask Arc), then public fallbacks.
  const defaults = ARC_IS_TESTNET
    ? [ARC_TESTNET_RPC]
    : [ARC_INFURA_RPC, ARC_BARACAT_RPC].filter(Boolean)
  const seen = new Set<string>()
  const out: string[] = []
  for (const u of [primary, ...extras, ...defaults]) {
    // Drop banned endpoints from EVERY source, env included — a configured-but-dead primary is
    // how this broke production, and silently honouring it would just reproduce that.
    if (u && isBannedArcRpc(u)) {
      console.warn(
        `[arc] ignoring unusable RPC ${u} — it answers eth_chainId but fails eth_call. ` +
          `Set NEXT_PUBLIC_ARC_RPC to an Infura Arc URL (or leave unset to use baracat).`,
      )
      continue
    }
    if (u && !seen.has(u)) {
      seen.add(u)
      out.push(u)
    }
  }
  return out
})()

export const ARC_RPC = ARC_RPC_URLS[0] || ''

/** Server-only RPC override. Empty → same as ARC_RPC. */
export const ARC_SERVER_RPC = process.env.ARC_RPC || ARC_RPC

/**
 * Instant create (token deploy + Uni V3 pool + single-sided mint + lock) is heavy.
 * Public Arc RPCs often choke on eth_estimateGas (-32005 limit / 429 / -32006). Skip
 * estimation with a fixed cap under Arc's 30M block gas limit.
 */
export const ARC_INSTANT_CREATE_GAS = 12_000_000n

/**
 * Bonding-curve create (token + optional first-buy) — lighter than Instant, but still
 * skip eth_estimateGas on flaky public Arc RPCs.
 */
export const ARC_CURVE_CREATE_GAS = 4_000_000n

/**
 * Live Instant factory `CREATION_FEE` is **1 native USDC** (1e18) for non-owner creators.
 * Factory **owner / platform wallet is fee-waived** on-chain (`creationFeeDue(owner) == 0`).
 * Public RPCs rate-limit eth_call, so the UI uses these constants instead of reading on-chain.
 * Excess value is refunded by the factory.
 */
export const ARC_CREATION_FEE_WEI: bigint = (() => {
  const raw = process.env.NEXT_PUBLIC_ARC_CREATION_FEE_WEI
  if (raw != null && raw !== '' && /^\d+$/.test(raw)) return BigInt(raw)
  return 10n ** 18n // 1 USDC native (public creators)
})()

/** Factory owner / platform wallet — free Instant creates (matches on-chain owner). */
export const ARC_PLATFORM_WALLET = (process.env.NEXT_PUBLIC_ARC_PLATFORM_WALLET ??
  '0x2403099Bbe0D2D340e1F461d63614568711BB537') as Address

/** Creation fee for a given creator. Platform owner → 0; everyone else → ARC_CREATION_FEE_WEI. */
export function arcCreationFeeWeiFor(creator: string | undefined | null): bigint {
  if (!creator) return ARC_CREATION_FEE_WEI
  if (creator.toLowerCase() === ARC_PLATFORM_WALLET.toLowerCase()) return 0n
  return ARC_CREATION_FEE_WEI
}

/** Same rule as the RPC: no testnet explorer fallback once off the testnet chain id. */
export const ARC_EXPLORER =
  process.env.NEXT_PUBLIC_ARC_EXPLORER ||
  (ARC_IS_TESTNET ? ARC_TESTNET_EXPLORER : ARC_MAINNET_CHAIN_ID === ARC_CHAIN_ID ? 'https://arcscan.app' : '')

const ZERO = '0x0000000000000000000000000000000000000000' as Address

/** Verified Uniswap V3 deployment on Arc mainnet (probed 2026-08-02). */
export const ARC_UNI_V3 = {
  FACTORY: '0xf0db7b58379503491d857dB50AC9ece64c653918' as Address,
  NFPM: '0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377' as Address,
  SWAP_ROUTER02: '0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77' as Address,
  QUOTER: '0x7DfD4F31be6814D2906BDE155c3e1B146EAc1468' as Address,
  WETH9: '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f' as Address,
  /** Default Instant pool fee tier (1%). */
  POOL_FEE: 10_000 as const,
} as const

/**
 * Product docs often describe Arc gas as "USDC 6dp"; the EVM native `msg.value` path is still
 * 1e18-scaled. We expose `nativeCurrency.decimals = 18` for viem/wallet_addEthereumChain.
 */
export const arcChain = defineChain({
  id: ARC_CHAIN_ID,
  name: ARC_IS_TESTNET ? 'Arc Testnet' : 'Arc',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ARC_RPC ? [ARC_RPC] : [] } },
  ...(ARC_EXPLORER
    ? {
        blockExplorers: {
          default: { name: ARC_IS_TESTNET ? 'ArcScan Testnet' : 'ArcScan', url: ARC_EXPLORER },
        },
      }
    : {}),
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
})

export const ARC = {
  /**
   * ERC-20 interface for USDC (6dp) — quote asset for Instant + RobinSwap.
   * Same economic balance as native gas at 1e12 ratio (6dp ↔ 18dp).
   */
  USDC_ERC20: (process.env.NEXT_PUBLIC_ARC_USDC ??
    '0x3600000000000000000000000000000000000000') as Address,
  /** Alias used by EvmChainConfig.usdc slot. */
  USDC: (process.env.NEXT_PUBLIC_ARC_USDC ??
    '0x3600000000000000000000000000000000000000') as Address,

  /** Uni WETH9 on Arc (router WETH9()). Env override if redeployed. */
  WETH: (process.env.NEXT_PUBLIC_ARC_WETH ?? ARC_UNI_V3.WETH9) as Address,
  WNATIVE: (process.env.NEXT_PUBLIC_ARC_WETH ?? ARC_UNI_V3.WETH9) as Address,
  /** @deprecated Use WETH — historical WUSDC name from pre-Uni Arc plan. */
  WUSDC: (process.env.NEXT_PUBLIC_ARC_WETH ?? process.env.NEXT_PUBLIC_ARC_WUSDC ?? ARC_UNI_V3.WETH9) as Address,

  // ── Canonical Uniswap V3 (graduation + Instant + RobinSwap venue) ───────────
  UNI_FACTORY: (process.env.NEXT_PUBLIC_ARC_UNI_FACTORY ?? ARC_UNI_V3.FACTORY) as Address,
  UNI_NFPM: (process.env.NEXT_PUBLIC_ARC_UNI_NFPM ??
    '0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377') as Address,
  UNI_ROUTER: (process.env.NEXT_PUBLIC_ARC_UNI_ROUTER ??
    '0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77') as Address,
  UNI_QUOTER: (process.env.NEXT_PUBLIC_ARC_UNI_QUOTER ??
    '0x7DfD4F31be6814D2906BDE155c3e1B146EAc1468') as Address,
  UNI_POOL_FEE: ARC_UNI_V3.POOL_FEE,

  /**
   * Launch token decimals for Arc Instant + bonding curve (LaunchToken18).
   * Quote USDC remains 6dp. Price math must use 18 token / 6 USDC raw ratio.
   */
  TOKEN_DECIMALS: 18 as const,
  /** Virtual token init (18dp) — matches ArcBondingCurveFactory / InstantErc20QuoteFactory. */
  VIRTUAL_TOKEN_INIT: 1_066_666_666_666_666_666_666_666_666n,
  /** Curve for-sale tokens (18dp). */
  CURVE_FOR_SALE: 800_000_000n * 10n ** 18n,

  // ── ArcFun Instant (LaunchToken18 · 5042) ───────────────────────────────────
  INSTANT_FACTORY: (process.env.NEXT_PUBLIC_ARC_INSTANT_FACTORY ??
    '0xd51E6217bb3bC7586866713854Ea75B7BefF1009') as Address,
  INSTANT_LOCKER: (process.env.NEXT_PUBLIC_ARC_INSTANT_LOCKER ??
    '0x84F486d7254aEDc89986bce392771D88bf5828EA') as Address,
  BPS_SOURCE: (process.env.NEXT_PUBLIC_ARC_BPS_SOURCE ??
    '0xFCF6Bf9A66AA167BfE4F6165bb04baEd97B6C2aE') as Address,

  // ── Instant Reflection (upgradeable; set after DeployInstantReflectionArc) ──
  REFLECTION_FACTORY: envAddr(process.env.NEXT_PUBLIC_ARC_REFLECTION_FACTORY, ZERO),
  REFLECTION_LOCKER: envAddr(process.env.NEXT_PUBLIC_ARC_REFLECTION_LOCKER, ZERO),

  // ── RobinSwap = fee router over Uni (not a private AMM) ─────────────────────
  FEE_ROUTER: (process.env.NEXT_PUBLIC_ARC_FEE_ROUTER ??
    '0x6795d7Ee7A83EfeDE1dedD96B86f0f6Efdabf088') as Address,
  /** Platform skim on RobinSwap path (bps). Contract is source of truth after deploy. */
  FEE_BPS: Number(process.env.NEXT_PUBLIC_ARC_FEE_BPS ?? 100),

  /**
   * @deprecated Private RobinSwap V3 fork — not the Arc product path.
   * Kept so old env keys don't crash imports; always ZERO for product UI.
   */
  ROBINSWAP_FACTORY: (process.env.NEXT_PUBLIC_ARC_ROBINSWAP_FACTORY ?? ZERO) as Address,
  ROBINSWAP_NFPM: (process.env.NEXT_PUBLIC_ARC_ROBINSWAP_NFPM ?? ZERO) as Address,
  ROBINSWAP_ROUTER: (process.env.NEXT_PUBLIC_ARC_ROBINSWAP_ROUTER ?? ZERO) as Address,
  ROBINSWAP_QUOTER: (process.env.NEXT_PUBLIC_ARC_ROBINSWAP_QUOTER ?? ZERO) as Address,

  /**
   * Arc USDC bonding-curve factory (LaunchToken18 → Uni V3 graduate).
   * DeployBondingCurveArc 2026-08-06.
   */
  FACTORY: envAddr(
    process.env.NEXT_PUBLIC_ARC_FACTORY,
    '0x36e600d7e85E82F34a64652A45710c046E78589b',
  ),
  /** Dedicated MonLock for curve graduations (Instant locker stays separate). */
  CURVE_LOCKER: envAddr(
    process.env.NEXT_PUBLIC_ARC_CURVE_LOCKER,
    '0xd0c5C466d430d52416B402608ef47FA286681A45',
  ),
} as const

export function arcRpcConfigured(): boolean {
  return ARC_RPC !== ''
}

/** True when Instant pad contracts are configured. */
export function arcInstantEnabled(): boolean {
  return arcRpcConfigured() && ARC.INSTANT_FACTORY !== ZERO && ARC.INSTANT_LOCKER !== ZERO
}

/** True when Instant Reflection factory is deployed and wired. */
export function arcReflectionEnabled(): boolean {
  return arcRpcConfigured() && ARC.REFLECTION_FACTORY !== ZERO && ARC.REFLECTION_LOCKER !== ZERO
}

/**
 * Arc USDC bonding curve — WITHDRAWN 2026-08-06. Instant DEX is the only Arc launch path.
 *
 * Hard-false rather than merely unconfigured, because ARC.FACTORY has a non-zero default baked in,
 * so the config check alone would keep the curve live. This is the single kill switch: the create
 * chooser, the create form, /api/arc/tokens, /api/arc/[token], and catalog resolution all read it,
 * so nothing can offer a curve launch while it returns false — including a hand-typed
 * `/bondingcurve/coins/create-arc?curve=1`.
 *
 * The contracts remain deployed and untouched. Set NEXT_PUBLIC_ARC_CURVE_ENABLED=1 to bring it
 * back (the chooser's Option element also needs restoring — see CreateChooserModal).
 */
export function arcCurveEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_ARC_CURVE_ENABLED !== '1') return false
  return arcRpcConfigured() && ARC.FACTORY !== ZERO
}

/**
 * True when RobinSwap can execute: Uni router known + optional fee router.
 * Fee router may be ZERO → UI should call SwapRouter02 directly (0% platform skim).
 */
export function arcRobinSwapEnabled(): boolean {
  return arcRpcConfigured() && ARC.UNI_ROUTER !== ZERO && ARC.UNI_QUOTER !== ZERO
}

/** Soft feature flag — off by default until env enables Arc UI. */
export function arcEnabled(): boolean {
  if (!arcRpcConfigured()) return false
  if (process.env.NEXT_PUBLIC_ARC_ENABLED === '0') return false
  if (process.env.NEXT_PUBLIC_ARC_ENABLED === '1') return true
  // Auto-on when Instant, curve, or Uni swap path is wired
  return arcInstantEnabled() || arcCurveEnabled() || arcRobinSwapEnabled()
}

/**
 * Ordered candidates for the server client: the private override first (if set and not banned),
 * then the same filtered public list ARC_RPC_URLS already built, deduped.
 *
 * ARC_SERVER_RPC alone is NOT this list — it is just `process.env.ARC_RPC || ARC_RPC`, i.e. the
 * private override with no fallback at all if that one URL fails. That gap is exactly what caused
 * every server-side Arc catalog build to return an empty [] silently: production runtime logs
 * (2026-08-07) show 7 occurrences of "project ID exceeded quota" on this exact path — the private
 * ARC_RPC env var points at the same quota-exhausted Infura project as NEXT_PUBLIC_ARC_RPC, and a
 * single-URL client has nowhere to go when it errors.
 */
const ARC_SERVER_RPC_CANDIDATES: string[] = (() => {
  const priv = process.env.ARC_RPC?.trim() || ''
  const seen = new Set<string>()
  const out: string[] = []
  for (const u of [priv, ...ARC_RPC_URLS]) {
    if (u && !isBannedArcRpc(u) && !seen.has(u)) {
      seen.add(u)
      out.push(u)
    }
  }
  return out
})()

const _clients: ReturnType<typeof createPublicClient>[] = []
export function arcPublicClient() {
  if (!_clients[0]) {
    const urls = ARC_SERVER_RPC_CANDIDATES.length ? ARC_SERVER_RPC_CANDIDATES : [ARC_SERVER_RPC]
    _clients[0] = createPublicClient({
      chain: arcChain,
      // A single transport with no fallback is how a quota-exhausted or dead RPC took down every
      // server-side Arc read at once. fallback() tries the next URL only when shouldThrow says
      // this error means "this endpoint is broken", not "the call itself failed" — an ordinary
      // revert or bad-input error should still surface immediately, not spend a round-trip on
      // every remaining candidate first.
      transport:
        urls.length > 1
          ? fallback(
              // retryCount: 0 per-transport — viem's http() default (3) would retry a quota-exceeded
              // or dead-node error three times before ever reaching the next candidate. That error
              // will not resolve on retry; the useful retry here is trying a DIFFERENT endpoint,
              // which is what fallback() itself does.
              urls.map((u) => http(u, { retryCount: 0 })),
              { shouldThrow: (error) => !isArcRpcInfraError(error) },
            )
          : http(urls[0]),
    })
  }
  return _clients[0]
}

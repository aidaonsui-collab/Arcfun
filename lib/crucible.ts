/**
 * Crucible product surface — quote-side 1% USDC fee splits, referral codes, mock Burn tape.
 *
 * Live locks may still be 70/30 (Meme) or 50/25/25 (Reflection). The numbers here are the
 * product splits. Do not treat them as on-chain until NEXT_PUBLIC_CRUCIBLE_ONCHAIN=1.
 */
export const FEE_BPS_DENOM = 10_000
/** Uniswap V3 pool fee on Instant launches (1%). */
export const SWAP_FEE_BPS = 100

export const BURN_ADDRESS = '0x000000000000000000000000000000000000dead' as const
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const

export const REFERRAL_ORIGIN = 'https://www.arcfun.co'
export const REF_COOKIE_KEY = 'arcfun_ref'
export const REF_STORAGE_KEY = 'arcfun_ref'
export const REF_CODE_STORAGE_KEY = 'arcfun_ref_code'
export const REF_STORAGE_AT_KEY = 'arcfun_ref_at'

/** Optional protocol token. Empty until an $ARCFUN address is wired. */
export const ARCFUN_TOKEN = (process.env.NEXT_PUBLIC_ARCFUN_TOKEN || '').trim()

/**
 * True only when lock contracts actually pay the Crucible / referrer / project-burn legs.
 * Default off — live pools still use the legacy bps below.
 */
export const CRUCIBLE_ONCHAIN = process.env.NEXT_PUBLIC_CRUCIBLE_ONCHAIN === '1'

export function usesLegacyOnChainSplits(): boolean {
  return !CRUCIBLE_ONCHAIN
}

export const CRUCIBLE_CONTRACTS_NOTE =
  'Live pools still split quote fees 70/30 (Meme) or 50/25/25 (Reflection). Crucible legs ship with the next lock contracts — this UI is the product surface, not a claim that current pools already pay Crucible.'

export type LaunchKind = 'meme' | 'reflect'
export type TradeSide = 'buy' | 'sell'

export type FeeLegId =
  | 'creator'
  | 'crucible'
  | 'projectBurn'
  | 'platform'
  | 'referrer'
  | 'holders'
  | 'tokenBurn'

export type FeeLeg = {
  id: FeeLegId
  label: string
  /** Share of the quote-side 1% USDC fee (10_000 = 100% of that fee). */
  bps: number
  /** Tailwind background class (chips). */
  swatch: string
  /** Hex for pie / bar charts. Distinct from Tolly stacked bars. */
  color: string
}

export type FeeSplitLeg = FeeLeg & { usdc: number; pct: number }

/** Product Meme split of the 1% USDC (quote) fee. Missing referrer falls into Crucible. */
export const MEME_FEE_LEGS: FeeLeg[] = [
  { id: 'creator', label: 'Creator', bps: 5_000, swatch: 'bg-lime', color: '#2f84db' },
  { id: 'crucible', label: 'Crucible', bps: 2_500, swatch: 'bg-lime-t', color: '#7ec0f7' },
  { id: 'projectBurn', label: 'Project burn', bps: 1_000, swatch: 'bg-coral', color: '#ff7a62' },
  { id: 'platform', label: 'Platform', bps: 1_000, swatch: 'bg-s3', color: '#9aa3b5' },
  { id: 'referrer', label: 'Referrer', bps: 500, swatch: 'bg-amber-500', color: '#f5b942' },
]

/** Product Reflect split of the 1% USDC (quote) fee. */
export const REFLECT_FEE_LEGS: FeeLeg[] = [
  { id: 'holders', label: 'Holders', bps: 2_000, swatch: 'bg-violet-500', color: '#a78bfa' },
  { id: 'crucible', label: 'Crucible', bps: 3_000, swatch: 'bg-lime-t', color: '#7ec0f7' },
  { id: 'creator', label: 'Creator', bps: 2_000, swatch: 'bg-lime', color: '#2f84db' },
  { id: 'projectBurn', label: 'Project burn', bps: 1_500, swatch: 'bg-coral', color: '#ff7a62' },
  { id: 'platform', label: 'Platform', bps: 1_000, swatch: 'bg-s3' },
  { id: 'referrer', label: 'Referrer', bps: 500, swatch: 'bg-amber-500' },
]

/** On-chain today (MonLock) — shown only as a "next" footnote, never as the product bar. */
export const LEGACY_MEME_FEE_LEGS: FeeLeg[] = [
  { id: 'creator', label: 'Creator', bps: 7_000, swatch: 'bg-lime', color: '#2f84db' },
  { id: 'platform', label: 'Platform', bps: 3_000, swatch: 'bg-s3', color: '#9aa3b5' },
]

export const LEGACY_REFLECT_FEE_LEGS: FeeLeg[] = [
  { id: 'holders', label: 'Holders', bps: 5_000, swatch: 'bg-violet-500', color: '#a78bfa' },
  { id: 'creator', label: 'Creator', bps: 2_500, swatch: 'bg-lime', color: '#2f84db' },
  { id: 'platform', label: 'Platform', bps: 2_500, swatch: 'bg-s3', color: '#9aa3b5' },
]

export const SELL_FEE_LEG: FeeLeg = {
  id: 'tokenBurn',
  label: 'Launch-token burn',
  bps: 10_000,
  swatch: 'bg-coral',
  color: '#ff7a62',
}

export function feeLegsFor(kind: LaunchKind): FeeLeg[] {
  return kind === 'reflect' ? REFLECT_FEE_LEGS : MEME_FEE_LEGS
}

export function quoteFeeFromNotional(notionalUsdc: number): number {
  if (!Number.isFinite(notionalUsdc) || notionalUsdc <= 0) return 0
  return (notionalUsdc * SWAP_FEE_BPS) / FEE_BPS_DENOM
}

/**
 * Split a USDC fee amount (already the 1% quote-side fee, not notionals) into labeled legs.
 * Remainder from rounding goes to Crucible (same destination as a missing referrer).
 */
export function splitUsdcFee(usdcFee: number, kind: LaunchKind): FeeSplitLeg[] {
  const legs = feeLegsFor(kind)
  if (!Number.isFinite(usdcFee) || usdcFee <= 0) {
    return legs.map((leg) => ({ ...leg, usdc: 0, pct: (leg.bps / FEE_BPS_DENOM) * 100 }))
  }
  const out: FeeSplitLeg[] = []
  let allocated = 0
  let crucibleIdx = -1
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]
    if (leg.id === 'crucible') crucibleIdx = i
    const usdc = (usdcFee * leg.bps) / FEE_BPS_DENOM
    allocated += usdc
    out.push({ ...leg, usdc, pct: (leg.bps / FEE_BPS_DENOM) * 100 })
  }
  const dust = usdcFee - allocated
  if (crucibleIdx >= 0 && Math.abs(dust) > 1e-12) {
    out[crucibleIdx] = { ...out[crucibleIdx], usdc: out[crucibleIdx].usdc + dust }
  }
  return out
}

/** Missing referrer — that 5% leg is folded into Crucible. */
export function foldMissingReferrer(legs: FeeSplitLeg[]): FeeSplitLeg[] {
  const ref = legs.find((l) => l.id === 'referrer')
  if (!ref) return legs
  return legs
    .filter((l) => l.id !== 'referrer')
    .map((l) =>
      l.id === 'crucible'
        ? { ...l, usdc: l.usdc + ref.usdc, bps: l.bps + ref.bps, pct: l.pct + ref.pct }
        : l,
    )
}

export function referralLink(code: string): string {
  return `${REFERRAL_ORIGIN}/r/${encodeURIComponent(code)}`
}

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/** Opaque short code — never a 0x address. Deterministic from a seed when provided. */
export function generateReferralCode(seed: string): string {
  let h = 2166136261
  const s = `arcfun-ref:${seed.trim().toLowerCase()}`
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  let n = h >>> 0
  let out = ''
  for (let i = 0; i < 8; i++) {
    out += CODE_ALPHABET[n % CODE_ALPHABET.length]
    n = Math.imul(n, 1664525) + 1013904223
    n >>>= 0
  }
  return out
}

export function sanitizeReferralCode(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/^0x[a-fA-F0-9]{40}$/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 32)
}

export function persistReferralCode(code: string): string | null {
  const cleaned = sanitizeReferralCode(code)
  if (!cleaned) return null
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(REF_STORAGE_KEY, cleaned)
      localStorage.setItem(REF_STORAGE_AT_KEY, String(Date.now()))
    }
  } catch {
    /* private mode */
  }
  try {
    if (typeof document !== 'undefined') {
      document.cookie = `${REF_COOKIE_KEY}=${encodeURIComponent(cleaned)};path=/;max-age=${30 * 24 * 3600};samesite=lax`
    }
  } catch {
    /* ignore */
  }
  return cleaned
}

export function getOrCreateReferralCode(wallet: string): string {
  try {
    const existing = typeof localStorage !== 'undefined' ? localStorage.getItem(REF_CODE_STORAGE_KEY) : null
    if (existing && sanitizeReferralCode(existing) === existing) return existing
  } catch {
    /* ignore */
  }
  const code = generateReferralCode(wallet || 'anon')
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(REF_CODE_STORAGE_KEY, code)
  } catch {
    /* ignore */
  }
  return code
}

export type CrucibleMelt = {
  id: string
  ts: number
  usdcIn: number
  arcfunBought: number
  arcfunBurned: number
  preview: boolean
}

export type CrucibleStats = {
  usdcIn: number
  arcfunBought: number
  arcfunAtDead: number
  burnedPct: number | null
  lastMelt: CrucibleMelt | null
  melts: CrucibleMelt[]
  preview: boolean
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Deterministic demo Burn tape until Crucible buy/burn events exist.
 * Always tagged `preview: true`.
 */
export function mockMeltFeed(nowMs = Date.now()): CrucibleMelt[] {
  const now = Math.floor(nowMs / 1000)
  const day = Math.floor(now / 86400)
  const rand = mulberry(0xc4c1b1e ^ day)
  const melts: CrucibleMelt[] = []
  let t = now - 68 * 3600
  for (let i = 0; i < 16; i++) {
    t += Math.floor(2.4 * 3600 + rand() * 4.6 * 3600)
    if (t > now - 90) break
    const usdcIn = Math.round((22 + rand() * 240) * 100) / 100
    const px = 0.012 + rand() * 0.01
    const bought = Math.round((usdcIn / px) * 100) / 100
    melts.push({
      id: `preview-${day}-${i}`,
      ts: t,
      usdcIn,
      arcfunBought: bought,
      arcfunBurned: bought,
      preview: true,
    })
  }
  return melts.sort((a, b) => b.ts - a.ts)
}

export function mockCrucibleStats(nowMs = Date.now(), burnedPctLive: number | null = null): CrucibleStats {
  const melts = mockMeltFeed(nowMs)
  const usdcIn = melts.reduce((s, m) => s + m.usdcIn, 0)
  const arcfunBought = melts.reduce((s, m) => s + m.arcfunBought, 0)
  const arcfunAtDead = melts.reduce((s, m) => s + m.arcfunBurned, 0)
  const supply = 1_000_000_000
  return {
    usdcIn,
    arcfunBought,
    arcfunAtDead,
    burnedPct: burnedPctLive != null ? burnedPctLive : (arcfunAtDead / supply) * 100,
    lastMelt: melts[0] ?? null,
    melts,
    preview: burnedPctLive == null,
  }
}

export function fmtBpsPct(bps: number): string {
  const pct = bps / 100
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`
}

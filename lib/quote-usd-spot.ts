/**
 * Client-side USD spot for Instant RWA first-buy / tape (cirBTC, XAUM, …).
 * Amounts are entered in USDC (dollars) then converted to quote raw at submit.
 */

export type QuoteUsdSpotPair = 'BTC-USD' | 'XAU-USD'

const CACHE_MS = 60_000
const cache = new Map<QuoteUsdSpotPair, { price: number; at: number }>()

const COINBASE: Record<QuoteUsdSpotPair, string> = {
  'BTC-USD': 'https://api.coinbase.com/v2/prices/BTC-USD/spot',
  'XAU-USD': 'https://api.coinbase.com/v2/prices/XAU-USD/spot',
}

/** Fallback when live spot is unavailable (virtual-quote seed only). */
export const SPOT_USD_FALLBACK: Record<QuoteUsdSpotPair, number> = {
  'BTC-USD': 100_000,
  'XAU-USD': 4_000,
}

export async function fetchQuoteUsdSpot(
  pair: QuoteUsdSpotPair,
  opts?: { force?: boolean },
): Promise<number | null> {
  const force = Boolean(opts?.force)
  const cached = cache.get(pair)
  if (!force && cached && Date.now() - cached.at < CACHE_MS) {
    return cached.price
  }
  const url = COINBASE[pair]
  if (!url) return force ? null : cached?.price ?? null
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) {
      return force ? null : cached?.price ?? null
    }
    const json = (await res.json()) as { data?: { amount?: string } }
    const price = Number(json?.data?.amount)
    if (!Number.isFinite(price) || price <= 0) {
      return force ? null : cached?.price ?? null
    }
    cache.set(pair, { price, at: Date.now() })
    return price
  } catch {
    return force ? null : cached?.price ?? null
  }
}

/** Convert USD dollars → quote human amount string for parseUnits. */
export function usdToSpotQuoteAmount(usd: number, spotUsd: number, decimals = 8): string {
  if (!(usd > 0) || !(spotUsd > 0)) return '0'
  const q = usd / spotUsd
  const dp = Math.min(Math.max(0, Math.floor(decimals)), 18)
  const fixed = q.toFixed(dp)
  return fixed.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '') || '0'
}

export function formatSpotQuoteApprox(usd: number, spotUsd: number | null | undefined): string | null {
  if (!(usd > 0) || !spotUsd || !(spotUsd > 0)) return null
  const q = usd / spotUsd
  const fixed =
    q >= 1 ? q.toFixed(4) : q >= 0.01 ? q.toFixed(6) : q.toFixed(8)
  return fixed.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '')
}

/** Quote human amount → USD. */
export function spotQuoteToUsd(quoteHuman: number, spotUsd: number | null | undefined): number {
  if (!(quoteHuman > 0) || !spotUsd || !(spotUsd > 0)) return 0
  const usd = quoteHuman * spotUsd
  return Number.isFinite(usd) && usd > 0 ? usd : 0
}

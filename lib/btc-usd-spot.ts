/**
 * Client-side BTC-USD spot for cirBTC first-buy UX.
 * Amounts are entered in USDC (dollars) then converted to cirBTC raw (8dp) at submit.
 */

const CACHE_MS = 60_000
let cached: { price: number; at: number } | null = null

const COINBASE_SPOT = 'https://api.coinbase.com/v2/prices/BTC-USD/spot'

export async function fetchBtcUsdSpot(opts?: { force?: boolean }): Promise<number | null> {
  const force = Boolean(opts?.force)
  if (!force && cached && Date.now() - cached.at < CACHE_MS) {
    return cached.price
  }
  try {
    const res = await fetch(COINBASE_SPOT, { cache: 'no-store' })
    if (!res.ok) {
      // Submit (force) must not silently reuse a stale spot for the tx.
      return force ? null : cached?.price ?? null
    }
    const json = (await res.json()) as { data?: { amount?: string } }
    const price = Number(json?.data?.amount)
    if (!Number.isFinite(price) || price <= 0) {
      return force ? null : cached?.price ?? null
    }
    cached = { price, at: Date.now() }
    return price
  } catch {
    // Display may use cache; force/submit path returns null so UI asks to retry.
    return force ? null : cached?.price ?? null
  }
}

/** Convert USD dollars → cirBTC human amount string (≤8 fractional digits) for parseUnits. */
export function usdToCirBtcAmount(usd: number, btcUsd: number): string {
  if (!(usd > 0) || !(btcUsd > 0)) return '0'
  const cir = usd / btcUsd
  // Fixed 8dp matches cirBTC decimals; trim trailing zeros for readability.
  const fixed = cir.toFixed(8)
  return fixed.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '') || '0'
}

export function formatCirBtcApprox(usd: number, btcUsd: number | null | undefined): string | null {
  if (!(usd > 0) || !btcUsd || !(btcUsd > 0)) return null
  const cir = usd / btcUsd
  const fixed =
    cir >= 1 ? cir.toFixed(4) : cir >= 0.01 ? cir.toFixed(6) : cir.toFixed(8)
  return fixed.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '')
}

/** cirBTC human amount → USD. */
export function cirBtcToUsd(cirBtc: number, btcUsd: number | null | undefined): number {
  if (!(cirBtc > 0) || !btcUsd || !(btcUsd > 0)) return 0
  const usd = cirBtc * btcUsd
  return Number.isFinite(usd) && usd > 0 ? usd : 0
}

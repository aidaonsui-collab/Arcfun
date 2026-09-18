/**
 * BTC-USD spot helpers (cirBTC). Prefer quote-usd-spot for multi-pair Instant quotes.
 */
import { fetchQuoteUsdSpot, formatSpotQuoteApprox, spotQuoteToUsd, usdToSpotQuoteAmount } from './quote-usd-spot'

export async function fetchBtcUsdSpot(opts?: { force?: boolean }): Promise<number | null> {
  return fetchQuoteUsdSpot('BTC-USD', opts)
}

export function usdToCirBtcAmount(usd: number, btcUsd: number): string {
  return usdToSpotQuoteAmount(usd, btcUsd, 8)
}

export function formatCirBtcApprox(usd: number, btcUsd: number | null | undefined): string | null {
  return formatSpotQuoteApprox(usd, btcUsd)
}

export function cirBtcToUsd(cirBtc: number, btcUsd: number | null | undefined): number {
  return spotQuoteToUsd(cirBtc, btcUsd)
}

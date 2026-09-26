/**
 * Quote-token chrome for home/token UI (marks, tints, pair chips).
 * Create/trade still use `arc-rwa-assets` for on-chain policy.
 */
export type QuoteKind = 'usdc' | 'mmf' | 'equity' | 'btc' | 'gold' | 'usdcat' | 'poll'

export type QuoteAsset = {
  id: string
  symbol: string
  kind: QuoteKind
  label: string
  mark: string | null
  tint: string
}

const MMF = new Set(['usyc', 'buidl', 'jaaa', 'jtrsy'])
const EQUITY = new Set(['crcl'])
const BTC = new Set(['cirbtc'])
const GOLD = new Set(['xaum'])

export const QUOTE_ASSETS: Record<string, QuoteAsset> = {
  usdc: { id: 'usdc', symbol: 'USDC', kind: 'usdc', label: 'USDC', mark: '/marks/usdc.png', tint: '110 184 232' },
  usyc: { id: 'usyc', symbol: 'USYC', kind: 'mmf', label: 'MMF', mark: '/marks/usyc.png', tint: '165 214 246' },
  buidl: { id: 'buidl', symbol: 'BUIDL', kind: 'mmf', label: 'MMF', mark: '/marks/buidl.png', tint: '210 218 228' },
  jaaa: { id: 'jaaa', symbol: 'JAAA', kind: 'mmf', label: 'MMF', mark: null, tint: '165 214 246' },
  jtrsy: { id: 'jtrsy', symbol: 'JTRSY', kind: 'mmf', label: 'MMF', mark: null, tint: '165 214 246' },
  crcl: { id: 'crcl', symbol: 'CRCL', kind: 'equity', label: 'Equity', mark: '/marks/crcl.svg', tint: '110 231 183' },
  cirbtc: { id: 'cirbtc', symbol: 'cirBTC', kind: 'btc', label: 'BTC', mark: '/marks/cirbtc.svg', tint: '247 168 90' },
  xaum: { id: 'xaum', symbol: 'XAUM', kind: 'gold', label: 'Gold', mark: '/marks/xaum.svg', tint: '212 185 110' },
  usdcat: {
    id: 'usdcat',
    symbol: 'USDCAT',
    kind: 'usdcat',
    label: 'USDCAT',
    mark: '/marks/usdcat.jpg',
    tint: '37 99 235',
  },
  poll: { id: 'poll', symbol: 'POLL', kind: 'poll', label: 'POLL', mark: null, tint: '124 58 237' },
}

export function quoteAsset(quote?: string | null): QuoteAsset {
  const id = (quote || 'USDC').toLowerCase()
  const known = QUOTE_ASSETS[id]
  if (known) return known
  const kind: QuoteKind = MMF.has(id)
    ? 'mmf'
    : EQUITY.has(id)
      ? 'equity'
      : BTC.has(id)
        ? 'btc'
        : GOLD.has(id)
          ? 'gold'
          : id === 'usdcat'
            ? 'usdcat'
            : 'usdc'
  const label =
    kind === 'usdc'
      ? 'USDC'
      : kind === 'mmf'
        ? 'MMF'
        : kind === 'equity'
          ? 'Equity'
          : kind === 'btc'
            ? 'BTC'
            : kind === 'usdcat'
              ? 'USDCAT'
              : 'Gold'
  return { id, symbol: quote || 'USDC', kind, label, mark: null, tint: '110 184 232' }
}

export function quoteKind(quote?: string | null): QuoteKind {
  return quoteAsset(quote).kind
}

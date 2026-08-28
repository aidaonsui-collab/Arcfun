/**
 * Parse an X mention into an Instant launch command. Pure — no I/O.
 *
 * Grammar (case-insensitive):
 *   (launch|create)  ["a token"]  NAME  ticker  TICKER  ["on arc"|"on base"]
 * Name ≤ 48 chars. Ticker 2–12 A–Z / 0–9. Optional chain suffix is ignored
 * (Arcfun always Instant-creates on Arc, never Base).
 */

export type BlitzLaunchCommand = { name: string; symbol: string }

const CMD =
  /\b(launch|create)(?:\s+a\s+token)?\s+(.+?)\s+ticker\s+([A-Za-z0-9]{2,12})\b/i

/** Well-known / phishing tickers the mention bot will not mint. */
const DENIED_TICKERS = [
  'USDC', 'USDT', 'USD', 'EURC', 'DAI', 'USDS', 'PYUSD', 'USD1', 'USDG',
  'ETH', 'WETH', 'BTC', 'WBTC', 'SOL', 'BNB',
  'ARCFUN', 'EVE', 'WATCH', 'TETHER', 'CIRCLE', 'XAUT', 'GOLD',
]

export function deniedTickers(): Set<string> {
  const extra = String(process.env.BLITZ_TICKER_DENY || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
  return new Set([...DENIED_TICKERS, ...extra])
}

export function isDeniedTicker(symbol: string, name?: string): boolean {
  const deny = deniedTickers()
  const sym = String(symbol || '').toUpperCase()
  if (sym && deny.has(sym)) return true
  const n = String(name || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  return Boolean(n && deny.has(n))
}

export function parseBlitzLaunchCommand(text: string): BlitzLaunchCommand | null {
  if (!text) return null
  const cleaned = String(text)
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/@\w+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const m = cleaned.match(CMD)
  if (!m) return null
  let name = m[2].trim()
  name = name.replace(/\s+on\s+(arc|base)\b/gi, ' ').replace(/\s+/g, ' ').trim()
  if (!name || name.length > 48) return null
  if (/[\u0000-\u001f]/.test(name)) return null
  const symbol = m[3].toUpperCase()
  if (!/^[A-Z0-9]{2,12}$/.test(symbol)) return null
  if (isDeniedTicker(symbol, name)) return null
  return { name, symbol }
}

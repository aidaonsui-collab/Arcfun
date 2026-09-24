/**
 * iMessage buy-bot intent grammar (docs/IMESSAGE_EVE_BUY_BOT.md, v1). $EVE only — no free-text
 * ticker resolution, so a typo can never become a buy of some other token.
 */
import { parseUnits } from 'viem'

export type Intent =
  | { kind: 'buy'; usdcIn: bigint }
  | { kind: 'yes' }
  | { kind: 'cancel' }
  | { kind: 'balance' }
  | { kind: 'link' }
  | { kind: 'help' }
  | { kind: 'reject'; reason: string }

const AMOUNT = String.raw`\$?(\d+(?:\.\d{1,6})?)`
const EVE = String.raw`\$?eve`
const BUY_PATTERNS = [
  new RegExp(String.raw`^buy\s+${AMOUNT}\s+(?:of\s+)?${EVE}$`, 'i'),
  new RegExp(String.raw`^buy\s+${EVE}\s+with\s+${AMOUNT}$`, 'i'),
]
const ANY_BUY = /^buy\b/i

export function parseIntent(raw: string): Intent {
  const text = raw.trim().replace(/\s+/g, ' ').replace(/[.!]+$/, '')
  const lower = text.toLowerCase()
  if (lower === 'yes') return { kind: 'yes' }
  if (lower === 'cancel') return { kind: 'cancel' }
  if (lower === 'balance' || lower === 'bal') return { kind: 'balance' }
  if (lower === 'link') return { kind: 'link' }

  for (const re of BUY_PATTERNS) {
    const m = text.match(re)
    if (!m) continue
    const usdcIn = parseUnits(m[1], 6)
    if (usdcIn <= 0n) return { kind: 'reject', reason: 'Amount must be more than $0.' }
    return { kind: 'buy', usdcIn }
  }
  if (ANY_BUY.test(text)) {
    return {
      kind: 'reject',
      reason: 'Only $EVE is supported, in plain dollars — e.g. "buy $5 of $eve".',
    }
  }
  return { kind: 'help' }
}

/**
 * Bounds for Upstash PAYG (10MB per command). A busy token's catch-up RPUSH or a
 * large holder-ledger HGETALL was getting the whole command rejected — Jessica then
 * retried the same oversized write on a 4s loop, which is the 10MB email.
 *
 * Kept free of next/server so node --test can import it.
 */

/** Trades per RPUSH. A full tape is TRADES_CAP (400); 50 JSON rows stays far under 10MB. */
export const KV_LIST_CHUNK = 50
/** Hash fields per HMGET/HSET. Transfer chunks can touch many addrs; 500 keys is still tiny. */
export const KV_HASH_FIELD_CHUNK = 500
/** HGETALL is one response of every field. Stay well under 10MB; bigger hashes HSCAN. */
export const HGETALL_SAFE_FIELDS = 8_000
/** HSCAN COUNT hint. Redis may return more or fewer; ~1000 field/value pairs per round trip. */
export const HSCAN_COUNT = 1_000

export function chunkArray<T>(items: T[], size: number): T[][] {
  const n = Math.max(1, size | 0)
  const out: T[][] = []
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n))
  return out
}

/** Newest `cap` items of an oldest→newest list. Empty/oversize cap returns a copy. */
export function cappedNewest<T>(items: T[], cap: number): T[] {
  if (cap <= 0) return []
  if (items.length <= cap) return items
  return items.slice(-cap)
}

/**
 * Inclusive LRANGE window for a newest-first page over an oldest→newest list.
 * `offset` skips that many of the newest rows. Null when the page is empty.
 */
export function tradeTapePageRange(
  total: number,
  offset: number,
  limit: number,
): { start: number; end: number } | null {
  if (!Number.isFinite(total) || !Number.isFinite(offset) || !Number.isFinite(limit)) return null
  if (total <= 0 || limit <= 0 || offset < 0) return null
  const end = total - offset - 1
  const start = Math.max(0, total - offset - limit)
  if (end < 0 || start > end) return null
  return { start, end }
}

function parseRawBalance(raw: string | number | undefined): bigint {
  try {
    const n = BigInt(String(raw ?? '0') || '0')
    return n > 0n ? n : 0n
  } catch {
    return 0n
  }
}

/** Fold a hash record (HGETALL / HMGET object) into address → raw balance, skipping zeros. */
export function ingestLedgerRecord(raw: Record<string, string | number>, out: Map<string, bigint>): void {
  for (const [addr, bal] of Object.entries(raw)) {
    const b = parseRawBalance(bal)
    if (b > 0n) out.set(addr, b)
  }
}

/** Fold HSCAN field/value pairs into address → raw balance, skipping zeros. */
export function ingestLedgerScanItems(items: Array<string | number>, out: Map<string, bigint>): void {
  for (let i = 0; i + 1 < items.length; i += 2) {
    const b = parseRawBalance(items[i + 1])
    if (b > 0n) out.set(String(items[i]), b)
  }
}

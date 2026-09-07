/**
 * Durable OHLCV history — Supabase Postgres, separate from the Vercel KV trade tape in
 * lib/arc-trades.ts.
 *
 * The KV tape is deliberately kept short (TRADES_CAP trades) for the token-page activity feed —
 * that's a "recent swaps" list, not chart history. Before this store existed, the chart shared
 * that same trimmed tape, so a token's candles could never reach further back than its last
 * TRADES_CAP swaps — e.g. EVE (17d old, high volume) only ever showed ~4 days on any timeframe.
 * This table is append-only and never trimmed: one row per (token, 1-minute bucket), forever.
 * Every coarser resolution the chart offers (5m/15m/1h/4h/1d/1w) is rolled up from these 1m rows
 * on read via the arc_candles_rollup() Postgres function — see the migration in this PR.
 *
 * First real wiring of Supabase into this repo — nothing here before this file. Configure via
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (server-only; never expose the service role key to the
 * browser). Every export in this file no-ops quietly when those aren't set, and never throws —
 * this store must be additive. A Postgres hiccup must never break the KV trade tape or the
 * existing chart fallback (buildCandles/fillCandleGaps over the live tape).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Address } from 'viem'
import type { Candle } from './candles'
import type { EvmTrade } from './evm-trades'

let cached: SupabaseClient | null | undefined

function supa(): SupabaseClient | null {
  if (cached !== undefined) return cached
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  cached = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null
  return cached
}

export function candleStoreConfigured(): boolean {
  return supa() !== null
}

const BUCKET_SEC = 60

type Row1m = {
  token: string
  ts: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/**
 * Fold freshly-scanned trades into the 1-minute table. Called from lib/arc-trades.ts's
 * persistTrades() with exactly the trades that just passed the KV seen-set dedupe — the same
 * "truly new" set the trade tape itself appends, so this store and the tape can never disagree
 * about what's new.
 *
 * Buckets a trade touches mid-cycle (its first print lands in one indexer tick, a later print in
 * the same 60s bucket lands in the next) are merged against whatever's already stored: `open`
 * never moves once a bucket exists, `high`/`low` widen, `close`/`volume` take the latest tick's
 * numbers since fresh trades are always chronologically newer than what's stored.
 */
export async function recordTrades1m(token: Address, trades: EvmTrade[]): Promise<void> {
  const db = supa()
  if (!db) return
  const priced = trades.filter((t) => t.ts > 0 && t.priceUsd > 0)
  if (priced.length === 0) return

  const tokenLc = token.toLowerCase()
  const buckets = new Map<
    number,
    { open: number; high: number; low: number; close: number; volume: number; firstTs: number; lastTs: number }
  >()
  for (const t of priced) {
    const bt = Math.floor(t.ts / BUCKET_SEC) * BUCKET_SEC
    const b = buckets.get(bt)
    if (!b) {
      buckets.set(bt, {
        open: t.priceUsd,
        high: t.priceUsd,
        low: t.priceUsd,
        close: t.priceUsd,
        volume: t.valueUsd,
        firstTs: t.ts,
        lastTs: t.ts,
      })
      continue
    }
    if (t.ts < b.firstTs) {
      b.open = t.priceUsd
      b.firstTs = t.ts
    }
    if (t.ts >= b.lastTs) {
      b.close = t.priceUsd
      b.lastTs = t.ts
    }
    b.high = Math.max(b.high, t.priceUsd)
    b.low = Math.min(b.low, t.priceUsd)
    b.volume += t.valueUsd
  }

  try {
    const tsList = [...buckets.keys()]
    const { data: existingRows, error: selErr } = await db
      .from('arc_candles_1m')
      .select('ts,open,high,low,close,volume')
      .eq('token', tokenLc)
      .in('ts', tsList)
    if (selErr) throw selErr

    const existing = new Map<number, Row1m>((existingRows ?? []).map((r) => [Number(r.ts), r as Row1m]))
    const merged: Row1m[] = tsList.map((ts) => {
      const fresh = buckets.get(ts)!
      const prev = existing.get(ts)
      if (!prev) {
        return { token: tokenLc, ts, open: fresh.open, high: fresh.high, low: fresh.low, close: fresh.close, volume: fresh.volume }
      }
      return {
        token: tokenLc,
        ts,
        open: prev.open,
        high: Math.max(prev.high, fresh.high),
        low: Math.min(prev.low, fresh.low),
        close: fresh.close,
        volume: prev.volume + fresh.volume,
      }
    })

    const { error: upErr } = await db.from('arc_candles_1m').upsert(merged, { onConflict: 'token,ts' })
    if (upErr) throw upErr
  } catch (e) {
    console.warn('[arc-candle-store] recordTrades1m', token, e instanceof Error ? e.message : e)
  }
}

/** Rolled-up candles for [fromTs, toTs] at bucketSec, ascending by time. Empty array (never
 *  throws) when the store isn't configured or the query fails — callers fall back to the live
 *  KV-tape path. */
export async function readCandlesRollup(
  token: Address,
  bucketSec: number,
  fromTs: number,
  toTs: number,
): Promise<Candle[]> {
  const db = supa()
  if (!db) return []
  try {
    const { data, error } = await db.rpc('arc_candles_rollup', {
      p_token: token.toLowerCase(),
      p_bucket_sec: bucketSec,
      p_from: fromTs,
      p_to: toTs,
    })
    if (error) throw error
    return ((data ?? []) as { bucket: number; open: number; high: number; low: number; close: number; volume: number }[]).map(
      (r) => ({ time: Number(r.bucket), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }),
    )
  } catch (e) {
    console.warn('[arc-candle-store] readCandlesRollup', token, e instanceof Error ? e.message : e)
    return []
  }
}

export interface BackfillState {
  token: string
  pool: string
  scannedUpToBlock: bigint
  done: boolean
}

export async function getBackfillState(token: Address): Promise<BackfillState | null> {
  const db = supa()
  if (!db) return null
  try {
    const { data, error } = await db
      .from('arc_candle_backfill_state')
      .select('token,pool,scanned_up_to_block,done')
      .eq('token', token.toLowerCase())
      .maybeSingle()
    if (error) throw error
    if (!data) return null
    return { token: data.token, pool: data.pool, scannedUpToBlock: BigInt(data.scanned_up_to_block), done: data.done }
  } catch (e) {
    console.warn('[arc-candle-store] getBackfillState', token, e instanceof Error ? e.message : e)
    return null
  }
}

export async function setBackfillState(
  token: Address,
  pool: Address,
  scannedUpToBlock: bigint,
  done: boolean,
): Promise<void> {
  const db = supa()
  if (!db) return
  try {
    const { error } = await db.from('arc_candle_backfill_state').upsert(
      {
        token: token.toLowerCase(),
        pool: pool.toLowerCase(),
        scanned_up_to_block: scannedUpToBlock.toString(),
        done,
      },
      { onConflict: 'token' },
    )
    if (error) throw error
  } catch (e) {
    console.warn('[arc-candle-store] setBackfillState', token, e instanceof Error ? e.message : e)
  }
}

/**
 * GET /api/arc/indexer/status — public health of the Arc event index.
 */
import { NextResponse } from 'next/server'
import {
  KvUnavailableError,
  countOrNull,
  loadState,
  tokenCount,
  otcOfferCount,
  kvConfigured,
  loadOtcDeskStats,
} from '@/lib/arc-indexer/store'

export const dynamic = 'force-dynamic'

export async function GET() {
  // Read-only endpoint: a KV read failure is reported, not thrown. Distinguishing "kv is
  // degraded right now" from "the index is genuinely empty" is the whole point — before this,
  // both rendered as tokenCount: 0 / factoryCursor: "0", which made intermittent Upstash
  // failures look exactly like a healthy-but-empty index.
  let state = null
  let stateError: string | null = null
  try {
    state = await loadState()
  } catch (e) {
    stateError = e instanceof KvUnavailableError ? e.message : String(e)
  }

  return NextResponse.json({
    ok: stateError == null,
    kvConfigured: kvConfigured(),
    kvDegraded: stateError != null,
    // null (not 0) when KV could not answer — 0 now unambiguously means "genuinely empty".
    tokenCount: await countOrNull(tokenCount),
    otcOfferCount: await countOrNull(otcOfferCount),
    deskStats: await loadOtcDeskStats(),
    state,
    ...(stateError ? { error: stateError } : {}),
  })
}

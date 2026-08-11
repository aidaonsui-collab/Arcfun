/**
 * GET /api/arc/indexer/status — public health of the Arc event index.
 */
import { NextResponse } from 'next/server'
import {
  loadState,
  tokenCount,
  otcOfferCount,
  kvConfigured,
} from '@/lib/arc-indexer/store'

export const dynamic = 'force-dynamic'

export async function GET() {
  const state = await loadState()
  return NextResponse.json({
    ok: true,
    kvConfigured: kvConfigured(),
    tokenCount: await tokenCount(),
    otcOfferCount: await otcOfferCount(),
    state,
  })
}

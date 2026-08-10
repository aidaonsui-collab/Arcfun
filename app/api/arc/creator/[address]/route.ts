/**
 * GET /api/arc/creator/[address] — public creator profile (tokens launched by wallet).
 */
import { NextResponse } from 'next/server'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { buildCreatorProfile } from '@/lib/arc-creator'
import { jsonSafe } from '@/lib/json-safe'
import { summarizeRpcError } from '@/lib/rpc-error'
import { arcInstantEnabled, arcCurveEnabled, arcReflectionEnabled } from '@/lib/contracts-arc'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  const raw = (address ?? '').trim()

  if (!isPlausibleEvmAddress(raw)) {
    return NextResponse.json({ ok: false, error: 'invalid address' }, { status: 400 })
  }

  if (!arcInstantEnabled() && !arcCurveEnabled() && !arcReflectionEnabled()) {
    return NextResponse.json(
      { ok: false, error: 'arc launchpad not configured' },
      { status: 404 },
    )
  }

  const url = new URL(req.url)
  const light = url.searchParams.get('light') === '1'
  const pnlRange = (url.searchParams.get('pnl') as '1D' | '1W' | '1M' | 'ALL') || '1W'

  try {
    const profile = await buildCreatorProfile(raw, {
      includeFees: !light,
      includePnl: !light,
      pnlRange: ['1D', '1W', '1M', 'ALL'].includes(pnlRange) ? pnlRange : '1W',
    })
    if (!profile) {
      return NextResponse.json({ ok: false, error: 'invalid address' }, { status: 400 })
    }
    return jsonSafe(
      { ok: true, profile },
      { headers: { 'Cache-Control': light ? 'public, s-maxage=15' : 'public, s-maxage=20, stale-while-revalidate=40' } },
    )
  } catch (e) {
    console.error('[api/arc/creator]', summarizeRpcError(e))
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}

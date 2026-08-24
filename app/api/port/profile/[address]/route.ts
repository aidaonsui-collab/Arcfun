import { NextResponse } from 'next/server'
import { getStudioProfile } from '@/lib/port/studio-profile'
import { jsonSafe } from '@/lib/json-safe'
import { summarizeRpcError } from '@/lib/rpc-error'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  try {
    const profile = await getStudioProfile(address)
    if (!profile) {
      return NextResponse.json({ ok: false, error: 'invalid address' }, { status: 400 })
    }
    return jsonSafe(
      { ok: true, profile },
      { headers: { 'Cache-Control': 'public, s-maxage=20, stale-while-revalidate=60' } },
    )
  } catch (e) {
    console.error('[api/port/profile]', summarizeRpcError(e))
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}

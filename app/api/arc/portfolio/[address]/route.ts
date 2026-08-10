/**
 * GET /api/arc/portfolio/[address] — holdings-facing portfolio summary.
 * Currently focuses on Instant Reflection USDC rewards for the wallet.
 */
import { NextResponse } from 'next/server'
import { getAddress, isAddress } from 'viem'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { fetchReflectionRewards } from '@/lib/arc-reflection-rewards'
import { jsonSafe } from '@/lib/json-safe'
import { summarizeRpcError } from '@/lib/rpc-error'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address: raw } = await params
  if (!isPlausibleEvmAddress(raw) || !isAddress(raw)) {
    return NextResponse.json({ ok: false, error: 'invalid address' }, { status: 400 })
  }

  try {
    const address = getAddress(raw)
    const rewards = await fetchReflectionRewards(address)
    return jsonSafe(
      {
        ok: true,
        portfolio: {
          address,
          usdcRewards: {
            claimable: rewards.claimableUsdc,
            earned: rewards.earnedUsdc,
            claimed: rewards.claimedUsdc,
            otherClaimable: rewards.otherClaimable,
          },
          reflectionLines: rewards.lines,
          tokensChecked: rewards.tokensChecked,
          at: rewards.at,
        },
      },
      { headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=30' } },
    )
  } catch (e) {
    console.error('[api/arc/portfolio]', summarizeRpcError(e))
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}

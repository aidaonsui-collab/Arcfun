/**
 * PUT /api/port/[address]/meta — collection owner updates off-chain banner (and optional image).
 */
import { NextRequest, NextResponse } from 'next/server'
import { isAddress, type Address } from 'viem'
import { isPlausibleEvmAddress } from '@/lib/evm-address'
import { collectionBannerEditMessage, verifyWalletAuth } from '@/lib/arc-auth'
import { setPortCollectionMeta } from '@/lib/port/meta'
import { PORT_FACTORY_ABI, PORT_NFT_ABI } from '@/lib/port/abi'
import { ARC, arcPublicClient } from '@/lib/contracts-arc'

export const dynamic = 'force-dynamic'

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address: pathAddr } = await params
  if (!isPlausibleEvmAddress(pathAddr)) {
    return NextResponse.json({ ok: false, error: 'invalid address' }, { status: 400 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    address?: string
    signature?: string
    timestamp?: number
    bannerUrl?: string
  }

  const collection = (body.address || pathAddr).trim()
  if (!isAddress(collection) || collection.toLowerCase() !== pathAddr.toLowerCase()) {
    return NextResponse.json({ ok: false, error: 'address mismatch' }, { status: 400 })
  }

  const client = arcPublicClient()
  let owner: Address
  try {
    const ok = await client.readContract({
      address: ARC.NFT_FACTORY,
      abi: PORT_FACTORY_ABI,
      functionName: 'isCollection',
      args: [collection as Address],
    })
    if (!ok) {
      return NextResponse.json({ ok: false, error: 'not an ArcStudio collection' }, { status: 404 })
    }
    owner = (await client.readContract({
      address: collection as Address,
      abi: PORT_NFT_ABI,
      functionName: 'owner',
    })) as Address
  } catch {
    return NextResponse.json({ ok: false, error: 'could not read collection owner' }, { status: 502 })
  }

  const timestamp = Number(body.timestamp)
  const checked = await verifyWalletAuth({
    address: owner,
    message: collectionBannerEditMessage(collection, timestamp),
    signature: body.signature || '',
    timestamp,
  })
  if (!checked.ok) {
    return NextResponse.json({ ok: false, error: checked.error }, { status: 401 })
  }

  const bannerUrl = typeof body.bannerUrl === 'string' ? body.bannerUrl.trim() : ''
  if (bannerUrl && !/^https?:\/\//i.test(bannerUrl)) {
    return NextResponse.json({ ok: false, error: 'banner must be an https URL' }, { status: 400 })
  }

  try {
    await setPortCollectionMeta(collection, { bannerUrl: bannerUrl || '' })
    return NextResponse.json({ ok: true, bannerUrl: bannerUrl || '' })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message || 'kv write failed' },
      { status: 500 },
    )
  }
}

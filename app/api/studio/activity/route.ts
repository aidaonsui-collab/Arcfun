import { NextRequest, NextResponse } from 'next/server'
import { isAddress, parseEventLogs, type Address, type Hex } from 'viem'
import { getActivity, getGlobalActivity, recordActivity } from '@/lib/port/market'
import { PORT_FACTORY_ABI, PORT_NFT_ABI } from '@/lib/port/abi'
import { ARC, arcPublicClient } from '@/lib/contracts-arc'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const collection = req.nextUrl.searchParams.get('collection') || ''
  const tokenId = req.nextUrl.searchParams.get('tokenId')
  if (!collection) {
    const activity = await getGlobalActivity(40)
    return NextResponse.json({ ok: true, activity })
  }
  if (!isAddress(collection)) {
    return NextResponse.json({ ok: false, error: 'collection required' }, { status: 400 })
  }
  const activity = await getActivity(collection, tokenId || undefined)
  return NextResponse.json({ ok: true, activity })
}

/** Client reports a mint or send tx. We only write after receipt + Minted / Transfer logs. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { collection?: string; txHash?: string } | null
  const collection = (body?.collection || '').trim()
  const txHash = (body?.txHash || '').trim() as Hex
  if (!isAddress(collection) || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return NextResponse.json({ ok: false, error: 'collection and txHash required' }, { status: 400 })
  }

  const client = arcPublicClient()
  try {
    const ok = await client.readContract({
      address: ARC.NFT_FACTORY,
      abi: PORT_FACTORY_ABI,
      functionName: 'isCollection',
      args: [collection as Address],
    })
    if (!ok) return NextResponse.json({ ok: false, error: 'not an ArcStudio collection' }, { status: 404 })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `could not reach factory: ${(e as Error).message.slice(0, 120)}` },
      { status: 502 },
    )
  }

  let receipt
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `could not read tx: ${(e as Error).message.slice(0, 120)}` },
      { status: 502 },
    )
  }
  if (receipt.status !== 'success') {
    return NextResponse.json({ ok: false, error: 'tx did not succeed' }, { status: 400 })
  }
  if (receipt.to && receipt.to.toLowerCase() !== collection.toLowerCase()) {
    return NextResponse.json({ ok: false, error: 'tx is not on this collection' }, { status: 400 })
  }

  const mintedLogs = parseEventLogs({
    abi: PORT_NFT_ABI,
    eventName: 'Minted',
    logs: receipt.logs,
  })
  const at = Date.now()
  let recorded = 0

  if (mintedLogs.length > 0) {
    for (const log of mintedLogs) {
      const { to, firstId, n, paid } = log.args
      const count = Number(n)
      if (!Number.isInteger(count) || count <= 0) continue
      const each = paid / n
      for (let i = 0; i < count; i++) {
        const tokenId = (firstId + BigInt(i)).toString()
        await recordActivity({
          type: 'mint',
          collection,
          tokenId,
          priceAtomic: each.toString(),
          from: to,
          orderHash: `${txHash}:${tokenId}`,
          txHash,
          at,
        })
        recorded += 1
      }
    }
    return NextResponse.json({ ok: true, recorded })
  }

  const xfers = parseEventLogs({
    abi: PORT_NFT_ABI,
    eventName: 'Transfer',
    logs: receipt.logs,
  })
  const zero = '0x0000000000000000000000000000000000000000'
  for (const log of xfers) {
    const from = log.args.from
    const to = log.args.to
    if (from.toLowerCase() === zero) continue
    const tokenId = log.args.tokenId.toString()
    await recordActivity({
      type: 'transfer',
      collection,
      tokenId,
      priceAtomic: '0',
      from,
      to,
      orderHash: `${txHash}:${tokenId}`,
      txHash,
      at,
    })
    recorded += 1
  }
  if (recorded === 0) {
    return NextResponse.json({ ok: false, error: 'no mint or transfer in tx' }, { status: 400 })
  }
  return NextResponse.json({ ok: true, recorded })
}

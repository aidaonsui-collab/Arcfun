/**
 * Read buyer/seller/tokenId from a Seaport receipt. Client-supplied buyer/tx fields are not trusted.
 */
import { parseEventLogs, zeroAddress, type Address, type Hex, type TransactionReceipt } from 'viem'
import { ItemType, SEAPORT_ABI, SEAPORT_ADDRESS } from './seaport'
import type { OrderKind } from './market'

const TX_RE = /^0x[a-fA-F0-9]{64}$/

export function isTxHash(v: unknown): v is Hex {
  return typeof v === 'string' && TX_RE.test(v)
}

function nftId(
  items: readonly { itemType: number; identifier: bigint }[] | undefined,
): string | null {
  const hit = items?.find(
    (i) => i.itemType === ItemType.ERC721 || i.itemType === ItemType.ERC721_WITH_CRITERIA,
  )
  return hit ? hit.identifier.toString() : null
}

export function readFillFromReceipt(
  receipt: TransactionReceipt,
  orderHash: string,
  kind: OrderKind | undefined,
): { from: Address; to: Address; tokenId: string | null } | null {
  if (receipt.status !== 'success') return null
  if (!receipt.to || receipt.to.toLowerCase() !== SEAPORT_ADDRESS.toLowerCase()) return null
  const logs = parseEventLogs({
    abi: SEAPORT_ABI,
    eventName: 'OrderFulfilled',
    logs: receipt.logs.filter((l) => l.address.toLowerCase() === SEAPORT_ADDRESS.toLowerCase()),
  })
  const hit = logs.find((l) => l.args.orderHash?.toLowerCase() === orderHash.toLowerCase())
  if (!hit) return null
  const offerer = hit.args.offerer as Address
  const recipient =
    hit.args.recipient && hit.args.recipient !== zeroAddress
      ? (hit.args.recipient as Address)
      : receipt.from
  const offerKind = kind === 'offer' || kind === 'collection-offer'
  // Listing: offerer sold the NFT, recipient received it.
  // Offer: offerer is the bidder; the fulfiller (tx.from) sold the NFT.
  const from = offerKind ? receipt.from : offerer
  const to = offerKind ? offerer : recipient
  const tokenId = offerKind ? nftId(hit.args.consideration) : nftId(hit.args.offer)
  return { from, to, tokenId }
}

export function readCancelFromReceipt(
  receipt: TransactionReceipt,
  orderHash: string,
  offerer: string,
): boolean {
  if (receipt.status !== 'success') return false
  if (!receipt.to || receipt.to.toLowerCase() !== SEAPORT_ADDRESS.toLowerCase()) return false
  const seaportLogs = receipt.logs.filter((l) => l.address.toLowerCase() === SEAPORT_ADDRESS.toLowerCase())
  const cancelled = parseEventLogs({
    abi: SEAPORT_ABI,
    eventName: 'OrderCancelled',
    logs: seaportLogs,
  })
  if (cancelled.some((l) => l.args.orderHash?.toLowerCase() === orderHash.toLowerCase())) return true
  const bumped = parseEventLogs({
    abi: SEAPORT_ABI,
    eventName: 'CounterIncremented',
    logs: seaportLogs,
  })
  return bumped.some((l) => l.args.offerer?.toLowerCase() === offerer.toLowerCase())
}

/**
 * Studio order-book policy. Seaport will settle whatever is signed; we only store orders that
 * match buildListing / buildOffer (USDC, factory collection, 2.5% + EIP-2981 split).
 */
import { zeroAddress, type Address } from 'viem'
import { ARC, arcPublicClient } from '@/lib/contracts-arc'
import { PORT_FACTORY_ABI, PORT_NFT_ABI } from './abi'
import {
  buildListing,
  buildOffer,
  CONDUIT_KEY,
  ItemType,
  localOrderHash,
  OrderType,
  orderKindOf,
  STUDIO_FEE_BPS,
  studioTreasury,
  type OrderComponents,
} from './seaport'

export type AcceptedOrder = {
  kind: 'listing' | 'offer' | 'collection-offer'
  nft: Address
  tokenId: string
  priceAtomic: bigint
}

function requireFixedAmounts(order: OrderComponents) {
  for (const item of [...order.offer, ...order.consideration]) {
    if (item.startAmount !== item.endAmount) {
      throw new Error('dutch / decaying orders are not accepted')
    }
  }
}

export async function assertAcceptedStudioOrder(order: OrderComponents): Promise<AcceptedOrder> {
  if (order.zone !== zeroAddress) throw new Error('zone must be empty')
  if (order.zoneHash !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
    throw new Error('zoneHash must be empty')
  }
  if (order.conduitKey !== CONDUIT_KEY) throw new Error('conduit must be Seaport itself')
  if (order.orderType !== OrderType.FULL_OPEN) throw new Error('only fully-open orders')
  requireFixedAmounts(order)

  const kind = orderKindOf(order)
  const nft = (kind === 'listing' ? order.offer[0]?.token : order.consideration[0]?.token) as Address
  if (!nft) throw new Error('empty order')

  const client = arcPublicClient()
  const isCol = await client.readContract({
    address: ARC.NFT_FACTORY,
    abi: PORT_FACTORY_ABI,
    functionName: 'isCollection',
    args: [nft],
  })
  if (!isCol) throw new Error('not an ArcStudio collection')

  const priceAtomic =
    kind === 'listing'
      ? order.consideration.reduce((a, i) => a + i.startAmount, 0n)
      : order.offer[0].startAmount

  const idForRoyalty =
    kind === 'collection-offer' ? 1n : kind === 'listing' ? order.offer[0].identifierOrCriteria : order.consideration[0].identifierOrCriteria
  const [royaltyReceiver, royaltyAmount] = (await client.readContract({
    address: nft,
    abi: PORT_NFT_ABI,
    functionName: 'royaltyInfo',
    args: [idForRoyalty, priceAtomic],
  })) as [Address, bigint]

  const expected =
    kind === 'listing'
      ? buildListing({
          collection: nft,
          tokenId: order.offer[0].identifierOrCriteria,
          priceAtomic,
          seller: order.offerer,
          royaltyReceiver,
          royaltyAmount,
          platformTreasury: studioTreasury(),
          counter: order.counter,
          startTime: order.startTime,
          endTime: order.endTime,
          salt: order.salt,
        })
      : buildOffer({
          collection: nft,
          tokenId: kind === 'collection-offer' ? 0n : order.consideration[0].identifierOrCriteria,
          priceAtomic,
          buyer: order.offerer,
          royaltyReceiver,
          royaltyAmount,
          platformTreasury: studioTreasury(),
          counter: order.counter,
          startTime: order.startTime,
          endTime: order.endTime,
          salt: order.salt,
        })

  if (localOrderHash(order) !== localOrderHash(expected)) {
    throw new Error(`order must include the ${STUDIO_FEE_BPS / 100}% studio fee and on-chain royalty`)
  }

  if (kind === 'listing' && order.offer[0].itemType !== ItemType.ERC721) {
    throw new Error('listings must offer one ERC-721')
  }

  const tokenId =
    kind === 'collection-offer'
      ? '0'
      : (kind === 'listing' ? order.offer[0].identifierOrCriteria : order.consideration[0].identifierOrCriteria).toString()

  return { kind, nft, tokenId, priceAtomic }
}

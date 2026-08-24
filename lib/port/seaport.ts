/**
 * Seaport 1.6 order construction for ArcStudio secondary trading on Arc.
 *
 * Seaport 1.6 is already deployed on Arc at its canonical address and is fully functional
 * (name "Seaport", version "1.6", conduitController wired) — but had never been used on this
 * chain, so this is the first integration. We do NOT deploy marketplace contracts: Seaport owns
 * escrow, matching and settlement, which is the part you never want to write yourself.
 *
 * Domain is VERIFIED, not assumed: keccak(EIP712Domain typehash, keccak"Seaport", keccak"1.6",
 * 5042, 0x0000…B395) reproduces the live information().domainSeparator
 * 0xd08c3bd74d9035369a65b4edfd3a1274787d548e39708c880c165a248aa0ee7a exactly. The order-type
 * hashes are checked the same way, against Seaport's own getOrderHash() — see verifyOrderHash().
 *
 * conduitKey is bytes32(0) on purpose: that routes transfers through Seaport itself, so a seller
 * approves the Seaport address directly and we don't have to deploy and own a Conduit. Revisit
 * only if we want one approval shared across venues.
 */
import { type Address, type Hex, encodeAbiParameters, keccak256, zeroAddress } from 'viem'
import { ARC } from '@/lib/contracts-arc'

export const SEAPORT_ADDRESS = '0x0000000000000068F116a894984e2DB1123eB395' as Address
export const SEAPORT_VERSION = '1.6'
export const ARC_CHAIN = 5042
/** bytes32(0) → transfers route through Seaport itself (no Conduit to deploy or own). */
export const CONDUIT_KEY = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

/** Seaport ItemType enum (SeaportEnums.sol). */
export const ItemType = {
  NATIVE: 0,
  ERC20: 1,
  ERC721: 2,
  ERC1155: 3,
  ERC721_WITH_CRITERIA: 4,
  ERC1155_WITH_CRITERIA: 5,
} as const

/** Seaport OrderType enum. FULL_OPEN = anyone may fill, no zone. */
export const OrderType = {
  FULL_OPEN: 0,
  PARTIAL_OPEN: 1,
  FULL_RESTRICTED: 2,
  PARTIAL_RESTRICTED: 3,
  CONTRACT: 4,
} as const

export type OfferItem = {
  itemType: number
  token: Address
  identifierOrCriteria: bigint
  startAmount: bigint
  endAmount: bigint
}

export type ConsiderationItem = OfferItem & { recipient: Address }

export type OrderComponents = {
  offerer: Address
  zone: Address
  offer: OfferItem[]
  consideration: ConsiderationItem[]
  orderType: number
  startTime: bigint
  endTime: bigint
  zoneHash: Hex
  salt: bigint
  conduitKey: Hex
  counter: bigint
}

export function seaportDomain() {
  return {
    name: 'Seaport',
    version: SEAPORT_VERSION,
    chainId: ARC_CHAIN,
    verifyingContract: SEAPORT_ADDRESS,
  } as const
}

/** Must match Seaport's typehash strings exactly — field order is part of the hash. */
export const SEAPORT_ORDER_TYPES = {
  OrderComponents: [
    { name: 'offerer', type: 'address' },
    { name: 'zone', type: 'address' },
    { name: 'offer', type: 'OfferItem[]' },
    { name: 'consideration', type: 'ConsiderationItem[]' },
    { name: 'orderType', type: 'uint8' },
    { name: 'startTime', type: 'uint256' },
    { name: 'endTime', type: 'uint256' },
    { name: 'zoneHash', type: 'bytes32' },
    { name: 'salt', type: 'uint256' },
    { name: 'conduitKey', type: 'bytes32' },
    { name: 'counter', type: 'uint256' },
  ],
  OfferItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
  ],
  ConsiderationItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
    { name: 'recipient', type: 'address' },
  ],
} as const

const OFFER_ITEM = [
  { name: 'itemType', type: 'uint8' },
  { name: 'token', type: 'address' },
  { name: 'identifierOrCriteria', type: 'uint256' },
  { name: 'startAmount', type: 'uint256' },
  { name: 'endAmount', type: 'uint256' },
] as const

const CONSIDERATION_ITEM = [...OFFER_ITEM, { name: 'recipient', type: 'address' }] as const

const ORDER_COMPONENTS = [
  { name: 'offerer', type: 'address' },
  { name: 'zone', type: 'address' },
  { name: 'offer', type: 'tuple[]', components: OFFER_ITEM },
  { name: 'consideration', type: 'tuple[]', components: CONSIDERATION_ITEM },
  { name: 'orderType', type: 'uint8' },
  { name: 'startTime', type: 'uint256' },
  { name: 'endTime', type: 'uint256' },
  { name: 'zoneHash', type: 'bytes32' },
  { name: 'salt', type: 'uint256' },
  { name: 'conduitKey', type: 'bytes32' },
  { name: 'counter', type: 'uint256' },
] as const

/** Same as ORDER_COMPONENTS but with counter replaced by totalOriginalConsiderationItems.
 *  Spelled out rather than sliced from ORDER_COMPONENTS — .slice() widens the literal tuple type
 *  and viem then still demands `counter`, which fulfillOrder does not take. */
const ORDER_PARAMETERS = [
  { name: 'offerer', type: 'address' },
  { name: 'zone', type: 'address' },
  { name: 'offer', type: 'tuple[]', components: OFFER_ITEM },
  { name: 'consideration', type: 'tuple[]', components: CONSIDERATION_ITEM },
  { name: 'orderType', type: 'uint8' },
  { name: 'startTime', type: 'uint256' },
  { name: 'endTime', type: 'uint256' },
  { name: 'zoneHash', type: 'bytes32' },
  { name: 'salt', type: 'uint256' },
  { name: 'conduitKey', type: 'bytes32' },
  { name: 'totalOriginalConsiderationItems', type: 'uint256' },
] as const

/**
 * Written as explicit JSON, not parseAbi(): Seaport's nested tuple[] signatures are deep enough
 * that abitype's human-readable parser mis-parses them ("Unbalanced parentheses") and silently
 * produces a broken ABI rather than failing loudly.
 */
export const SEAPORT_ABI = [
  { type: 'function', name: 'getCounter', stateMutability: 'view',
    inputs: [{ name: 'offerer', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getOrderHash', stateMutability: 'view',
    inputs: [{ name: 'order', type: 'tuple', components: ORDER_COMPONENTS }],
    outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'getOrderStatus', stateMutability: 'view',
    inputs: [{ name: 'orderHash', type: 'bytes32' }],
    outputs: [
      { name: 'isValidated', type: 'bool' }, { name: 'isCancelled', type: 'bool' },
      { name: 'totalFilled', type: 'uint256' }, { name: 'totalSize', type: 'uint256' },
    ] },
  { type: 'function', name: 'fulfillOrder', stateMutability: 'payable',
    inputs: [
      { name: 'order', type: 'tuple', components: [
        { name: 'parameters', type: 'tuple', components: ORDER_PARAMETERS },
        { name: 'signature', type: 'bytes' },
      ] },
      { name: 'fulfillerConduitKey', type: 'bytes32' },
    ],
    outputs: [{ name: 'fulfilled', type: 'bool' }] },
  { type: 'function', name: 'cancel', stateMutability: 'nonpayable',
    inputs: [{ name: 'orders', type: 'tuple[]', components: ORDER_COMPONENTS }],
    outputs: [{ name: 'cancelled', type: 'bool' }] },
  { type: 'function', name: 'fulfillAdvancedOrder', stateMutability: 'payable',
    inputs: [
      { name: 'advancedOrder', type: 'tuple', components: [
        { name: 'parameters', type: 'tuple', components: ORDER_PARAMETERS },
        { name: 'numerator', type: 'uint120' },
        { name: 'denominator', type: 'uint120' },
        { name: 'signature', type: 'bytes' },
        { name: 'extraData', type: 'bytes' },
      ] },
      { name: 'criteriaResolvers', type: 'tuple[]', components: [
        { name: 'orderIndex', type: 'uint256' },
        { name: 'side', type: 'uint8' },
        { name: 'index', type: 'uint256' },
        { name: 'identifier', type: 'uint256' },
        { name: 'criteriaProof', type: 'bytes32[]' },
      ] },
      { name: 'fulfillerConduitKey', type: 'bytes32' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [{ name: 'fulfilled', type: 'bool' }] },
] as const

/** Platform cut on secondary sales, in bps. */
export const STUDIO_FEE_BPS = 250

export type BuildListingArgs = {
  collection: Address
  tokenId: bigint
  /** Total the buyer pays, in atomic USDC (6dp). */
  priceAtomic: bigint
  seller: Address
  /** From the collection's EIP-2981 royaltyInfo(tokenId, priceAtomic). */
  royaltyReceiver: Address
  royaltyAmount: bigint
  platformTreasury: Address
  counter: bigint
  startTime: bigint
  endTime: bigint
  salt: bigint
}

/**
 * A fixed-price listing: offer 1 NFT, consider USDC split across seller / creator / platform.
 *
 * Seaport requires the consideration to sum to what the buyer pays, so seller proceeds are the
 * REMAINDER after royalty and fee — never price minus fees computed independently, which is how
 * marketplaces end up off by a wei and revert on fulfilment.
 *
 * Royalty is included because we choose to honour EIP-2981. Seaport does not enforce royalties;
 * they are only paid because this consideration item exists.
 */
export function buildListing(a: BuildListingArgs): OrderComponents {
  const fee = (a.priceAtomic * BigInt(STUDIO_FEE_BPS)) / 10_000n
  const royalty = a.royaltyAmount
  const toSeller = a.priceAtomic - fee - royalty
  if (toSeller <= 0n) throw new Error('price too low to cover royalty + platform fee')

  const usdc = ARC.USDC as Address
  const consideration: ConsiderationItem[] = [
    { itemType: ItemType.ERC20, token: usdc, identifierOrCriteria: 0n, startAmount: toSeller, endAmount: toSeller, recipient: a.seller },
  ]
  if (royalty > 0n && a.royaltyReceiver !== zeroAddress) {
    consideration.push({ itemType: ItemType.ERC20, token: usdc, identifierOrCriteria: 0n, startAmount: royalty, endAmount: royalty, recipient: a.royaltyReceiver })
  }
  if (fee > 0n) {
    consideration.push({ itemType: ItemType.ERC20, token: usdc, identifierOrCriteria: 0n, startAmount: fee, endAmount: fee, recipient: a.platformTreasury })
  }

  return {
    offerer: a.seller,
    zone: zeroAddress,
    offer: [
      { itemType: ItemType.ERC721, token: a.collection, identifierOrCriteria: a.tokenId, startAmount: 1n, endAmount: 1n },
    ],
    consideration,
    orderType: OrderType.FULL_OPEN,
    startTime: a.startTime,
    endTime: a.endTime,
    zoneHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    salt: a.salt,
    conduitKey: CONDUIT_KEY,
    counter: a.counter,
  }
}

export type BuildOfferArgs = {
  collection: Address
  /** Omit or 0n for a collection-wide offer (any token). */
  tokenId?: bigint
  priceAtomic: bigint
  buyer: Address
  royaltyReceiver: Address
  royaltyAmount: bigint
  platformTreasury: Address
  counter: bigint
  startTime: bigint
  endTime: bigint
  salt: bigint
}

/**
 * Buyer bid: offer USDC, consider the NFT (or any NFT in the collection).
 *
 * Seaport sends offer items to the fulfiller first, then pulls consideration from the
 * fulfiller. Royalty + studio fee are extra USDC consideration, so they come out of the
 * USDC the seller just received — the buyer still only signs and approves `priceAtomic`.
 */
export function buildOffer(a: BuildOfferArgs): OrderComponents {
  const fee = (a.priceAtomic * BigInt(STUDIO_FEE_BPS)) / 10_000n
  const royalty = a.royaltyAmount
  if (a.priceAtomic - fee - royalty <= 0n) throw new Error('price too low to cover royalty + platform fee')

  const usdc = ARC.USDC as Address
  const collectionWide = !a.tokenId || a.tokenId === 0n
  const nftItem: ConsiderationItem = {
    itemType: collectionWide ? ItemType.ERC721_WITH_CRITERIA : ItemType.ERC721,
    token: a.collection,
    identifierOrCriteria: collectionWide ? 0n : a.tokenId!,
    startAmount: 1n,
    endAmount: 1n,
    recipient: a.buyer,
  }
  const consideration: ConsiderationItem[] = [nftItem]
  if (royalty > 0n && a.royaltyReceiver !== zeroAddress) {
    consideration.push({
      itemType: ItemType.ERC20, token: usdc, identifierOrCriteria: 0n,
      startAmount: royalty, endAmount: royalty, recipient: a.royaltyReceiver,
    })
  }
  if (fee > 0n) {
    consideration.push({
      itemType: ItemType.ERC20, token: usdc, identifierOrCriteria: 0n,
      startAmount: fee, endAmount: fee, recipient: a.platformTreasury,
    })
  }

  return {
    offerer: a.buyer,
    zone: zeroAddress,
    offer: [
      { itemType: ItemType.ERC20, token: usdc, identifierOrCriteria: 0n, startAmount: a.priceAtomic, endAmount: a.priceAtomic },
    ],
    consideration,
    orderType: OrderType.FULL_OPEN,
    startTime: a.startTime,
    endTime: a.endTime,
    zoneHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    salt: a.salt,
    conduitKey: CONDUIT_KEY,
    counter: a.counter,
  }
}

export function studioTreasury(): Address {
  return (process.env.NEXT_PUBLIC_ARC_PLATFORM_TREASURY ||
    '0x26bD491560b5175ee8bD1DA4998Fe260FfC413c9') as Address
}

export function orderKindOf(order: OrderComponents): 'listing' | 'offer' | 'collection-offer' {
  const offer0 = order.offer[0]
  const consid0 = order.consideration[0]
  if (offer0?.itemType === ItemType.ERC721) return 'listing'
  if (consid0?.itemType === ItemType.ERC721_WITH_CRITERIA) return 'collection-offer'
  return 'offer'
}

export function feePortion(priceAtomic: bigint, royaltyAmount: bigint): bigint {
  const fee = (priceAtomic * BigInt(STUDIO_FEE_BPS)) / 10_000n
  return fee + royaltyAmount
}

/** Shape fulfillOrder() wants: same fields, but counter replaced by totalOriginalConsiderationItems. */
export function toOrderParameters(o: OrderComponents) {
  const { counter: _counter, ...rest } = o
  return { ...rest, totalOriginalConsiderationItems: BigInt(o.consideration.length) }
}

/** Local EIP-712 struct hash — compared against Seaport's getOrderHash() to prove the types match. */
export function localOrderHash(o: OrderComponents): Hex {
  const offerTypeHash = keccak256(
    new TextEncoder().encode(
      'OfferItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)',
    ),
  )
  const considTypeHash = keccak256(
    new TextEncoder().encode(
      'ConsiderationItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)',
    ),
  )
  const orderTypeHash = keccak256(
    new TextEncoder().encode(
      'OrderComponents(address offerer,address zone,OfferItem[] offer,ConsiderationItem[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter)' +
        'ConsiderationItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)' +
        'OfferItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)',
    ),
  )
  const offerHashes = o.offer.map((i) =>
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
        [offerTypeHash, BigInt(i.itemType), i.token, i.identifierOrCriteria, i.startAmount, i.endAmount],
      ),
    ),
  )
  const considHashes = o.consideration.map((i) =>
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }],
        [considTypeHash, BigInt(i.itemType), i.token, i.identifierOrCriteria, i.startAmount, i.endAmount, i.recipient],
      ),
    ),
  )
  const concat = (hs: Hex[]) => keccak256(`0x${hs.map((h) => h.slice(2)).join('')}` as Hex)
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' },
        { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' },
        { type: 'bytes32' }, { type: 'uint256' },
      ],
      [
        orderTypeHash, o.offerer, o.zone, concat(offerHashes), concat(considHashes),
        BigInt(o.orderType), o.startTime, o.endTime, o.zoneHash, o.salt, o.conduitKey, o.counter,
      ],
    ),
  )
}

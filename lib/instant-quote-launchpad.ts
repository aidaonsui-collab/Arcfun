/**
 * InstantErc20QuoteFactory ABI — trimmed from Robinpad's `lib/instant-quote-launchpad.ts` to just
 * the ABI constant `lib/arc-instant-launchpad.ts` and `lib/arc-trades.ts` need. The upstream file
 * also builds RH4663 multi-quote (ETH/AAPL/GME/…) create calls via `lib/meme-quote-assets.ts` —
 * that's Robinhood-Chain-specific and not part of the Arc product surface, so it's dropped here.
 */
export const INSTANT_QUOTE_FACTORY_ABI = [
  {
    type: 'function',
    name: 'createTokenMemeInstantQuote',
    stateMutability: 'payable',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'symbol', type: 'string' },
      { name: 'firstBuyQuoteAmount', type: 'uint256' },
    ],
    outputs: [{ name: 'token', type: 'address' }],
  },
  {
    type: 'function',
    name: 'createTokenMemeInstantQuoteTo',
    stateMutability: 'payable',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'symbol', type: 'string' },
      { name: 'firstBuyQuoteAmount', type: 'uint256' },
      { name: 'creatorRewardsWallet', type: 'address' },
    ],
    outputs: [{ name: 'token', type: 'address' }],
  },
  {
    type: 'function',
    name: 'createTokenMemeInstantQuoteWithEth',
    stateMutability: 'payable',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'symbol', type: 'string' },
    ],
    outputs: [{ name: 'token', type: 'address' }],
  },
  {
    type: 'function',
    name: 'CREATION_FEE',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'quoteAcquisitionFee',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint24' }],
  },
  {
    type: 'function',
    name: 'allTokensLength',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allTokens',
    stateMutability: 'view',
    inputs: [{ name: 'i', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'launchVirtualQuote',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'QUOTE',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'quoteDecimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'poolFee',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint24' }],
  },
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'creator', type: 'address' },
          { name: 'uniPool', type: 'address' },
          { name: 'positionId', type: 'uint256' },
          { name: 'liquidity', type: 'uint128' },
          { name: 'tickLower', type: 'int24' },
          { name: 'tickUpper', type: 'int24' },
        ],
      },
    ],
  },
  {
    type: 'event',
    name: 'InstantQuoteTokenCreated',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'pool', type: 'address', indexed: false },
      { name: 'positionId', type: 'uint256', indexed: false },
    ],
  },
] as const

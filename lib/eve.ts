/**
 * $EVE buy/burn sink for @watch_eve Instant launches.
 * Creator LP USDC is stamped to EveBurn; a keeper cooks USDC → EVE → 0xdead.
 */
import type { Address, Abi } from 'viem'
import { getAddress, isAddress } from 'viem'

const ZERO = '0x0000000000000000000000000000000000000000' as Address

export const EVE_TOKEN = (process.env.NEXT_PUBLIC_EVE_TOKEN ||
  '0x19209E55049bc613c5cC8b66B7DF7824096e78CF') as Address

export const EVE_POOL_FEE = 10_000 as const

export function eveBurnAddress(): Address | null {
  const raw = (process.env.BLITZ_EVE_BURN || process.env.NEXT_PUBLIC_EVE_BURN || '').trim()
  if (!raw || !isAddress(raw)) return null
  const addr = getAddress(raw)
  return addr === ZERO ? null : addr
}

export const EVE_BURN_ABI = [
  {
    type: 'function',
    name: 'cook',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'minEveOut', type: 'uint256' },
    ],
    outputs: [{ name: 'eveOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'usdc',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'evePoolFee',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint24' }],
  },
] as const satisfies Abi

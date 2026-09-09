/**
 * HandlePay — per-X-handle creator-fee vaults on Arc.
 *
 * One HandlePay per handle, CREATE2-deployed by HandlePayFactory.
 * Instant create stamps the vault as creatorRewardsWallet so LP creator
 * fees accrue there; the handle owner claims via X OAuth + an EIP-712 voucher.
 *
 * Env: NEXT_PUBLIC_ARC_HANDLE_PAY_FACTORY — defaults to the live Arc factory.
 * Set to the zero address to hide the Wallet | X handle toggle.
 */
import { isAddress, keccak256, toBytes, type Address, type Hex } from 'viem'
import { arcPublicClient } from './contracts-arc'

/** Live HandlePayFactory on Arc 5042 (DeployHandlePayFactory, 2026-09-09). */
const HANDLE_PAY_FACTORY_LIVE = '0x0F9327627f2B6279d3130cAeB4D6e35283ae9fe5' as Address

export const HANDLE_PAY_FACTORY = (() => {
  const raw = (process.env.NEXT_PUBLIC_ARC_HANDLE_PAY_FACTORY || '').trim()
  if (raw && isAddress(raw)) return raw as Address
  return HANDLE_PAY_FACTORY_LIVE
})()

export function handlePayEnabled(): boolean {
  return !/^0x0+$/i.test(HANDLE_PAY_FACTORY)
}

/** CREATE2 deploy of an empty HandlePay is well under this. Skip public-RPC estimateGas. */
export const HANDLE_PAY_DEPLOY_GAS = 500_000n
/** Sweep native + one ERC-20. Skip public-RPC estimateGas. */
export const HANDLE_PAY_CLAIM_GAS = 250_000n

export const HANDLE_PAY_FACTORY_ABI = [
  {
    type: 'function',
    name: 'computeVault',
    stateMutability: 'view',
    inputs: [{ name: 'handleHash', type: 'bytes32' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'vaultOf',
    stateMutability: 'view',
    inputs: [{ name: 'handleHash', type: 'bytes32' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'deployVault',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'handleHash', type: 'bytes32' }],
    outputs: [{ name: 'vault', type: 'address' }],
  },
  {
    type: 'function',
    name: 'signer',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const

export const HANDLE_PAY_ABI = [
  {
    type: 'function',
    name: 'nonce',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'lastClaimAt',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'handleHash',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'recipient', type: 'address' },
      { name: 'tokens', type: 'address[]' },
      { name: 'sig', type: 'bytes' },
    ],
    outputs: [],
  },
] as const

/** Lowercase handle, no @ / URL. Empty if it is not a plausible X username. */
export function normaliseXHandle(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/.*(?:x\.com|twitter\.com)\//, '')
    .replace(/^@/, '')
    .replace(/[/?#].*$/, '')
    .trim()
  return /^[a-z0-9_]{1,15}$/.test(s) ? s : ''
}

/** keccak of the normalized handle — the CREATE2 salt AND identity. */
export function handleHashFor(rawHandle: string): Hex {
  return keccak256(toBytes(normaliseXHandle(rawHandle)))
}

/** Synthetic id the X OAuth start/verify flow carries for HandlePay claims. */
export const handlePayGiftId = (handle: string) => `handlepay:${normaliseXHandle(handle)}`

export async function computeHandlePayVault(rawHandle: string): Promise<Address | null> {
  if (!handlePayEnabled()) return null
  const handle = normaliseXHandle(rawHandle)
  if (!handle) return null
  try {
    return (await arcPublicClient().readContract({
      address: HANDLE_PAY_FACTORY,
      abi: HANDLE_PAY_FACTORY_ABI,
      functionName: 'computeVault',
      args: [handleHashFor(handle)],
    })) as Address
  } catch {
    return null
  }
}

export async function readHandlePayVaultOf(rawHandle: string): Promise<Address | null> {
  if (!handlePayEnabled()) return null
  const handle = normaliseXHandle(rawHandle)
  if (!handle) return null
  try {
    return (await arcPublicClient().readContract({
      address: HANDLE_PAY_FACTORY,
      abi: HANDLE_PAY_FACTORY_ABI,
      functionName: 'vaultOf',
      args: [handleHashFor(handle)],
    })) as Address
  } catch {
    return null
  }
}

/** EIP-712 typed data a claim voucher signs — mirrors HandlePay.claim's digest. */
export function handlePayClaimTypedData(
  chainId: number,
  vault: Address,
  recipient: Address,
  nonce: bigint,
) {
  return {
    domain: { name: 'HandlePay', version: '1', chainId, verifyingContract: vault },
    types: { Claim: [{ name: 'recipient', type: 'address' }, { name: 'nonce', type: 'uint256' }] },
    primaryType: 'Claim' as const,
    message: { recipient, nonce },
  }
}



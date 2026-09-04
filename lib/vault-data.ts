/**
 * Eve Vault board copy. UI only.
 * No fee routing, no vault contract, no keeper. Do not treat preview figures as live.
 */

export const VAULT_NETWORK = {
  name: 'Arc',
  chainId: 5042,
  windowLabel: 'Circle mainnet window',
  windowDate: '2026-09-16T00:00:00.000Z',
} as const

export const VAULT = {
  name: 'Eve Vault',
  shareSymbol: 'eveRWA',
  standard: 'ERC-4626',
  status: 'stub' as const,
  live: false,
}

export type VaultRwaStatus = 'queued' | 'candidate'

export type VaultRwa = {
  id: string
  ticker: string
  name: string
  issuer: string
  kind: string
  status: VaultRwaStatus
  note: string
  expectedApy: number
  maxWeight: number
  letters: string
}

export const VAULT_RWAS: VaultRwa[] = [
  {
    id: 'buidl',
    ticker: 'BUIDL',
    name: 'BlackRock USD Institutional Digital Liquidity Fund',
    issuer: 'BlackRock / Securitize',
    kind: 'Tokenized T-bills',
    status: 'queued',
    note: 'First name on the original Eve Vault shell. Stays queued until Arc lists a public RWA market.',
    expectedApy: 4.12,
    maxWeight: 40,
    letters: 'BU',
  },
  {
    id: 'usyc',
    ticker: 'USYC',
    name: 'Hashnote Short Duration Yield',
    issuer: 'Hashnote / Circle',
    kind: 'Tokenized T-bills',
    status: 'queued',
    note: 'Circle-adjacent yield. Natural fit if it ships on Arc alongside USDC.',
    expectedApy: 4.05,
    maxWeight: 25,
    letters: 'US',
  },
  {
    id: 'ustb',
    ticker: 'USTB',
    name: 'Superstate Short Duration US Government Securities',
    issuer: 'Superstate',
    kind: 'Gov securities fund',
    status: 'candidate',
    note: 'Short-duration Treasuries. Candidate until an Arc market and oracle exist.',
    expectedApy: 3.94,
    maxWeight: 20,
    letters: 'ST',
  },
  {
    id: 'usdy',
    ticker: 'USDY',
    name: 'Ondo U.S. Dollar Yield',
    issuer: 'Ondo Finance',
    kind: 'Tokenized Treasuries',
    status: 'candidate',
    note: 'Permissioned in some venues. Listed here only as a curator candidate.',
    expectedApy: 4.28,
    maxWeight: 15,
    letters: 'ON',
  },
  {
    id: 'benji',
    ticker: 'BENJI',
    name: 'Franklin OnChain U.S. Government Money Fund',
    issuer: 'Franklin Templeton',
    kind: 'Gov money fund',
    status: 'candidate',
    note: 'Money-market exposure. Stays candidate until Arc listing and a vault cap.',
    expectedApy: 3.88,
    maxWeight: 15,
    letters: 'FT',
  },
]

export type VaultFlowKind = 'in' | 'hold' | 'route'

export type VaultFlowEvent = {
  id: string
  kind: VaultFlowKind
  source: string
  amount: number
  ago: string
}

/** Sample tape for the preview toggle only. Not indexed, not on-chain. */
export const VAULT_PREVIEW_FLOW: VaultFlowEvent[] = [
  { id: '1', kind: 'in', source: 'eve Instant', amount: 18.4, ago: '2m ago' },
  { id: '2', kind: 'in', source: 'Reflect Instant', amount: 4.12, ago: '14m ago' },
  { id: '3', kind: 'in', source: 'Arc Trencher Instant', amount: 2.05, ago: '1h ago' },
  { id: '4', kind: 'hold', source: 'USDC awaiting keeper', amount: 24.57, ago: 'queued' },
  { id: '5', kind: 'route', source: 'Projected BUIDL buy', amount: 24.57, ago: 'not live' },
  { id: '6', kind: 'in', source: 'Lazy Chameleon Instant', amount: 1.1, ago: '6h ago' },
  { id: '7', kind: 'in', source: 'internet money Instant', amount: 0.84, ago: '11h ago' },
]

export const VAULT_PREVIEW = {
  tvl: 128_400,
  usdcRouted: 41_220,
  rwaHeld: 0,
  lastDeposits: 26.51,
  pools: 5,
  active: 0,
}

export const VAULT_STEPS = [
  {
    n: '01',
    title: 'Instant fees settle as USDC',
    body: 'Eve Instant creator fees collect in USDC on Arc. Nothing is split differently. The vault only reads what Instant already pays.',
  },
  {
    n: '02',
    title: 'A keeper buys an approved RWA',
    body: 'When a public Arc RWA clears the curator list, a keeper buys it and deposits the position into a single ERC-4626 vault.',
  },
  {
    n: '03',
    title: 'Holdings print here',
    body: 'Vault TVL, share price, and RWA weights show on this board. Later, an optional slice can keep cooking $EVE instead of going out.',
  },
]

export const VAULT_STACK = [
  { label: 'Arc', detail: 'Settlement · chain 5042' },
  { label: 'USDC', detail: 'Instant creator proceeds' },
  { label: 'ERC-4626', detail: 'Single curated vault' },
  { label: 'Keeper', detail: 'Buys only approved RWAs' },
  { label: 'Circle window', detail: 'Public RWAs mid-Sep' },
]

export const VAULT_FLOW_LEGS = [
  { n: '01', title: 'Instant', body: 'Creator fees accrue as USDC on each Eve Instant launch.', live: true },
  { n: '02', title: 'Escrow', body: 'USDC sits idle. No split change. No keeper yet.', live: true },
  { n: '03', title: 'Yes', body: 'Arcfun signs routing. Caps, curator list, and the 4626 go live.', live: false },
  { n: '04', title: 'Keeper', body: 'Buys only approved RWAs and deposits the lot into the vault.', live: false },
  { n: '05', title: 'Board', body: 'TVL, weights, and your share print here. Unwind is a redeem.', live: false },
]

export function projectedVault(monthlyFees: number, eveSlicePct: number) {
  const toEve = monthlyFees * (eveSlicePct / 100)
  const toVault = monthlyFees - toEve
  const apy = 0.0412
  const yearly = toVault * 12
  const yieldYear = yearly * apy
  const months = Array.from({ length: 13 }, (_, i) => {
    const deposited = toVault * i
    const grown = deposited * Math.pow(1 + apy / 12, i)
    return { month: i, value: i === 0 ? 0 : grown }
  })
  return { toEve, toVault, yearly, yieldYear, apy, months }
}

export function formatVaultUsd(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return '$0'
  return n.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })
}

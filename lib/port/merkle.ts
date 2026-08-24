/**
 * Merkle tree matching OpenZeppelin MerkleProof (commutative keccak pair + double-hashed address leaf).
 * Leaf = keccak256(keccak256(abi.encode(address)))
 */
import {
  concat,
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  type Address,
  type Hex,
} from 'viem'

export function allowlistLeaf(addr: Address): Hex {
  const inner = keccak256(encodeAbiParameters([{ type: 'address' }], [getAddress(addr)]))
  return keccak256(inner)
}

function hashPair(a: Hex, b: Hex): Hex {
  return a.toLowerCase() < b.toLowerCase() ? keccak256(concat([a, b])) : keccak256(concat([b, a]))
}

export function parseWallets(text: string): Address[] {
  const seen = new Set<string>()
  const out: Address[] = []
  for (const raw of text.split(/[\s,;]+/)) {
    const t = raw.trim().replace(/^["']|["']$/g, '')
    if (!t || t.toLowerCase() === 'address' || t.toLowerCase() === 'wallet') continue
    if (!isAddress(t)) continue
    const a = getAddress(t)
    const k = a.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(a)
  }
  return out
}

export function buildAllowlist(wallets: string[]): { root: Hex; leaves: Hex[]; sorted: Address[] } {
  const sorted = parseWallets(wallets.join('\n')).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  const leaves = sorted.map(allowlistLeaf)
  if (leaves.length === 0) {
    return {
      root: '0x0000000000000000000000000000000000000000000000000000000000000000',
      leaves: [],
      sorted: [],
    }
  }
  let layer = leaves
  while (layer.length > 1) {
    const next: Hex[] = []
    for (let i = 0; i < layer.length; i += 2) {
      if (i + 1 >= layer.length) next.push(layer[i])
      else next.push(hashPair(layer[i], layer[i + 1]))
    }
    layer = next
  }
  return { root: layer[0], leaves, sorted }
}

export function allowlistProof(wallets: string[], wallet: string): Hex[] {
  if (!isAddress(wallet)) return []
  const { leaves, sorted } = buildAllowlist(wallets)
  const idx = sorted.findIndex((a) => a.toLowerCase() === getAddress(wallet).toLowerCase())
  if (idx < 0) return []
  const proof: Hex[] = []
  let index = idx
  let layer = leaves
  while (layer.length > 1) {
    const sibling = index % 2 === 0 ? index + 1 : index - 1
    if (sibling < layer.length) proof.push(layer[sibling])
    const next: Hex[] = []
    for (let i = 0; i < layer.length; i += 2) {
      if (i + 1 >= layer.length) next.push(layer[i])
      else next.push(hashPair(layer[i], layer[i + 1]))
    }
    index = Math.floor(index / 2)
    layer = next
  }
  return proof
}

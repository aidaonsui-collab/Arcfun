import { type Address, zeroAddress } from 'viem'
import { ARC } from '@/lib/contracts-arc'

export function arcPortFactory(): Address {
  return ARC.NFT_FACTORY
}

export function arcPortEnabled() {
  const f = ARC.NFT_FACTORY
  return Boolean(f) && f !== zeroAddress
}

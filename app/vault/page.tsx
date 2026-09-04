import type { Metadata } from 'next'
import { VaultPageClient } from '@/components/vault/VaultPageClient'

export const revalidate = 60

export const metadata: Metadata = {
  title: 'Eve Vault · Arcfun',
  description:
    'When RWAs land on Arc, Eve creator rewards buy them into a vault. Stub only; no fees move yet.',
}

/**
 * Product stub only. No fee routing, no vault contract, no keeper.
 * Creator USDC still follows Instant / EveBurn / Crucible as today.
 */
export default function EveVaultPage() {
  return <VaultPageClient />
}

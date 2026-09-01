/**
 * Server wait for an Instant / Reflection create receipt.
 * Uses Infura-first RPC so we are not stuck on public nodes that hang TLS or lag receipts.
 */
import { parseEventLogs, type Address, type Hex, type TransactionReceipt } from 'viem'
import { INSTANT_QUOTE_FACTORY_ABI } from './instant-quote-launchpad'
import { INSTANT_REFLECTION_FACTORY_ABI } from './arc-reflection-launchpad'
import { arcReceiptClient } from './contracts-arc'

export type ArcCreateReceipt = {
  token: Address
  pool?: Address
  receipt: TransactionReceipt
}

export function parseArcCreateReceipt(receipt: TransactionReceipt): { token?: Address; pool?: Address } {
  const [instant] = parseEventLogs({
    abi: INSTANT_QUOTE_FACTORY_ABI,
    eventName: 'InstantQuoteTokenCreated',
    logs: receipt.logs,
  })
  if (instant?.args?.token) {
    return {
      token: instant.args.token as Address,
      pool: (instant.args.pool as Address | undefined) || undefined,
    }
  }
  const [reflection] = parseEventLogs({
    abi: INSTANT_REFLECTION_FACTORY_ABI,
    eventName: 'InstantReflectionCreated',
    logs: receipt.logs,
  })
  if (reflection?.args?.token) {
    return {
      token: reflection.args.token as Address,
      pool: (reflection.args.pool as Address | undefined) || undefined,
    }
  }
  return {}
}

export async function waitArcCreateReceipt(hash: Hex, timeoutMs = 25_000): Promise<ArcCreateReceipt> {
  const client = arcReceiptClient()
  const receipt = await client.waitForTransactionReceipt({
    hash,
    timeout: timeoutMs,
    pollingInterval: 800,
  })
  if (receipt.status === 'reverted') {
    throw new Error('Create transaction reverted')
  }
  const parsed = parseArcCreateReceipt(receipt)
  if (!parsed.token) {
    throw new Error('Token created, but InstantQuoteTokenCreated / InstantReflectionCreated was missing')
  }
  return { token: parsed.token, pool: parsed.pool, receipt }
}

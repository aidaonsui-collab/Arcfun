/**
 * Server wait for an Instant / Reflection create receipt.
 * Uses Infura-first RPC so we are not stuck on public nodes that hang TLS or lag receipts.
 */
import { parseEventLogs, type Address, type Hex, type TransactionReceipt } from 'viem'
import { INSTANT_QUOTE_FACTORY_ABI } from './instant-quote-launchpad'
import { INSTANT_REFLECTION_FACTORY_ABI } from './arc-reflection-launchpad'
import {
  EVE_INSTANT_V4_FACTORY_ABI,
  EVE_V4_TOKEN_LAUNCHED_DUAL_ABI,
  parseV4PoolId,
} from './eve-instant-v4-launchpad'
import { arcReceiptClient } from './contracts-arc'

export type ArcCreateReceipt = {
  token: Address
  pool?: Address
  poolId?: Hex
  receipt: TransactionReceipt
}

export function parseArcCreateReceipt(receipt: TransactionReceipt): {
  token?: Address
  pool?: Address
  poolId?: Hex
} {
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
  for (const abi of [EVE_V4_TOKEN_LAUNCHED_DUAL_ABI, EVE_INSTANT_V4_FACTORY_ABI]) {
    const [v4] = parseEventLogs({
      abi,
      eventName: 'TokenLaunched',
      logs: receipt.logs,
    })
    if (v4?.args?.token) {
      return {
        token: v4.args.token as Address,
        poolId: parseV4PoolId(v4.args.id),
      }
    }
  }
  return {}
}

export async function waitArcMinedReceipt(hash: Hex, timeoutMs = 25_000): Promise<TransactionReceipt> {
  const client = arcReceiptClient()
  const receipt = await client.waitForTransactionReceipt({
    hash,
    timeout: timeoutMs,
    pollingInterval: 800,
  })
  if (receipt.status === 'reverted') {
    throw new Error('Transaction reverted')
  }
  return receipt
}

export async function waitArcCreateReceipt(hash: Hex, timeoutMs = 25_000): Promise<ArcCreateReceipt> {
  const receipt = await waitArcMinedReceipt(hash, timeoutMs)
  const parsed = parseArcCreateReceipt(receipt)
  if (!parsed.token) {
    throw new Error('Token created, but InstantQuoteTokenCreated / InstantReflectionCreated / TokenLaunched was missing')
  }
  return { token: parsed.token, pool: parsed.pool, poolId: parsed.poolId, receipt }
}

/**
 * Lightweight wallet auth for profile edits / follow — personal_sign + timestamp window.
 */
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from 'viem'

const MAX_SKEW_MS = 10 * 60 * 1000 // 10 minutes

export function profileEditMessage(address: string, timestamp: number): string {
  return [
    'Arcfun profile edit',
    `Address: ${getAddress(address)}`,
    'Action: update-profile',
    `Timestamp: ${timestamp}`,
  ].join('\n')
}

export function collectionBannerEditMessage(collection: string, timestamp: number): string {
  return [
    'ArcStudio collection edit',
    `Collection: ${getAddress(collection)}`,
    'Action: update-banner',
    `Timestamp: ${timestamp}`,
  ].join('\n')
}

export function followMessage(
  follower: string,
  target: string,
  action: 'follow' | 'unfollow',
  timestamp: number,
): string {
  return [
    'Arcfun social',
    `Follower: ${getAddress(follower)}`,
    `Target: ${getAddress(target)}`,
    `Action: ${action}`,
    `Timestamp: ${timestamp}`,
  ].join('\n')
}

export async function verifyWalletAuth(opts: {
  address: string
  message: string
  signature: string
  timestamp: number
}): Promise<{ ok: true; address: Address } | { ok: false; error: string }> {
  const { address, message, signature, timestamp } = opts
  if (!isAddress(address)) return { ok: false, error: 'invalid address' }
  if (!Number.isFinite(timestamp) || timestamp <= 0) return { ok: false, error: 'invalid timestamp' }
  const age = Math.abs(Date.now() - timestamp)
  if (age > MAX_SKEW_MS) return { ok: false, error: 'signature expired — sign again' }
  if (!signature || typeof signature !== 'string' || !signature.startsWith('0x')) {
    return { ok: false, error: 'invalid signature' }
  }
  try {
    const valid = await verifyMessage({
      address: getAddress(address) as Address,
      message,
      signature: signature as Hex,
    })
    if (!valid) return { ok: false, error: 'bad signature' }
    return { ok: true, address: getAddress(address) as Address }
  } catch {
    return { ok: false, error: 'signature verification failed' }
  }
}

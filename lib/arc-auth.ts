/**
 * Wallet auth for profile edits / collection writes — personal_sign.
 *
 * Collection edits bind a payload hash and a single-use nonce so a signature cannot be
 * replayed as a different write. Profile/follow keep the older timestamp-only messages.
 */
import { getAddress, isAddress, keccak256, stringToHex, verifyMessage, type Address, type Hex } from 'viem'

const MAX_SKEW_MS = 10 * 60 * 1000 // 10 minutes

export const AUTH_NONCE_RE = /^[0-9a-f]{32}$/i

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

export function hashPayload(value: unknown): Hex {
  return keccak256(stringToHex(stableStringify(value)))
}

export function newAuthNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function collectionEditMessage(opts: {
  collection: string
  action: string
  payloadHash: Hex
  nonce: string
  timestamp: number
}): string {
  return [
    'ArcStudio collection edit',
    `Collection: ${getAddress(opts.collection)}`,
    `Action: ${opts.action}`,
    `Payload: ${opts.payloadHash}`,
    `Nonce: ${opts.nonce.toLowerCase()}`,
    `Timestamp: ${opts.timestamp}`,
  ].join('\n')
}

export function tokenRegisterMessage(opts: {
  token: string
  payloadHash: Hex
  nonce: string
  timestamp: number
}): string {
  return [
    'ArcFun token register',
    `Token: ${getAddress(opts.token)}`,
    'Action: register-token',
    `Payload: ${opts.payloadHash}`,
    `Nonce: ${opts.nonce.toLowerCase()}`,
    `Timestamp: ${opts.timestamp}`,
  ].join('\n')
}

export function prepareCollectionAuth(collection: string, action: string, payload: unknown) {
  const timestamp = Date.now()
  const nonce = newAuthNonce()
  const payloadHash = hashPayload(payload)
  const message = collectionEditMessage({ collection, action, payloadHash, nonce, timestamp })
  return { timestamp, nonce, payloadHash, message }
}

export function prepareTokenRegisterAuth(token: string, payload: unknown) {
  const timestamp = Date.now()
  const nonce = newAuthNonce()
  const payloadHash = hashPayload(payload)
  const message = tokenRegisterMessage({ token, payloadHash, nonce, timestamp })
  return { timestamp, nonce, payloadHash, message }
}

export function authQuery(auth: { signature: string; timestamp: number; nonce: string }) {
  return new URLSearchParams({
    signature: auth.signature,
    timestamp: String(auth.timestamp),
    nonce: auth.nonce,
  }).toString()
}

export function profileEditMessage(address: string, timestamp: number): string {
  return [
    'Arcfun profile edit',
    `Address: ${getAddress(address)}`,
    'Action: update-profile',
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

export function parseAuthFields(body: {
  signature?: unknown
  timestamp?: unknown
  nonce?: unknown
}): { signature: string; timestamp: number; nonce: string } | { error: string } {
  const signature = typeof body.signature === 'string' ? body.signature : ''
  const timestamp = Number(body.timestamp)
  const nonce = typeof body.nonce === 'string' ? body.nonce.trim().toLowerCase() : ''
  if (!AUTH_NONCE_RE.test(nonce)) return { error: 'invalid nonce' }
  if (!Number.isFinite(timestamp) || timestamp <= 0) return { error: 'invalid timestamp' }
  if (!signature.startsWith('0x')) return { error: 'invalid signature' }
  return { signature, timestamp, nonce }
}

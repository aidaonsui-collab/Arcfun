/**
 * Server-only wallet auth: single-use nonce in KV. Do not import from client components.
 */
import { kv } from '@vercel/kv'
import { getAddress, type Address } from 'viem'
import {
  AUTH_NONCE_RE,
  collectionEditMessage,
  hashPayload,
  parseAuthFields,
  tokenRegisterMessage,
  verifyWalletAuth,
} from '@/lib/arc-auth'

const NONCE_TTL_SEC = 10 * 60

async function consumeAuthNonce(nonce: string): Promise<boolean> {
  if (!AUTH_NONCE_RE.test(nonce)) return false
  try {
    const ok = await kv.set(`arcfun:auth:nonce:${nonce.toLowerCase()}`, 1, { nx: true, ex: NONCE_TTL_SEC })
    return ok != null && ok !== 0
  } catch {
    return false
  }
}

export async function verifyCollectionAuth(opts: {
  owner: Address
  collection: string
  action: string
  payload: unknown
  signature: string
  timestamp: number
  nonce: string
}): Promise<{ ok: true; address: Address } | { ok: false; error: string }> {
  const payloadHash = hashPayload(opts.payload)
  const message = collectionEditMessage({
    collection: opts.collection,
    action: opts.action,
    payloadHash,
    nonce: opts.nonce,
    timestamp: opts.timestamp,
  })
  const checked = await verifyWalletAuth({
    address: opts.owner,
    message,
    signature: opts.signature,
    timestamp: opts.timestamp,
  })
  if (!checked.ok) return checked
  const used = await consumeAuthNonce(opts.nonce)
  if (!used) return { ok: false, error: 'signature already used — sign again' }
  return checked
}

export async function verifyTokenRegisterAuth(opts: {
  creator: Address
  token: string
  payload: unknown
  signature: string
  timestamp: number
  nonce: string
}): Promise<{ ok: true; address: Address } | { ok: false; error: string }> {
  const payloadHash = hashPayload(opts.payload)
  const message = tokenRegisterMessage({
    token: opts.token,
    payloadHash,
    nonce: opts.nonce,
    timestamp: opts.timestamp,
  })
  const checked = await verifyWalletAuth({
    address: opts.creator,
    message,
    signature: opts.signature,
    timestamp: opts.timestamp,
  })
  if (!checked.ok) return checked
  const used = await consumeAuthNonce(opts.nonce)
  if (!used) return { ok: false, error: 'signature already used — sign again' }
  return checked
}

export function authFromSearchParams(sp: URLSearchParams) {
  return parseAuthFields({
    signature: sp.get('signature') || '',
    timestamp: sp.get('timestamp') || '',
    nonce: sp.get('nonce') || '',
  })
}

export async function verifyOwnerRead(opts: {
  owner: Address
  collection: string
  action: string
  searchParams: URLSearchParams
}): Promise<boolean> {
  const parsed = authFromSearchParams(opts.searchParams)
  if ('error' in parsed) return false
  const checked = await verifyCollectionAuth({
    owner: opts.owner,
    collection: opts.collection,
    action: opts.action,
    payload: { collection: getAddress(opts.collection) },
    signature: parsed.signature,
    timestamp: parsed.timestamp,
    nonce: parsed.nonce,
  })
  return checked.ok
}

/**
 * lib/json-safe.ts
 *
 * Bigint-tolerant JSON response helper. `PoolToken` (lib/tokens.ts) carries bigint reserve fields
 * (virtualSuiReserves / virtualTokenReserves) and there is NO `BigInt.prototype.toJSON` polyfill, so
 * `NextResponse.json(...)` throws "Do not know how to serialize a BigInt" on any route that emits a
 * PoolToken built by the EVM indexer (lib/evm-tokens.ts `mapPool`). This was latent until a real EVM
 * launchpad token existed (Monad has none live yet — Robinhood's RHCT was the first to trip it).
 *
 * Use `jsonSafe(data, init)` exactly like `NextResponse.json(data, init)` anywhere a response can carry
 * bigint. The reserves are rendered as decimal strings (consumers that need them as bigint re-parse).
 */
import { NextResponse } from 'next/server'

/** JSON.stringify replacer rendering BigInt as a decimal string (JSON has no bigint literal). */
export const bigintReplacer = (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)

export function jsonSafe(
  data: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): NextResponse {
  return new NextResponse(JSON.stringify(data, bigintReplacer), {
    status: init?.status,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
}

import { kv } from '@vercel/kv'
import type { BlitzTweet } from './arc-blitz'

export type BlitzInvoice = {
  tweetId: string
  authorId: string
  handle: string
  name: string
  symbol: string
  tweet: BlitzTweet
}

const INVOICE_TTL_SEC = 30 * 60

export function blitzInvoiceKey(tweetId: string): string {
  return `arcfun:blitz:bot:invoice:${tweetId}`
}

export async function saveBlitzInvoice(inv: BlitzInvoice): Promise<void> {
  await kv.set(blitzInvoiceKey(inv.tweetId), inv, { ex: INVOICE_TTL_SEC })
}

export async function loadBlitzInvoice(tweetId: string): Promise<BlitzInvoice | null> {
  const raw = await kv.get<BlitzInvoice>(blitzInvoiceKey(tweetId))
  if (!raw || !raw.tweetId || !raw.name || !raw.symbol || !raw.tweet) return null
  return raw
}

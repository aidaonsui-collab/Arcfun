/**
 * Arc OTC desk constants (fee waiver + treasury).
 * CCTP multi-chain rails are not part of this surface.
 */
import type { Address } from 'viem'

/** Waiver threshold display: 0.01% of ROBIN supply (~100k hint). */
export const ROBIN_WAIVER_SUPPLY_BPS = 1
export const ROBIN_TOKEN = '0xfB4729659eeF22Bfc1c2B680F6F873f8147aaaab' as Address
export const ROBIN_DECIMALS = 6
export const ROBIN_WAIVER_HINT = 100_000

export const PLATFORM_TREASURY =
  (process.env.NEXT_PUBLIC_BRIDGE_TREASURY as Address | undefined) ??
  ('0xDE0d5aea396D5b937149E36ddBfd6b49f26f19bc' as Address)

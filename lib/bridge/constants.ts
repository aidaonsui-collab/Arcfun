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

/**
 * $EVE holder exception: ≥0.1% of supply on Arc waives the Arc OTC platform fee entirely
 * (feeBps=0), via the same oracle-voucher mechanism as the ROBIN discount above — see
 * app/api/bridge/otc-voucher/route.ts. Checked against Arc directly (arcPublicClient), not
 * RH4663 — EVE is an Arc token, unlike ROBIN.
 */
export const EVE_WAIVER_SUPPLY_BPS = 10
export const EVE_TOKEN = '0x19209E55049bc613c5cC8b66B7DF7824096e78CF' as Address
export const EVE_DECIMALS = 18
/** Waiver threshold display hint — 0.1% of EVE's fixed 1B supply. */
export const EVE_WAIVER_HINT = 1_000_000

export const PLATFORM_TREASURY =
  (process.env.NEXT_PUBLIC_BRIDGE_TREASURY as Address | undefined) ??
  ('0xDE0d5aea396D5b937149E36ddBfd6b49f26f19bc' as Address)

import { formatUnits, parseUnits } from 'viem'

/**
 * Launch-token 6dp formatting helpers, lifted from Robinpad's `lib/monad-launchpad.ts` so
 * `components/ArcDexTradePanel.tsx` (reused verbatim from that codebase) needs zero edits.
 *
 * NOTE: `lib/contracts-arc.ts`'s `ARC.TOKEN_DECIMALS` is documented as 18 ("LaunchToken18"), but
 * the upstream helper this fork carries forward uses 6dp — same mismatch exists in the source
 * repo's ArcDexTradePanel (its own `fmtTok` hardcodes `formatUnits(v, 6)` too). Reproduced as-is
 * rather than "fixed" here since we didn't verify which figure the deployed token actually uses;
 * flag for follow-up if balances look off by 10^12.
 */
const TOKEN_DECIMALS = 6

export const parseToken = (v: string | number) => parseUnits(String(v), TOKEN_DECIMALS)
export const formatToken = (v: bigint) => formatUnits(v, TOKEN_DECIMALS)

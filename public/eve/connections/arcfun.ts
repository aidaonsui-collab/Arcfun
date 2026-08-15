/**
 * Eve MCP connection to the ArcFun venue.
 *
 * Copy to agent/connections/arcfun.ts in an `eve init` project.
 * Tools surface as arcfun__about, arcfun__list_tokens, arcfun__prepare_swap, …
 *
 * Wallet is Circle Agent Stack. This connection is read + prepare only.
 * Broadcasts go through tools/submit_prepared_tx.ts (approval: always).
 */
import { defineMcpClientConnection } from 'eve/connections'

export default defineMcpClientConnection({
  url: 'https://www.arcfun.co/api/mcp',
  description:
    'ArcFun Instant and Instant Reflection launchpad on Arc (chain 5042). List tokens, quote USDC buys and sells, and prepare unsigned launches and swaps. Sign with Circle Agent Stack via submit_prepared_tx. Eve is the agent runtime.',
  tools: {
    allow: [
      'about',
      'list_tokens',
      'get_token',
      'quote_buy',
      'quote_sell',
      'get_holders',
      'get_candles',
      'prepare_launch',
      'prepare_swap',
    ],
  },
})

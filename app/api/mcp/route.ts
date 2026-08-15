/**
 * ArcFun MCP venue — Streamable HTTP at /api/mcp
 *
 * Agents (Claude, Cursor, Codex, Eve) call these tools to list/quote and to
 * prepare unsigned launch/swap txs. Circle Agent Stack signs. This server
 * never holds keys.
 */
import { createMcpHandler } from 'mcp-handler'
import { z } from 'zod'
import {
  mcpAbout,
  mcpCandles,
  mcpError,
  mcpGetToken,
  mcpHolders,
  mcpJson,
  mcpListTokens,
  mcpPrepareLaunch,
  mcpPrepareSwap,
  mcpQuote,
} from '@/lib/arc-mcp'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      'about',
      {
        title: 'About ArcFun + Circle + Eve',
        description:
          'How ArcFun, Circle Agent Stack, and Eve fit together. Call this first. Venue is ArcFun Instant/Reflection on Arc. Wallet is Circle Agent Wallet / CLI. Agent runtime is Eve or any MCP client.',
        inputSchema: z.object({}),
      },
      async () => {
        try {
          return mcpJson(mcpAbout())
        } catch (e) {
          return mcpError(e)
        }
      },
    )

    server.registerTool(
      'list_tokens',
      {
        title: 'List ArcFun tokens',
        description: 'List live Instant and Instant Reflection tokens on ArcFun, sorted by market cap.',
        inputSchema: z.object({
          limit: z.number().int().min(1).max(80).optional().describe('Max tokens to return (default 40)'),
        }),
      },
      async ({ limit }) => {
        try {
          return mcpJson(await mcpListTokens(limit ?? 40))
        } catch (e) {
          return mcpError(e)
        }
      },
    )

    server.registerTool(
      'get_token',
      {
        title: 'Get one token',
        description: 'Token page snapshot: price, FDV, 24h volume, USDC liquidity, socials, pool.',
        inputSchema: z.object({
          address: z.string().describe('Token contract 0x address'),
        }),
      },
      async ({ address }) => {
        try {
          return mcpJson(await mcpGetToken(address))
        } catch (e) {
          return mcpError(e)
        }
      },
    )

    server.registerTool(
      'quote_buy',
      {
        title: 'Quote a USDC buy',
        description: 'Quote tokens received for spending this much USDC on the TOKEN/USDC 1% pool.',
        inputSchema: z.object({
          address: z.string().describe('Token 0x address'),
          amountUsdc: z.string().describe('USDC amount as a decimal string, e.g. "50"'),
        }),
      },
      async ({ address, amountUsdc }) => {
        try {
          return mcpJson(await mcpQuote('buy', address, amountUsdc))
        } catch (e) {
          return mcpError(e)
        }
      },
    )

    server.registerTool(
      'quote_sell',
      {
        title: 'Quote a token sell',
        description: 'Quote USDC received for selling this many tokens on the TOKEN/USDC 1% pool.',
        inputSchema: z.object({
          address: z.string().describe('Token 0x address'),
          amountToken: z.string().describe('Token amount as a decimal string'),
        }),
      },
      async ({ address, amountToken }) => {
        try {
          return mcpJson(await mcpQuote('sell', address, amountToken))
        } catch (e) {
          return mcpError(e)
        }
      },
    )

    server.registerTool(
      'get_holders',
      {
        title: 'Get holders',
        description: 'Ranked non-zero holders for a token (excludes factory, locker, pool).',
        inputSchema: z.object({
          address: z.string().describe('Token 0x address'),
        }),
      },
      async ({ address }) => {
        try {
          return mcpJson(await mcpHolders(address))
        } catch (e) {
          return mcpError(e)
        }
      },
    )

    server.registerTool(
      'get_candles',
      {
        title: 'Get candles',
        description: 'OHLCV candles from the indexed swap tape. Same buckets as the ArcFun chart.',
        inputSchema: z.object({
          address: z.string().describe('Token 0x address'),
          interval: z.enum(['5M', '15M', '1H', '1D']).optional(),
        }),
      },
      async ({ address, interval }) => {
        try {
          return mcpJson(await mcpCandles(address, interval ?? '5M'))
        } catch (e) {
          return mcpError(e)
        }
      },
    )

    server.registerTool(
      'prepare_launch',
      {
        title: 'Prepare an Instant or Reflection launch',
        description:
          'Build unsigned approve + create transactions for an ArcFun launch. Does not send. Sign with a Circle Agent Wallet (or any Arc wallet) via Eve submit_prepared_tx. Creation fee is 0.10 native USDC. First buy is ERC-20 USDC.',
        inputSchema: z.object({
          name: z.string().min(1).max(32),
          symbol: z.string().min(1).max(12),
          kind: z.enum(['instant', 'reflection']).describe('instant = 70/30 meme. reflection = 25/50/25 holders.'),
          firstBuyUsdc: z.string().optional().describe('Optional first buy in USDC, e.g. "100"'),
          rewardsWallet: z.string().optional().describe('Creator fee recipient. Defaults to the signer.'),
          rewardToken: z.string().optional().describe('Reflection reward token. Defaults to Arc USDC.'),
          wallet: z.string().optional().describe('Signer address (used for fee waiver check).'),
        }),
      },
      async (args) => {
        try {
          return mcpJson(await mcpPrepareLaunch(args))
        } catch (e) {
          return mcpError(e)
        }
      },
    )

    server.registerTool(
      'prepare_swap',
      {
        title: 'Prepare a buy or sell',
        description:
          'Build unsigned approve + swap transactions on the token Uni V3 pool. Does not send. Sign with a Circle Agent Wallet via Eve. wallet is the recipient.',
        inputSchema: z.object({
          token: z.string().describe('Token 0x address'),
          side: z.enum(['buy', 'sell']),
          amount: z.string().describe('USDC amount for buy, token amount for sell'),
          wallet: z.string().describe('Signer / recipient 0x address'),
          slippageBps: z.number().int().min(10).max(1000).optional().describe('Default 150 (1.5%)'),
        }),
      },
      async (args) => {
        try {
          return mcpJson(await mcpPrepareSwap(args))
        } catch (e) {
          return mcpError(e)
        }
      },
    )
  },
  {
    serverInfo: { name: 'arcfun', version: '1.1.0' },
    verboseLogs: false,
  },
)

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version',
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS })
}

async function withCors(req: Request) {
  const res = await handler(req)
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

export { withCors as GET, withCors as POST, withCors as DELETE }

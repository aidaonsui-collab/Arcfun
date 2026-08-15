---
name: arcfun
description: >
  Launch and trade Instant / Instant Reflection tokens on ArcFun (Arc, chain 5042).
  Use when the user wants to list ArcFun tokens, quote a USDC buy or sell, launch a meme
  or reflection token, or wire an Eve agent to the pad with Circle Agent Stack as the wallet.
---

# ArcFun + Circle Agent Stack + Eve

ArcFun is the venue (Uniswap V3 TOKEN/USDC Instant pad).
Circle Agent Stack is the wallet (Agent Wallets, Circle CLI, spend policies).
Eve is the agent (MCP connection, tools, approvals). Any MCP client also works.

This skill never asks ArcFun to hold a key. The MCP only reads the pad and returns unsigned transactions. Signing is `circle wallet execute`.

## Connect

Add the ArcFun MCP server (Streamable HTTP):

```json
{
  "mcpServers": {
    "arcfun": {
      "url": "https://www.arcfun.co/api/mcp"
    }
  }
}
```

Eve: copy https://www.arcfun.co/eve/connections/arcfun.ts into `agent/connections/arcfun.ts`.

Claude Code:

```bash
claude mcp add --transport http arcfun https://www.arcfun.co/api/mcp --scope user
```

Codex:

```bash
codex mcp add arcfun --url https://www.arcfun.co/api/mcp
```

Call `about` first.

## Circle Agent Stack

Paste this into your agent to install the wallet:

```text
Run curl -sL https://agents.circle.com/skills/setup.md, and use the returned setup instructions to set up my agent wallet.
```

Then:

1. `circle wallet login you@example.com`
2. `circle wallet list --chain ARC --type agent` (or `ARC-TESTNET`)
3. Fund the wallet on Arc. Gas is native USDC.
4. Cap spend and allowlist ArcFun contracts:

```bash
circle wallet limit set --address $CIRCLE_WALLET_ADDRESS --chain ARC \
  --policy-type stablecoin --per-tx 250 --daily 1000

circle wallet limit set --address $CIRCLE_WALLET_ADDRESS --chain ARC \
  --policy-type contract --rule-type contract-allowlist \
  --targets "[0xd51E6217bb3bC7586866713854Ea75B7BefF1009,0xa4957E724696b740b323fF3536415bB945e46828,0x3600000000000000000000000000000000000000,0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77,0x6795d7Ee7A83EfeDE1dedD96B86f0f6Efdabf088]"
```

Contracts:

- Instant factory `0xd51E6217bb3bC7586866713854Ea75B7BefF1009`
- Reflection factory `0xa4957E724696b740b323fF3536415bB945e46828`
- USDC `0x3600000000000000000000000000000000000000`
- Uni router `0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77`
- Fee router `0x6795d7Ee7A83EfeDE1dedD96B86f0f6Efdabf088`

Creation fee is **0.10 native USDC** (`msg.value`). First buy is ERC-20 USDC (6dp) via approve.

Each prepared step includes `circle.shell`. Example:

```bash
circle wallet execute "approve(address,uint256)" 0xFactory 100000000 \
  --contract 0x3600000000000000000000000000000000000000 \
  --address $CIRCLE_WALLET_ADDRESS \
  --chain ARC --output json
```

Circle codegen MCP (`api.circle.com/v1/codegen/mcp`) writes Circle SDK code. It does not sign ArcFun trades. Use Agent Wallet / CLI.

`circle blockchain list` is the source of truth for the Arc `--chain` flag. Circle currently publishes Arc testnet as `ARC-TESTNET`. On live ArcFun (5042) use the Arc identifier your CLI lists.

## Eve

Scaffold with `npx eve@latest init`. See https://eve.dev/docs/getting-started and https://www.arcfun.co/eve/README.md

- `agent/connections/arcfun.ts` → `defineMcpClientConnection` to `https://www.arcfun.co/api/mcp`
- `agent/tools/submit_prepared_tx.ts` with `approval: always()` runs `circle wallet execute`
- `agent/instructions.md` and `agent/skills/arcfun.md` from `/eve/`
- Do not skip human approval on `submit_prepared_tx`

## Tool order

1. `about` then `list_tokens` or `get_token`
2. `quote_buy` / `quote_sell`
3. `prepare_swap` or `prepare_launch` (needs `wallet` for swaps)
4. Sign and send each step in order with Circle Agent Stack via Eve `submit_prepared_tx`

Launch kinds:

- `instant`: 70% creator / 30% platform, launch-token fees burn
- `reflection`: 50% holders / 25% creator / 25% platform, USDC rewards by default

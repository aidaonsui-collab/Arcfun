# Eve + Circle Agent Stack + ArcFun

ArcFun MCP is the venue. Circle Agent Stack is the wallet. Eve is the agent.

This folder is a drop-in sketch for an Eve app. Copy the files under `agent/` of an `eve init` project.

## Setup

1. Install Circle Agent Stack (CLI + Agent Wallet):

```text
Run curl -sL https://agents.circle.com/skills/setup.md, and use the returned setup instructions to set up my agent wallet.
```

2. `npx eve@latest init arcfun-agent`
3. Copy into the Eve project:

```text
connections/arcfun.ts          -> agent/connections/arcfun.ts
tools/submit_prepared_tx.ts    -> agent/tools/submit_prepared_tx.ts
instructions.md                -> agent/instructions.md
skills/arcfun.md               -> agent/skills/arcfun.md
```

4. Export the wallet Eve will sign with:

```bash
export CIRCLE_WALLET_ADDRESS=0xYourCircleAgentWallet
# optional if `circle blockchain list` uses a different Arc id than ARC
export CIRCLE_CHAIN=ARC
```

5. Fund that wallet on Arc. Gas is native USDC. Then set spend policy:

```bash
circle wallet limit set --address $CIRCLE_WALLET_ADDRESS --chain ARC \
  --policy-type stablecoin --per-tx 250 --daily 1000

circle wallet limit set --address $CIRCLE_WALLET_ADDRESS --chain ARC \
  --policy-type contract --rule-type contract-allowlist \
  --targets "[0xd51E6217bb3bC7586866713854Ea75B7BefF1009,0xa4957E724696b740b323fF3536415bB945e46828,0x3600000000000000000000000000000000000000,0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77,0x6795d7Ee7A83EfeDE1dedD96B86f0f6Efdabf088]"
```

Run `circle blockchain list` if `ARC` is not accepted. Circle currently publishes Arc testnet as `ARC-TESTNET`. On live ArcFun (chain 5042) use the Arc identifier your CLI lists, or a Circle local wallet plus `--rpc-url`.

## Flow

1. Eve discovers ArcFun tools through `connections/arcfun.ts` (`defineMcpClientConnection`).
2. Eve calls `list_tokens` / `quote_buy` / `prepare_swap` or `prepare_launch`.
3. `submit_prepared_tx` pauses for human approval (`approval: always()`).
4. On approve, the tool runs `circle wallet execute` from Circle Agent Stack.

ArcFun never sees the private key. Circle holds the Agent Wallet under your policy. Eve is the runtime.

Docs: [Circle Agent Wallets](https://developers.circle.com/agent-stack/agent-wallets) · [Circle CLI](https://developers.circle.com/agent-stack/circle-cli/command-reference) · [Eve](https://eve.dev/docs/getting-started)

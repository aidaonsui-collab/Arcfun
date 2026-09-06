---
name: arcfun
description: >
  Launch and trade Instant / Instant Reflection tokens on eve.fun using Eve +
  Circle Agent Stack. Use when the user wants to list tokens, quote a USDC
  buy or sell, launch a meme or reflection token, or submit a prepared tx.
---

# eve.fun + Circle Agent Stack + Eve

Copy this file to `agent/skills/arcfun.md`. The full skill lives at
https://www.arcfun.co/skills/arcfun.md

- Venue: eve.fun MCP `https://www.arcfun.co/api/mcp` via `connections/arcfun.ts`
- Wallet: Circle Agent Stack. `submit_prepared_tx` runs `circle wallet execute`.
- Runtime: Eve. `approval: always()` on every broadcast.

Never ask eve.fun to sign. Never skip human approval.

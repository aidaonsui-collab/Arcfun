# iMessage bot: buy $EVE on Arc

**Status:** Phase 1 dry run built (`npm run imsg-buybot`). No gateway, AA deploy, signing, or broadcast code.  
**Date:** 2026-09-23  
**Scope:** eve.fun Instant buy path (`lib/arc-swap.ts`) behind an iMessage YES gate, starting with USDC → `$EVE`  
**Out of scope:** Instant create, sell, multi-token catalog, mint/redeem of RWAs, dividends, Apple Business Chat / iMessage for Business certification (product call later)

---

## Goal

Let a user text something like:

```text
buy $5 of $eve
```

to an iMessage-reachable contact, get a quote back, reply **YES**, and have their Arc account-abstraction wallet execute the same USDC → `$EVE` Instant buy Instant already does in the web UI — gas paid in USDC (no separate gas token).

This matches the Invisible Money pattern (iMessage → YES → ERC-4337 UserOp on Arc), with a Uni / FeeRouter swap instead of a plain USDC transfer.

---

## Why Arc makes this feasible

| Piece | Already true on Arc mainnet (5042) |
|-------|-------------------------------------|
| Native / gas in USDC | No separate gas token for the user to hold |
| ERC-4337 | EntryPoint 0.7 `handleOps`; Kernel-style senders observed live (Invisible Money) |
| Instant buy path | Reuse `quoteArcBuy` + `buildArcBuy` / FeeRouter `swapExactInput` |
| `$EVE` | `0x19209E55049bc613c5cC8b66B7DF7824096e78CF`, Uni V3 USDC pool fee **1%** (`EVE_POOL_FEE = 10000`) |

The hard product work is the Messages pipe, session-key policy, and onboarding — not inventing a new DEX.

---

## User flow (v1)

```text
User ──iMessage──▶ Bot number
  "buy $5 of $eve"
        │
        ▼
  Parse intent → quote (USDC in, $EVE out, fee, slippage, gas estimate)
        │
        ▼
  Bot replies with quote + "Reply YES to confirm (expires in 60s)"
        │
  User: YES
        │
        ▼
  Session key signs UserOp (approve if needed + FeeRouter buy)
  Bundler submits handleOps
        │
        ▼
  Bot replies with explorer link + amount out
```

**Reject without YES.** No silent swaps. Quote expiry is mandatory (stale quotes must not execute).

### Intent grammar (v1)

| Pattern | Meaning |
|---------|---------|
| `buy $<usd> of $eve` / `buy $<usd> eve` | Exact USDC notional buy |
| `buy $eve with $<usd>` | Same |
| `balance` / `bal` | USDC + $EVE balances on linked Kernel |
| `cancel` | Drop pending quote |

Case-insensitive. `$EVE` / `eve` / `EVE` all resolve to the platform token address below. No free-text ticker resolution in v1 (avoids wrong-token buys).

### Quote message shape

```text
Buy $5.00 USDC → ~X.XX $EVE
Pool fee 1% · Instant platform skim ~1% · slippage 1%
Min out: Y.YY $EVE
Est. gas: ~$0.01 USDC
Expires in 60s — reply YES to confirm
```

Numbers come from the same quote helpers Instant uses (`quoteArcBuy` / FeeRouter fee bps).

---

## System components

```text
┌─────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  iMessage   │────▶│  Bot gateway     │────▶│  Intent + session   │
│  (SMS/IM)   │◀────│  (Linq / Loop /  │◀────│  store (Redis/DB)   │
└─────────────┘     │   custom bridge) │     └──────────┬──────────┘
                    └──────────────────┘                │
                                                        ▼
                                             ┌─────────────────────┐
                                             │  Quote + UserOp     │
                                             │  builder (Node)     │
                                             │  reuses arc-swap    │
                                             └──────────┬──────────┘
                                                        │
                    ┌──────────────────┐                ▼
                    │  Bundler +       │◀──── ERC-4337 UserOp
                    │  USDC paymaster  │
                    └────────┬─────────┘
                             ▼
                    Arc 5042 · EntryPoint 0.7
                    Kernel AA wallet (per user)
                    FeeRouter → SwapRouter02 → $EVE/USDC pool
```

### 1. iMessage gateway

Apple does not expose a public “iMessage bot API.” Practical options:

| Option | Notes |
|--------|--------|
| **Linq Message / similar** | Hosted Blue Bubbles–style or carrier bridge; easiest MVP |
| **Self-hosted Mac + BlueBubbles / similar** | Full control; ops burden; Mac always on |
| **SMS-only short code** | Works cross-platform; loses pure iMessage UX |

v1 recommendation: hosted gateway with a dedicated number branded as eve.fun (or “Eve Buy”), not the Invisible Money number.

### 2. Identity: phone ↔ Kernel wallet

One-time link:

1. User texts `link` (or opens `eve.fun/imsg?c=…`).
2. Bot creates (or recovers) a **Kernel** smart account for that phone hash.
3. User funds it with USDC on Arc (deposit address = Kernel address; show QR / copy).
4. Bot installs a **session key** whose permissions are the allowlist below.

Phone number is stored as a salted hash only. Never put seed phrases in Messages.

### 3. Session key policy (critical)

The bot’s signer must **not** be a full owner key. Use a Kernel session / validator key with:

| Allow | Deny |
|-------|------|
| `USDC.approve(ReferralRouter, amount == quote amountIn)` | Arbitrary `approve`, and the web UI’s unlimited approve |
| `ReferralRouter.buy(EVE, 10000, amountIn, minOut, "")` — the live buy path (see §4) | Any other tokenOut; any non-empty referral code |
| Optional: native USDC paymaster interaction as required by Arc bundler | Transfers of USDC or $EVE to arbitrary addresses |
| Max notional per UserOp (e.g. **$25** first week) and per day (e.g. **$100**) | Sell path in v1 |
| Deadline / validUntil on the session and on each quote | Calls to unknown contracts |

On YES, the server signs **only** the UserOp that matches the stored quote id (amountIn, minOut, fee tier, spender). Mismatch → abort and tell the user to request a new quote.

### 4. Quote + swap (reuse Instant)

Do **not** fork swap math. Call into the same surface Instant uses:

| Step | Helper / contract |
|------|-------------------|
| Resolve fee tier | `findArcPoolFee($EVE)` (expect `10000`) |
| Quote | `quoteArcBuy(EVE, usdcIn)` |
| Min out | `minOutFromSlippage(quoted, 100)` (1% default; configurable) |
| Spender | `arcSwapSpender('buy')` → ReferralRouter (production sets `NEXT_PUBLIC_ARC_REFERRAL_ROUTER`) |
| Calldata | `buildArcBuy(EVE, usdcIn, minOut, fee, '')` → `ReferralRouter.buy(...)` |

Because production sets the ReferralRouter, the shared helpers emit `ReferralRouter.buy`, not
`FeeRouter.swapExactInput`. The ReferralRouter forwards to the FeeRouter (1%) and SwapRouter02,
and pays `$EVE` to `msg.sender` — verified by `eth_simulateV1` on mainnet (2026-09-23): approve +
buy of $5 both succeed and the caller's `$EVE` balance rises by exactly the quoted amount.

Live mainnet addresses (from the deployed site bundle and on-chain reads, 2026-09-23):

| Name | Address |
|------|---------|
| Chain | `5042` |
| USDC (6dp ERC-20) | `0x3600000000000000000000000000000000000000` |
| `$EVE` | `0x19209E55049bc613c5cC8b66B7DF7824096e78CF` |
| Uni V3 factory | `0xf0db7b58379503491d857dB50AC9ece64c653918` |
| SwapRouter02 | `0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77` |
| ReferralRouter (buy spender) | `0xe65eE188f8FaB172CaA981b9bf4b8B71a3E8dC06` |
| FeeRouter (1%, behind ReferralRouter) | `0x8d051f7FCf2F67f272b6ec96dAf2e9a847633394` |
| Quoter | `0x7DfD4F31be6814D2906BDE155c3e1B146EAc1468` |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |

Do not trust the in-code fallbacks: without production env, `lib/contracts-arc.ts` falls back
to an older FeeRouter (`0x6795d7Ee7A83EfeDE1dedD96B86f0f6Efdabf088`) and no ReferralRouter. The
bot's policy pins the live addresses above, so a missing env produces a refused quote rather than
a buy through the wrong router.

UserOp `callData` is a Kernel v3 (ERC-7579) `execute` batch:

1. `USDC.approve(ReferralRouter, usdcIn)` if allowance &lt; usdcIn (exact amount, never unlimited)
2. `ReferralRouter.buy` calldata from `buildArcBuy`

Gas: Arc USDC paymaster / native USDC gas — same class of flow Invisible Money uses (~sub-cent observed on simple transfers; quote the estimate in the YES message).

### 5. Bundler

Use a maintained Arc 4337 bundler (ZeroDev / Pimlico-class, or Arc’s public bundler if published). Invisible Money’s live path used EntryPoint 0.7 `handleOps` with a Kernel-labeled sender — treat that as the reference shape, not a dependency on their vendor.

---

## Security & product framing

- **Custody model:** “Your Kernel wallet; we hold a narrowly scoped session key that only runs buys you YES.” Not “we hold your funds.”
- **No broker framing** in copy: relay + quote + execute approved UserOp. Legal review before public launch.
- **Rate limits:** per-phone and per-Kernel; exponential backoff on failed YES / reverts.
- **Replay:** each quote has a unique id; YES consumes it once; expiry ≤ 60–120s.
- **Support:** every success/fail reply includes Kernel address + tx hash (or revert reason).
- **Secrets:** session private keys in KMS/HSM; never in the iMessage host process plaintext longer than signing.
- **Money-moving changes:** any live deploy, fee skim, or session-key widen follows the existing rule — propose, wait for Jack’s explicit yes, then ship. This doc alone is not a ship yes.

---

## Phased build

| Phase | Deliverable | Ship gate |
|-------|-------------|-----------|
| **0 — this doc** | Architecture + addresses + policy | Merged as docs |
| **1 — dry-run** ✅ | CLI: parse intent → quote → print UserOp calldata (no Messages, no broadcast). Built: `lib/imsg-buybot/`, `npm run imsg-buybot` | Internal |
| **2 — AA testnet / mainnet canary** | One funded Kernel + session key; scripted YES path buys $1 of $EVE | Explicit yes |
| **3 — iMessage MVP** | Gateway + link flow + buy $EVE only + YES | Explicit yes |
| **4 — harden** | Limits, monitoring, support runbook, optional `sell` / other Instant tickers | Explicit yes each |

Suggested MVP caps: **$1–$25** per buy, **$100**/day, `$EVE` only, USDC in only.

---

## Effort sketch

| Workstream | Rough |
|------------|--------|
| Intent parser + quote service (wrap `arc-swap`) | 1–2 days |
| Kernel factory + session key installer + KMS | 2–3 days |
| UserOp builder + bundler integration + canary | 2–3 days |
| iMessage gateway + link/onboarding UX | 2–4 days (vendor-dependent) |
| Limits, monitoring, runbook | 1–2 days |

---

## Open product calls (need Jack)

1. Brand: “Eve” / “eve.fun” / separate buy-bot name in Messages?
2. MVP max notional and daily cap.
3. Gateway vendor vs self-hosted Mac.
4. Whether ReferralRouter codes are ever accepted from chat (default **no** in v1).
5. Public launch vs allowlisted phones first.

---

## Remaining ship calls

Locked by this note: **docs-only architecture**; Instant buy helpers are the swap source of truth; v1 is `$EVE` + YES gate + Kernel session allowlist.

**Not locked / not approved to build or deploy:** live session keys, bundler production keys, iMessage number, fee changes, or any UserOp that moves user funds. Those need an explicit yes after Phase 0.

---

## References in-repo

- `lib/arc-swap.ts` — `quoteArcBuy`, `buildArcBuy`, `arcSwapSpender`, slippage helpers  
- `lib/contracts-arc.ts` — `ARC.USDC`, `ARC.UNI_*`, `ARC.FEE_ROUTER`, chain 5042  
- `lib/eve.ts` — `EVE_TOKEN`, `EVE_POOL_FEE`  
- `lib/imsg-buybot/` — Phase 1: `intent.ts` (grammar), `policy.ts` (pinned session-key allowlist + caps), `kernel.ts` (ERC-7579 batch callData), `bot.ts` (quote → YES → submit loop, gateway-agnostic), `live.ts` (quotes via arc-swap)  
- `lib/imsg-buybot.test.mjs` — offline tests for all of the above  
- Invisible Money (external reference, 2026-09-23): iMessage `Send $N to 0x…` → YES → Kernel UserOp, USDC gas on Arc

## Running the Phase 1 dry run

Needs production's router env (`vercel env pull --environment production .env.local`, or set
`NEXT_PUBLIC_ARC_FEE_ROUTER` and `NEXT_PUBLIC_ARC_REFERRAL_ROUTER`). Without it the policy refuses
to quote, by design.

```bash
npm run imsg-buybot                              # chat as if in Messages
npm run imsg-buybot -- "buy $5 of $eve"          # one message, auto-YES, print the unsigned UserOp
npm run imsg-buybot -- --account 0x… balance     # read a real wallet's USDC / $EVE
```

Live quotes, real callData, never signs or broadcasts.

# Referral system — implementation plan

Status: **plan only, not built**. Written 2026-08-10 per platform-owner request, targeting
recommendation #2 from the referral-ideas discussion: **volume-tiered % of platform fees,
off-chain attribution, keeper-pattern payout.**

## Why this model

ArcFun already has every piece this needs, proven in production by two existing systems:

- **Fee source**: `MonLock`'s per-position fee split already carves out a platform leg (bps,
  configurable per lock) on every trade. A referral commission is a slice of that leg — no new
  token, no new supply, no new fee mechanism.
- **Payout pattern**: `lib/arc-reflection-keeper.ts` + `app/api/arc/keeper/reflect/route.ts` is a
  proven template — Vercel Cron, `CRON_SECRET`-gated, accrue → sweep-on-schedule → dust floor
  skip, USDC payouts, per-item try/catch so one bad row never kills the run.
- **Storage**: `@vercel/kv` (Upstash Redis, `arcfun:` key namespace) is already wired and used in
  production for the follow graph (`lib/arc-followers.ts`) and creator/token metadata. No new
  infra to provision.

So this plan is mostly *composition* of things ArcFun already runs, not new architecture.

## Data model (Vercel KV)

```
arcfun:ref:code:<code>              → wallet address (owner of that referral code)
arcfun:ref:wallet:<wallet>          → referral code (reverse lookup, one code per wallet)
arcfun:ref:attributed:<wallet>      → referrer wallet (set ONCE, first-touch — never overwritten)
arcfun:ref:attributed_at:<wallet>   → unix ts of attribution
arcfun:ref:volume:<referrer>        → running total referred-trade volume (USDC, float, INCRBYFLOAT)
arcfun:ref:pending:<referrer>       → accrued unpaid commission (USDC, 6dp int, INCRBY)
arcfun:ref:paid_total:<referrer>    → lifetime paid-out total (USDC, 6dp int)
arcfun:ref:payout_log:<referrer>    → Redis list of {txHash, amount, ts} — audit trail
```

All keyed by lowercased address, matching the existing `followersKey`/`followingKey` convention.

## Flow

### 1. Code generation
- Auto-generate a short code the first time a wallet visits a "referrals" tab (or on-demand button)
  — e.g. `AF-XXXXXX` derived from a hash of the wallet address, collision-checked against
  `arcfun:ref:code:*`. No user input needed, no squatting risk.
- `GET /api/arc/referral/code?wallet=0x…` → creates if missing, returns `{ code, link }` where
  `link = https://arcfun.co/?ref=<code>`.

### 2. Attribution (off-chain, first-touch, client-driven)
- `?ref=CODE` on any page → store `arcfun_ref=<code>` in `localStorage` (not a cookie — no
  cross-site tracking concerns, and this is a single-domain dapp) with a 30-day expiry stamp.
- On the referred wallet's **first on-chain trade** (buy or sell, detected client-side right after
  a successful tx, same place `refreshAfterTrade()` already fires in
  `app/token/[address]/page.tsx`), POST once to `/api/arc/referral/attribute` with
  `{ wallet, code }`.
- Server verifies: code exists, `wallet !== code owner` (no self-referral), and
  `arcfun:ref:attributed:<wallet>` is unset (first-touch, permanent — matches the reflection
  keeper's "permissionless but idempotent" philosophy). Sets it via `SETNX` for atomicity.
- No wallet signature required for attribution itself — the fee-accrual step below is what
  actually matters financially, and it's driven by real on-chain trade data, not by this claim.

### 3. Volume + commission accrual
- Every trade already gets indexed by `lib/arc-trades.ts` for the chart/activity tape. Extend that
  same pull (or a lightweight parallel one) to, per trade:
  1. Look up `arcfun:ref:attributed:<trader>` → referrer (skip if none).
  2. Compute the trade's platform-fee-leg USDC amount (same bps math `MonLock` already applies).
  3. `INCRBYFLOAT arcfun:ref:volume:<referrer>` by trade USDC volume.
  4. Look up the referrer's current tier (volume thresholds below) → commission %.
  5. `INCRBY arcfun:ref:pending:<referrer>` by `platformFeeLeg * tierPct`.
- This can run as a lightweight step inside the *existing* trades-indexing path rather than a
  separate scan — avoids double `eth_getLogs` cost.

### 4. Tiers (mirrors the RadarDEX curve you referenced)

| Cumulative referred volume | Referrer commission (of platform's fee leg) |
|---|---|
| $0 – $50K | 10% |
| $50K – $250K | 20% |
| $250K – $500K | 30% |
| $500K – $1M | 40% |
| $1M+ | 50% |

Numbers are placeholders — tune once you know the platform leg's real bps and want a target
$/month ceiling to advertise (like the screenshot's "$500/month"). Tiers only ever move up
(sticky high-water-mark on volume), never down.

### 5. Payout — keeper pattern
- New route: `app/api/arc/keeper/referral-payout/route.ts`, same shape as
  `keeper/reflect/route.ts` — `CRON_SECRET` gated, added to `vercel.json` crons (daily is plenty;
  referral payouts don't need 15-minute latency like reflections do).
- `lib/arc-referral-keeper.ts`: for every referrer with `pending >= MIN_PAYOUT_USDC` (e.g. $5,
  well above gas-not-worth-it dust), send USDC from the platform beneficiary wallet directly to
  the referrer, zero the pending counter, append to `payout_log`.
- Funding: same wallet/allowance pattern already proven for the reflection keeper's self-top-up —
  no new treasury wallet needed.

### 6. Anti-gaming guardrails
- **Self-referral**: reject attribution where `code owner === wallet`; additionally flag (don't
  auto-block, just surface for manual review) referrer/referred pairs whose *funding source*
  wallet matches (would need a light heuristic — e.g. both wallets' first inbound transfer came
  from the same address).
- **Minimum trade size**: trades under some floor (e.g. $1) don't count toward volume — kills
  wash-trading-for-volume via thousands of dust trades.
- **Payout floor**: `MIN_PAYOUT_USDC` above already prevents gas-inefficient micro-payouts and
  raises the bar for farming.
- **Manual kill switch**: `arcfun:ref:frozen:<referrer>` flag checked before every payout — lets
  you freeze a suspicious account without touching code.

### 7. UI
- `/referral` page: reuse the existing `s1`/`s2` surface + lime-accent visual language. Sections:
  - Hero: "Invite friends, earn up to $X/month" + the tier curve (can literally reuse
    `TokenChart`'s lightweight-charts area-series styling for the curve, or a simple SVG path like
    `sparkPath` in `lib/ui-format.ts`).
  - Your link + copy button (same `navigator.clipboard.writeText` pattern already shipped on the
    token page).
  - Stats: referred volume, current tier, pending commission, lifetime paid.
  - Referral activity table: wallet, first trade date, volume contributed.
- Small "Referred by" badge or banner if the current visitor arrived via `?ref=` and hasn't traded
  yet, so the incentive is visible before their first swap, not just after.

## Build order (suggested phases)

1. **Schema + code generation** — KV helpers (`lib/arc-referral.ts` mirroring
   `lib/arc-followers.ts`), `/api/arc/referral/code` route. No payout yet, no UI yet — just prove
   codes generate and resolve.
2. **Attribution** — `?ref=` capture, localStorage, `/api/arc/referral/attribute` route,
   first-touch `SETNX` semantics. Verify with two test wallets end-to-end.
3. **Accrual** — wire volume/commission tracking into the trade-indexing path. Verify pending
   balances increment correctly against real testnet trades before touching payouts.
4. **Payout keeper** — `referral-payout` route + cron, dust floor, funding wallet. Dry-run against
   a manually-inflated `pending` value before trusting it on a schedule.
5. **UI** — `/referral` page, copy-link flow, stats dashboard.
6. **Guardrails** — self-referral checks, min trade size, freeze flag — ideally in before any real
   money is at stake, but sequenced last here since they're cheap to retrofit onto the schema
   above and easier to get right once you've seen real traffic patterns.

Each phase ships independently via the existing branch → PR → merge → verify workflow, same as
everything else in this repo — no reason to build this as one giant PR.

## Open questions for the platform owner

- **Tier percentages and thresholds** — the table above is a placeholder shape, not a
  recommendation on the actual numbers. What's the target advertised ceiling (RadarDEX's is
  $500/month)?
- **Platform fee leg size** — what bps is actually configured for the platform leg on live locks
  today? That determines what tier % translates to in real dollars.
- **Code format** — auto-generated only, or allow custom vanity codes (adds a squatting/moderation
  surface)?
- **Retroactive**: does attribution apply only to trades after a wallet's first `?ref=` visit, or
  could it be argued for historical volume too? (Recommend: forward-only, simpler and avoids
  disputes.)

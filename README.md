# ArcFun

A single-chain fork of [Robinpad](https://robinpad.app) scoped to **Arc mainnet only**
(chain `5042`). One product: **Instant token launch** — create a token, its full supply mints
straight onto a fresh Uniswap V3 TOKEN/USDC pool (1% fee tier), the LP NFT locks for a year.
No bonding curve, no RobinSwap standalone product, no CCTP bridge desk, no other chains.

Domain target: **arcfun.lol** (not yet registered — see "Go live" below).

## Why this looks the way it does

This was carved out of `aidaonsui-collab/robots` (a large multi-chain, multi-product monorepo:
Sui + Robinhood Chain + Monad + Stable + Arc, perps, staking, RWA-backed tokens, an AI-agent
product, etc.). Robinpad already had a working Arc Instant integration in there
(`lib/contracts-arc.ts`, `lib/arc-instant-*.ts`, `components/ArcDexTradePanel.tsx`,
`app/api/arc/*`) — this repo lifts **just that vertical slice**, plus new small
purpose-built pages, rather than the whole app.

Two things worth knowing if you keep developing this:

1. **Files carried over verbatim** (`lib/contracts-arc.ts`, `lib/arc-instant-launchpad.ts`,
   `lib/arc-swap.ts`, `lib/arc-trades.ts`, `lib/arc-token-meta.ts`, `lib/arc-instant-tokens.ts`,
   `components/ArcDexTradePanel.tsx`, all six `app/api/arc/**` routes) are unmodified or
   near-unmodified copies of the source repo, so bugfixes/behavior there match upstream exactly
   (including one known upstream quirk — see the comment in `lib/token-format.ts` about a
   6dp/18dp decimals mismatch that was never chased down).
2. **Files rewritten from scratch** (`app/page.tsx`, `app/create/page.tsx` +
   `components/ArcCreateForm.tsx`, `app/token/[address]/page.tsx`, `lib/tokens.ts`,
   `lib/evm-holders.ts`, `lib/evm-trades.ts`, `lib/instant-quote-launchpad.ts`,
   `lib/token-format.ts`, `lib/evm-address.ts`) exist because the "obvious" reuse candidates in
   the source repo (`components/CreateTokenMeme.tsx`, `components/coin/*`, `lib/tokens.ts`,
   `lib/evm-holders.ts`, `lib/evm-chains.ts`) are wired into the *whole* multi-chain app —
   pulling any of them in via their real imports drags in the Sui SDK, Hyperliquid/perp
   registries, RWA/Rialto integrations, and four other chains' contract configs. None of that
   belongs in an Arc-only fork, so those pieces were rebuilt small and self-contained instead.
   `npm run build` type-checks clean with `ignoreBuildErrors: false` — verified locally before
   this was committed.

## Product scope (deliberately not built)

Per the fork decision: **Instant launch only**. Two things that exist in the source repo and
were intentionally left out — both are natural fast-follows, not blocked on anything:

- **RobinSwap-style standalone swap UI.** The buy/sell panel on the token page
  (`components/ArcDexTradePanel.tsx`) already lets you trade the token you're looking at; there's
  just no separate `/swap` product page.
- **CCTP bridge / Instant-OTC desk** for getting USDC onto Arc. `components/ArcBridgeCta.tsx`
  in this fork is a static pointer to "bridge via Circle CCTP or an exchange" rather than the
  source repo's in-app bridge product.
- **Bonding curve.** Not a scoping choice — it's withdrawn upstream too
  (`arcCurveEnabled()` in `lib/contracts-arc.ts` is hard-`false` unless
  `NEXT_PUBLIC_ARC_CURVE_ENABLED=1`). Instant is the only live Arc launch path as of this fork.

## Contracts

This fork points at the **already-deployed Robinpad-on-Arc contracts** (see
`.env.example` / `lib/contracts-arc.ts` defaults) — `InstantErc20QuoteFactory`, `MonLock`,
`ArcBpsSource`. That means launches through this app currently split LP fees the same way
Robinpad's do (70% creator / 30% *Robinpad's* platform wallet) and pay creation fees to
Robinpad's treasury, because the contracts weren't redeployed for this fork.

**If you want ArcFun to be economically independent from Robinpad**, redeploy your own
`InstantErc20QuoteFactory` + `MonLock` + `ArcBpsSource` (Foundry scripts referenced in
`docs/ARC_LAUNCHPAD_SPEC.md` in the source repo — not copied into this fork) and point
`NEXT_PUBLIC_ARC_INSTANT_FACTORY` / `NEXT_PUBLIC_ARC_INSTANT_LOCKER` / `NEXT_PUBLIC_ARC_BPS_SOURCE`
at your own addresses. Until then, treat this as "ArcFun UI over Robinpad's Arc contracts."

## Local dev

```bash
npm install
cp .env.example .env.local   # fill in KV + WalletConnect project id at minimum
npm run dev
```

## Go live — arcfun.lol

Nothing below is done yet; this is the runbook for whoever has domain/Vercel access.

1. **Buy `arcfun.lol`** (unregistered as of this writing).
2. **New Vercel project** — import this repo fresh. Do **not** add it to the existing
   `theodyssey2`/Robinpad project; this is meant to be a fully separate deployment.
3. **Provision a new Vercel KV (or Upstash Redis) store** for this project — do not point it at
   Robinpad's KV. Token metadata (`lib/arc-token-meta.ts`) and the holder-scan cache
   (`lib/evm-holders.ts`) both live there.
4. **Get your own WalletConnect / Reown Cloud project id** (cloud.reown.com) — don't reuse
   Robinpad's, or wallet metadata will say "Robinpad" mid-connect. Set
   `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`, and once the domain is live, add it under that
   project's **Verified Domains**.
5. **Set environment variables** in Vercel (Production) from `.env.example`. At minimum:
   `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_ARC_RPC` (or `NEXT_PUBLIC_INFURA_API_KEY`),
   `KV_REST_API_URL` / `KV_REST_API_TOKEN`, `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`.
6. **Add the domain** in Vercel → Settings → Domains → `arcfun.lol` (+ `www`, redirect to apex),
   then point DNS at Vercel per its dashboard instructions.
7. **Cloudinary**: this fork reuses Robinpad's unsigned upload preset (`lib/cloudinary.ts`) so
   image upload works out of the box. Swap to your own cloud/preset before real launch if you
   want uploads isolated from Robinpad's account.
8. **Smoke test**: connect wallet on Arc, launch a test token, confirm it shows on `/` and its
   `/token/[address]` page, confirm buy/sell works, confirm the image/socials you set on create
   show up (round-trips through `/api/arc/register` → KV).
9. **Brand assets**: `public/favicon.svg` is a placeholder (sky arrow glyph). No OG banner is
   configured (`app/layout.tsx` metadata omits `openGraph.images`). Both need real design work
   before sharing links widely.

## What's NOT independent from Robinpad yet

- Contracts (see above) — same factory/locker, same fee split.
- Cloudinary account (see above).
- No LP-fee-collection keeper. The source repo's `robinlock-keeper` cron only sweeps RH4663
  (chain 4663) locks, not Arc's — this fork carries none of it. Locked LP fees on Arc currently
  need a manual `collectFees` call on MonLock until someone builds an Arc-specific keeper cron
  (Vercel Cron + a route calling `collectFees` on `NEXT_PUBLIC_ARC_INSTANT_LOCKER`'s locked
  positions, same shape as the upstream keeper minus the RH4663-specific lockers).

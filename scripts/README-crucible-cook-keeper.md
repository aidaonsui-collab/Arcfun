# Crucible cook keeper — sketch

Answers "why does Crucible not show any $EVE buy and burns" with a working fix, not just a
diagnosis. **Not merged for a reason** — this is here to run and evaluate, not to ship yet.

## What it is

[`crucible-cook-keeper.ts`](./crucible-cook-keeper.ts) calls `Crucible.cook()` on a timer — the
step that buys `$EVE` with the sink's accrued USDC and burns it. Nothing in this repo has ever
called it: `git grep` for `cook(` across every `.ts`/`.tsx` file returns zero matches. The sink
accrues correctly on every CrucibleLock collect (verified on mainnet — 5 real collects, every
split landed at exactly 50/25/10/10/5), it just never gets spent. As of writing, the sink is
sitting on 2.02 USDC, unspent since deployment.

Reads the sink address live off `CrucibleLock.crucible()` rather than hardcoding it — the
address isn't recorded anywhere else in this codebase, and this way it keeps working if the sink
is ever rotated. Quotes the swap on the same Quoter ABI the app already uses for buy/sell
estimates ([`lib/arc-swap.ts`](../lib/arc-swap.ts)), and applies a slippage buffer with the app's
own `minOutFromSlippage` — reused, not reimplemented.

## This one is different from the local indexer: it moves real funds

The [local indexer sketch](./README-local-indexer.md) only ever reads and caches. This calls
`cook()`, an on-chain transaction that spends the sink's USDC. That changes what "safe to run
unattended" means:

- **Dry-run by default.** Every pass logs exactly what it would do — sink balance, quote, the
  `minEveOut` it computed — without signing or sending anything. Pass `--live` to actually
  broadcast. Watch a few dry-run passes first; there's no undo on a live `cook()`.
- **Use a dedicated keeper key, not the platform wallet.** `cook()` is gated `onlyKeeper`.
  Have the platform wallet call `crucible.setKeeper(<new address>, true)` once (owner-only), then
  only that narrower key — which can call `cook()`/`projectBurn()`-shaped functions and nothing
  else, not change owner, not touch the sink's own funds outside a quote-protected swap — needs
  to sit in `.env.local` on this machine, unattended, 24/7.
- **In-process lock against overlapping cooks.** A slow RPC plus a short `--interval` could
  otherwise fire two passes against the same balance before the first confirms — the second would
  just revert (`InsufficientUsdc`) after the first drains it, wasting its gas. Guarded against.
- **Every action is logged with amounts and a tx hash.** This handles money — "what did it do"
  needs to be answerable from stdout alone, not inferred from balances after the fact.

## Verified before committing, not just written

- Read path (sink discovery, balance, `cookPaused`, `keepers()`) run against **live production**
  with `--once` and a throwaway key — correctly found the real sink (`0x0B3Eb6Ce...`), the real
  balance (2.019608 USDC), and correctly refused to proceed because the throwaway key isn't an
  authorized keeper (exactly the behavior a real unauthorized key should get).
- Quoter path independently checked against the live pool: quoting that same 2.019608 USDC
  currently returns ~19,285 EVE.
- `npx tsc --noEmit` clean.
- The `cook()` broadcast itself is the one thing not exercised here — that needs a real keeper
  key, which this session never had access to. It reuses the exact `writeContract` /
  `waitForTransactionReceipt` pattern already proven working elsewhere in this codebase
  ([`lib/arc-reflection-keeper.ts`](../lib/arc-reflection-keeper.ts)).

## Try it

```bash
npx tsx --env-file=.env.local scripts/crucible-cook-keeper.ts --once
```

One dry-run pass, then exit — the fastest way to see it work and read its output before deciding
anything. Needs `CRUCIBLE_KEEPER_PRIVATE_KEY` (0x-prefixed) and the same `ARC_RPC` /
`NEXT_PUBLIC_ARC_RPC` your `.env.local` already has for the Next.js app. No Vercel KV dependency —
everything here is a direct chain read/write.

To loop continuously: drop `--once`. `--interval=N` sets seconds between passes (default 600).
`--min-usdc=N` sets the USDC threshold to bother cooking at all (default 1 — tune this up once
volume grows, so it's not swapping single dollars for gas). `--slippage=N` sets the price
protection in bps (default 300 = 3%). Add `--live` only once you trust what the dry runs show you.

## Before leaving it running unattended

- Set up the dedicated keeper key (above) before anything else.
- **Keep the Mac from sleeping** — `caffeinate -i`, or `pmset` while it's meant to stay up.
- **Supervise it** with [`crucible-cook-keeper.launchd.plist.example`](./crucible-cook-keeper.launchd.plist.example)
  — a template, not installed by anything here, and deliberately does not pass `--live` even in
  the example. Fill in the paths, get comfortable with dry-run output, then add `--live` yourself.
- **Watch the log.** `StandardOutPath` in the plist is your only record of every cook this makes.

## What this deliberately doesn't cover

- No alerting beyond stdout — if you want to know this stopped running, or a cook reverted
  repeatedly, that's on you to notice today.
- No minimum-balance ratchet beyond `--min-usdc` — it cooks the *entire* sink balance each
  qualifying pass, not a fixed chunk. Simple, and matches how `cook(amountIn, ...)` already takes
  an explicit amount rather than "cook everything" being a special case.
- Reflection's Crucible legs (holders/creator/platform/project-burn on the Reflect kind) aren't
  touched by this — same `cook()` mechanism would apply whenever Reflection collects start
  accruing into the same sink, nothing here special-cases Meme vs. Reflect.

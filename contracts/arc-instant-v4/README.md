# arc-instant-v4

Uniswap v4 Instant for eve.fun. New meme / reflect / RWA launches go here. The live V3 Instant
factory (`0x05BF…`) and CrucibleLock keeper stay up for tokens already on that path — they are
not migrated.

Two factories share one hook:

- **`EveFeeHook.sol`** — `AFTER_SWAP` + `AFTER_SWAP_RETURNS_DELTA`. One swap fee (0.3–3%), same
  on buy and sell. 100% of that fee is allocated creator / burn / holders / auto-LP / platform,
  with a 10% platform floor. Burn of the launch token happens in-swap to `0xdead`; quote-side
  burn accrues to `pendingBurn` (cannot `swap()` the same pool in `afterSwap`). Auto-LP and
  holders accrue pull-based like creator. Multiple factories can be allowed on the same hook.
- **`EveInstantV4Factory.sol`** — USDC (or any ERC-20 quote) Instant for meme + reflect. Per-create
  split, virtual quote, same-tx first buy. No Crucible leg. Auto-LP slice accrues to the factory
  until donate/flush lands. Holders slice accrues to the address passed at create.
- **`RwaFeeHook.sol` / `RwaInstantV4Factory.sol`** — earlier 50/40/10 sketch. RWA creates will
  point at `EveFeeHook` instead; do not grow a second split model.

Create UI: `/create` shows the fee chooser unless `NEXT_PUBLIC_ARC_INSTANT_V4=0`. The live create
transaction still hits V3 Instant until `NEXT_PUBLIC_ARC_INSTANT_V4_FACTORY` is set.

HolderSink + EveV4Router live in this package. `HolderSink.distribute()` / `claim()` is the
reflect path. RWA factory registers on EveFeeHook (holders slice rejected).

The rest of this file is the original RWA sketch (still accurate for `RwaFeeHook`).

## What v4 buys here, concretely

`contracts/crucible`'s v3 fee split needs a keeper to call `collectFees()` — the exact thing that
took a wall-clock-budget fix and keeper-key setup to keep from stalling (`lib/arc-indexer/run.ts`).
`RwaFeeHook` has no collection step: it's a v4 `afterSwap` hook, so creator/crucible/platform legs
settle atomically inside every swap. No cron, no keeper, nothing to keep alive.

- **`LaunchToken18.sol`** — copy of the v3 pad's plain launch token (1B supply, 18dp, no owner,
  no tax). Same contract, different pairing.
- **`RwaFeeHook.sol`** — a v4 hook with only `AFTER_SWAP` + `AFTER_SWAP_RETURNS_DELTA`
  permissions. Taxes the *unspecified* currency of each swap (the side the swapper didn't pin —
  standard v4 fee-hook shape), pulls it via `poolManager.take()`, splits it creator/crucible/
  platform, and credits `owed[recipient][currency]` — pull-based, mirroring CrucibleLock's
  `owed`/`_payOrAccrue` pattern so a blacklisted or reverting recipient can never jam a swap.
  Because the fee is levied on whichever side the pool paid out, accrued balances can land in
  either the launch token or the quote currency depending on trade mix — recipients call
  `withdraw(currency)` for whichever actually accrued.
- **`RwaInstantV4Factory.sol`** — deploys the token, initializes a v4 pool (fee = 0; the hook
  replaces the LP fee entirely), registers the split on the hook, and mints the entire supply as
  a single-sided position at the extreme edge of the usable tick range (`minUsableTick`/
  `maxUsableTick`) — so the whole representable range sits above (or below) the starting price
  and 100% of the deposit is the token, zero quote required. The position is owned by the factory
  inside `PoolManager`'s own accounting; nothing in this contract can ever call
  `modifyLiquidity` with a negative delta on it. That's the "no NFT withdraw, creator can't rug"
  guarantee CrucibleLock gives structurally instead of via a revert-guarded function.

## Deliberately simpler than the v3 factory, for now

- **Starting valuation is optional.** `createToken(..., launchVirtualQuote, firstBuyQuoteAmount)`
  uses the same raw-unit encoding as Instant V3 (`VIRTUAL_TOKEN_INIT` vs quote raw). 0 falls
  back to the factory default (`setLaunchVirtualQuote`); if that is also 0 the pool still opens
  at the usable-tick edge. Pass `5500e6` on a 6dp quote for the ~$5.2k FDV Instant uses on USDC.
- **First buy is in the create tx.** Nonzero `firstBuyQuoteAmount` is pulled from the caller
  (approve the factory) and swapped quote→token inside the same `unlock()` as the LP mint. The
  hook taxes that swap like any other. 0 skips the swap. The original 4-arg `createToken` is
  launch-only.
- **The "crucible" leg only accrues — nothing burns automatically yet.** v3's project-burn leg
  buys back and burns the launch token; there's no guaranteed launch-token/EVE route for an
  arbitrary RWA pair. The crucible leg here just piles up as a withdrawable balance in whatever
  currency accrued. Routing it into the real EVE buyback-and-burn (`contracts/eve-burn`,
  `scripts/cook-crucible.ts`) once a swap path from a given RWA quote into USDC exists is the
  natural next step, not built here.
- **Split (50/40/10 creator/crucible/platform) is a factory-wide constant**, not per-launch or
  owner-tunable — simpler than v3's per-`Kind` bps tables. Folds v3's separate "project burn"
  share into `crucible` since there's no burn route yet (see `RwaFeeHook`'s top comment).

## What's actually proven vs. what's still assumed

**Proven** — `forge test` deploys a real `PoolManager` (Uniswap's actual v4-core, vendored as a
submodule, not a mock) and a real `PoolSwapTest` router, launches a token against a mock RWA
quote, and swaps both directions:

```
forge test -vv
```

11/11 passing, including a 256-run fuzz test that the creator/platform/crucible split holds
*exactly* to the bps constants across trade sizes from 1 to 500,000 quote units, and a directional
test proving the fee correctly lands in the token on a buy and the quote on a sell (the highest-risk
part of this build — v4's specified/unspecified-currency accounting is genuinely easy to get
backwards, and this is what confirms it isn't).

**Not proven / explicitly unverified:**
- **Arc's real v4 `PoolManager` address.** There's an address that's *plausibly* it
  (`0x8366a39cc670b4001a1121b8f6a443a643e40951` — inferred from watching it hold the LP for a
  couple of independently-launched tokens on Arc mainnet, in the session this shipped from) but
  nobody has confirmed it against Uniswap's own deployment records. `script/` deploys its own
  fresh `PoolManager` by default rather than hardcode that guess — pass `POOL_MANAGER=0x...` once
  it's actually verified.
- **Any live RWA quote token.** USYC has a real Arc *testnet* address in
  `lib/arc-rwa-assets.ts`; nothing is live on mainnet yet. Tests use `MockRwaToken`, a 6dp stand-in.
- **Frontend integration.** No create-flow UI, no trading UI wired to a v4 router. The pad would
  need a production swap router in front of these pools — `PoolSwapTest` in tests is Uniswap's
  own test scaffolding, not something to point real traffic at.
- **A security review.** This hook moves real value on every swap; get the specified/unspecified
  math or the `take()`/settle accounting wrong and it either bricks trading or misroutes fees. The
  test suite proves the happy paths; it is not a substitute for an audit before any real quote
  asset touches this.

Not deployed anywhere. Ship testnet once a real RWA quote token exists there, watch it, then
revisit the mainnet `PoolManager` address before going further.

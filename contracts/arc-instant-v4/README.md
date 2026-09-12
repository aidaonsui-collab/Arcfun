# arc-instant-v4

The RWA-paired launch path, built natively on Uniswap v4 instead of the pad's existing v3
(`contracts/arc-instant`). Came out of a session comparing v3 vs v4 for eve.fun: don't migrate
the live Meme/Reflection pad, but build the not-yet-shipped RWA pairing (`lib/arc-rwa-assets.ts`
on the app side — USYC/BUIDL/tokenized CRCL, currently all "Soon") on v4 from the start, since
that's new code either way and it's where this kind of liquidity is actually heading.

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

## Holder payout baskets — `BasketVault.sol`

"Earn RWAs automatically, just for holding," from [based.bid](https://x.com/basedbidx/status/2081029361965080803): a creator-configured basket of assets (stocks, ETFs, other RWAs) that a
pool's fees convert into and pay out to holders, either **all-at-once** (every asset, every
cycle, split by weight) or **rotating** (one asset per cycle, cycling through the list).

- **One `BasketVault` per pool, never a shared address.** `RwaFeeHook.owed[recipient][currency]`
  is keyed globally by (address, currency) across every pool the hook serves. A single router
  address reused as `crucible` for two pools that happen to share a quote currency (likely —
  most RWA launches would share the same RWA quote) would have both pools' fees landing in the
  same slot with no way to tell whose money is whose. `RwaInstantV4Factory.createTokenWithBasketVault`
  deploys a fresh vault per launch specifically to make that structurally impossible rather than a
  bookkeeping problem to get right.
- **`pull(currency)`** — permissionless, claims whatever accrued to the vault from the hook (the
  vault *is* that pool's sole crucible recipient, so this is unambiguous).
- **`convert(fromCurrency, minOuts)`** — swaps the pulled balance into the basket via real v4
  pools (creator supplies the pool key per basket asset at `setBasket` time — mismatches revert
  rather than silently routing through the wrong pool). AllAtOnce splits by weight in one call;
  Rotating sends the whole amount to the next asset in line and advances the pointer.
- **`disperse(asset, holders[], amounts[])`** — **not** computed on-chain. Enumerating "every
  current holder and their exact balance" cheaply on-chain is a real unsolved problem for a plain
  ERC-20; this mirrors the pattern already proven in production for $EVE holder rewards
  (`lib/arc-eve-holder-rewards.ts`): a keeper reads real balances off-chain, computes the pro-rata
  weights, and submits them here. The contract's only enforcement is `sum(amounts) <=
  pendingDistribution[asset]` and an owner gate on who can call it — it cannot verify the weights
  are *correct*, same trust boundary the existing EVE rewards keeper already operates under.
- **`setBasket(...)` is creator-only and callable any time** — "fully automatic, no relaunches":
  changing what holders earn never touches the token or its pool.

Proven by `test/BasketVault.t.sol` (10 tests, part of the same `forge test` run below): real
launch-with-vault wiring, weight validation, pull + convert in both payout modes against real v4
pools for two mock "stock" assets, the disperse cap + ownership gates. Not built: the off-chain
keeper script that would actually compute and submit `disperse` batches (same gap #234's plain
launch path has for the crucible leg — this is the next layer up, not re-solved here).

## Deliberately simpler than the v3 factory, for now

- **No starting-valuation bonding math.** v3's `launchVirtualQuote` picks a deliberate initial
  price. This always starts at the literal floor/ceiling of the tick range and lets the market
  walk the price up (or down) through trading — sidesteps needing this contract to reason about
  an arbitrary RWA quote's decimals or a "fair" launch valuation. A caller-supplied virtual quote
  is a reasonable follow-up.
- **No first-buy-in-the-same-transaction.** v3's `createTokenMemeInstantQuote` takes a
  `firstBuyQuoteAmount` and buys atomically at creation. Folding a swap into the same `unlock()`
  as the liquidity mint is a real correctness-sensitive addition on top of an already-dense
  callback — left out until this path has real usage. Creator can swap immediately after in a
  second transaction.
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

21/21 passing (11 for the launch path, 10 for BasketVault), including a 256-run fuzz test that
the creator/platform/crucible split holds *exactly* to the bps constants across trade sizes from
1 to 500,000 quote units, and a directional test proving the fee correctly lands in the token on
a buy and the quote on a sell (the highest-risk part of this build — v4's specified/unspecified-
currency accounting is genuinely easy to get backwards, and this is what confirms it isn't).

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

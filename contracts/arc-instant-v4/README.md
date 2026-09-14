# arc-instant-v4

Uniswap v4 Instant for eve.fun. New meme / reflect / RWA launches go here. The live V3 Instant
factory (`0x05BF…`) and CrucibleLock keeper stay up for tokens already on that path — they are
not migrated.

Two factories share one hook:

- **`EveFeeHook.sol`** — `AFTER_SWAP` + `AFTER_SWAP_RETURNS_DELTA`. One swap fee (0.3–3%), same
  on buy and sell. 100% of that fee is allocated creator / burn / holders / auto-LP / platform,
  with a 10% platform floor. Burn of the launch token happens in-swap to `0xdead`; quote-side
  burn accrues to `pendingBurn` (cannot `swap()` the same pool in `afterSwap`); `flushQuoteBurn`
  (permissionless, not automated) swaps that quote to the launch token in a later `unlock` and
  sends it to `0xdead`. Auto-LP accrues per-pool in `pendingAutoLp` (not factory `owed`, which is
  global per currency). `flushAutoLp` on the factory mints it into the locked position; leftover
  at the current tick is restowed. Holders still accrue pull-based like creator. Multiple
  factories can be allowed on the same hook.
- **`EveInstantV4Factory.sol`** — USDC (or any ERC-20 quote) Instant for meme + reflect. Per-create
  split, virtual quote, same-tx first buy. No Crucible leg. Auto-LP slice is per-pool on the hook;
  `flushAutoLp` mints it into the factory-owned position (`donate` is wrong: these pools have LP
  fee 0). Holders slice accrues to the address passed at create.
- **`RwaFeeHook.sol`** — the earlier 50/40/10 sketch this replaced. `RwaInstantV4Factory` now
  points at `EveFeeHook` instead (see below); this file is dead code, kept only because deleting
  it isn't this consolidation's job. Do not grow a second split model.
- **`RwaInstantV4Factory.sol`** — Instant quoted against an RWA (USYC, BUIDL, …), registered on
  the shared `EveFeeHook`. A general holders slice is banned here (a permissioned MMF token
  landing in random wallets is a real compliance problem) — `createTokenWithBundle` is the one
  sanctioned exception, see `BundleSink.sol` below.

Create UI: `/create` shows the fee chooser unless `NEXT_PUBLIC_ARC_INSTANT_V4=0`. New USDC meme
and reflect creates hit `EveInstantV4Factory`. The V3 Instant factory stays for tokens already
on that path.

## Live on Arc 5042 (2026-09-14)

Deployed with `script/DeployEveInstantV4.s.sol` through Arachnid's CREATE2 deployer
(`0x4e59b44847b379578588920cA78FbF26c0B4956C`) so the hook address carries
`AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA` (flags 68). Owner is passed into the hook constructor
so the CREATE2 factory is not locked as owner.

| Contract | Address |
| --- | --- |
| Uniswap `PoolManager` | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| `EveFeeHook` | `0x9fbA9571A43e5624a09F741911D4e51B0016C044` |
| `EveInstantV4Factory` | `0x9066C6Cc7eB666c43d1B07430E56fBB64255430a` |
| `EveV4Router` | `0x494715a3923392Dd0fD312B0CC40055679Feaad2` |
| `BundleSinkDeployer` | `0x987BD34E847AFAEbfa28aC86F64A97AD427e2E57` |
| `RwaInstantV4Factory` | `0x7739C8938Dfe76d1121af1Fb58fe0F34F633ddA7` |

PoolManager is Uniswap's official Arc address (`Uniswap/contracts` `deployments/json/5042.json`).
Factory `launchVirtualQuote` is `5500e6`. Owner / platform wallet is
`0x26bD491560b5175ee8bD1DA4998Fe260FfC413c9`.

`RwaInstantV4Factory` joined the same hook via `setFactoryAllowed` (USDC factory stays
allowed). BundleSink creation code lives on `BundleSinkDeployer` so the factory stays under
EIP-170.

The live hook/factories above are the pre-flush bytecode. Auto-LP mint (`flushAutoLp`) and
quote-burn swap (`flushQuoteBurn`) change hook + factory code. PoolKey binds the hook address,
so a new CREATE2 hook (same flags) and new factories are required; the router can stay.
Do not treat the table as "flush is already on 5042" until those addresses are retargeted.

Quote is per-create. Issuer token addresses (USYC / BUIDL / CRCL) are still unset on
mainnet, so those create cards stay Soon until `NEXT_PUBLIC_ARC_RWA_<ID>` is set.

HolderSink + EveV4Router live in this package. `HolderSink.distribute()` / `claim()` is the
Eve-factory reflect path (a fixed launch/quote pair). `BundleSink.sol` is the RWA-factory
equivalent for a creator-configured *basket* of assets instead of a fixed pair — see its own
section below.

## `RwaInstantV4Factory.sol` + `BundleSink.sol` — "earn RWAs automatically, just for holding"

`RwaFeeHook` (now retired) needed a keeper to call `collectFees()`-equivalent work — the exact
kind of thing that took a wall-clock-budget fix and keeper-key setup to keep alive elsewhere in
this repo (`lib/arc-indexer/run.ts`). `EveFeeHook` has no collection step at all: it's a v4
`afterSwap` hook, so every leg of the split settles atomically inside the swap itself.

- **`LaunchToken18.sol`** / **`LaunchToken18Tracked.sol`** — the plain 1B/18dp launch token, and a
  variant that notifies a `sink` contract on every transfer. `RwaInstantV4Factory` only deploys
  the tracked variant for a bundle-enabled launch (`createTokenWithBundle`); a plain launch keeps
  using the untracked one, same as before.
- **`RwaInstantV4Factory.sol`** — deploys the token, initializes a v4 pool (fee = 0; the hook
  replaces the LP fee entirely), registers the split on `EveFeeHook`, and mints the entire supply
  as a single-sided position at the extreme edge of the usable tick range (`minUsableTick`/
  `maxUsableTick`) — so the whole representable range sits above (or below) the starting price and
  100% of the deposit is the token, zero quote required. The position is owned by the factory
  inside `PoolManager`'s own accounting; nothing in this contract can ever call `modifyLiquidity`
  with a negative delta on it. That's the "no NFT withdraw, creator can't rug" guarantee
  CrucibleLock gives structurally instead of via a revert-guarded function.

### `BundleSink.sol` — the holders slice, generalized into a creator-configured basket

"Earn RWAs automatically, just for holding," from
[based.bid](https://x.com/basedbidx/status/2081029361965080803): a creator-configured basket of
assets (stocks, ETFs, other RWAs) that a pool's fees convert into and pay out to holders, either
**all-at-once** (every asset, every cycle, split by weight) or **rotating** (one asset per cycle,
cycling through the list).

This used to be a separate contract (`BundleVault`, briefly `BasketVault`) built against the now-
retired `RwaFeeHook`, with its own off-chain keeper computing holder balances and submitting
`disperse()` batches — the one real trust gap in that design. Consolidated here on top of
`EveFeeHook`'s `holders` slice and `HolderSink`'s on-chain accounting instead:

- **`pull(currency)` / `convert(fromCurrency, minOuts)`** — unchanged from `BundleVault`. Pull
  whatever accrued to this sink from the hook, swap it into the basket via real v4 pools (creator
  supplies the pool key per basket asset at `setBasket` time — mismatches revert rather than
  silently routing through the wrong pool). Both are permissionless; there is no keeper role left
  to trust for this half either.
- **On-chain, keeperless distribution** — the actual change. `HolderSink` already proved
  real-time, per-share accounting checkpointed via a tracked token's transfer hook, for a *fixed*
  launch/quote pair. `BundleSink` generalizes that same `accPerShare`/`debt`/`unclaimed` machinery
  over `trackedAssets` (every basket asset the creator has ever configured, append-only) instead
  of two hardcoded currencies. Every holder gets a real `claim()` / `claim(asset)`, correct at any
  instant, computed from their actual on-chain balance — no batches, no off-chain balance scan, no
  owner-gated `disperse()` anywhere in the contract. The only privileged action left at all is
  `setBasket`, gated to the launch's creator.
- **Why `RwaInstantV4Factory` can allow a holders slice here specifically, when it otherwise bans
  one**: the compliance concern that ban exists for is a permissioned MMF token landing directly
  in an arbitrary holder's wallet. Holders here never touch the raw quote asset — `convert()`
  swaps it into the creator's basket first, and only the converted asset is ever paid out.
- **One sink per pool, deliberately** — `EveFeeHook.owed[recipient][currency]` is keyed globally
  by (address, currency) across every pool the hook serves; a shared sink address reused across
  two pools that share a quote currency would land both pools' fees in the same slot with no way
  to tell whose money is whose. `createTokenWithBundle` deploys a fresh sink per launch to make
  that structurally impossible.
- **A real, disclosed tradeoff**: checkpointing on every transfer loops over `trackedAssets`, so
  gas scales with how many *distinct* assets a launch's basket has ever held — bounded by how
  often a creator actually reconfigures it, not by the current basket size, but not free either.
  Assets rotated out of the live basket stay claimable (`test_claim_stillWorksForAnAssetRotated
  OutOfTheLiveBasket` proves it); they just keep costing a checkpoint slot forever.

## Deliberately simpler than the v3 factory, for now

- **Starting valuation is optional.** `createToken(..., launchVirtualQuote, firstBuyQuoteAmount)`
  uses the same raw-unit encoding as Instant V3 (`VIRTUAL_TOKEN_INIT` vs quote raw). 0 falls
  back to the factory default (`setLaunchVirtualQuote`); if that is also 0 the pool still opens
  at the usable-tick edge. Pass `5500e6` on a 6dp quote for the ~$5.2k FDV Instant uses on USDC.
- **First buy is in the create tx.** Nonzero `firstBuyQuoteAmount` is pulled from the caller
  (approve the factory) and swapped quote→token inside the same `unlock()` as the LP mint. The
  hook taxes that swap like any other. 0 skips the swap. The original 4-arg `createToken` is
  launch-only.
- **The burn leg only sends the launch token to `0xdead` in-swap; a quote-side burn just
  accrues** (`pendingBurn`). `afterSwap` cannot `swap()` the same pool. `flushQuoteBurn(key,
  minOut)` (or `flushBurn(key, quote)` with `minOut = 0`) is permissionless and not automated:
  it unlocks, swaps quote → launch, and sends the launch token to dead. v4 skips `afterSwap`
  when the hook itself is the swapper, so this flush is not re-taxed. Callers who care about
  sandwiching pass a real `minOut`.
- **Auto-LP is `modifyLiquidity+` into the factory-owned position, not `donate`.** `pendingAutoLp`
  is keyed `(poolId, currency)` so two pools that share USDC cannot mix. `flushAutoLp(token)`
  is permissionless and not automated. In-range mint needs both sides (buy + sell inventory);
  a single-sided flush restows. Tick range is stored in `tickLowerOf` / `tickUpperOf` (`poolOf`
  stays 5 fields). The USDC factory `delegatecall`s `InstantAutoLpHelper` for the mint so its
  runtime stays under EIP-170; the RWA factory inlines the same library (more headroom after
  the BundleSink split).

## What's actually proven vs. what's still assumed

**Proven** — `forge test` deploys a real `PoolManager` (Uniswap's actual v4-core, vendored as a
submodule, not a mock) and real `PoolSwapTest`/`PoolModifyLiquidityTest` routers, launches tokens
against a mock RWA quote (plain and bundle-enabled), and swaps both directions:

```
forge test -vv
```

59/59 passing across the package (14 for the plain RWA launch path, 33 for the Eve meme/reflect
factory, 12 for `BundleSink`) — including a 256-run fuzz test that the Eve-factory split holds
*exactly* to its bps constants across trade sizes, a directional test proving the fee correctly
lands in the token on a buy and the quote on a sell (v4's specified/unspecified-currency
accounting is genuinely easy to get backwards), and — the highest-risk part of the `BundleSink`
work — a test with two genuinely different holders (one who traded, one who only ever received a
transfer) claiming real, proportionally-different amounts of a real basket asset with no keeper or
owner action anywhere in the path.

**Still unverified / not on mainnet:**
- **Any live RWA quote token.** USYC has a real Arc *testnet* address in
  `lib/arc-rwa-assets.ts`; nothing is wired as a mainnet Instant quote yet. Tests use
  `MockRwaToken`, a 6dp stand-in. The RWA factory is live; create cards stay Soon until
  the issuer token env is set.
- **A security review.** These hooks move real value on every swap, and `BundleSink` additionally
  moves real value through live AMM swaps on `convert()`. Get the specified/unspecified math, the
  `take()`/settle accounting, or the accrual bookkeeping wrong and it either bricks trading,
  misroutes fees, or lets a holder over-claim. The test suite proves the happy paths; it is not a
  substitute for an audit.

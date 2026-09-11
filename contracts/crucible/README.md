# Crucible lock piping

Fee engine for **new** ArcFun launches. Live Instant / Reflection lockers are **not** upgraded.

- Engine name: **Crucible** (never Furnace).
- Burn feed: **Burn tape**. The cook event is `Burn`.
- Burn target: `$EVE` `0x19209E55049bc613c5cC8b66B7DF7824096e78CF`, Uni V3 USDC fee **10000**. Immutable at construction.
- This PR does **not** deploy to Arc mainnet.

## Contracts

| Contract | Role |
|---|---|
| `Crucible` | Holds quote-side Crucible USDC. `$EVE` is **immutable**. `cook(amountIn, minOut)` swaps USDC→`$EVE` on SwapRouter02 and sends `$EVE` to `0x…dead`. Keeper-gated. |
| `CrucibleLock` | Holds the Uni V3 LP NFT. Permissionless `collectFees(tokenId)` pays USDC legs and burns sell-side token. **Does not swap. Does not cook.** `projectBurn` is keeper-gated. **No NFT withdraw.** |
| `ReferralRegistry` | Public first-come `code → payout` wallet. Code owner can `rotatePayout`. Codes are opaque strings, never `0x` addresses. Links: `https://www.arcfun.co/r/{code}`. |
| `ReferralRouter` | Buy-side wrapper. Live code (not self) skims **5 bps** of USDC in, then swaps the rest through FeeRouter / SwapRouter02. Sells stay on the existing path. |

## Swap execution is keeper-gated

`collectFees(tokenId)` stays permissionless. It moves USDC to fixed destinations and burns the sell-side token. It does not swap.

`CrucibleLock.projectBurn` and `Crucible.cook` are owner or `setKeeper` allowlist. `minOut` is caller-supplied, so an open entrypoint could pass `1` and accept a manipulated price. A TWAP floor was rejected: these pools launch with `observationCardinality = 1`.

## The burn target

`$EVE` is set in `Crucible(usdc, swapRouter, eve, evePoolFee)`. There is no setter. `setCookPaused(true)` stops cooking without touching the target.

Crucible and EveBurn are **separate sinks**: Crucible takes the LP-fee leg, EveBurn takes Instant-creator USDC from `@watch_eve` Blitz launches. A public burn total must add both, not double-count.

## Splits (bps of the collected 1% quote USDC, 10_000 = 100%)

**Meme:** Creator 5000, Crucible 3000, Project burn 1000, Platform 1000

**Reflect:** Holders 2000, Crucible 3500, Creator 2000, Project burn 1500, Platform 1000

- **Sell path:** collected launch token is 100% sent to dead. A launch token that refuses that transfer accrues to `owed[launch][dead]`. `withdrawOwed(launch, 0x…dead)` retries; anyone may call it.
- **Project burn:** USDC slice accrues on collect. A keeper calls `projectBurn(tokenId, minLaunchOut)` and buys the launch token on the same pool to dead.
- **Referrer:** not paid from collect. See ReferralRouter.
- Rounding dust goes to Crucible.
- A blacklisted USDC payee accrues to `owed[token][account]`.
- `lock` rejects a pair that does not include the quote. There is no NFT withdraw.

Old lockers stay 70/30 Meme and 50/25/25 Reflection. This lock is for **new** launches only.

## Per-trade referrals (ReferralRouter)

`collectFees` cannot see who referred a given buy. Collect folds the old 500 bps referrer leg into Crucible.

`ReferralRouter.buy(token, fee, amountIn, minOut, code)`:

- Empty, unknown, or self → no skim.
- Live payout (not the buyer) → **5 bps of the USDC in**, rest swaps through FeeRouter (or SwapRouter02).
- Direct Uni / aggregator swaps have no code and pay nobody.

Sells are not referred.

## Frontend ABI to match (live, do not break)

From `lib/arc-creator-fees.ts` (`MONLOCK_COLLECT_ABI`):

- `collectFees(uint256 tokenId) → (uint256 amount0, uint256 amount1)`
- `creatorSplits(uint256 tokenId) → (address wallet, uint16 bps)`

Live Instant (unchanged by this PR):

- INSTANT_LOCKER `0x84F486d7254aEDc89986bce392771D88bf5828EA`
- INSTANT_FACTORY `0xd51E6217bb3bC7586866713854Ea75B7BefF1009` (transparent proxy; impl `0x8a930e86fb0a33cac80fb4a73d20400ba48a0cc7`)
- SwapRouter02 `0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77`
- USDC `0x3600000000000000000000000000000000000000`
- Pool fee 1% (`10000`)

Token-page buys already call `ReferralRouter.buy` when `NEXT_PUBLIC_ARC_REFERRAL_ROUTER` is set.

## Owner knobs (no LP rug)

- `Crucible`: `setEvePoolFee`, `setSwapRouter` (revokes old approval), `setCookPaused`, `setKeeper`, `transferOwnership`. Burn target is immutable.
- `ReferralRouter`: `setSwapRouter` / `setFeeRouter` revoke the old contract's USDC approval.
- `CrucibleLock`: `setFactory`, `setPlatformWallet`, `setCrucible`, `setReferralRegistry`, `setSwapRouter` (revokes old approval), `transferOwnership`
- `withdrawNft` reverts `NoNftWithdraw`.

`lock(tokenId, creator, kind, holders, referrerCode)` is factory-or-owner. Empty code means no referrer. `referrerCodeHash` is stamped but collect does not pay it (referrals are per-trade). For Reflect, `holders` is required.

## How to deploy later (not this PR)

Do not run this against Arc mainnet from this PR.

1. Deploy `ReferralRegistry`.
2. Deploy `Crucible(usdc, swapRouter02, eve, 10000)` with `$EVE` `0x19209E55049bc613c5cC8b66B7DF7824096e78CF`.
3. Deploy `CrucibleLock(nfpm, usdc, swapRouter02, crucible, registry, platformWallet)`.
4. Deploy `ReferralRouter(usdc, swapRouter02, feeRouter, registry)`.
5. New Instant creates must lock NFTs here. The live Instant factory has **no `setLocker`**; locker is the MonLock in proxy storage. Switching means a new factory implementation and a ProxyAdmin upgrade (`0x724a342947eebd37548b92075cccd6f57361a9bd`, owner the bot). Instant factory source is not in this repo.
6. `lock.setFactory(instantFactory)` when that factory exists.
7. `lock.setKeeper(keeper, true)` and `crucible.setKeeper(keeper, true)`.
8. Keeper `cook(amountIn, minOut)` once Crucible holds USDC.

## Tests

```bash
cd contracts/crucible
forge install foundry-rs/forge-std
# or: ln -s ../arc-nft/lib/forge-std lib/forge-std
forge test -vv
```

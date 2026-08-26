# Crucible lock piping

Fee engine for **new** ArcFun launches. Live Instant / Reflection lockers are **not** upgraded.

- Engine name: **Crucible** (never Furnace).
- Burn feed: **Burn tape**. The cook event is `Burn`.
- `$ARCFUN` is **not launched**. `Crucible.arcfun` starts at `address(0)`.
- This PR does **not** deploy to Arc mainnet and does **not** spend USDC.

## Contracts

| Contract | Role |
|---|---|
| `Crucible` | Holds quote-side Crucible USDC. `setArcfun(address)` is **one-shot**. `cook(amountIn, minOut)` swaps USDC→ARCFUN on SwapRouter02 and sends ARCFUN to `0x…dead`. No zero-slippage overload, and **keeper-gated** (see Swap execution). |
| `CrucibleLock` | Holds the Uni V3 LP NFT. Permissionless `collectFees(tokenId)` (MonLock-compatible) pays USDC legs and burns sell-side token. **Does not swap. Does not cook.** `projectBurn(tokenId, minOut)` does the launch-token buy/burn and is **keeper-gated**. Referrer code is stamped at `lock`. **No NFT withdraw.** |
| `ReferralRegistry` | Public first-come `code → payout` wallet. Owner of a code can `rotatePayout`. Codes are opaque strings, never `0x` addresses. Links: `https://www.arcfun.co/r/{code}`. |

Optional minimal interfaces: `ISwapRouter02`, `INonfungiblePositionManager`, `ICrucible`, `IReferralRegistry`.

## Swap execution is keeper-gated

`collectFees(tokenId)` stays permissionless — it moves USDC to fixed destinations and burns the
sell-side token, and it does not swap, so it is not price-sensitive.

The two entrypoints that **do** swap, `CrucibleLock.projectBurn` and `Crucible.cook`, are
restricted to the owner or an address allowlisted via `setKeeper(address, bool)`.

Requiring `minOut != 0` is not sufficient on its own. Both functions take the bound from the
caller, so while they were open, an attacker could move the pool, pass `minOut = 1` to clear the
zero-check, and let the contract buy at the manipulated price in the same transaction — spending
the whole budget for dust. A caller-supplied floor cannot protect against that caller.

A TWAP-derived floor was considered instead. It was rejected for now because these pools launch
with `observationCardinality = 1`, which makes the TWAP manipulable in the same transaction it is
read; it would offer the appearance of protection without the substance. If cardinality is raised
at launch, an on-chain floor becomes a viable way to reopen these entrypoints to everyone.

## What `cook()` does while `arcfun` is unset

USDC transferred to Crucible is **held**. `cook(amountIn, minOut)` reverts `ArcfunUnset`. Nothing is bought. Nothing is sent to dead.

Once the owner calls `setArcfun(token)` (one-shot; cannot unset or repoint) and cook is not paused, a keeper calls `cook(amountIn, minArcfunOut)` with a quoted min. That swaps that USDC amount for ARCFUN and transfers ARCFUN to `0x000000000000000000000000000000000000dead`, then emits:

```
Burn(address indexed token, uint256 usdcIn, uint256 arcfunOut, uint256 ts)
```

Collect does **not** call cook. Owner can `setCookPaused(true)` to stop cooking without unsetting the token.

`setSwapRouter` revokes the previous router's USDC allowance. `setArcfunPoolFee(0)` reverts.

## Splits (bps of the collected 1% quote USDC, 10_000 = 100%)

Uniswap V3 pool fee on Instant launches is 1% (`fee = 10000`).

**Meme:** Creator 5000, Crucible 2500, Project burn 1000, Platform 1000, Referrer 500

**Reflect:** Holders 2000, Crucible 3000, Creator 2000, Project burn 1500, Platform 1000, Referrer 500

- **Sell path:** collected launch token is 100% sent to dead. Nobody is paid. No USDC from sells.
- **Project burn:** that USDC slice is accrued on collect. A keeper calls `projectBurn(tokenId, minLaunchOut)`, which buys the **launch** token on the same pool and sends it to dead. Collapsed price reverts instead of burning dust.
- **Missing / unknown referrer:** referrer 500 bps falls into Crucible (held until cook).
- Rounding dust goes to Crucible.
- A blacklisted payee (Circle USDC) accrues to `owed[token][account]` instead of reverting the whole collect. `withdrawOwed(token, to)` pulls it later.

Old lockers stay as they are (70/30 Meme, 50/25/25 Reflection). This lock is for **new** launches only.

## Honest referrer limitation (do not fake per-trade attribution)

Uniswap V3 LP fees accrue on the NFT. `collectFees(tokenId)` is **batched**, so this contract **cannot** know which trader's referral code applied to which dollars at collect time without a custom swap router.

Implemented behavior:

- Referrer is bound at `lock(..., referrerCode)`. One code per launch, not per trade.
- `collectFees(uint256 tokenId)` — MonLock ABI. No referrer argument. Pays the current registry payout for that stamped code, or folds 500 bps into Crucible if the code is empty / unregistered.
- There is **no** `collectFees(tokenId, address)` — that let any registered wallet claim the leg.

A keeper (or anyone) can collect. Rotate on the registry still flows through because collect resolves `payoutOfHash` live.

## Frontend ABI to match (live, do not break)

From `lib/arc-creator-fees.ts` (`MONLOCK_COLLECT_ABI`):

- `collectFees(uint256 tokenId) → (uint256 amount0, uint256 amount1)`
- `creatorSplits(uint256 tokenId) → (address wallet, uint16 bps)`

Live (unchanged by this PR):

- INSTANT_LOCKER `0x84F486d7254aEDc89986bce392771D88bf5828EA`
- INSTANT_FACTORY `0xd51E6217bb3bC7586866713854Ea75B7BefF1009`
- REFLECTION_LOCKER `0x20647d9cA81d31f0624aB9912eAf51892d62c24F`
- REFLECTION_FACTORY `0xa4957E724696b740b323fF3536415bB945e46828`
- Uni V3 FACTORY `0xf0db7b58379503491d857dB50AC9ece64c653918`
- NFPM `0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377`
- SWAP_ROUTER02 `0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77`
- USDC (6dp) `0x3600000000000000000000000000000000000000`
- Pool fee 1% (`10000`)

## Owner knobs (no LP rug)

- `Crucible`: `setArcfun` (one-shot), `setArcfunPoolFee`, `setSwapRouter` (revokes old), `setCookPaused`, `transferOwnership`
- `CrucibleLock`: `setFactory`, `setPlatformWallet`, `setCrucible`, `setReferralRegistry`, `transferOwnership`
- `withdrawNft` exists only to revert `NoNftWithdraw`. The LP NFT cannot leave this contract.

`lock(tokenId, creator, kind, holders, referrerCode)` is factory-or-owner. Empty `referrerCode` means no referrer. For Reflect, `holders` is the USDC recipient of the holders 2000 bps (typically the reflection token / fee sink). Factory should `approve` this locker (or mint the NFT with recipient = locker) then call `lock`.

## How to deploy later (not this PR)

Do not run this against Arc mainnet from this PR.

1. Deploy `ReferralRegistry`.
2. Deploy `Crucible(usdc, swapRouter02, 10000)` — leave `arcfun` unset.
3. Deploy `CrucibleLock(nfpm, usdc, swapRouter02, crucible, registry, platformWallet)`.
4. `lock.setFactory(newLaunchFactory)` when the new factory exists.
5. Allowlist the keeper on both contracts: `lock.setKeeper(keeper, true)` and `crucible.setKeeper(keeper, true)`.
6. After `$ARCFUN` exists and a USDC/ARCFUN 1% pool is live: `crucible.setArcfun(arcfun)` then a keeper may `cook(amountIn, minOut)`.

## Tests

Foundry already exists at `contracts/arc-nft` (forge-std + OZ submodules). This package is standalone.

```bash
cd contracts/crucible
forge install foundry-rs/forge-std
# or: ln -s ../arc-nft/lib/forge-std lib/forge-std
forge test -vv
```

`foundry.toml` also lists `../arc-nft/lib` so a full-repo checkout with submodules can reuse those libs.

# Crucible lock piping

Fee engine for **new** ArcFun launches. Live Instant / Reflection lockers are **not** upgraded.

- Engine name: **Crucible** (never Furnace).
- Burn feed: **Burn tape**. The cook event is `Burn`.
- `$ARCFUN` is **not launched**. `Crucible.arcfun` starts at `address(0)`.
- This PR does **not** deploy to Arc mainnet and does **not** spend USDC.

## Contracts

| Contract | Role |
|---|---|
| `Crucible` | Holds quote-side Crucible USDC. The `$EVE` burn target is **immutable**, fixed at construction. `cook(amountIn, minOut)` swaps USDC→`$EVE` on SwapRouter02 and sends `$EVE` to `0x…dead`. No zero-slippage overload, and **keeper-gated** (see Swap execution). |
| `CrucibleLock` | Holds the Uni V3 LP NFT. Permissionless `collectFees(tokenId)` (MonLock-compatible) pays USDC legs and burns sell-side token. **Does not swap. Does not cook.** Referrer 500 bps of the LP fee is folded into Crucible. `projectBurn` is **keeper-gated**. **No NFT withdraw.** |
| `ReferralRegistry` | Public first-come `code → payout` wallet. Owner of a code can `rotatePayout`. Codes are opaque strings, never `0x` addresses. Links: `https://www.arcfun.co/r/{code}`. |
| `ReferralRouter` | Buy-side wrapper. If a live code is passed (and not self), skims **5 bps** of USDC in to the payout wallet, then swaps the rest through FeeRouter / SwapRouter02. Sells stay on the existing path. |

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

## The burn target

`$EVE` `0x19209E55049bc613c5cC8b66B7DF7824096e78CF`, Uni V3 USDC pool fee **10000**. It is an
`immutable` set at construction — there is no setter, so it cannot be repointed by a mistaken or
compromised owner call, and no USDC ever accrues against an unset target. Same shape as
`EveBurn`. Owner can `setCookPaused(true)` to stop cooking without touching the target.

Crucible and EveBurn are **deliberately separate sinks**: Crucible takes the LP-fee leg from
launches, EveBurn takes Instant-creator USDC from `@watch_eve` Blitz launches. Both buy `$EVE`
and burn it, so any public burn total must reconcile the two rather than double-count them.


## Splits (bps of the collected 1% quote USDC, 10_000 = 100%)

Uniswap V3 pool fee on Instant launches is 1% (`fee = 10000`).

**Meme:** Creator 5000, Crucible 3000, Project burn 1000, Platform 1000

**Reflect:** Holders 2000, Crucible 3500, Creator 2000, Project burn 1500, Platform 1000

- **Sell path:** collected launch token is 100% sent to dead. Nobody is paid. No USDC from sells. A launch token that refuses the transfer to dead (pausable, blacklisting) accrues to `owed[launch][dead]` rather than reverting the collect — otherwise the project's own token could freeze the creator's, the platform's and Crucible's USDC. `withdrawOwed(launch, 0x…dead)` retries the burn; anyone may call it.
- **Project burn:** that USDC slice is accrued on collect. A keeper calls `projectBurn(tokenId, minLaunchOut)`, which buys the **launch** token on the same pool and sends it to dead. Collapsed price reverts instead of burning dust.
- **Referrer:** not paid from collect. See ReferralRouter.
- Rounding dust goes to Crucible.
- A blacklisted payee (Circle USDC) accrues to `owed[token][account]` instead of reverting the whole collect. `withdrawOwed(token, to)` pulls it later.
- `lock` rejects a position whose pair does not include the quote. There is no NFT withdraw, so a position this contract cannot collect on is one nobody could ever recover.

Old lockers stay as they are (70/30 Meme, 50/25/25 Reflection). This lock is for **new** launches only.

## Per-trade referrals (ReferralRouter)

Uniswap V3 LP fees accrue on the NFT, so `collectFees` cannot see who referred a given buy. Collect always folds the old 500 bps referrer leg into Crucible.

Anyone with a registered code can share `https://www.arcfun.co/r/{code}` at any time after launch. A buy through Arcfun's `ReferralRouter.buy(token, fee, amountIn, minOut, code)`:

- Resolves `payoutOf(code)`. Empty, unknown, or self → no skim, full amount swaps.
- Live payout (not the buyer) → **5 bps of the USDC in** to that wallet (same dollars as 5% of the 1% pool fee), rest swaps through the live FeeRouter (or SwapRouter02).
- Pays immediately. Rotate on the registry is live on the next buy.
- Direct Uni / aggregator swaps have no code and pay nobody.

Sells are not referred. This PR does not deploy the router to mainnet.

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

- `Crucible`: `setEvePoolFee`, `setSwapRouter` (revokes old approval), `setCookPaused`, `setKeeper`, `transferOwnership`. The burn target is immutable — no setter.
- `ReferralRouter`: `setSwapRouter` / `setFeeRouter` both revoke the old contract's USDC approval on rotation, matching `Crucible.setSwapRouter`. `_approveMax` grants an unlimited allowance, so a rotation that skipped the revoke would leave a de-authorised router able to pull whatever this contract holds.
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
6. A keeper may `cook(amountIn, minOut)` once the Crucible holds USDC.

## Tests

Foundry already exists at `contracts/arc-nft` (forge-std + OZ submodules). This package is standalone.

```bash
cd contracts/crucible
forge install foundry-rs/forge-std
# or: ln -s ../arc-nft/lib/forge-std lib/forge-std
forge test -vv
```

`foundry.toml` also lists `../arc-nft/lib` so a full-repo checkout with submodules can reuse those libs.

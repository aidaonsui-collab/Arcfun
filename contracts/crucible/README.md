# Crucible lock piping

Fee engine for **new** ArcFun launches. Live Instant / Reflection lockers are **not** upgraded.

- Engine name: **Crucible** (never Furnace).
- Burn feed: **Burn tape**. The cook event is `Burn`.
- `$ARCFUN` is **not launched**. `Crucible.arcfun` starts at `address(0)`.
- This PR does **not** deploy to Arc mainnet and does **not** spend USDC.

## Contracts

| Contract | Role |
|---|---|
| `Crucible` | Holds quote-side Crucible USDC. `setArcfun(address)` (owner, updateable). `cook()` swaps USDC→ARCFUN on SwapRouter02 and sends ARCFUN to `0x…dead`. |
| `CrucibleLock` | Holds the Uni V3 LP NFT. Permissionless `collectFees(tokenId)` (MonLock-compatible). Stamps creator wallet + bps at lock. **No NFT withdraw.** |
| `ReferralRegistry` | Public first-come `code → payout` wallet. Owner of a code can `rotatePayout`. Codes are opaque strings, never `0x` addresses. Links: `https://www.arcfun.co/r/{code}`. |

Optional minimal interfaces: `ISwapRouter02`, `INonfungiblePositionManager`, `ICrucible`, `IReferralRegistry`.

## What `cook()` does while `arcfun` is unset

USDC transferred to Crucible is **held**. `cook()` reverts `ArcfunUnset`. Nothing is bought. Nothing is sent to dead.

Once the owner calls `setArcfun(token)` (and cook is not paused), `cook()` / the collect path swaps the full USDC balance for ARCFUN and transfers ARCFUN to `0x000000000000000000000000000000000000dead`, then emits:

```
Burn(address indexed token, uint256 usdcIn, uint256 arcfunOut, uint256 ts)
```

Owner can `setCookPaused(true)` to stop cooking without unsetting the token.

## Splits (bps of the collected 1% quote USDC, 10_000 = 100%)

Uniswap V3 pool fee on Instant launches is 1% (`fee = 10000`).

**Meme:** Creator 5000, Crucible 2500, Project burn 1000, Platform 1000, Referrer 500

**Reflect:** Holders 2000, Crucible 3000, Creator 2000, Project burn 1500, Platform 1000, Referrer 500

- **Sell path:** collected launch token is 100% sent to dead. Nobody is paid. No USDC from sells.
- **Project burn:** that USDC slice buys the **launch** token on the same pool and sends it to dead.
- **Missing / unknown referrer:** referrer 500 bps falls into Crucible (held or cooked).
- Rounding dust goes to Crucible.

Old lockers stay as they are (70/30 Meme, 50/25/25 Reflection). This lock is for **new** launches only.

## Honest referrer limitation (do not fake per-trade attribution)

Uniswap V3 LP fees accrue on the NFT. `collectFees(tokenId)` is **batched**, so this contract **cannot** know which trader's referral code applied to which dollars at collect time without a custom swap router.

Implemented behavior:

- `collectFees(uint256 tokenId)` — MonLock ABI. Referrer bps always → Crucible.
- `collectFees(uint256 tokenId, address referrer)` — Referrer 500 bps is paid to `referrer` **only if** that address is a currently registered payout wallet in `ReferralRegistry`. Otherwise it folds into Crucible.

A keeper (or anyone) can collect. There is no per-swap code on the NFT.

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

- `Crucible`: `setArcfun`, `setArcfunPoolFee`, `setSwapRouter`, `setCookPaused`, `transferOwnership`
- `CrucibleLock`: `setFactory`, `setPlatformWallet`, `setCrucible`, `setReferralRegistry`, `transferOwnership`
- `withdrawNft` exists only to revert `NoNftWithdraw`. The LP NFT cannot leave this contract.

`lock(tokenId, creator, kind, holders)` is factory-or-owner. For Reflect, `holders` is the USDC recipient of the holders 2000 bps (typically the reflection token / fee sink). Factory should `approve` this locker (or mint the NFT with recipient = locker) then call `lock`.

## How to deploy later (not this PR)

Do not run this against Arc mainnet from this PR.

1. Deploy `ReferralRegistry`.
2. Deploy `Crucible(usdc, swapRouter02, 10000)` — leave `arcfun` unset.
3. Deploy `CrucibleLock(nfpm, usdc, swapRouter02, crucible, registry, platformWallet)`.
4. `lock.setFactory(newLaunchFactory)` when the new factory exists.
5. After `$ARCFUN` exists and a USDC/ARCFUN 1% pool is live: `crucible.setArcfun(arcfun)` then anyone may `cook()`.

## Tests

Foundry already exists at `contracts/arc-nft` (forge-std + OZ submodules). This package is standalone.

```bash
cd contracts/crucible
forge install foundry-rs/forge-std
# or: ln -s ../arc-nft/lib/forge-std lib/forge-std
forge test -vv
```

`foundry.toml` also lists `../arc-nft/lib` so a full-repo checkout with submodules can reuse those libs.

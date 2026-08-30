# Arc Instant launch contracts

Source for the contracts ArcFun's `/create` flow currently points at on Arc mainnet —
`InstantErc20QuoteFactory`, `MonLock`, `ArcBpsSource`. Brought into this repo for the first time;
nothing here has been deployed. ArcFun still points at the existing live addresses
(`.env.example` / `lib/contracts-arc.ts`) exactly as before.

## Where this came from

Pulled from `aidaonsui-collab/robots` (private), `contracts/monad-launchpad/`, at commit
`57336f3e082fd1d4e2440d1e56283b7e7762357a` (2026-08-30). That project targets several chains —
this only pulls the files actually reachable from the Arc USDC-quoted deploy path:

```
src/InstantErc20QuoteFactory.sol          the factory ArcFun's create flow calls
src/InstantErc20QuoteFactoryProxyInit.sol
src/MonLock.sol                           the locker — holds every creator's LP position
src/MonLockUUPS.sol
src/MonLockProxyInit.sol
src/ArcBpsSource.sol                      fee-split configuration
src/BondingCurveDexSeed.sol               \
src/UniV3Interfaces.sol                    | resolved by following the actual import graph,
src/LaunchToken18.sol                      | not guessed — every local import chased until it
src/GraduationStamper.sol                 /  closed on nothing but these + OZ/forge-std/v4-core
script/DeployInstantUsdcArc.s.sol         the Arc-specific deploy script
test/MonLock.t.sol
test/MonLockSecurity.t.sol
test/MonLockV2Guards.t.sol
test/MonLockBackingSplit.t.sol
```

`lib/forge-std`, `lib/openzeppelin-contracts`, `lib/v4-core` are real git submodules, matching
the convention already established in `contracts/arc-nft/` — not vendored copies. `v4-core` is
pinned to `59d3ecf53afa9264a16bba0e38f4c5d2231f80bc`, the exact commit `robots`' own
`foundry.lock` pins it to.

## Deliberately left out, and why

Three more files in `robots` share the `Instant*` naming but aren't part of what ArcFun actually
uses — checked individually rather than assumed:

- **`test/InstantLaunch.t.sol`** — tests `InstantLaunchFactory`, a bonding-curve variant. Not
  `InstantErc20QuoteFactory`; different contract entirely, name similarity aside.
- **`test/InstantErc20QuoteScanner.t.sol`** — imports plain `LaunchToken.sol`. The real deployed
  factory uses `LaunchToken18.sol` (confirmed: `InstantErc20QuoteFactory.sol` imports
  `LaunchToken18`, not `LaunchToken`) — this test exercises a different token variant.
- **`test/InstantErc20QuoteCreatorRewards.t.sol`** — depends on `CreatorRewardsRegistry.sol`,
  which is not referenced anywhere in ArcFun (grepped: zero hits). Not part of the live Arc
  deployment.

## Verified before trusting it, not after

- **Builds clean**: `forge build`, zero errors, only routine lint warnings.
- **45/45 tests pass**, including a 2000-run fuzz test and two reentrancy-guard tests
  (`MonLockSecurity.t.sol`).
- **The Arc deploy script's constants match the real chain**: `CHAIN_ARC = 5042`, USDC address
  `0x3600…0000`, and the env var names it tells you to set afterward
  (`NEXT_PUBLIC_ARC_INSTANT_FACTORY` / `NEXT_PUBLIC_ARC_INSTANT_LOCKER` /
  `NEXT_PUBLIC_ARC_BPS_SOURCE`) match this app's own `.env.example` exactly, including
  `MEME_CREATOR_BPS` defaulting to `7000` — the 70% creator split this app already observes
  on-chain.
- **Bytecode comparison — partial, reported honestly.** Compared this build's
  `InstantErc20QuoteFactory` against the live implementation
  (`0x8a930E86Fb0A33cAC80fB4a73d20400BA48a0cC7`, read via `cast code`). Not byte-identical. But:
  the dispatch preamble is identical, the **first function selector matches exactly**
  (`0x02255656`), and the trailing compiler-version marker matches solc `0.8.26` on both sides.
  Tried the repo's own `[profile.deploy]` (`optimizer_runs = 1`) — worse, not better, ruling that
  out. The remaining gap is most likely a solc/forge patch-version or an additional compile flag
  not captured in `robots`' checked-in `foundry.toml`, not a source mismatch — but this was not
  driven to a byte-exact match, and that gap should stay open rather than be quietly rounded up to
  "identical."

## What this is not

No new deployment. No env var changes. `NEXT_PUBLIC_ARC_INSTANT_FACTORY` and friends still point
at the existing live addresses. This is the source landing in this repo for the first time —
deploying it is a separate, later decision.

## Testnet self-contained deploy (Arc testnet 5042002 only)

Throwaway Uniswap V3 + Instant stack for Arc **testnet** (chain id `5042002`). Deploys a fresh
Uni V3 factory (testnet factories are spam — do not pick a "canonical" one), mock USDC (6dp),
WETH9, NFPM, SwapRouter02, ArcBpsSource, MonLock, and InstantErc20QuoteFactory.

This is **not** a mainnet deploy. It does **not** retarget live Instant
(`NEXT_PUBLIC_ARC_INSTANT_*` / `lib/contracts-arc.ts` still point at 5042). PR #91 remains a
source-only drop. Addresses printed by the script are throwaway testnet addresses.

Uni V3 is deployed from official solc 0.7.6 creation bytecode (see `script/bytecode/`) so Instant's
0.8.26 / via_ir profile never compiles Uni. Instant uses SwapRouter02 `exactInputSingle` without a
deadline — not v3-periphery SwapRouter. Do not assume mainnet USDC `0x3600…0000` exists on testnet.

### How to run

From `contracts/arc-instant/`:

```
forge script script/DeployInstantArcTestnet.s.sol:DeployInstantArcTestnet \
  --rpc-url $ARC_TESTNET_RPC \
  --broadcast
```

Required env: `PRIVATE_KEY` (keep it in your environment — do not paste it into chat or logs).
Optional: `TREASURY`, `OWNER`, `LP_RECIPIENT`, `STAKING_POOL`, `LOCK_DURATION`,
`CREATION_FEE_WEI`, `LAUNCH_VIRTUAL_QUOTE`, `MEME_CREATOR_BPS`, `MEME_STAKER_BPS`,
`SMOKE_CREATE=true` (mints mock USDC and creates Smoke/SMK with a 100 USDC first-buy).

In-memory stack test (no RPC, no broadcast):

```
forge test --match-contract InstantTestnetStack
```

The helper `script/InstantTestnetStack.sol` is not a Script (no chain-id require) so tests can
reuse it. The broadcast script is the only place that `require`s `5042002`.

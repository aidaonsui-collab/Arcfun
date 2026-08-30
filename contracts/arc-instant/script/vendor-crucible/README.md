# Vendored: contracts/crucible/src

This directory is a **copy** of `contracts/crucible/src/` as of commit
[`3bd95e9`](https://github.com/aidaonsui-collab/Arcfun/commit/3bd95e9cf39b93f17d63c9960332ad22f8bce024)
on `feat/instant-crucible-locker-adapter` (PR #99, based on the still-open `feat/crucible-lock`,
PR #65).

**Why vendored instead of imported in place:** `contracts/arc-instant` and `contracts/crucible`
are separate Foundry projects living on different branches right now — `contracts/arc-instant`
is on `main`, `contracts/crucible` only exists on `feat/crucible-lock` and its descendants. This
testnet deploy script needs both trees present simultaneously to compile and run, and there is
no commit yet where they both live on the same branch (that only happens once `feat/crucible-lock`
merges to `main`). Copying the ~10 small files here — with zero external dependencies beyond
each other (no forge-std, no OpenZeppelin) — was simpler and lower-risk than merging unrelated
history from `main` into a Crucible feature branch or vice versa, just to run one script.

**Canonical source:** `contracts/crucible/src/` on `feat/crucible-lock` (or `main`, once #65
merges). If you're reading this after that merge, this vendored copy is stale — delete this
directory and point `InstantCrucibleTestnetStack.sol`'s imports directly at
`contracts/crucible/src/` instead.

**Do not edit these files here.** If CrucibleLock/Crucible/ReferralRegistry/InstantLockerAdapter
need a change, make it in `contracts/crucible/src/` and re-copy.

Files: `CrucibleLock.sol`, `Crucible.sol`, `ReferralRegistry.sol`, `InstantLockerAdapter.sol`,
`interfaces/*.sol` (6 files).

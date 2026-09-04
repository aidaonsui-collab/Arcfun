# Verify ArcFun mainnet contracts on Arc explorer

Chain **5042**. Explorer UI: https://www.arcexplorer.org/contract/`<addr>`  
Custom verify API (not Blockscout): `POST https://www.arcexplorer.org/api/v1/contracts/verify`  
Status: `GET https://www.arcexplorer.org/api/v1/contracts/<addr>`

Also useful:

| Surface | URL | Notes |
| --- | --- | --- |
| Arcscan Etherscan API | `https://api.arc-scan.org/api?module=contract&action=getsourcecode&address=` | Works for status; **verification provider is Sourcify and does not list 5042 yet** (`/v1/verify/options` → `provider_supported: false`) |
| Arcscan RPC | `https://rpc.arc-scan.org` | Used for `cast code` / EIP-1967 slots |
| Legacy Blockscout host | `https://arcscan.app/api` | Does not resolve from this environment (2026-09-04) |
| forge `--verifier blockscout` | against arcexplorer `/api` | Returns HTML SPA shell — **not** a Blockscout verifier |

Rate limit on arcexplorer verify: **5 requests / hour** per IP (`ratelimit: "5-in-1hr"`). Failed attempts count.

### Verified this pass (2026-09-04 CT)

| Contract | Address | Explorer status |
| --- | --- | --- |
| CrucibleLock | `0xE522…928EA` → `0xE522907807CdDF006b433a103356d2c30ac39209` | `verified=true`, `verificationStatus=metadata_match` |
| ReferralRegistry | `0x1E61c1DBcD0E2147Ae2247285B6788dAa4564033` | `verified=true`, `verificationStatus=metadata_match` |

Still unverified: **EveBurn** (ctor-arg / immutable blocker — not rate limit alone), ArcBpsSource, Crucible, InstantLockerAdapter, Instant/MonLock impls, Robin OTC.

### EveBurn retry (2026-09-04 ~15:25–15:40 CT)

Flattened single-file POST (same method as CrucibleLock/ReferralRegistry). Confirmed locally:

- `forge` artifact creation bytecode **byte-identical** to creation tx `0x47ff…e394` prefix; suffix = ABI-encoded ctor `(0x3600…0000, SwapRouter02, 0x1920…78CF, 10000)`.
- Runtime length 3030; metadata CBOR/IPFS CID **identical** to on-chain; only immutable slots (`usdc`, `eve`) differ until ctor args are applied.
- UI verify form sends only `{address, compilerVersion, contractPath, contractName, sources, settings.optimizer}` — **no** `constructorArguments` / `viaIR` / `evmVersion`.

API responses (all HTTP **422**, `verificationStatus` stays `failed`, `verified=false`):

```text
{"error":"Error: Compiled runtime bytecode does not match the deployed contract\n    at main (file:///app/src/verify-worker.js:68:41)\n    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)"}
```

Tried (each counted against 5/hr): hex `constructorArguments` (no/`0x` prefix); `constructorArguements` + `constructorArgs`; `autodetectConstructorArguments: true`; JSON-array decoded args; extra `creationBytecode`/`deployedBytecode` fields. Same 422 body every time.

Also: `api.arc-scan.org` `verifysourcecode` refuses chain 5042 (Sourcify `provider_supported: false`). Blocker is **arcexplorer verify-worker not applying constructor args / immutableReferences** — not local bytecode mismatch. Contracts without runtime immutables (CrucibleLock, ReferralRegistry) still verify via flattened POST → `metadata_match`.

## Inventory (5042)

| Name | Address | Kind | Explorer | Local source | Settings that body-match | Verified? | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Instant factory (live) | `0x05BF9d713E1f58779aD4Dd8d6Fef4C7529c7323a` | EIP-1967 proxy | [link](https://www.arcexplorer.org/contract/0x05BF9d713E1f58779aD4Dd8d6Fef4C7529c7323a) | OZ TransparentUpgradeableProxy | n/a (proxy) | no | impl → `0x2a0a428807ef78768d0db23b3607a09707a9077d` |
| Instant live impl | `0x2a0a428807ef78768d0db23b3607a09707a9077d` | implementation | [link](https://www.arcexplorer.org/contract/0x2a0a428807ef78768d0db23b3607a09707a9077d) | `InstantErc20QuoteFactoryProxyInit` | closest: solc 0.8.26 / viaIR / opt 200 / cancun — **not byte-identical** (same len 15329, prefix≈15201) | no | Do not claim match. Immutables: USDC/6/WETH |
| Instant factory ($EVE / PREV) | `0xd51E6217bb3bC7586866713854Ea75B7BefF1009` | EIP-1967 proxy | [link](https://www.arcexplorer.org/contract/0xd51E6217bb3bC7586866713854Ea75B7BefF1009) | OZ TUP | n/a | no | impl → `0x8a930E86Fb0A33cAC80fB4a73d20400BA48a0cC7` |
| Instant PREV impl | `0x8a930E86Fb0A33cAC80fB4a73d20400BA48a0cC7` | implementation | [link](https://www.arcexplorer.org/contract/0x8a930E86Fb0A33cAC80fB4a73d20400BA48a0cC7) | vendored Instant tree | **known mismatch** vs this repo (see `contracts/arc-instant/README.md`) | no | README: not byte-identical; first selector + solc 0.8.26 marker only |
| MonLock (locker for PREV/LEGACY) | `0x84F486d7254aEDc89986bce392771D88bf5828EA` | EIP-1967 proxy | [link](https://www.arcexplorer.org/contract/0x84F486d7254aEDc89986bce392771D88bf5828EA) | OZ TUP | n/a | no | impl → `0x701ba347bbd231e604fbc4303d5a2dce8abe52ed` |
| MonLock impl | `0x701ba347bbd231e604fbc4303d5a2dce8abe52ed` | implementation | [link](https://www.arcexplorer.org/contract/0x701ba347bbd231e604fbc4303d5a2dce8abe52ed) | `src/MonLock.sol` / `MonLockUUPS.sol` | no match in matrix (prologue differs; on-chain has **no** solc metadata trailer) | no | Likely different compile flags / bytecode_hash=none strip |
| ArcBpsSource | `0xFCF6Bf9A66AA167BfE4F6165bb04baEd97B6C2aE` | plain | [link](https://www.arcexplorer.org/contract/0xFCF6Bf9A66AA167BfE4F6165bb04baEd97B6C2aE) | `src/ArcBpsSource.sol` | **body** = cancun + viaIR + opt 200 + `bytecode_hash=none` **with metadata trailer stripped on-chain** | no | On-chain runtime is 1109 B; local same body + 13 B solc CBOR. arcexplorer exact-match fails |
| EveBurn | `0x292C8Fd478eC224aAC5CAf338c4d3B67203e899E` | plain | [link](https://www.arcexplorer.org/contract/0x292C8Fd478eC224aAC5CAf338c4d3B67203e899E) | `contracts/eve-burn/src/EveBurn.sol` | **exact**: solc 0.8.26, **viaIR false**, opt 200, cancun, ipfs; ctor `(usdc, swapRouter, eve, 10000)` | **no** (blocked) | Local creation bytecode == creation tx; metadata CID identical. Worker ignores ctor args → immutables mismatch. See “EveBurn retry” below |
| CrucibleLock (`NEXT_PUBLIC_ARC_INSTANT_LOCKER`) | `0xE522907807CdDF006b433a103356d2c30ac39209` | plain | [link](https://www.arcexplorer.org/contract/0xE522907807CdDF006b433a103356d2c30ac39209) | `script/vendor-crucible/src/CrucibleLock.sol` | **body** match: cancun + viaIR + opt 200 + ipfs (only metadata IPFS CID differs) | **yes** (`metadata_match`, 2026-09-04) | Flattened single-file submit succeeded. Multi-file std-json returned HTTP 500 |
| InstantLockerAdapter | `0x9deBd8d2CFa7dA789257146D325Af4094B1c1c5f` | plain | [link](https://www.arcexplorer.org/contract/0x9deBd8d2CFa7dA789257146D325Af4094B1c1c5f) | `script/vendor-crucible/src/InstantLockerAdapter.sol` | **body** match same settings (CID differs) | pending | Immutables: CrucibleLock + NFPM |
| Crucible (burn sink) | `0x0B3Eb6Cef8B2b3b158c560898Ead0127f08AE6B6` | plain | [link](https://www.arcexplorer.org/contract/0x0B3Eb6Cef8B2b3b158c560898Ead0127f08AE6B6) | `script/vendor-crucible/src/Crucible.sol` | **body** match same settings (CID differs) | pending | From CrucibleLock.crucible() |
| ReferralRegistry | `0x1E61c1DBcD0E2147Ae2247285B6788dAa4564033` | plain | [link](https://www.arcexplorer.org/contract/0x1E61c1DBcD0E2147Ae2247285B6788dAa4564033) | `script/vendor-crucible/src/ReferralRegistry.sol` | cancun + viaIR + opt 200 | **yes** (`metadata_match`, 2026-09-04) | From CrucibleLock.referralRegistry() |
| Robin OTC liquidity | `0xBD06241e272d05449A034abc0cfd558905c4aE3e` | plain | [link](https://www.arcexplorer.org/contract/0xBD06241e272d05449A034abc0cfd558905c4aE3e) | **not in this repo** (ABI only under `subgraph/`) | — | no | Default in `lib/bridge/robin-otc.ts` `OTC_DEFAULTS.liquidity` |
| Fee router (`.env.example`) | `0x8d051f7FCf2F67f272b6ec96dAf2e9a847633394` | plain | [link](https://www.arcexplorer.org/contract/0x8d051f7FCf2F67f272b6ec96dAf2e9a847633394) | not under `contracts/arc-instant` | — | no | `lib/contracts-arc.ts` hardcodes a **different** default `0x6795…f088` |
| Instant LEGACY factory | `0x607bff9EB2ff1494AC8f0b545502Ce49ee2Ae42B` | EIP-1967 proxy | [link](https://www.arcexplorer.org/contract/0x607bff9EB2ff1494AC8f0b545502Ce49ee2Ae42B) | — | — | no | impl `0x61655fF3b76E21bEC788916242365a96cf0d5E85` |
| Reflection factory / locker | `0xa495…` / `0x2064…` | proxies | — | not in arc-instant drop | — | no | From `.env.example` |
| NFT factory / Disperse | `0x0b7a…` / `0xE13D…` | — | — | `contracts/arc-nft` | — | no | Out of Instant priority |

## Method used (2026-09-04)

1. Shallow-cloned this repo; `git submodule update --init` under `contracts/arc-instant/lib`.
2. Inventoried addresses from `.env.example`, `lib/contracts-arc.ts`, deploy script constants, and on-chain views (`crucible()`, `referralRegistry()`, EIP-1967 slot `0x3608…`).
3. Compared `cast code` vs `forge`/`solc` artifacts with an anvil create simulation (needed for immutable-bearing contracts).
4. Attempted `forge verify-contract --verifier blockscout --verifier-url https://www.arcexplorer.org/api` → HTML, not Blockscout.
5. Submitted to arcexplorer `POST /api/v1/contracts/verify` (requires `compilerVersion` like `0.8.26+commit.8a97fa7a`). Hit **5/hr** after EveBurn/ArcBps mismatch attempts.
6. Arcscan `/v1/verify` is Sourcify-backed and refuses 5042 until Sourcify lists the chain.

## Instant bytecode gap (do not claim match)

- PREV impl `0x8a930E…`: documented in `contracts/arc-instant/README.md` — vendored tree is **not** byte-identical; dispatch preamble / first selector `0x02255656` / solc `0.8.26` marker only.
- Live impl `0x2a0a42…`: closest local build is `InstantErc20QuoteFactoryProxyInit` with cancun + viaIR + opt 200 (runtime length 15329). Prefix match ~15201/15329 — **not** body-identical. Likely robots-tree delta or uncaptured compile flag. Prefer verifying **implementation only** once a robots commit reproduces bytecode; do not verify claiming the vendored Arcfun tree matches.

## How to finish verification after rate limit

```bash
# from repo root
./scripts/verify-arc.sh status          # getsource / arcexplorer status for inventory
./scripts/verify-arc.sh submit-eve      # EveBurn — blocked until explorer applies ctor/immutables
./scripts/verify-arc.sh submit-crucible # CrucibleLock multi-file standard-json
```

Prefer multi-file `sources` maps (paths as in deploy) so metadata IPFS CIDs can match. Flattened single-file bodies often match while CIDs differ — arcexplorer compares **exact** runtime bytecode today.

Constructor for EveBurn (must match on-chain immutables):

```text
usdc       0x3600000000000000000000000000000000000000
swapRouter 0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77
eve        0x19209E55049bc613c5cC8b66B7DF7824096e78CF
evePoolFee 10000
```

CrucibleLock ctor (storage only — does not affect runtime code):

```text
nfpm, usdc, swapRouter, crucible, referralRegistry, platformWallet
= NFPM, 0x3600…0000, SwapRouter02, 0x0B3E…B6, 0x1E61…33, 0x26bD…C9
```

## Out of scope

No fee-routing changes. No Instant→CrucibleLock wiring changes. Docs/script only.

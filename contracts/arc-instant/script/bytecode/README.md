# Official Uniswap V3 creation bytecode

Throwaway Uni V3 for Arc **testnet 5042002** Instant. These hex files are official published
creation bytecode with **empty `linkReferences`** (no library linking). Instant is solc 0.8.26 /
via_ir / optimizer_runs 200 — **do not compile Uni with Instant's foundry profile**. Uni V3 is
solc 0.7.6; deploying from these artifacts avoids PUSH0 on an unknown testnet EVM.

Hex files keep the `0x` prefix. Confirm no `__$` placeholders before deploy.

| Contract | Package | unpkg | sha256 of hex file |
| --- | --- | --- | --- |
| UniswapV3Factory | `@uniswap/v3-core@1.0.1` | https://unpkg.com/@uniswap/v3-core@1.0.1/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json | `56a5c814569c7c598c7c9f70bf173a875a70f21c533bb74295b92ff7725a4529` |
| NonfungiblePositionManager | `@uniswap/v3-periphery@1.4.4` | https://unpkg.com/@uniswap/v3-periphery@1.4.4/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json | `8520d0ab6269f65ec0276c89f5fb52054e41abf63d67378426607a87c4031489` |
| SwapRouter02 | `@uniswap/swap-router-contracts@1.3.0` | https://unpkg.com/@uniswap/swap-router-contracts@1.3.0/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json | `3d4afc2c84e59df869b72e75c90192577dd0dfadd0e8f23dd25a08304041dd1a` |

Constructor args (ABI-encoded, packed after creation bytecode):

- **UniswapV3Factory** — none. Default fee `10000` → tickSpacing `200` is enabled in the factory ctor.
- **NonfungiblePositionManager** — `(_factory, _WETH9, _tokenDescriptor_)`
- **SwapRouter02** — `(_factoryV2, factoryV3, _positionManager, _WETH9)`. Instant uses SwapRouter02
  `exactInputSingle` **without a deadline**. Do **not** use v3-periphery `SwapRouter`. Testnet
  deploys pass `factoryV2 = address(0)`.

Deploy via `create` of `abi.encodePacked(creation, ctorArgs)`.

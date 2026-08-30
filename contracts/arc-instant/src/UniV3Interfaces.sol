// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal Uniswap V3 surface used by the launchpad graduation. Monad mainnet (chainId
///         143): Factory 0x204faca1764b154221e35c0d20abb3c525710498, NonfungiblePositionManager
///         0x7197e214c0b767cfb76fb734ab638e2c192f4e53, feeAmountTickSpacing(10000)=200.
interface INonfungiblePositionManager {
    /// @notice The canonical Uniswap V3 factory this position manager mints pools under. Lets the
    ///         launchpad factories resolve the factory address for a launch token's own CREATE2 pool
    ///         pre-computation without a new config slot.
    function factory() external view returns (address);

    /// @dev Inherited from PoolInitializer. Creates the pool if needed and initializes its price.
    ///      Returns the pool address. Idempotent on price if the pool already exists.
    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);

    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    struct IncreaseLiquidityParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    /// @notice Add liquidity to an existing position. Tokens are pulled from `msg.sender`.
    function increaseLiquidity(IncreaseLiquidityParams calldata params)
        external
        payable
        returns (uint128 liquidity, uint256 amount0, uint256 amount1);
}

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

/// @notice Wrapped MON (WETH9-style). The launchpad raises native MON, then wraps it to WMON to
///         pair with the launch token in a Uniswap V3 pool (UniV3 LPs are ERC-20s, not native).
///         Monad mainnet WMON: 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A.
interface IWMON {
    function deposit() external payable;
    function withdraw(uint256) external;
}

/// @notice Minimal MonLock surface the factory calls to atomically stamp a freshly-minted LP lock.
///         UniV3 `mint` uses `_mint` (no ERC721 receive hook), so the factory must call `lockPosition`
///         itself after minting the position to the locker. The locker validates it actually holds the
///         tokenId, so a spurious call is a no-op revert (which the factory swallows).
interface ILpLocker {
    function lockPosition(uint256 tokenId) external returns (uint64 unlockTime);
    /// @notice Stamp a lock that routes `backingBps` of collected fees to `backingWallet` (the rest to
    ///         the beneficiary). Caller must be the locker's authorized `stamper` (this factory).
    function lockPositionWithBacking(uint256 tokenId, address backingWallet, uint16 backingBps)
        external
        returns (uint64 unlockTime);
    /// @notice Stamp a lock with a 3-way fee split: `backingBps` → `backingWallet`, `stakerBps` →
    ///         `stakerWallet` (the staking pool), the rest → beneficiary. Stamper-only.
    function lockPositionWithSplit(
        uint256 tokenId,
        address backingWallet,
        uint16 backingBps,
        address stakerWallet,
        uint16 stakerBps
    ) external returns (uint64 unlockTime);
    /// @notice Meme post-bond: launch-token LP fees burn; quote (WMON/WETH) → staker/creator/platform.
    function lockPositionMeme(
        uint256 tokenId,
        address launchToken,
        address quoteToken,
        address stakerWallet,
        uint16 stakerBps,
        address creatorWallet,
        uint16 creatorBps
    ) external returns (uint64 unlockTime);
    /// @notice Backed post-bond: launch-token LP fees burn (all slices); quote → backing/creator/staker/platform.
    function lockPositionWithSplitLaunch(
        uint256 tokenId,
        address launchToken,
        address quoteToken,
        address backingWallet,
        uint16 backingBps,
        address stakerWallet,
        uint16 stakerBps,
        address creatorWallet,
        uint16 creatorBps
    ) external returns (uint64 unlockTime);
    /// @notice Dex-seed meme lock at launch: fees active immediately; principal locked only after
    ///         `finalizeDexSeedLock` at graduation. Stamper-only. Returns unlockTime=0 until finalize.
    function lockDexSeedPosition(
        uint256 tokenId,
        address launchToken,
        address quoteToken,
        address creatorWallet,
        address stakerWallet,
        uint16 creatorBps,
        uint16 stakerBps
    ) external returns (uint64 unlockTime);
    /// @notice Dex-seed backed lock (RWA/perp): launch burn + backing/staker/creator quote split;
    ///         principal deferred until finalize. Stamper-only.
    function lockDexSeedPositionBacked(
        uint256 tokenId,
        address launchToken,
        address quoteToken,
        address backingWallet,
        uint16 backingBps,
        address stakerWallet,
        uint16 stakerBps,
        address creatorWallet,
        uint16 creatorBps
    ) external returns (uint64 unlockTime);
    /// @notice Start the 365d principal lock on a dex-seed position at curve graduation. Factory-only.
    function finalizeDexSeedLock(uint256 tokenId) external returns (uint64 unlockTime);
    /// @notice Factory-only: pull tokens from factory and increase liquidity on a held position.
    ///         Refunds unused token0/token1 to `msg.sender` (the factory).
    function increaseLiquidity(uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired)
        external
        returns (uint128 liquidity, uint256 amount0, uint256 amount1);
}

/// @notice Read surface used only by the fork test (assert the migrated pool's price + liquidity).
interface IUniswapV3PoolState {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    function liquidity() external view returns (uint128);
}

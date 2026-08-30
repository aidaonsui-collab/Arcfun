// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {INonfungiblePositionManager, IWMON, ILpLocker} from "./UniV3Interfaces.sol";
import {IGraduationStamper, StampParams} from "./GraduationStamper.sol";

/**
 * @title BondingCurveDexSeed
 * @notice Linked library for UniV3 seed + graduation paths. `external` functions are DELEGATECALLed
 *         from BondingCurveFactory so `address(this)` / ETH / token balances stay on the factory.
 *         Extracted to keep the factory under EIP-170 (24KB) after dex-seed landed.
 */
library BondingCurveDexSeed {
    using SafeERC20 for IERC20;

    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;

    /// @dev UniV3 + fee-routing knobs the factory passes in (immutables/storage the lib cannot see).
    struct Config {
        address wmon;
        address nfpm;
        address locker;
        address lpRecipient;
        address treasury;
        address stakingPool;
        address graduationStamper;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 lpBackingBps;
        uint16 lpStakerBps;
        uint16 lpCreatorBps;
        uint16 lpMemeCreatorBps;
        uint16 lpMemeStakerBps;
    }

    struct SeedResult {
        address pool;
        uint256 positionId;
        uint128 seedLiquidity;
        uint256 seedEthWei;
    }

    // Event signatures match BondingCurveFactory so indexers keep working (log address = factory).
    event DexSeeded(
        address indexed token, address pool, uint256 indexed positionId, uint256 seedTokens, uint256 seedEthWei
    );
    event DexSeedFinalized(
        address indexed token, uint256 indexed positionId, uint64 unlockTime, uint256 addedTokens, uint256 addedEth
    );
    event PoolMigrated(
        address indexed token, address pool, uint256 tokenId, uint128 liquidity, uint256 tokenUsed, uint256 quoteUsed
    );
    event LpAutoLocked(address indexed token, uint256 indexed tokenId, uint64 unlockTime);

    /// @notice Mint thin full-range seed LP to locker and stamp dex-seed lock (meme or backed).
    /// @param isMeme true → meme LP fee bps; false → backed bps with `backingWallet`.
    function seedDexPool(
        Config memory cfg,
        address token,
        address creator,
        address backingWallet,
        bool isMeme,
        uint256 vQuote,
        uint256 vToken,
        uint256 seedTokens,
        uint256 seedEthWei
    ) external returns (SeedResult memory result) {
        IWMON(cfg.wmon).deposit{value: seedEthWei}();
        address wmon = cfg.wmon;

        (address token0, address token1) = token < wmon ? (token, wmon) : (wmon, token);
        bool launchIsToken0 = (token0 == token);
        uint160 sqrtP = sqrtPriceX96(launchIsToken0, vQuote, vToken);

        INonfungiblePositionManager pm = INonfungiblePositionManager(cfg.nfpm);
        address pool = pm.createAndInitializePoolIfNecessary(token0, token1, cfg.poolFee, sqrtP);

        (uint256 tokenId, uint128 liquidity, uint256 used0, uint256 used1) = _mintFullRange(
            cfg, token, wmon, launchIsToken0, seedTokens, seedEthWei, cfg.locker, sqrtP
        );

        uint256 quoteUsed = launchIsToken0 ? used1 : used0;
        uint256 tokenUsed = launchIsToken0 ? used0 : used1;
        uint256 quoteLeft = seedEthWei - quoteUsed;
        uint256 tokenLeft = seedTokens - tokenUsed;
        if (quoteLeft > 0) IERC20(wmon).safeTransfer(cfg.treasury, quoteLeft);
        if (tokenLeft > 0) IERC20(token).safeTransfer(cfg.treasury, tokenLeft);

        result = SeedResult({pool: pool, positionId: tokenId, seedLiquidity: liquidity, seedEthWei: seedEthWei});

        _stampDexSeed(cfg, token, creator, backingWallet, isMeme, wmon, tokenId);
        emit DexSeeded(token, pool, tokenId, seedTokens, seedEthWei);
    }

    /// @notice Merge LP_RESERVE + raised quote into existing seed position; finalize principal lock.
    /// @param quoteAmt Raised ETH already zeroed from the pool by the factory (effects-before-calls).
    function graduateIntoExisting(
        Config memory cfg,
        address token,
        address creator,
        address backingWallet,
        bool isMeme,
        uint256 vQuote,
        uint256 vToken,
        uint256 quoteAmt,
        address seedPool,
        uint256 seedId
    ) external {
        if (cfg.nfpm == address(0) || cfg.locker == address(0) || seedId == 0) return;

        uint256 tokenAmt = IERC20(token).balanceOf(address(this));
        IWMON(cfg.wmon).deposit{value: quoteAmt}();
        address wmon = cfg.wmon;

        (address token0,) = token < wmon ? (token, wmon) : (wmon, token);
        bool launchIsToken0 = (token0 == token);
        (uint256 amount0Desired, uint256 amount1Desired) =
            launchIsToken0 ? (tokenAmt, quoteAmt) : (quoteAmt, tokenAmt);

        IERC20(token).forceApprove(cfg.locker, tokenAmt);
        IERC20(wmon).forceApprove(cfg.locker, quoteAmt);

        uint256 tokenUsed;
        uint256 quoteUsed;
        uint128 liqAdded;
        bool merged;
        try ILpLocker(cfg.locker).increaseLiquidity(seedId, amount0Desired, amount1Desired) returns (
            uint128 liquidity, uint256 used0, uint256 used1
        ) {
            liqAdded = liquidity;
            tokenUsed = launchIsToken0 ? used0 : used1;
            quoteUsed = launchIsToken0 ? used1 : used0;
            merged = true;
        } catch {}

        IERC20(token).forceApprove(cfg.locker, 0);
        IERC20(wmon).forceApprove(cfg.locker, 0);

        if (!merged) {
            uint256 tokenLeft = IERC20(token).balanceOf(address(this));
            uint256 wmonLeft = IERC20(wmon).balanceOf(address(this));
            if (tokenLeft > 0 && wmonLeft > 0) {
                uint160 sqrtP = sqrtPriceX96(launchIsToken0, vQuote, vToken);
                (uint256 newId, uint128 newLiq, uint256 u0, uint256 u1) =
                    _mintFullRange(cfg, token, wmon, launchIsToken0, tokenLeft, wmonLeft, cfg.locker, sqrtP);
                tokenUsed = launchIsToken0 ? u0 : u1;
                quoteUsed = launchIsToken0 ? u1 : u0;
                liqAdded = newLiq;
                emit PoolMigrated(token, seedPool, newId, newLiq, tokenUsed, quoteUsed);
                _stampGrad(cfg, token, creator, backingWallet, isMeme, wmon, newId);
            }
        } else {
            emit PoolMigrated(token, seedPool, seedId, liqAdded, tokenUsed, quoteUsed);
        }

        {
            uint256 tokenLeft = IERC20(token).balanceOf(address(this));
            uint256 wmonLeft = IERC20(wmon).balanceOf(address(this));
            if (tokenLeft > 0) IERC20(token).safeTransfer(cfg.treasury, tokenLeft);
            if (wmonLeft > 0) IERC20(wmon).safeTransfer(cfg.treasury, wmonLeft);
        }

        uint64 unlockTime;
        try ILpLocker(cfg.locker).finalizeDexSeedLock(seedId) returns (uint64 t) {
            unlockTime = t;
            emit LpAutoLocked(token, seedId, t);
        } catch {}
        emit DexSeedFinalized(token, seedId, unlockTime, tokenUsed, quoteUsed);
    }

    /// @notice Standard (non-dex-seed) graduation: wrap raised quote, mint full-range, stamp lock.
    /// @param quoteAmt Raised ETH already zeroed from the pool by the factory.
    function graduateFresh(
        Config memory cfg,
        address token,
        address creator,
        address backingWallet,
        bool isMeme,
        uint256 vQuote,
        uint256 vToken,
        uint256 quoteAmt
    ) external {
        if (cfg.nfpm == address(0)) return;

        uint256 tokenAmt = IERC20(token).balanceOf(address(this));
        IWMON(cfg.wmon).deposit{value: quoteAmt}();
        address wmon = cfg.wmon;

        (address token0,) = token < wmon ? (token, wmon) : (wmon, token);
        bool launchIsToken0 = (token0 == token);
        uint160 sqrtP = sqrtPriceX96(launchIsToken0, vQuote, vToken);

        address lpDest = cfg.locker != address(0) ? cfg.locker : cfg.lpRecipient;
        address pool = INonfungiblePositionManager(cfg.nfpm).createAndInitializePoolIfNecessary(
            launchIsToken0 ? token : wmon, launchIsToken0 ? wmon : token, cfg.poolFee, sqrtP
        );

        (uint256 tokenId, uint128 liquidity, uint256 used0, uint256 used1) =
            _mintFullRange(cfg, token, wmon, launchIsToken0, tokenAmt, quoteAmt, lpDest, sqrtP);

        uint256 quoteUsed = launchIsToken0 ? used1 : used0;
        uint256 tokenUsed = launchIsToken0 ? used0 : used1;
        uint256 quoteLeft = quoteAmt - quoteUsed;
        uint256 tokenLeft = IERC20(token).balanceOf(address(this));
        if (quoteLeft > 0) IERC20(wmon).safeTransfer(cfg.treasury, quoteLeft);
        if (tokenLeft > 0) IERC20(token).safeTransfer(cfg.treasury, tokenLeft);

        emit PoolMigrated(token, pool, tokenId, liquidity, tokenUsed, quoteUsed);

        if (cfg.locker != address(0)) {
            _stampGrad(cfg, token, creator, backingWallet, isMeme, wmon, tokenId);
        }
    }

    // ─── internals ─────────────────────────────────────────────────────────────────────────

    function _mintFullRange(
        Config memory cfg,
        address token,
        address wmon,
        bool launchIsToken0,
        uint256 tokenAmt,
        uint256 quoteAmt,
        address recipient,
        uint160 /*sqrtP*/
    ) private returns (uint256 tokenId, uint128 liquidity, uint256 used0, uint256 used1) {
        address nfpm = cfg.nfpm;
        (address token0, address token1) = launchIsToken0 ? (token, wmon) : (wmon, token);
        (uint256 amount0Desired, uint256 amount1Desired) =
            launchIsToken0 ? (tokenAmt, quoteAmt) : (quoteAmt, tokenAmt);

        IERC20(token).forceApprove(nfpm, tokenAmt);
        IERC20(wmon).forceApprove(nfpm, quoteAmt);

        int24 ts = cfg.tickSpacing;
        int24 tickLower = (MIN_TICK / ts) * ts;
        int24 tickUpper = (MAX_TICK / ts) * ts;

        (tokenId, liquidity, used0, used1) = INonfungiblePositionManager(nfpm).mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: cfg.poolFee,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: 0,
                amount1Min: 0,
                recipient: recipient,
                deadline: block.timestamp
            })
        );

        IERC20(token).forceApprove(nfpm, 0);
        IERC20(wmon).forceApprove(nfpm, 0);
    }

    function _stampDexSeed(
        Config memory cfg,
        address token,
        address creator,
        address backingWallet,
        bool isMeme,
        address wmon,
        uint256 tokenId
    ) private {
        if (cfg.graduationStamper != address(0)) {
            StampParams memory stamp = StampParams({
                lpLocker: cfg.locker,
                tokenId: tokenId,
                token: token,
                quoteToken: wmon,
                backingWallet: isMeme ? address(0) : backingWallet,
                lpBackingBps: isMeme ? 0 : cfg.lpBackingBps,
                stakingPool: cfg.stakingPool,
                lpStakerBps: isMeme ? cfg.lpMemeStakerBps : cfg.lpStakerBps,
                isMemeToken: isMeme,
                creatorWallet: creator,
                lpCreatorBps: isMeme ? cfg.lpMemeCreatorBps : cfg.lpCreatorBps
            });
            try IGraduationStamper(cfg.graduationStamper).stampDexSeed(stamp) returns (bool ok, uint64 unlockTime) {
                if (ok) emit LpAutoLocked(token, tokenId, unlockTime);
            } catch {}
        } else if (isMeme) {
            try ILpLocker(cfg.locker).lockDexSeedPosition(
                tokenId, token, wmon, creator, cfg.stakingPool, cfg.lpMemeCreatorBps, cfg.lpMemeStakerBps
            ) returns (uint64 unlockTime) {
                emit LpAutoLocked(token, tokenId, unlockTime);
            } catch {}
        } else {
            try ILpLocker(cfg.locker).lockDexSeedPositionBacked(
                tokenId,
                token,
                wmon,
                backingWallet,
                cfg.lpBackingBps,
                cfg.stakingPool,
                cfg.lpStakerBps,
                creator,
                cfg.lpCreatorBps
            ) returns (uint64 unlockTime) {
                emit LpAutoLocked(token, tokenId, unlockTime);
            } catch {}
        }
    }

    function _stampGrad(
        Config memory cfg,
        address token,
        address creator,
        address backingWallet,
        bool isMeme,
        address wmon,
        uint256 tokenId
    ) private {
        StampParams memory stamp = StampParams({
            lpLocker: cfg.locker,
            tokenId: tokenId,
            token: token,
            quoteToken: wmon,
            backingWallet: backingWallet,
            lpBackingBps: cfg.lpBackingBps,
            stakingPool: cfg.stakingPool,
            lpStakerBps: isMeme ? cfg.lpMemeStakerBps : cfg.lpStakerBps,
            isMemeToken: isMeme,
            creatorWallet: creator,
            lpCreatorBps: isMeme ? cfg.lpMemeCreatorBps : cfg.lpCreatorBps
        });
        if (cfg.graduationStamper != address(0)) {
            try IGraduationStamper(cfg.graduationStamper).stampLpLock(stamp) returns (bool ok, uint64 unlockTime) {
                if (ok) emit LpAutoLocked(token, tokenId, unlockTime);
            } catch {}
        } else {
            try ILpLocker(cfg.locker).lockPosition(tokenId) returns (uint64 unlockTime) {
                emit LpAutoLocked(token, tokenId, unlockTime);
            } catch {}
        }
    }

    function sqrtPriceX96(bool launchIsToken0, uint256 vQuote, uint256 vToken) internal pure returns (uint160) {
        (uint256 num, uint256 den) = launchIsToken0 ? (vQuote, vToken) : (vToken, vQuote);
        uint256 ratioX192 = Math.mulDiv(num, uint256(1) << 192, den);
        uint256 s = Math.sqrt(ratioX192);
        require(s <= type(uint160).max);
        return uint160(s);
    }
}

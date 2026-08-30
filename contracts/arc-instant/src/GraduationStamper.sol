// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ILpLocker} from "./UniV3Interfaces.sol";

/// @notice Parameters the factory passes when delegating post-graduation LP stamping.
struct StampParams {
    address lpLocker;
    uint256 tokenId;
    address token;
    address quoteToken;
    address backingWallet;
    uint16 lpBackingBps;
    address stakingPool;
    uint16 lpStakerBps;
    bool isMemeToken;
    address creatorWallet;
    uint16 lpCreatorBps;
}

/// @notice Minimal surface BondingCurveFactory calls to delegate LP lock stamping.
interface IGraduationStamper {
    function stampLpLock(StampParams calldata p) external returns (bool stamped, uint64 unlockTime);
    /// @notice Stamp a thin UniV3 seed LP at meme launch (fees active; principal lock deferred).
    function stampDexSeed(StampParams calldata p) external returns (bool stamped, uint64 unlockTime);
}

/**
 * @title GraduationStamper
 * @notice External, upgradeable module that stamps RobinLock/MonLock positions at graduation
 *         (and at dex-seed meme launch). Extracted from BondingCurveFactory so routing logic can
 *         evolve without redeploying the factory proxy (LaunchToken pins `factory` immutably).
 *         Must be set as the locker's `stamper` so backed/meme/dex-seed split paths authorize;
 *         plain `lockPosition` is permissionless.
 */
contract GraduationStamper is Ownable, Initializable, UUPSUpgradeable, IGraduationStamper {
    /// @notice Only this factory may call `stampLpLock` / `stampDexSeed` (rotatable when migrating).
    address public factory;

    event FactoryChanged(address indexed factory);
    event LpStamped(uint256 indexed tokenId, bool backed, bool meme, uint64 unlockTime);
    /// @notice Dex-seed stamp at launch — `unlockTime` is 0 until factory calls `finalizeDexSeedLock`.
    event DexSeedStamped(uint256 indexed tokenId, uint64 unlockTime);

    error NotFactory();
    error ZeroAddress();

    /// @dev Implementation constructor — WMON/factory immutables live on the factory, not here.
    constructor() Ownable(address(1)) {
        _disableInitializers();
    }

    function initialize(address factory_, address owner_) external initializer {
        if (factory_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        factory = factory_;
        _transferOwnership(owner_);
    }

    /// @inheritdoc IGraduationStamper
    function stampLpLock(StampParams calldata p) external returns (bool stamped, uint64 unlockTime) {
        if (msg.sender != factory) revert NotFactory();
        if (p.lpLocker == address(0)) return (false, 0);

        if (p.backingWallet != address(0) && p.lpBackingBps > 0) {
            try ILpLocker(p.lpLocker).lockPositionWithSplitLaunch(
                p.tokenId,
                p.token,
                p.quoteToken,
                p.backingWallet,
                p.lpBackingBps,
                p.stakingPool,
                p.lpStakerBps,
                p.creatorWallet,
                p.lpCreatorBps
            ) returns (uint64 t) {
                emit LpStamped(p.tokenId, true, false, t);
                return (true, t);
            } catch {}
        } else if (p.isMemeToken) {
            // p.lpStakerBps/p.lpCreatorBps carry the MEME-specific globals here, not the backed ones
            // above -- BondingCurveFactory._graduate() picks the right source per token type before
            // populating this struct. See the ternary at that call site for why this is safe.
            try ILpLocker(p.lpLocker).lockPositionMeme(
                p.tokenId, p.token, p.quoteToken, p.stakingPool, p.lpStakerBps, p.creatorWallet, p.lpCreatorBps
            ) returns (uint64 t) {
                emit LpStamped(p.tokenId, false, true, t);
                return (true, t);
            } catch {}
        } else {
            try ILpLocker(p.lpLocker).lockPosition(p.tokenId) returns (uint64 t) {
                emit LpStamped(p.tokenId, false, false, t);
                return (true, t);
            } catch {}
        }
        return (false, 0);
    }

    /// @inheritdoc IGraduationStamper
    /// @dev Early UniV3 seed LP stamp. Backed (RWA/perp) when backingWallet+bps set; else meme.
    ///      Fees active immediately; principal locked at graduation via finalizeDexSeedLock.
    function stampDexSeed(StampParams calldata p) external returns (bool stamped, uint64 unlockTime) {
        if (msg.sender != factory) revert NotFactory();
        if (p.lpLocker == address(0)) return (false, 0);

        if (p.backingWallet != address(0) && p.lpBackingBps > 0) {
            try ILpLocker(p.lpLocker).lockDexSeedPositionBacked(
                p.tokenId,
                p.token,
                p.quoteToken,
                p.backingWallet,
                p.lpBackingBps,
                p.stakingPool,
                p.lpStakerBps,
                p.creatorWallet,
                p.lpCreatorBps
            ) returns (uint64 t) {
                emit DexSeedStamped(p.tokenId, t);
                emit LpStamped(p.tokenId, true, false, t);
                return (true, t);
            } catch {}
        } else {
            try ILpLocker(p.lpLocker).lockDexSeedPosition(
                p.tokenId,
                p.token,
                p.quoteToken,
                p.creatorWallet,
                p.stakingPool,
                p.lpCreatorBps,
                p.lpStakerBps
            ) returns (uint64 t) {
                emit DexSeedStamped(p.tokenId, t);
                emit LpStamped(p.tokenId, false, true, t);
                return (true, t);
            } catch {}
        }
        return (false, 0);
    }

    function setFactory(address factory_) external onlyOwner {
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        emit FactoryChanged(factory_);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    uint256[49] private __gap;
}
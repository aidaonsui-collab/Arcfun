// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CrucibleLock} from "./CrucibleLock.sol";

/// @dev `approve` isn't on the shared INonfungiblePositionManager interface (CrucibleLock's own
///      `lock` only ever needs `transferFrom`) — kept local rather than widening a file that's
///      already been through review for an addition only this adapter uses.
interface INftApprove {
    function approve(address to, uint256 tokenId) external;
}

/// @title InstantLockerAdapter
/// @notice Translates ArcFun Instant's `ILpLocker.lockPositionMeme(...)` call (defined in
///         contracts/arc-instant/src/UniV3Interfaces.sol) into `CrucibleLock.lock(...)`.
///         Instant's `InstantErc20QuoteFactory._mintSingleSided` mints the fresh LP position
///         NFT directly to whatever address is configured as `lpLocker` (`recipient: lpLocker`
///         in the UniV3 `mint` call), then calls `lockPositionMeme` on that same address. This
///         contract IS that `lpLocker`: it receives the NFT, approves CrucibleLock to pull it,
///         and stamps the lock as `Kind.Meme` — so a collect afterward pays CrucibleLock's own
///         hardcoded 50/25/10/10/5 split (see CrucibleLock's constants), not Instant's
///         ArcBpsSource value. `stakerWallet`/`stakerBps`/`creatorBps` from the ILpLocker call
///         are intentionally ignored: CrucibleLock's Meme split is a fixed protocol constant,
///         not a per-lock configurable one.
///
///         Deliberately minimal and stateless w.r.t. custody: the NFT never sits here past the
///         single transaction that mints, approves, and locks it. `onlyInstantFactory` gates
///         who may drive a lock — only the wired Instant factory contract, so nothing else can
///         direct an arbitrary NFT into Crucible pretending to be a real launch.
contract InstantLockerAdapter {
    CrucibleLock public immutable CRUCIBLE_LOCK;
    address public immutable NFPM;

    address public owner;
    address public instantFactory;

    event OwnerTransferred(address indexed previous, address indexed next);
    event InstantFactorySet(address indexed factory);
    event Locked(uint256 indexed tokenId, address indexed creatorWallet);

    error NotOwner();
    error NotInstantFactory();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyInstantFactory() {
        if (msg.sender != instantFactory) revert NotInstantFactory();
        _;
    }

    constructor(address crucibleLock_, address nfpm_, address instantFactory_) {
        if (crucibleLock_ == address(0) || nfpm_ == address(0) || instantFactory_ == address(0)) {
            revert ZeroAddress();
        }
        CRUCIBLE_LOCK = CrucibleLock(crucibleLock_);
        NFPM = nfpm_;
        owner = msg.sender;
        instantFactory = instantFactory_;
        emit InstantFactorySet(instantFactory_);
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, next);
        owner = next;
    }

    function setInstantFactory(address factory_) external onlyOwner {
        if (factory_ == address(0)) revert ZeroAddress();
        instantFactory = factory_;
        emit InstantFactorySet(factory_);
    }

    /// @notice ILpLocker surface Instant's factory calls after minting the position to this
    ///         contract. Signature must match UniV3Interfaces.sol's `ILpLocker.lockPositionMeme`
    ///         exactly — the factory's low-level `try` call is selector-matched, not interface-
    ///         checked. `launchToken`/`quoteToken`/`stakerWallet`/`stakerBps`/`creatorBps` are
    ///         accepted for ABI compatibility only; CrucibleLock's Meme split ignores all of
    ///         them in favor of its own fixed constants.
    function lockPositionMeme(
        uint256 tokenId,
        address, /* launchToken */
        address, /* quoteToken */
        address, /* stakerWallet */
        uint16, /* stakerBps */
        address creatorWallet,
        uint16 /* creatorBps */
    ) external onlyInstantFactory returns (uint64 unlockTime) {
        INftApprove(NFPM).approve(address(CRUCIBLE_LOCK), tokenId);
        CRUCIBLE_LOCK.lock(tokenId, creatorWallet, CrucibleLock.Kind.Meme, address(0), "");
        emit Locked(tokenId, creatorWallet);
        // CrucibleLock has no NFT withdraw — the position is locked forever. There is no
        // meaningful unlock time to report; Instant's factory discards this return value
        // (`_stampLock` never reads it), so type(uint64).max is a deliberately honest "never".
        return type(uint64).max;
    }
}

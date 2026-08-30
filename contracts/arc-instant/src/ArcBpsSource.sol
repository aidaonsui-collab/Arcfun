// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ArcBpsSource
 * @notice Minimal LP-fee bps source for Arc Instant launches.
 *         InstantErc20QuoteFactory reads `lpMemeCreatorBps` / `lpMemeStakerBps` at stamp time
 *         (same interface as BondingCurveFactory on RH4663). No curve factory on Arc Phase 1.
 *
 *         Defaults: creator 70% of quote-side LP fees, staker 0% — remainder (30%) platform
 *         per MonLock meme lock semantics. Launch-token side of LP fees always burns on collect.
 */
contract ArcBpsSource is Ownable {
    uint16 public lpMemeCreatorBps = 7000;
    uint16 public lpMemeStakerBps = 0;

    // Optional read-throughs for future Instant RWA/margin on Arc (unused by meme Instant).
    uint16 public lpBackingBps = 7000;
    uint16 public lpStakerBps = 1000;
    uint16 public lpCreatorBps = 0;

    event MemeBpsSet(uint16 creatorBps, uint16 stakerBps);
    event BackedBpsSet(uint16 backingBps, uint16 stakerBps, uint16 creatorBps);

    constructor(address owner_) Ownable(owner_) {
        require(owner_ != address(0), "owner");
    }

    function setMemeBps(uint16 creatorBps_, uint16 stakerBps_) external onlyOwner {
        require(uint256(creatorBps_) + uint256(stakerBps_) <= 10_000, "bps");
        lpMemeCreatorBps = creatorBps_;
        lpMemeStakerBps = stakerBps_;
        emit MemeBpsSet(creatorBps_, stakerBps_);
    }

    function setBackedBps(uint16 backingBps_, uint16 stakerBps_, uint16 creatorBps_) external onlyOwner {
        require(uint256(backingBps_) + uint256(stakerBps_) + uint256(creatorBps_) <= 10_000, "bps");
        lpBackingBps = backingBps_;
        lpStakerBps = stakerBps_;
        lpCreatorBps = creatorBps_;
        emit BackedBpsSet(backingBps_, stakerBps_, creatorBps_);
    }
}

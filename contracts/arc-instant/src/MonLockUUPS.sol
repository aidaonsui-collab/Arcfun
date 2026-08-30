// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {MonLock} from "./MonLock.sol";

/**
 * @title MonLockUUPS
 * @notice UUPS-upgradeable RobinLock/MonLock. LP NFTs custodied at the proxy address survive
 *         implementation upgrades. `POSITION_MANAGER` is an implementation immutable (NFPM address).
 */
contract MonLockUUPS is MonLock, Initializable, UUPSUpgradeable {
    constructor(address positionManager_)
        MonLock(positionManager_, address(0xdead), address(0xdead), 365 days)
    {
        _disableInitializers();
    }

    function initialize(address defaultBeneficiary_, address owner_, uint64 defaultLockDuration_)
        external
        initializer
    {
        if (defaultBeneficiary_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        if (defaultLockDuration_ == 0) revert ZeroDuration();
        if (defaultLockDuration_ < MIN_LOCK_DURATION) revert DurationTooShort();
        defaultBeneficiary = defaultBeneficiary_;
        owner = owner_;
        defaultLockDuration = defaultLockDuration_;
    }

    function _authorizeUpgrade(address newImplementation) internal override {
        if (msg.sender != owner) revert NotOwner();
        // silence unused warning when optimizer strips the param
        newImplementation;
    }

    uint256[50] private __gap;
}
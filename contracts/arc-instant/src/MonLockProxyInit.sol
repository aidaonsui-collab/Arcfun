// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MonLock} from "./MonLock.sol";

/// @notice MonLock implementation for TransparentUpgradeableProxy (no UUPS bytecode overhead).
contract MonLockProxyInit is MonLock {
    bool private _initialized;

    constructor(address positionManager_)
        MonLock(positionManager_, address(0xdead), address(0xdead), 365 days)
    {}

    function initialize(address defaultBeneficiary_, address owner_, uint64 defaultLockDuration_) external {
        require(!_initialized, "initialized");
        if (defaultBeneficiary_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        if (defaultLockDuration_ == 0) revert ZeroDuration();
        if (defaultLockDuration_ < MIN_LOCK_DURATION) revert DurationTooShort();
        _initialized = true;
        defaultBeneficiary = defaultBeneficiary_;
        owner = owner_;
        defaultLockDuration = defaultLockDuration_;
    }
}
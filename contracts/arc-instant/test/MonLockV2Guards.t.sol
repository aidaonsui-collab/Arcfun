// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MonLock} from "../src/MonLock.sol";

contract MonLockV2GuardsTest is Test {
    MonLock internal lock;

    address internal beneficiary = makeAddr("beneficiary");
    address internal owner = makeAddr("owner");

    function setUp() public {
        lock = new MonLock(makeAddr("nfpm"), beneficiary, owner, 365 days);
    }

    function test_MIN_LOCK_DURATION_is30Days() public view {
        assertEq(lock.MIN_LOCK_DURATION(), 30 days);
    }

    function test_setDefaults_revertsBelowMin() public {
        vm.prank(owner);
        vm.expectRevert(MonLock.DurationTooShort.selector);
        lock.setDefaults(beneficiary, 29 days);
    }

    function test_constructor_revertsBelowMin() public {
        vm.expectRevert(MonLock.DurationTooShort.selector);
        new MonLock(makeAddr("nfpm2"), beneficiary, owner, 1 days);
    }
}
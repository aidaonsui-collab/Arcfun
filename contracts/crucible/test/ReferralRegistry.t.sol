// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ReferralRegistry} from "../src/ReferralRegistry.sol";

contract ReferralRegistryTest is Test {
    ReferralRegistry internal registry;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public {
        registry = new ReferralRegistry();
    }

    function test_registerFirstComeAndPayout() public {
        vm.prank(alice);
        registry.register("texxas", bob);
        assertEq(registry.ownerOf("texxas"), alice);
        assertEq(registry.payoutOf("texxas"), bob);
        assertTrue(registry.isRegisteredPayout(bob));
        assertFalse(registry.isRegisteredPayout(alice));
    }

    function test_registerTakenReverts() public {
        vm.prank(alice);
        registry.register("texxas", alice);
        vm.prank(bob);
        vm.expectRevert(ReferralRegistry.Taken.selector);
        registry.register("texxas", bob);
    }

    function test_rotatePayout() public {
        vm.prank(alice);
        registry.register("texxas", alice);
        vm.prank(alice);
        registry.rotatePayout("texxas", carol);
        assertEq(registry.payoutOf("texxas"), carol);
        assertTrue(registry.isRegisteredPayout(carol));
        assertFalse(registry.isRegisteredPayout(alice));
    }

    function test_rotatePayoutNotOwner() public {
        vm.prank(alice);
        registry.register("texxas", alice);
        vm.prank(bob);
        vm.expectRevert(ReferralRegistry.NotOwner.selector);
        registry.rotatePayout("texxas", bob);
    }

    function test_rejectOxAddressCode() public {
        vm.prank(alice);
        vm.expectRevert(ReferralRegistry.CodeLooksLikeAddress.selector);
        registry.register("0x1234", alice);
    }

    function test_rejectEmpty() public {
        vm.prank(alice);
        vm.expectRevert(ReferralRegistry.EmptyCode.selector);
        registry.register("", alice);
    }

    function test_rejectBadCharset() public {
        vm.prank(alice);
        vm.expectRevert(ReferralRegistry.BadCharset.selector);
        registry.register("bad code", alice);
    }

    function test_publicAnyoneCanRegister() public {
        vm.prank(bob);
        registry.register("friend-1", bob);
        assertEq(registry.ownerOf("friend-1"), bob);
    }
}

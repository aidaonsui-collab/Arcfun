// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ArcDisperse} from "../src/ArcDisperse.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract ArcDisperseTest is Test {
    ArcDisperse disperse;
    MockUSDC usdc;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address payer = makeAddr("payer");

    function setUp() public {
        disperse = new ArcDisperse();
        usdc = new MockUSDC();
        usdc.mint(payer, 1_000_000_000);
        vm.prank(payer);
        usdc.approve(address(disperse), type(uint256).max);
    }

    function test_disperse_splits() public {
        address[] memory to = new address[](2);
        uint256[] memory amt = new uint256[](2);
        to[0] = alice;
        to[1] = bob;
        amt[0] = 10_000_000;
        amt[1] = 5_000_000;
        vm.prank(payer);
        disperse.disperseToken(usdc, to, amt);
        assertEq(usdc.balanceOf(alice), 10_000_000);
        assertEq(usdc.balanceOf(bob), 5_000_000);
        assertEq(usdc.balanceOf(payer), 1_000_000_000 - 15_000_000);
    }

    function test_lenMismatchReverts() public {
        address[] memory to = new address[](1);
        uint256[] memory amt = new uint256[](2);
        to[0] = alice;
        vm.prank(payer);
        vm.expectRevert(ArcDisperse.Len.selector);
        disperse.disperseToken(usdc, to, amt);
    }
}

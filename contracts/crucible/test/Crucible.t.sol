// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Crucible} from "../src/Crucible.sol";
import {MockERC20, MockSwapRouter} from "./mocks/Mocks.sol";

contract CrucibleTest is Test {
    Crucible internal crucible;
    MockERC20 internal usdc;
    MockERC20 internal arcfun;
    MockSwapRouter internal router;
    address internal dead = 0x000000000000000000000000000000000000dEaD;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        arcfun = new MockERC20("EVE", "EVE", 18);
        router = new MockSwapRouter();
        crucible = new Crucible(address(usdc), address(router), address(arcfun), 10_000);
        arcfun.mint(address(router), 1_000_000e18);
    }


    function test_burnTargetIsImmutable() public view {
        // No setter exists: the target cannot be repointed after deploy.
        assertEq(crucible.eve(), address(arcfun));
    }

    function test_cookBurns() public {
        usdc.mint(address(crucible), 100e6);
        assertEq(crucible.eve(), address(arcfun));

        vm.expectEmit(true, false, false, true);
        emit Crucible.Burn(address(arcfun), 100e6, 100e18, block.timestamp);
        uint256 out = crucible.cook(100e6, 100e18);

        assertEq(out, 100e18);
        assertEq(usdc.balanceOf(address(crucible)), 0);
        assertEq(arcfun.balanceOf(dead), 100e18);
        assertEq(usdc.balanceOf(dead), 0);
        assertEq(arcfun.balanceOf(address(crucible)), 0);
    }

    function test_cookPausedHolds() public {
        usdc.mint(address(crucible), 10e6);
        crucible.setCookPaused(true);
        vm.expectRevert(Crucible.CookIsPaused.selector);
        crucible.cook(10e6, 10e18);
        assertEq(usdc.balanceOf(address(crucible)), 10e6);
    }

    function test_cookZeroBalanceNoOp() public {
        assertEq(crucible.cook(0, 0), 0);
    }

    function test_cookZeroMinOutReverts() public {
        usdc.mint(address(crucible), 10e6);
        vm.expectRevert(Crucible.ZeroMinOut.selector);
        crucible.cook(10e6, 0);
    }


    function test_setEvePoolFeeRejectsZero() public {
        vm.expectRevert(Crucible.ZeroFee.selector);
        crucible.setEvePoolFee(0);
    }

    function test_setSwapRouterRevokesOldAllowance() public {
        usdc.mint(address(crucible), 10e6);
        crucible.cook(10e6, 10e18);
        assertGt(usdc.allowance(address(crucible), address(router)), 0);

        MockSwapRouter next = new MockSwapRouter();
        crucible.setSwapRouter(address(next));
        assertEq(usdc.allowance(address(crucible), address(router)), 0);
        assertEq(crucible.swapRouter(), address(next));
    }

    function test_cookPartialLeavesRest() public {
        usdc.mint(address(crucible), 100e6);
        crucible.cook(40e6, 40e18);
        assertEq(usdc.balanceOf(address(crucible)), 60e6);
        assertEq(arcfun.balanceOf(dead), 40e18);
    }
}

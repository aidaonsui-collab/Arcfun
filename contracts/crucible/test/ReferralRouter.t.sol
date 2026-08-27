// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ReferralRouter} from "../src/ReferralRouter.sol";
import {ReferralRegistry} from "../src/ReferralRegistry.sol";
import {MockERC20, MockSwapRouter} from "./mocks/Mocks.sol";

contract ReferralRouterTest is Test {
    ReferralRouter internal rtr;
    ReferralRegistry internal registry;
    MockERC20 internal usdc;
    MockERC20 internal launch;
    MockSwapRouter internal uni;
    address internal referrer = makeAddr("referrer");
    address internal buyer = makeAddr("buyer");
    address internal payout = makeAddr("payout");

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        launch = new MockERC20("MEME", "MEME", 18);
        uni = new MockSwapRouter();
        registry = new ReferralRegistry();
        rtr = new ReferralRouter(address(usdc), address(uni), address(0), address(registry));
        launch.mint(address(uni), 1_000_000e18);
        usdc.mint(buyer, 10_000e6);
        vm.prank(buyer);
        usdc.approve(address(rtr), type(uint256).max);
    }

    function test_codePaysFiveBps() public {
        vm.prank(referrer);
        registry.register("texxas", referrer);

        vm.prank(buyer);
        uint256 out = rtr.buy(address(launch), 10_000, 10_000e6, 1, "texxas");

        // 5 bps of 10_000e6 = 5e6 USDC
        assertEq(usdc.balanceOf(referrer), 5e6);
        assertEq(usdc.balanceOf(buyer), 0);
        // swap remaining 9_995e6 → 9_995e18 at mock 1 USDC = 1e18
        assertEq(out, 9_995e18);
        assertEq(launch.balanceOf(buyer), 9_995e18);
    }

    function test_noCodeNoSkim() public {
        vm.prank(buyer);
        rtr.buy(address(launch), 10_000, 10_000e6, 1, "");
        assertEq(usdc.balanceOf(referrer), 0);
        assertEq(launch.balanceOf(buyer), 10_000e18);
    }

    function test_unknownCodeNoSkim() public {
        vm.prank(buyer);
        rtr.buy(address(launch), 10_000, 10_000e6, 1, "nobody");
        assertEq(launch.balanceOf(buyer), 10_000e18);
    }

    function test_selfReferralNoSkim() public {
        vm.prank(buyer);
        registry.register("mine", buyer);
        vm.prank(buyer);
        rtr.buy(address(launch), 10_000, 10_000e6, 1, "mine");
        assertEq(usdc.balanceOf(buyer), 0);
        assertEq(launch.balanceOf(buyer), 10_000e18);
    }

    function test_rotatedPayoutGetsCut() public {
        vm.prank(referrer);
        registry.register("texxas", referrer);
        vm.prank(referrer);
        registry.rotatePayout("texxas", payout);

        vm.prank(buyer);
        rtr.buy(address(launch), 10_000, 10_000e6, 1, "texxas");
        assertEq(usdc.balanceOf(payout), 5e6);
        assertEq(usdc.balanceOf(referrer), 0);
    }

    function test_minOutAppliesToPostSkim() public {
        vm.prank(referrer);
        registry.register("texxas", referrer);
        uni.setOutPerIn(1);
        vm.prank(buyer);
        vm.expectRevert();
        rtr.buy(address(launch), 10_000, 10_000e6, 9_995e18, "texxas");
    }
}

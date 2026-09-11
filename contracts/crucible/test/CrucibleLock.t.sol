// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CrucibleLock} from "../src/CrucibleLock.sol";
import {Crucible} from "../src/Crucible.sol";
import {ReferralRegistry} from "../src/ReferralRegistry.sol";
import {MockERC20, MockSwapRouter, MockNFPM} from "./mocks/Mocks.sol";

contract CrucibleLockTest is Test {
    CrucibleLock internal locker;
    Crucible internal crucible;
    ReferralRegistry internal registry;
    MockERC20 internal usdc;
    MockERC20 internal launch;
    MockERC20 internal arcfun;
    MockSwapRouter internal router;
    MockNFPM internal nfpm;

    address internal platform = makeAddr("platform");
    address internal creator = makeAddr("creator");
    address internal holders = makeAddr("holders");
    address internal referrer = makeAddr("referrer");
    address internal dead = 0x000000000000000000000000000000000000dEaD;

    uint256 internal constant TOKEN_ID = 7;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        launch = new MockERC20("MEME", "MEME", 18);
        arcfun = new MockERC20("ARCFUN", "ARCFUN", 18);
        router = new MockSwapRouter();
        nfpm = new MockNFPM();
        registry = new ReferralRegistry();
        crucible = new Crucible(address(usdc), address(router), address(arcfun), 10_000);
        locker = new CrucibleLock(
            address(nfpm), address(usdc), address(router), address(crucible), address(registry), platform
        );

        nfpm.mint(TOKEN_ID, address(this), address(usdc), address(launch), 10_000);
        nfpm.approve(address(locker), TOKEN_ID);
        locker.lock(TOKEN_ID, creator, CrucibleLock.Kind.Meme, address(0), "");

        arcfun.mint(address(router), 1_000_000e18);
        launch.mint(address(router), 1_000_000e18);
    }

    function _seedFees(uint256 usdcFee, uint256 tokenFee) internal {
        if (usdcFee > 0) usdc.mint(address(nfpm), usdcFee);
        if (tokenFee > 0) launch.mint(address(nfpm), tokenFee);
        nfpm.setOwed(TOKEN_ID, uint128(usdcFee), uint128(tokenFee));
    }

    function _lockWithCode(uint256 id, string memory code) internal {
        nfpm.mint(id, address(this), address(usdc), address(launch), 10_000);
        nfpm.approve(address(locker), id);
        locker.lock(id, creator, CrucibleLock.Kind.Meme, address(0), code);
    }

    function test_creatorSplitsStampedAtLock() public view {
        (address wallet, uint16 bps) = locker.creatorSplits(TOKEN_ID);
        assertEq(wallet, creator);
        assertEq(bps, 5_000);
    }

    function test_sellTokenAllToDead() public {
        uint256 tokenFee = 40e18;
        _seedFees(0, tokenFee);

        locker.collectFees(TOKEN_ID);

        assertEq(launch.balanceOf(dead), tokenFee);
        assertEq(launch.balanceOf(creator), 0);
        assertEq(launch.balanceOf(platform), 0);
        assertEq(launch.balanceOf(address(crucible)), 0);
        assertEq(launch.balanceOf(address(locker)), 0);
        assertEq(usdc.balanceOf(creator), 0);
        assertEq(usdc.balanceOf(platform), 0);
    }

    /// The burn target is immutable now, so "unset" is unreachable: USDC accrues against a
    /// target that was fixed at construction and cannot be repointed.
    function test_burnTargetIsFixedAtConstruction() public {
        uint256 fee = 10_000e6;
        _seedFees(fee, 0);

        locker.collectFees(TOKEN_ID);
        locker.projectBurn(TOKEN_ID, 1_000e18);

        // Meme, no referrer: creator 50%, crucible 30% (25+5), project burn 10%, platform 10%
        assertEq(usdc.balanceOf(creator), 5_000e6);
        assertEq(usdc.balanceOf(platform), 1_000e6);
        assertEq(usdc.balanceOf(address(crucible)), 3_000e6);
        assertEq(launch.balanceOf(dead), 1_000e18);
        assertEq(usdc.balanceOf(dead), 0);
        assertEq(crucible.eve(), address(arcfun), "target fixed at deploy");
    }

    function test_collectDoesNotAutoCook() public {
        uint256 fee = 10_000e6;
        _seedFees(fee, 0);

        locker.collectFees(TOKEN_ID);

        assertEq(usdc.balanceOf(address(crucible)), 3_000e6);
        assertEq(arcfun.balanceOf(dead), 0);

        crucible.cook(3_000e6, 3_000e18);
        locker.projectBurn(TOKEN_ID, 1_000e18);

        assertEq(usdc.balanceOf(address(crucible)), 0);
        assertEq(arcfun.balanceOf(dead), 3_000e18);
        assertEq(launch.balanceOf(dead), 1_000e18);
    }

    function test_unknownReferrerGoesToCrucible() public {
        uint256 fee = 10_000e6;
        _seedFees(fee, 0);
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        registry.register("unrelated", stranger);

        locker.collectFees(TOKEN_ID);

        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(usdc.balanceOf(address(crucible)), 3_000e6);
        assertEq(usdc.balanceOf(creator), 5_000e6);
    }

    function test_collectFoldsReferrerIntoCrucible() public {
        uint256 id = 11;
        vm.prank(referrer);
        registry.register("texxas", referrer);
        _lockWithCode(id, "texxas");

        usdc.mint(address(nfpm), 10_000e6);
        nfpm.setOwed(id, 10_000e6, 0);

        locker.collectFees(id);

        // Per-trade path is ReferralRouter. Collect never pays the stamped code.
        assertEq(usdc.balanceOf(referrer), 0);
        assertEq(usdc.balanceOf(address(crucible)), 3_000e6);
        assertEq(usdc.balanceOf(creator), 5_000e6);
        assertEq(usdc.balanceOf(platform), 1_000e6);
    }

    function test_rotatedPayoutDoesNotCollectFromLock() public {
        uint256 id = 12;
        address payout = makeAddr("payout");
        vm.prank(referrer);
        registry.register("texxas", referrer);
        _lockWithCode(id, "texxas");
        vm.prank(referrer);
        registry.rotatePayout("texxas", payout);

        usdc.mint(address(nfpm), 10_000e6);
        nfpm.setOwed(id, 10_000e6, 0);
        locker.collectFees(id);

        assertEq(usdc.balanceOf(payout), 0);
        assertEq(usdc.balanceOf(referrer), 0);
        assertEq(usdc.balanceOf(address(crucible)), 3_000e6);
    }

    function test_attackerCannotSelfAssignReferrer() public {
        uint256 id = 13;
        address attacker = makeAddr("attacker");
        vm.prank(referrer);
        registry.register("texxas", referrer);
        vm.prank(attacker);
        registry.register("unrelated", attacker);
        _lockWithCode(id, "texxas");

        usdc.mint(address(nfpm), 10_000e6);
        nfpm.setOwed(id, 10_000e6, 0);
        vm.prank(attacker);
        locker.collectFees(id);

        assertEq(usdc.balanceOf(attacker), 0);
        assertEq(usdc.balanceOf(referrer), 0);
        assertEq(usdc.balanceOf(address(crucible)), 3_000e6);
    }

    function test_reflectHoldersLeg() public {
        uint256 id = 8;
        nfpm.mint(id, address(this), address(usdc), address(launch), 10_000);
        nfpm.approve(address(locker), id);
        locker.lock(id, creator, CrucibleLock.Kind.Reflect, holders, "");

        usdc.mint(address(nfpm), 10_000e6);
        nfpm.setOwed(id, 10_000e6, 0);

        locker.collectFees(id);
        locker.projectBurn(id, 1_500e18);

        assertEq(usdc.balanceOf(holders), 2_000e6);
        assertEq(usdc.balanceOf(creator), 2_000e6);
        assertEq(usdc.balanceOf(platform), 1_000e6);
        assertEq(usdc.balanceOf(address(crucible)), 3_500e6); // 3000 + 500 unknown ref
        assertEq(launch.balanceOf(dead), 1_500e18);
        (address w, uint16 bps) = locker.creatorSplits(id);
        assertEq(w, creator);
        assertEq(bps, 2_000);
    }

    function test_noNftWithdraw() public {
        vm.expectRevert(CrucibleLock.NoNftWithdraw.selector);
        locker.withdrawNft(TOKEN_ID);
        assertEq(nfpm.ownerOf(TOKEN_ID), address(locker));
    }

    function test_permissionlessCollect() public {
        _seedFees(10_000e6, 1e18);
        vm.prank(makeAddr("keeper"));
        locker.collectFees(TOKEN_ID);
        locker.projectBurn(TOKEN_ID, 1_000e18);
        assertEq(launch.balanceOf(dead), 1e18 + 1_000e18);
        assertEq(usdc.balanceOf(creator), 5_000e6);
    }

    function test_lockOnlyFactoryOrOwner() public {
        uint256 id = 99;
        nfpm.mint(id, address(this), address(usdc), address(launch), 10_000);
        nfpm.approve(address(locker), id);
        vm.prank(makeAddr("rando"));
        vm.expectRevert(CrucibleLock.NotFactory.selector);
        locker.lock(id, creator, CrucibleLock.Kind.Meme, address(0), "");
    }

    function test_projectBurnZeroMinOutReverts() public {
        _seedFees(10_000e6, 0);
        locker.collectFees(TOKEN_ID);
        vm.expectRevert(CrucibleLock.ZeroMinOut.selector);
        locker.projectBurn(TOKEN_ID, 0);
    }

    function test_projectBurnCollapsedRateReverts() public {
        _seedFees(10_000e6, 0);
        locker.collectFees(TOKEN_ID);
        router.setOutPerIn(1);
        vm.expectRevert();
        locker.projectBurn(TOKEN_ID, 1_000e18);
        assertEq(locker.pendingProjectBurn(TOKEN_ID), 1_000e6);
        assertEq(launch.balanceOf(dead), 0);
    }

    function test_setSwapRouterRevokesOldAllowance() public {
        _seedFees(10_000e6, 0);
        locker.collectFees(TOKEN_ID);
        locker.projectBurn(TOKEN_ID, 1_000e18);
        assertEq(usdc.allowance(address(locker), address(router)), type(uint256).max);

        MockSwapRouter next = new MockSwapRouter();
        locker.setSwapRouter(address(next));
        assertEq(usdc.allowance(address(locker), address(router)), 0);
        assertEq(locker.swapRouter(), address(next));
    }

    function test_setSwapRouterZeroReverts() public {
        vm.expectRevert(CrucibleLock.ZeroAddress.selector);
        locker.setSwapRouter(address(0));
    }
}

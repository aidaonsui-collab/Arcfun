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
        crucible = new Crucible(address(usdc), address(router), 10_000);
        locker = new CrucibleLock(
            address(nfpm), address(usdc), address(router), address(crucible), address(registry), platform
        );

        // token0 = USDC, token1 = launch. Factory-style: mint to this test, approve locker, lock.
        nfpm.mint(TOKEN_ID, address(this), address(usdc), address(launch), 10_000);
        nfpm.approve(address(locker), TOKEN_ID);
        locker.lock(TOKEN_ID, creator, CrucibleLock.Kind.Meme, address(0));

        arcfun.mint(address(router), 1_000_000e18);
        launch.mint(address(router), 1_000_000e18);
    }

    function _seedFees(uint256 usdcFee, uint256 tokenFee) internal {
        if (usdcFee > 0) usdc.mint(address(nfpm), usdcFee);
        if (tokenFee > 0) launch.mint(address(nfpm), tokenFee);
        nfpm.setOwed(TOKEN_ID, uint128(usdcFee), uint128(tokenFee));
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

    function test_unsetArcfunHoldsUsdcOnCrucible() public {
        uint256 fee = 10_000e6; // $10k USDC fee → easy bps
        _seedFees(fee, 0);

        locker.collectFees(TOKEN_ID);

        // Meme, no referrer: creator 50%, crucible 30% (25+5), project burn 10%, platform 10%
        assertEq(usdc.balanceOf(creator), 5_000e6);
        assertEq(usdc.balanceOf(platform), 1_000e6);
        assertEq(usdc.balanceOf(address(crucible)), 3_000e6);
        // project burn swapped USDC → launch to dead
        assertEq(launch.balanceOf(dead), 1_000e18);
        assertEq(usdc.balanceOf(dead), 0);
        assertEq(crucible.arcfun(), address(0));

        vm.expectRevert(Crucible.ArcfunUnset.selector);
        crucible.cook();
        assertEq(usdc.balanceOf(address(crucible)), 3_000e6);
        assertEq(arcfun.balanceOf(dead), 0);
    }

    function test_setArcfunThenCollectCooksBurnTape() public {
        uint256 fee = 10_000e6;
        _seedFees(fee, 0);
        crucible.setArcfun(address(arcfun));

        locker.collectFees(TOKEN_ID);

        assertEq(usdc.balanceOf(address(crucible)), 0);
        // crucible slice 3000e6 USDC → 3000e18 ARCFUN to dead
        assertEq(arcfun.balanceOf(dead), 3_000e18);
        assertEq(launch.balanceOf(dead), 1_000e18); // project burn
    }

    function test_unknownReferrerGoesToCrucible() public {
        uint256 fee = 10_000e6;
        _seedFees(fee, 0);
        address stranger = makeAddr("stranger");

        locker.collectFees(TOKEN_ID, stranger);

        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(usdc.balanceOf(address(crucible)), 3_000e6);
        assertEq(usdc.balanceOf(creator), 5_000e6);
    }

    function test_registeredReferrerGetsFiveHundredBps() public {
        uint256 fee = 10_000e6;
        _seedFees(fee, 0);
        vm.prank(referrer);
        registry.register("texxas", referrer);

        locker.collectFees(TOKEN_ID, referrer);

        assertEq(usdc.balanceOf(referrer), 500e6);
        assertEq(usdc.balanceOf(address(crucible)), 2_500e6);
        assertEq(usdc.balanceOf(creator), 5_000e6);
        assertEq(usdc.balanceOf(platform), 1_000e6);
    }

    function test_rotatedPayoutReceivesFees() public {
        uint256 fee = 10_000e6;
        _seedFees(fee, 0);
        address payout = makeAddr("payout");
        vm.prank(referrer);
        registry.register("texxas", referrer);
        vm.prank(referrer);
        registry.rotatePayout("texxas", payout);

        locker.collectFees(TOKEN_ID, payout);

        assertEq(usdc.balanceOf(payout), 500e6);
        assertEq(usdc.balanceOf(referrer), 0);
        assertEq(usdc.balanceOf(address(crucible)), 2_500e6);
        // old payout no longer registered
        assertFalse(registry.isRegisteredPayout(referrer));
        assertTrue(registry.isRegisteredPayout(payout));
    }

    function test_oldPayoutAfterRotateIsUnknown() public {
        uint256 fee = 10_000e6;
        _seedFees(fee, 0);
        address payout = makeAddr("payout");
        vm.prank(referrer);
        registry.register("texxas", referrer);
        vm.prank(referrer);
        registry.rotatePayout("texxas", payout);

        locker.collectFees(TOKEN_ID, referrer);
        assertEq(usdc.balanceOf(referrer), 0);
        assertEq(usdc.balanceOf(address(crucible)), 3_000e6);
    }

    function test_reflectHoldersLeg() public {
        uint256 id = 8;
        nfpm.mint(id, address(this), address(usdc), address(launch), 10_000);
        nfpm.approve(address(locker), id);
        locker.lock(id, creator, CrucibleLock.Kind.Reflect, holders);

        usdc.mint(address(nfpm), 10_000e6);
        nfpm.setOwed(id, 10_000e6, 0);

        locker.collectFees(id);

        assertEq(usdc.balanceOf(holders), 2_000e6);
        assertEq(usdc.balanceOf(creator), 2_000e6);
        assertEq(usdc.balanceOf(platform), 1_000e6);
        assertEq(usdc.balanceOf(address(crucible)), 3_500e6); // 3000 + 500 unknown ref
        assertEq(launch.balanceOf(dead), 1_500e18); // project burn 15%
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
        // sell-side 1e18 token burn + project-burn 1000e6 USDC → 1000e18 launch
        assertEq(launch.balanceOf(dead), 1e18 + 1_000e18);
        assertEq(usdc.balanceOf(creator), 5_000e6);
    }

    function test_lockOnlyFactoryOrOwner() public {
        uint256 id = 99;
        nfpm.mint(id, address(this), address(usdc), address(launch), 10_000);
        nfpm.approve(address(locker), id);
        vm.prank(makeAddr("rando"));
        vm.expectRevert(CrucibleLock.NotFactory.selector);
        locker.lock(id, creator, CrucibleLock.Kind.Meme, address(0));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CrucibleLock} from "../src/CrucibleLock.sol";
import {Crucible} from "../src/Crucible.sol";
import {ReferralRegistry} from "../src/ReferralRegistry.sol";
import {InstantLockerAdapter} from "../src/InstantLockerAdapter.sol";
import {MockERC20, MockSwapRouter, MockNFPM} from "./mocks/Mocks.sol";

/// Exercises the full Instant-shaped create → collect path through the adapter: the factory
/// mints the LP NFT straight to the adapter (mirroring `recipient: lpLocker` in
/// InstantErc20QuoteFactory._mintSingleSided), then calls `lockPositionMeme` with the exact
/// ABI Instant's ILpLocker interface uses. Confirms the realized payout is CrucibleLock's
/// 50/25/10/10/5 Meme split — not Instant's own 70/0/30 ArcBpsSource split — and that nothing
/// but the wired Instant factory can drive a lock.
contract InstantLockerAdapterTest is Test {
    CrucibleLock internal locker;
    Crucible internal crucible;
    ReferralRegistry internal registry;
    InstantLockerAdapter internal adapter;
    MockERC20 internal usdc;
    MockERC20 internal launch;
    MockERC20 internal arcfun;
    MockSwapRouter internal router;
    MockNFPM internal nfpm;

    address internal platform = makeAddr("platform");
    address internal creator = makeAddr("creator");
    address internal instantFactory = makeAddr("instantFactory");

    uint256 internal constant TOKEN_ID = 42;

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
        adapter = new InstantLockerAdapter(address(locker), address(nfpm), instantFactory);
        locker.setFactory(address(adapter));

        // Mirrors InstantErc20QuoteFactory._mintSingleSided: UniV3 `mint(..., recipient: lpLocker)`
        // sends the fresh position straight to whatever `lpLocker` is configured — here, the adapter.
        nfpm.mint(TOKEN_ID, address(adapter), address(usdc), address(launch), 10_000);

        arcfun.mint(address(router), 1_000_000e18);
        launch.mint(address(router), 1_000_000e18);
    }

    function _seedFees(uint256 usdcFee, uint256 tokenFee) internal {
        if (usdcFee > 0) usdc.mint(address(nfpm), usdcFee);
        if (tokenFee > 0) launch.mint(address(nfpm), tokenFee);
        nfpm.setOwed(TOKEN_ID, uint128(usdcFee), uint128(tokenFee));
    }

    function test_onlyInstantFactoryCanLock() public {
        vm.expectRevert(InstantLockerAdapter.NotInstantFactory.selector);
        adapter.lockPositionMeme(TOKEN_ID, address(launch), address(usdc), address(0), 0, creator, 7_000);
    }

    function test_lockPositionMemeIgnoresCallerSuppliedBpsAndStamps5000() public {
        vm.prank(instantFactory);
        uint64 unlockTime = adapter.lockPositionMeme(
            TOKEN_ID,
            address(launch),
            address(usdc),
            address(0),
            0, // stakerBps — ignored
            creator,
            7_000 // creatorBps — ignored; CrucibleLock's Meme creator share is a fixed 5_000
        );

        assertEq(unlockTime, type(uint64).max);
        (address wallet, uint16 bps) = locker.creatorSplits(TOKEN_ID);
        assertEq(wallet, creator);
        assertEq(bps, 5_000, "adapter must not let the caller pick a different creator bps");
    }

    function test_nftEndsUpInCrucibleLockNotStrandedInAdapter() public {
        vm.prank(instantFactory);
        adapter.lockPositionMeme(TOKEN_ID, address(launch), address(usdc), address(0), 0, creator, 7_000);

        assertEq(nfpm.ownerOf(TOKEN_ID), address(locker));
    }

    /// End-to-end: lock through the adapter, seed a collectable fee, collect, and check the
    /// realized split is CrucibleLock's 50/25/10/10/5 — not Instant's 70/0/30.
    function test_collectAfterAdapterLockPaysCrucible5025101005NotInstant7030() public {
        vm.prank(instantFactory);
        adapter.lockPositionMeme(TOKEN_ID, address(launch), address(usdc), address(0), 0, creator, 7_000);

        uint256 fee = 10_000e6; // 10,000 USDC
        _seedFees(fee, 0);
        locker.collectFees(TOKEN_ID);

        // No referrer at lock → the 500 bps referrer slice folds into Crucible (2500 + 500 = 3000).
        assertEq(usdc.balanceOf(creator), 5_000e6, "creator should get 50%, not Instant's 70%");
        assertEq(usdc.balanceOf(platform), 1_000e6, "platform should get 10%, not Instant's 30%");
        assertEq(usdc.balanceOf(address(crucible)), 3_000e6, "crucible sink should get 25%+5% referrer fold-in");
        assertEq(locker.pendingProjectBurn(TOKEN_ID), 1_000e6, "project burn should accrue 10%");
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(InstantLockerAdapter.ZeroAddress.selector);
        new InstantLockerAdapter(address(0), address(nfpm), instantFactory);

        vm.expectRevert(InstantLockerAdapter.ZeroAddress.selector);
        new InstantLockerAdapter(address(locker), address(0), instantFactory);

        vm.expectRevert(InstantLockerAdapter.ZeroAddress.selector);
        new InstantLockerAdapter(address(locker), address(nfpm), address(0));
    }

    function test_ownerCanRotateInstantFactory() public {
        address next = makeAddr("nextFactory");
        adapter.setInstantFactory(next);
        assertEq(adapter.instantFactory(), next);

        // Old factory is no longer authorized.
        vm.prank(instantFactory);
        vm.expectRevert(InstantLockerAdapter.NotInstantFactory.selector);
        adapter.lockPositionMeme(TOKEN_ID, address(launch), address(usdc), address(0), 0, creator, 7_000);
    }

    function test_nonOwnerCannotRotateInstantFactory() public {
        vm.prank(creator);
        vm.expectRevert(InstantLockerAdapter.NotOwner.selector);
        adapter.setInstantFactory(makeAddr("attacker"));
    }
}

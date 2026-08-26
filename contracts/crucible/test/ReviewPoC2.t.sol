// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CrucibleLock} from "../src/CrucibleLock.sol";
import {Crucible} from "../src/Crucible.sol";
import {ReferralRegistry} from "../src/ReferralRegistry.sol";
import {MockERC20, MockSwapRouter, MockNFPM} from "./mocks/Mocks.sol";

/// Regression tests for the second-round slippage finding.
///
/// Requiring `minOut != 0` protected an honest keeper from burning dust by accident, but both swap
/// entrypoints were permissionless AND took the bound from the caller — so an attacker passed 1,
/// cleared the guard, and still accepted a manipulated price. A caller-supplied floor is not a
/// defence against that caller. Both swaps are now keeper-gated; collectFees stays permissionless
/// because it no longer swaps.
contract ReviewPoC2Test is Test {
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
    address internal attacker = makeAddr("attacker");
    address internal keeper = makeAddr("keeper");
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
        nfpm.mint(TOKEN_ID, address(this), address(usdc), address(launch), 10_000);
        nfpm.approve(address(locker), TOKEN_ID);
        locker.lock(TOKEN_ID, creator, CrucibleLock.Kind.Meme, address(0), "");
        launch.mint(address(router), 1_000_000e18);
        arcfun.mint(address(router), 1_000_000e18);

        locker.setKeeper(keeper, true);
        crucible.setKeeper(keeper, true);
    }

    function _seedFees(uint256 usdcFee) internal {
        usdc.mint(address(nfpm), usdcFee);
        nfpm.setOwed(TOKEN_ID, uint128(usdcFee), 0);
    }

    /// The original round-2 exploit: minOut = 1 on a collapsed pool. Now unreachable.
    function test_attackerCannotProjectBurnWithMinOutOfOne() public {
        _seedFees(10_000e6);
        locker.collectFees(TOKEN_ID);
        assertEq(locker.pendingProjectBurn(TOKEN_ID), 1_000e6);

        router.setOutPerIn(1);

        vm.prank(attacker);
        vm.expectRevert(CrucibleLock.NotKeeper.selector);
        locker.projectBurn(TOKEN_ID, 1);

        assertEq(locker.pendingProjectBurn(TOKEN_ID), 1_000e6, "burn budget untouched");
        assertEq(launch.balanceOf(dead), 0, "nothing burned at a manipulated price");
    }

    function test_attackerCannotCookWithMinOutOfOne() public {
        crucible.setArcfun(address(arcfun));
        usdc.mint(address(crucible), 5_000e6);
        router.setOutPerIn(1);

        vm.prank(attacker);
        vm.expectRevert(Crucible.NotKeeper.selector);
        crucible.cook(5_000e6, 1);

        assertEq(usdc.balanceOf(address(crucible)), 5_000e6, "treasury untouched");
        assertEq(arcfun.balanceOf(dead), 0, "nothing burned");
    }

    /// Gating must not break the intended operator.
    function test_keeperCanStillBurn() public {
        _seedFees(10_000e6);
        locker.collectFees(TOKEN_ID);

        vm.prank(keeper);
        uint256 out = locker.projectBurn(TOKEN_ID, 900e18);

        assertEq(out, 1_000e18, "keeper burned at the honest rate");
        assertEq(launch.balanceOf(dead), 1_000e18);
        assertEq(locker.pendingProjectBurn(TOKEN_ID), 0);
    }

    function test_keeperCanStillCook() public {
        crucible.setArcfun(address(arcfun));
        usdc.mint(address(crucible), 5_000e6);

        vm.prank(keeper);
        uint256 out = crucible.cook(5_000e6, 4_000e18);

        assertEq(out, 5_000e18);
        assertEq(arcfun.balanceOf(dead), 5_000e18);
    }

    /// A revoked keeper loses access immediately.
    function test_revokedKeeperIsRejected() public {
        _seedFees(10_000e6);
        locker.collectFees(TOKEN_ID);
        locker.setKeeper(keeper, false);

        vm.prank(keeper);
        vm.expectRevert(CrucibleLock.NotKeeper.selector);
        locker.projectBurn(TOKEN_ID, 900e18);
    }

    /// Collecting must stay open to anyone — it no longer swaps, so it is not price-sensitive.
    function test_collectFeesStaysPermissionless() public {
        _seedFees(10_000e6);

        vm.prank(attacker);
        locker.collectFees(TOKEN_ID);

        assertEq(usdc.balanceOf(creator), 5_000e6, "creator still paid by a stranger's collect");
        assertEq(locker.pendingProjectBurn(TOKEN_ID), 1_000e6);
    }

    /// The honest-keeper protection from the previous fix still holds on top of the gate.
    function test_keeperStillProtectedByMinOut() public {
        _seedFees(10_000e6);
        locker.collectFees(TOKEN_ID);
        router.setOutPerIn(1);

        vm.prank(keeper);
        vm.expectRevert();
        locker.projectBurn(TOKEN_ID, 900e18);

        assertEq(locker.pendingProjectBurn(TOKEN_ID), 1_000e6, "budget preserved");
    }
}

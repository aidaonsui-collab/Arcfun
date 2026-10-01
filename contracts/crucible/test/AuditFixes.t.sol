// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CrucibleLock} from "../src/CrucibleLock.sol";
import {Crucible} from "../src/Crucible.sol";
import {ReferralRegistry} from "../src/ReferralRegistry.sol";
import {ReferralRouter} from "../src/ReferralRouter.sol";
import {MockERC20, MockSwapRouter, MockNFPM, MockBlockingERC20} from "./mocks/Mocks.sol";
import {ISwapRouter02} from "../src/interfaces/ISwapRouter02.sol";

/// Regression tests for the audit findings. Each fails on the previous code.
contract AuditFixesTest is Test {
    CrucibleLock internal locker;
    Crucible internal crucible;
    ReferralRegistry internal registry;
    MockERC20 internal usdc;
    MockERC20 internal other;
    MockERC20 internal eve;
    MockSwapRouter internal router;
    MockNFPM internal nfpm;

    address internal platform = makeAddr("platform");
    address internal creator = makeAddr("creator");
    address internal dead = 0x000000000000000000000000000000000000dEaD;

    uint256 internal constant TOKEN_ID = 11;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        other = new MockERC20("Other", "OTHER", 18);
        eve = new MockERC20("EVE", "EVE", 18);
        router = new MockSwapRouter();
        nfpm = new MockNFPM();
        registry = new ReferralRegistry();
        crucible = new Crucible(address(usdc), address(router), address(eve), 10_000);
        locker = new CrucibleLock(
            address(nfpm), address(usdc), address(router), address(crucible), address(registry), platform
        );
    }

    // -- a hostile launch token must not freeze the USDC legs ----------------

    /// The sell-side burn was a hard `_pay`. A launch token that refuses the
    /// transfer to `dead` took the whole collect with it, so the creator, the
    /// platform and Crucible could not be paid their USDC either.
    function test_blockedLaunchTokenDoesNotFreezeUsdcLegs() public {
        MockBlockingERC20 launch = new MockBlockingERC20();
        nfpm.mint(TOKEN_ID, address(this), address(usdc), address(launch), 10_000);
        nfpm.approve(address(locker), TOKEN_ID);
        locker.lock(TOKEN_ID, creator, CrucibleLock.Kind.Meme, address(0), "");

        usdc.mint(address(nfpm), 1_000e6);
        launch.mint(address(nfpm), 40e18);
        nfpm.setOwed(TOKEN_ID, uint128(1_000e6), uint128(40e18));

        // The project token blacklists `dead`, so the burn cannot land.
        launch.setBlocked(dead, true);

        locker.collectFees(TOKEN_ID);

        // Meme split of 1000 USDC: creator 50%, platform 10%, project burn 10%,
        // Crucible the rest (25% + the 5% referrer slice folded in).
        assertEq(usdc.balanceOf(creator), 500e6, "creator paid");
        assertEq(usdc.balanceOf(platform), 100e6, "platform paid");
        assertEq(usdc.balanceOf(address(crucible)), 300e6, "crucible paid");
        assertEq(locker.pendingProjectBurn(TOKEN_ID), 100e6, "project burn accrued");

        // The burn is booked as owed to dead, not lost.
        assertEq(locker.owed(address(launch), dead), 40e18, "burn accrued");
        assertEq(launch.balanceOf(dead), 0, "nothing burned yet");

        // Once the token stops blocking, anyone can complete the burn.
        launch.setBlocked(dead, false);
        locker.withdrawOwed(address(launch), dead);
        assertEq(launch.balanceOf(dead), 40e18, "burn retried");
        assertEq(locker.owed(address(launch), dead), 0, "owed cleared");
    }

    /// The happy path must still burn straight through, nothing accrued.
    function test_healthyLaunchTokenStillBurnsImmediately() public {
        MockBlockingERC20 launch = new MockBlockingERC20();
        nfpm.mint(TOKEN_ID, address(this), address(usdc), address(launch), 10_000);
        nfpm.approve(address(locker), TOKEN_ID);
        locker.lock(TOKEN_ID, creator, CrucibleLock.Kind.Meme, address(0), "");

        launch.mint(address(nfpm), 40e18);
        nfpm.setOwed(TOKEN_ID, 0, uint128(40e18));

        locker.collectFees(TOKEN_ID);

        assertEq(launch.balanceOf(dead), 40e18, "burned");
        assertEq(locker.owed(address(launch), dead), 0, "nothing accrued");
    }

    // -- a position we cannot service must not be lockable -------------------

    /// There is no NFT withdraw, so locking a non-quote pool stranded the
    /// position forever: every `collectFees` on it reverts `NotUsdcPool`.
    function test_lockRejectsNonUsdcPool() public {
        MockERC20 launch = new MockERC20("MEME", "MEME", 18);
        nfpm.mint(TOKEN_ID, address(this), address(other), address(launch), 10_000);
        nfpm.approve(address(locker), TOKEN_ID);

        vm.expectRevert(CrucibleLock.NotUsdcPool.selector);
        locker.lock(TOKEN_ID, creator, CrucibleLock.Kind.Meme, address(0), "");

        assertEq(nfpm.ownerOf(TOKEN_ID), address(this), "nft not taken");
    }

    /// Both orderings of the pair are still accepted.
    function test_lockAcceptsUsdcAsEitherSide() public {
        MockERC20 launch = new MockERC20("MEME", "MEME", 18);

        nfpm.mint(1, address(this), address(usdc), address(launch), 10_000);
        nfpm.approve(address(locker), 1);
        locker.lock(1, creator, CrucibleLock.Kind.Meme, address(0), "");

        nfpm.mint(2, address(this), address(launch), address(usdc), 10_000);
        nfpm.approve(address(locker), 2);
        locker.lock(2, creator, CrucibleLock.Kind.Meme, address(0), "");

        (address w0,) = locker.creatorSplits(1);
        (address w1,) = locker.creatorSplits(2);
        assertEq(w0, creator);
        assertEq(w1, creator);
    }

    // -- rotating a router must not leave it able to pull ---------------------

    /// `_approveMax` grants an unlimited allowance. Rotating without revoking
    /// left a de-authorised router still able to pull this contract's USDC.
    /// `Crucible.setSwapRouter` already revoked; ReferralRouter did not.
    function test_referralRouterRevokesOldRouterAllowance() public {
        MockERC20 launch = new MockERC20("MEME", "MEME", 18);
        MockSwapRouter uni = new MockSwapRouter();
        ReferralRouter rtr = new ReferralRouter(address(usdc), address(uni), address(0), address(registry));
        launch.mint(address(uni), 1_000_000e18);

        address buyer = makeAddr("buyer");
        usdc.mint(buyer, 1_000e6);
        vm.startPrank(buyer);
        usdc.approve(address(rtr), type(uint256).max);
        rtr.buy(address(launch), 10_000, 1_000e6, 1, "");
        vm.stopPrank();

        assertEq(usdc.allowance(address(rtr), address(uni)), type(uint256).max, "approved in use");

        MockSwapRouter next = new MockSwapRouter();
        rtr.setSwapRouter(address(next));
        assertEq(usdc.allowance(address(rtr), address(uni)), 0, "old router revoked");
    }

    /// Same for the fee router, including when it is being disabled entirely.
    function test_referralRouterRevokesOldFeeRouterAllowance() public {
        MockERC20 launch = new MockERC20("MEME", "MEME", 18);
        MockSwapRouter uni = new MockSwapRouter();
        MockFeeRouter fee = new MockFeeRouter();
        ReferralRouter rtr = new ReferralRouter(address(usdc), address(uni), address(fee), address(registry));
        launch.mint(address(uni), 1_000_000e18);

        address buyer = makeAddr("buyer");
        usdc.mint(buyer, 1_000e6);
        vm.startPrank(buyer);
        usdc.approve(address(rtr), type(uint256).max);
        rtr.buy(address(launch), 10_000, 1_000e6, 1, "");
        vm.stopPrank();

        assertEq(usdc.allowance(address(rtr), address(fee)), type(uint256).max, "approved in use");

        rtr.setFeeRouter(address(0)); // fall back to the plain swap router
        assertEq(usdc.allowance(address(rtr), address(fee)), 0, "old fee router revoked");
    }
}

/// Minimal stand-in for the live Arc fee router: forwards to SwapRouter02 and
/// hands `tokenOut` back to its caller.
contract MockFeeRouter {
    function swapExactInput(
        address router,
        address tokenIn,
        address tokenOut,
        uint24 poolFee,
        uint256 amountIn,
        uint256 amountOutMinimum
    ) external returns (uint256 amountOut) {
        MockERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        MockERC20(tokenIn).approve(router, amountIn);
        amountOut = MockSwapRouter(router)
            .exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: poolFee,
                recipient: msg.sender,
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
            );
    }
}

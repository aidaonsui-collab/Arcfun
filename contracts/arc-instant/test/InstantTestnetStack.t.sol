// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {InstantTestnetStack} from "../script/InstantTestnetStack.sol";
import {InstantErc20QuoteFactory} from "../src/InstantErc20QuoteFactory.sol";
import {InstantErc20QuoteFactoryProxyInit} from "../src/InstantErc20QuoteFactoryProxyInit.sol";
import {MonLockProxyInit} from "../src/MonLockProxyInit.sol";
import {MonLock} from "../src/MonLock.sol";
import {MockUSDC} from "../script/testnet/MockUSDC.sol";

interface INFPMView {
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface ISwapRouter02Quote {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice In-memory Instant + throwaway Uni V3 stack. Does not use a canonical testnet factory.
contract InstantTestnetStackTest is Test {
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address internal constant MAINNET_LOCKER = 0x84F486d7254aEDc89986bce392771D88bf5828EA;

    InstantTestnetStack.Addresses internal s;
    address internal alice;

    function setUp() public {
        alice = makeAddr("alice");
        s = InstantTestnetStack.deploy(address(this));
        require(s.locker != MAINNET_LOCKER, "must not be live mainnet locker");
    }

    function test_deployCreateSwapCollectWithdraw() public {
        MockUSDC usdc = MockUSDC(s.mockUsdc);
        InstantErc20QuoteFactoryProxyInit factory = InstantErc20QuoteFactoryProxyInit(payable(s.factory));
        MonLock locker = MonLock(payable(s.locker));

        usdc.mint(alice, 1_000e6);

        vm.startPrank(alice);
        usdc.approve(s.factory, 100e6);
        // first-buy uses amountOutMinimum: 0 (existing Instant behavior — do not "fix")
        address token = factory.createTokenMemeInstantQuote("Smoke", "SMK", 100e6);
        vm.stopPrank();

        InstantErc20QuoteFactory.InstantQuotePool memory pool = factory.getPool(token);
        uint256 positionId = pool.positionId;
        assertGt(positionId, 0, "position");
        assertEq(INFPMView(s.nfpm).ownerOf(positionId), s.locker, "nft at throwaway locker");

        // Generate more quote-side + launch-token fees via SwapRouter02 (no deadline).
        vm.startPrank(alice);
        usdc.approve(s.swapRouter02, 200e6);
        ISwapRouter02Quote(s.swapRouter02).exactInputSingle(
            ISwapRouter02Quote.ExactInputSingleParams({
                tokenIn: s.mockUsdc,
                tokenOut: token,
                fee: 10_000,
                recipient: alice,
                amountIn: 50e6,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        uint256 tokBal = IERC20(token).balanceOf(alice);
        uint256 sellAmt = tokBal / 2;
        IERC20(token).approve(s.swapRouter02, sellAmt);
        ISwapRouter02Quote(s.swapRouter02).exactInputSingle(
            ISwapRouter02Quote.ExactInputSingleParams({
                tokenIn: token,
                tokenOut: s.mockUsdc,
                fee: 10_000,
                recipient: alice,
                amountIn: sellAmt,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();

        uint256 creatorUsdcBefore = usdc.balanceOf(alice);
        uint256 platformUsdcBefore = usdc.balanceOf(address(this));
        uint256 deadTokBefore = IERC20(token).balanceOf(DEAD);
        uint256 lockerUsdcBefore = usdc.balanceOf(s.locker);
        uint256 lockerTokBefore = IERC20(token).balanceOf(s.locker);

        // MonLock fee sweep (collectFees — there is no `collect` alias).
        locker.collectFees(positionId);

        uint256 creatorGot = usdc.balanceOf(alice) - creatorUsdcBefore;
        uint256 platformGot = usdc.balanceOf(address(this)) - platformUsdcBefore;
        uint256 quoteFees = creatorGot + platformGot;
        assertGt(quoteFees, 0, "quote-side USDC fees");
        // ~70% creator / ~30% platform (staker bps = 0). Exact floor-div of MonLock._splitQuote.
        assertEq(creatorGot, (quoteFees * 7000) / 10_000, "70% creator USDC");
        assertEq(platformGot, quoteFees - creatorGot, "30% platform USDC");
        assertEq(usdc.balanceOf(s.locker), lockerUsdcBefore, "locker keeps no USDC fees");

        uint256 burned = IERC20(token).balanceOf(DEAD) - deadTokBefore;
        // Launch-token fees route to dead; a zero burn is only OK if the sell produced no launch fees,
        // but the sell-half path should accrue some. Require burn > 0.
        assertGt(burned, 0, "launch-token fees to dead");
        assertEq(IERC20(token).balanceOf(s.locker), lockerTokBefore, "locker keeps no launch fees");

        (address beneficiary, uint64 unlockTime, bool withdrawn,,) = locker.locks(positionId);
        assertEq(beneficiary, address(this), "beneficiary");
        assertFalse(withdrawn);
        assertGt(unlockTime, block.timestamp, "still locked");

        vm.warp(uint256(locker.defaultLockDuration()) + block.timestamp + 1);
        locker.withdraw(positionId);
        assertEq(INFPMView(s.nfpm).ownerOf(positionId), address(this), "nft withdrawn to beneficiary");
        (,, bool withdrawnAfter,,) = locker.locks(positionId);
        assertTrue(withdrawnAfter);
        // Never upgrade or withdraw on live mainnet locker.
        assertTrue(s.locker != MAINNET_LOCKER);
    }
}

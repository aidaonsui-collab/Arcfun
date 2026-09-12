// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/types/BalanceDelta.sol";

import {RwaFeeHook} from "../src/RwaFeeHook.sol";
import {RwaInstantV4Factory} from "../src/RwaInstantV4Factory.sol";
import {MockRwaToken} from "./MockRwaToken.sol";
import {HookMiner} from "./utils/HookMiner.sol";

contract RwaInstantV4Test is Test {
    using PoolIdLibrary for PoolKey;

    PoolManager manager;
    PoolSwapTest swapRouter;
    RwaFeeHook hook;
    RwaInstantV4Factory factory;
    MockRwaToken quote;

    address deployer = address(this);
    address platform = makeAddr("platform");
    address crucible = makeAddr("crucible");
    address creator = makeAddr("creator");
    address trader = makeAddr("trader");

    uint160 constant REQUIRED_FLAGS = uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);

    function setUp() public {
        manager = new PoolManager(deployer);
        swapRouter = new PoolSwapTest(IPoolManager(address(manager)));

        (address hookAddr, bytes32 salt) = HookMiner.find(
            address(this), REQUIRED_FLAGS, type(RwaFeeHook).creationCode, abi.encode(address(manager), deployer)
        );
        hook = new RwaFeeHook{salt: salt}(IPoolManager(address(manager)), deployer);
        require(address(hook) == hookAddr, "hook address mismatch");

        factory = new RwaInstantV4Factory(IPoolManager(address(manager)), hook, platform, crucible);
        hook.setFactory(address(factory));

        quote = new MockRwaToken();
        quote.mint(trader, 1_000_000e6);
        vm.prank(trader);
        quote.approve(address(swapRouter), type(uint256).max);
    }

    function _launch() internal returns (address token, PoolId id, bool tokenIsCurrency0) {
        (token, id) = factory.createToken("Test RWA Token", "TRWA", address(quote), creator);
        tokenIsCurrency0 = token < address(quote);
    }

    function _key(address token, bool tokenIsCurrency0) internal view returns (PoolKey memory) {
        (Currency c0, Currency c1) = tokenIsCurrency0
            ? (Currency.wrap(token), Currency.wrap(address(quote)))
            : (Currency.wrap(address(quote)), Currency.wrap(token));
        return PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: factory.TICK_SPACING(), hooks: IHooks(address(hook))});
    }

    // ── launch ─────────────────────────────────────────────────────────────────────────────
    function test_launch_mintsFullSupplySingleSided() public {
        (address token,,) = _launch();
        assertEq(IERC20Like(token).totalSupply(), factory.TOTAL_SUPPLY());
        // getLiquidityForAmount0/1 rounds the liquidity *down* to the largest value that requires
        // at most TOTAL_SUPPLY — so a wei-level dust remainder is expected, not a bug. It just
        // sits in the factory (no function ever moves it, same as the position itself); assert
        // it's negligible (<0.001% of supply) rather than exactly zero.
        uint256 dust = IERC20Like(token).balanceOf(address(factory));
        assertLt(dust, factory.TOTAL_SUPPLY() / 100_000);
        // The quote token never moves at all — single-sided means zero quote required at mint.
        assertEq(quote.balanceOf(address(factory)), 0);
    }

    function test_launch_registersPoolOnHook() public {
        (address token, PoolId id,) = _launch();
        (bool registered, address regCreator, address regPlatform, address regCrucible, uint16 cBps, uint16 xBps, uint16 pBps, uint24 feeBps) = hook.configs(id);
        assertTrue(registered);
        assertEq(regCreator, creator);
        assertEq(regPlatform, platform);
        assertEq(regCrucible, crucible);
        assertEq(uint256(cBps) + xBps + pBps, 10_000);
        assertEq(feeBps, factory.HOOK_FEE_BPS());
        assertTrue(token != address(0));
    }

    // ── swap fee-split: the actual point of building this on v4 ──────────────────────────────
    function test_buySwap_feeSplitsAcrossCreatorCrucziblePlatform() public {
        (address token, , bool tokenIsCurrency0) = _launch();
        PoolKey memory key = _key(token, tokenIsCurrency0);

        uint256 payIn = 1_000e6; // 1000 mock-USYC
        bool zeroForOne = !tokenIsCurrency0; // paying quote means: quote -> token

        vm.prank(trader);
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(payIn), sqrtPriceLimitX96: zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        // Buying token with quote, exact-input: specified=quote(input), unspecified=token(output).
        // The hook taxes the unspecified side, so the fee should be denominated in TOKEN here,
        // not quote — and nothing should be owed in quote at all.
        Currency tokenCurrency = Currency.wrap(token);
        Currency quoteCurrency = Currency.wrap(address(quote));

        uint256 creatorTok = hook.owed(creator, tokenCurrency);
        uint256 platformTok = hook.owed(platform, tokenCurrency);
        uint256 crucibleTok = hook.owed(crucible, tokenCurrency);
        uint256 totalFeeTok = creatorTok + platformTok + crucibleTok;

        assertGt(totalFeeTok, 0, "fee should have accrued in the token");
        assertEq(hook.owed(creator, quoteCurrency), 0, "no fee should accrue in quote on a buy");

        // Exact split proportions, matching the factory's constants.
        assertEq(creatorTok, (totalFeeTok * factory.CREATOR_BPS()) / 10_000);
        assertEq(platformTok, (totalFeeTok * factory.PLATFORM_BPS()) / 10_000);
        assertEq(crucibleTok, totalFeeTok - creatorTok - platformTok); // remainder-absorbs-dust leg
    }

    function test_sellSwap_feeAccruesInQuoteInstead() public {
        (address token, , bool tokenIsCurrency0) = _launch();
        PoolKey memory key = _key(token, tokenIsCurrency0);

        // First, buy some token so the trader has some to sell.
        bool buyZeroForOne = !tokenIsCurrency0;
        vm.prank(trader);
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: buyZeroForOne, amountSpecified: -int256(10_000e6), sqrtPriceLimitX96: buyZeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        Currency tokenCurrency = Currency.wrap(token);
        Currency quoteCurrency = Currency.wrap(address(quote));
        uint256 quoteOwedBefore = hook.owed(creator, quoteCurrency) + hook.owed(platform, quoteCurrency) + hook.owed(crucible, quoteCurrency);
        assertEq(quoteOwedBefore, 0, "sanity: no quote fee from the buy leg");
        assertGt(hook.owed(creator, tokenCurrency), 0, "sanity: the buy leg's fee landed in token, per the other test");

        uint256 tokenBal = IERC20Like(token).balanceOf(trader);
        assertGt(tokenBal, 0);

        vm.prank(trader);
        IERC20Like(token).approve(address(swapRouter), type(uint256).max);

        bool sellZeroForOne = tokenIsCurrency0; // selling token means: token -> quote
        uint256 sellAmount = tokenBal / 2;
        vm.prank(trader);
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: sellZeroForOne, amountSpecified: -int256(sellAmount), sqrtPriceLimitX96: sellZeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        // Selling token for quote, exact-input: specified=token(input), unspecified=quote(output).
        uint256 quoteOwedAfter = hook.owed(creator, quoteCurrency) + hook.owed(platform, quoteCurrency) + hook.owed(crucible, quoteCurrency);
        assertGt(quoteOwedAfter, 0, "sell should tax the quote (output) side");
    }

    function testFuzz_buySwap_splitProportionsHoldAtAnySize(uint256 payIn) public {
        payIn = bound(payIn, 1e6, 500_000e6); // 1 to 500k mock-USYC — trader holds 1,000,000e6
        (address token, , bool tokenIsCurrency0) = _launch();
        PoolKey memory key = _key(token, tokenIsCurrency0);
        bool zeroForOne = !tokenIsCurrency0;

        vm.prank(trader);
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(payIn), sqrtPriceLimitX96: zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        Currency tokenCurrency = Currency.wrap(token);
        uint256 creatorTok = hook.owed(creator, tokenCurrency);
        uint256 platformTok = hook.owed(platform, tokenCurrency);
        uint256 crucibleTok = hook.owed(crucible, tokenCurrency);
        uint256 total = creatorTok + platformTok + crucibleTok;
        if (total == 0) return; // dust-sized trade rounded the fee to zero — nothing to check

        assertEq(creatorTok, (total * factory.CREATOR_BPS()) / 10_000);
        assertEq(platformTok, (total * factory.PLATFORM_BPS()) / 10_000);
        assertEq(crucibleTok, total - creatorTok - platformTok);
    }

    // ── withdraw ───────────────────────────────────────────────────────────────────────────
    function test_withdraw_paysRealTokensAndZeroesOwed() public {
        (address token, , bool tokenIsCurrency0) = _launch();
        PoolKey memory key = _key(token, tokenIsCurrency0);
        bool zeroForOne = !tokenIsCurrency0;
        vm.prank(trader);
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(1_000e6), sqrtPriceLimitX96: zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        Currency tokenCurrency = Currency.wrap(token);
        uint256 owedBefore = hook.owed(creator, tokenCurrency);
        assertGt(owedBefore, 0);

        vm.prank(creator);
        uint256 got = hook.withdraw(tokenCurrency);
        assertEq(got, owedBefore);
        assertEq(hook.owed(creator, tokenCurrency), 0);
        assertEq(IERC20Like(token).balanceOf(creator), owedBefore);
    }

    function test_withdraw_zeroWhenNothingOwed() public {
        Currency c = Currency.wrap(address(quote));
        vm.prank(creator);
        assertEq(hook.withdraw(c), 0);
    }

    // ── admin guards ───────────────────────────────────────────────────────────────────────
    function test_onlyFactory_canRegisterPool() public {
        PoolKey memory fakeKey; // zero-valued, fine — this must revert before touching it meaningfully
        vm.expectRevert(RwaFeeHook.NotFactory.selector);
        hook.registerPool(fakeKey, creator, platform, crucible, 5000, 4000, 1000, 100);
    }

    function test_onlyPoolManager_canCallAfterSwap() public {
        PoolKey memory fakeKey;
        SwapParams memory p;
        vm.expectRevert(RwaFeeHook.NotManager.selector);
        hook.afterSwap(address(this), fakeKey, p, BalanceDeltaLibrary.ZERO_DELTA, "");
    }

    function test_onlyOwner_guardsHookAdmin() public {
        vm.startPrank(trader);
        vm.expectRevert(RwaFeeHook.NotOwner.selector);
        hook.setFactory(trader);
        vm.expectRevert(RwaFeeHook.NotOwner.selector);
        hook.transferOwnership(trader);
        vm.stopPrank();

        hook.transferOwnership(trader);
        assertEq(hook.owner(), trader);
    }

    function test_onlyOwner_guardsFactoryAdmin() public {
        vm.startPrank(trader);
        vm.expectRevert();
        factory.setPlatformWallet(trader);
        vm.expectRevert();
        factory.setCrucible(trader);
        vm.expectRevert();
        factory.transferOwnership(trader);
        vm.stopPrank();
    }

}

interface IERC20Like {
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

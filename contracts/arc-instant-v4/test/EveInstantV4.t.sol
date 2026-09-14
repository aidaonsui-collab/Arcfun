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
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {BalanceDeltaLibrary} from "v4-core/types/BalanceDelta.sol";

import {EveFeeHook} from "../src/EveFeeHook.sol";
import {EveInstantV4Factory} from "../src/EveInstantV4Factory.sol";
import {EveV4Router} from "../src/EveV4Router.sol";
import {HolderSink} from "../src/HolderSink.sol";
import {VirtualQuote} from "../src/libraries/VirtualQuote.sol";
import {MockRwaToken} from "./MockRwaToken.sol";
import {HookMiner} from "./utils/HookMiner.sol";

contract EveInstantV4Test is Test {
    using PoolIdLibrary for PoolKey;

    PoolManager manager;
    PoolSwapTest swapRouter;
    EveFeeHook hook;
    EveInstantV4Factory factory;
    EveV4Router router;
    MockRwaToken quote;

    address deployer = address(this);
    address platform = makeAddr("platform");
    address creator = makeAddr("creator");
    address trader = makeAddr("trader");
    address holders = makeAddr("holders");

    uint160 constant REQUIRED_FLAGS = uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);
    uint256 constant VQ_6DP = 5_500e6;
    uint160 constant MIN_SQRT = 4295128740;
    uint160 constant MAX_SQRT = 1461446703485210103287273052203988822378723970341;

    function setUp() public {
        manager = new PoolManager(deployer);
        swapRouter = new PoolSwapTest(IPoolManager(address(manager)));

        (address hookAddr, bytes32 salt) = HookMiner.find(
            address(this), REQUIRED_FLAGS, type(EveFeeHook).creationCode, abi.encode(address(manager), address(this))
        );
        hook = new EveFeeHook{salt: salt}(IPoolManager(address(manager)), address(this));
        require(address(hook) == hookAddr, "hook address mismatch");

        factory = new EveInstantV4Factory(IPoolManager(address(manager)), hook, platform);
        hook.setFactory(address(factory));
        router = new EveV4Router(IPoolManager(address(manager)));

        quote = new MockRwaToken();
        quote.mint(trader, 1_000_000e6);
        vm.prank(trader);
        quote.approve(address(swapRouter), type(uint256).max);
    }

    function _creatorSplit() internal pure returns (EveFeeHook.Split memory) {
        return EveFeeHook.Split({
            feeBps: 100,
            creatorBps: 7_000,
            burnBps: 1_000,
            holdersBps: 0,
            autoLpBps: 1_000,
            platformBps: 1_000
        });
    }

    function _reflectSplit() internal pure returns (EveFeeHook.Split memory) {
        return EveFeeHook.Split({
            feeBps: 100,
            creatorBps: 2_000,
            burnBps: 1_000,
            holdersBps: 5_000,
            autoLpBps: 1_000,
            platformBps: 1_000
        });
    }

    function _scorchedSplit() internal pure returns (EveFeeHook.Split memory) {
        return EveFeeHook.Split({
            feeBps: 100,
            creatorBps: 2_000,
            burnBps: 6_000,
            holdersBps: 0,
            autoLpBps: 1_000,
            platformBps: 1_000
        });
    }

    function _launch() internal returns (address token, PoolId id, bool tokenIsCurrency0) {
        (token, id) = factory.createToken("Test Eve Token", "TEVE", address(quote), creator);
        tokenIsCurrency0 = token < address(quote);
    }

    function _launchSplit(EveFeeHook.Split memory split, address holders_)
        internal
        returns (address token, PoolId id, bool tokenIsCurrency0)
    {
        (token, id,) =
            factory.createToken("Custom", "CUST", address(quote), creator, 0, 0, split, holders_);
        tokenIsCurrency0 = token < address(quote);
    }

    function _key(address token, bool tokenIsCurrency0) internal view returns (PoolKey memory) {
        (Currency c0, Currency c1) = tokenIsCurrency0
            ? (Currency.wrap(token), Currency.wrap(address(quote)))
            : (Currency.wrap(address(quote)), Currency.wrap(token));
        return PoolKey({
            currency0: c0, currency1: c1, fee: 0, tickSpacing: factory.TICK_SPACING(), hooks: IHooks(address(hook))
        });
    }

    function _buy(PoolKey memory key, bool tokenIsCurrency0, uint256 payIn) internal {
        bool zeroForOne = !tokenIsCurrency0;
        vm.prank(trader);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(payIn),
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _sellHalf(address token, PoolKey memory key, bool tokenIsCurrency0) internal {
        uint256 tokenBal = IERC20Like(token).balanceOf(trader);
        assertGt(tokenBal, 0);
        vm.prank(trader);
        IERC20Like(token).approve(address(swapRouter), type(uint256).max);
        bool sellZeroForOne = tokenIsCurrency0;
        vm.prank(trader);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: sellZeroForOne,
                amountSpecified: -int256(tokenBal / 2),
                sqrtPriceLimitX96: sellZeroForOne ? MIN_SQRT : MAX_SQRT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    // ── launch ─────────────────────────────────────────────────────────────────────────────
    function test_launch_mintsFullSupplySingleSided() public {
        (address token,,) = _launch();
        assertEq(IERC20Like(token).totalSupply(), factory.TOTAL_SUPPLY());
        uint256 dust = IERC20Like(token).balanceOf(address(factory));
        assertLt(dust, factory.TOTAL_SUPPLY() / 100_000);
        assertEq(quote.balanceOf(address(factory)), 0);
    }

    function test_launch_registersCreatorPresetOnHook() public {
        (address token, PoolId id,) = _launch();
        (
            bool registered,
            address regCreator,
            address regHolders,
            address regAutoLp,
            address regPlatform,
            address launch,
            uint16 feeBps,
            uint16 cBps,
            uint16 bBps,
            uint16 hBps,
            uint16 aBps,
            uint16 pBps
        ) = hook.configs(id);
        assertTrue(registered);
        assertEq(regCreator, creator);
        assertEq(regHolders, address(0));
        assertEq(regAutoLp, address(factory));
        assertEq(regPlatform, platform);
        assertEq(launch, token);
        assertEq(feeBps, factory.DEFAULT_FEE_BPS());
        assertEq(cBps, 7_000);
        assertEq(bBps, 1_000);
        assertEq(hBps, 0);
        assertEq(aBps, 1_000);
        assertEq(pBps, 1_000);
        assertEq(uint256(cBps) + bBps + hBps + aBps + pBps, 10_000);
    }

    // ── swap fee-split ─────────────────────────────────────────────────────────────────────
    function test_buySwap_feeSplitsAndBurnsLaunchToken() public {
        (address token, PoolId id, bool tokenIsCurrency0) = _launch();
        PoolKey memory key = _key(token, tokenIsCurrency0);
        _buy(key, tokenIsCurrency0, 1_000e6);

        Currency tokenCurrency = Currency.wrap(token);
        Currency quoteCurrency = Currency.wrap(address(quote));

        uint256 creatorTok = hook.owed(creator, tokenCurrency);
        uint256 platformTok = hook.owed(platform, tokenCurrency);
        uint256 autoLpTok = hook.pendingAutoLp(id, tokenCurrency);
        uint256 burnTok = IERC20Like(token).balanceOf(hook.DEAD());
        uint256 totalFeeTok = creatorTok + platformTok + autoLpTok + burnTok;

        assertGt(totalFeeTok, 0, "fee should have accrued in the token");
        assertEq(hook.owed(creator, quoteCurrency), 0, "no fee should accrue in quote on a buy");
        assertEq(hook.owed(address(factory), tokenCurrency), 0, "auto-LP is per-pool, not factory owed");
        assertEq(hook.pendingBurn(id, tokenCurrency), 0, "buy-side burn is in-swap to dead");
        assertEq(hook.pendingBurn(id, quoteCurrency), 0);

        assertEq(creatorTok, (totalFeeTok * 7_000) / 10_000);
        assertEq(burnTok, (totalFeeTok * 1_000) / 10_000);
        assertEq(autoLpTok, (totalFeeTok * 1_000) / 10_000);
        assertEq(platformTok, totalFeeTok - creatorTok - burnTok - autoLpTok);
    }

    function test_sellSwap_burnAccruesAsPendingQuote() public {
        (address token, PoolId id, bool tokenIsCurrency0) = _launch();
        PoolKey memory key = _key(token, tokenIsCurrency0);
        _buy(key, tokenIsCurrency0, 10_000e6);

        Currency quoteCurrency = Currency.wrap(address(quote));
        assertEq(
            hook.owed(creator, quoteCurrency) + hook.owed(platform, quoteCurrency)
                + hook.pendingAutoLp(id, quoteCurrency) + hook.pendingBurn(id, quoteCurrency),
            0,
            "sanity: no quote fee from the buy leg"
        );

        _sellHalf(token, key, tokenIsCurrency0);

        uint256 quoteOwed = hook.owed(creator, quoteCurrency) + hook.owed(platform, quoteCurrency);
        uint256 autoLpQuote = hook.pendingAutoLp(id, quoteCurrency);
        uint256 pending = hook.pendingBurn(id, quoteCurrency);
        assertGt(quoteOwed, 0, "sell should tax the quote (output) side");
        assertGt(autoLpQuote, 0, "sell-side auto-LP accrues per-pool");
        assertGt(pending, 0, "sell-side burn cannot swap in afterSwap");
        assertEq(quote.balanceOf(hook.DEAD()), 0, "quote is not sent to dead");
        assertEq(hook.owed(address(factory), quoteCurrency), 0, "auto-LP is not mixed into factory owed");
    }

    function test_scorched_buyBurnsSixtyPercentToDead() public {
        (address token, PoolId id, bool tokenIsCurrency0) = _launchSplit(_scorchedSplit(), address(0));
        PoolKey memory key = _key(token, tokenIsCurrency0);
        _buy(key, tokenIsCurrency0, 1_000e6);

        Currency tokenCurrency = Currency.wrap(token);
        uint256 creatorTok = hook.owed(creator, tokenCurrency);
        uint256 platformTok = hook.owed(platform, tokenCurrency);
        uint256 autoLpTok = hook.pendingAutoLp(id, tokenCurrency);
        uint256 burnTok = IERC20Like(token).balanceOf(hook.DEAD());
        uint256 total = creatorTok + platformTok + autoLpTok + burnTok;
        assertGt(total, 0);
        assertEq(burnTok, (total * 6_000) / 10_000);
        assertEq(creatorTok, (total * 2_000) / 10_000);
    }

    function test_reflect_deploysSinkDistributeAndClaim() public {
        (address token, PoolId id, bool tokenIsCurrency0) = _launchSplit(_reflectSplit(), address(0));
        (,,, address sinkAddr,) = factory.poolOf(token);
        assertTrue(sinkAddr != address(0));
        HolderSink sink = HolderSink(sinkAddr);

        PoolKey memory key = _key(token, tokenIsCurrency0);
        _buy(key, tokenIsCurrency0, 10_000e6);

        Currency tokenCurrency = Currency.wrap(token);
        uint256 holdersTok = hook.owed(sinkAddr, tokenCurrency);
        assertGt(holdersTok, 0);

        sink.distribute();
        assertEq(hook.owed(sinkAddr, tokenCurrency), 0);

        uint256 traderBal = IERC20Like(token).balanceOf(trader);
        assertGt(traderBal, 0);
        (uint256 previewLaunch,) = sink.preview(trader);
        assertGt(previewLaunch, 0);

        vm.prank(trader);
        (uint256 claimed,) = sink.claim();
        assertEq(claimed, previewLaunch);
        assertGt(IERC20Like(token).balanceOf(trader), traderBal);
        assertTrue(PoolId.unwrap(id) != bytes32(0));
    }

    function test_router_swapExactInBuy() public {
        (address token,, bool tokenIsCurrency0) = _launch();
        PoolKey memory key = _key(token, tokenIsCurrency0);
        quote.mint(trader, 1_000e6);
        vm.startPrank(trader);
        quote.approve(address(router), 1_000e6);
        uint256 out = router.swapExactIn(key, !tokenIsCurrency0, 1_000e6, 1, trader);
        vm.stopPrank();
        assertGt(out, 0);
        assertEq(IERC20Like(token).balanceOf(trader), out);
    }

    function testFuzz_buySwap_splitProportionsHoldAtAnySize(uint256 payIn) public {
        payIn = bound(payIn, 1e6, 500_000e6);
        (address token, PoolId id, bool tokenIsCurrency0) = _launch();
        PoolKey memory key = _key(token, tokenIsCurrency0);
        _buy(key, tokenIsCurrency0, payIn);

        Currency tokenCurrency = Currency.wrap(token);
        uint256 creatorTok = hook.owed(creator, tokenCurrency);
        uint256 platformTok = hook.owed(platform, tokenCurrency);
        uint256 autoLpTok = hook.pendingAutoLp(id, tokenCurrency);
        uint256 burnTok = IERC20Like(token).balanceOf(hook.DEAD());
        uint256 total = creatorTok + platformTok + autoLpTok + burnTok;
        if (total == 0) return;

        assertEq(creatorTok, (total * 7_000) / 10_000);
        assertEq(burnTok, (total * 1_000) / 10_000);
        assertEq(autoLpTok, (total * 1_000) / 10_000);
        assertEq(platformTok, total - creatorTok - burnTok - autoLpTok);
    }

    function test_feeBounds_030And300Work() public {
        EveFeeHook.Split memory lo = _creatorSplit();
        lo.feeBps = 30;
        (address tLo,, bool zLo) = _launchSplit(lo, address(0));
        _buy(_key(tLo, zLo), zLo, 10_000e6);
        assertGt(hook.owed(creator, Currency.wrap(tLo)), 0);

        EveFeeHook.Split memory hi = _creatorSplit();
        hi.feeBps = 300;
        (address tHi,, bool zHi) = _launchSplit(hi, address(0));
        _buy(_key(tHi, zHi), zHi, 10_000e6);
        assertGt(hook.owed(creator, Currency.wrap(tHi)), 0);
    }

    function test_create_rejectsFeeOutOfRange() public {
        EveFeeHook.Split memory s = _creatorSplit();
        s.feeBps = 29;
        vm.expectRevert(EveFeeHook.BadFeeBps.selector);
        factory.createToken("X", "X", address(quote), creator, 0, 0, s, address(0));

        s.feeBps = 301;
        vm.expectRevert(EveFeeHook.BadFeeBps.selector);
        factory.createToken("Y", "Y", address(quote), creator, 0, 0, s, address(0));
    }

    function test_create_rejectsPlatformBelowFloor() public {
        EveFeeHook.Split memory s = EveFeeHook.Split({
            feeBps: 100,
            creatorBps: 8_000,
            burnBps: 1_000,
            holdersBps: 0,
            autoLpBps: 1_000,
            platformBps: 0
        });
        vm.expectRevert(EveFeeHook.BadSplit.selector);
        factory.createToken("X", "X", address(quote), creator, 0, 0, s, address(0));
    }

    function test_create_reflectZeroHoldersDeploysSink() public {
        (address token,,) = _launchSplit(_reflectSplit(), address(0));
        (,,, address sinkAddr,) = factory.poolOf(token);
        assertTrue(sinkAddr != address(0));
    }

    function test_create_rejectsSplitNot100() public {
        EveFeeHook.Split memory s = _creatorSplit();
        s.creatorBps = 6_000;
        vm.expectRevert(EveFeeHook.BadSplit.selector);
        factory.createToken("X", "X", address(quote), creator, 0, 0, s, address(0));
    }

    // ── withdraw ───────────────────────────────────────────────────────────────────────────
    function test_withdraw_paysRealTokensAndZeroesOwed() public {
        (address token,, bool tokenIsCurrency0) = _launch();
        PoolKey memory key = _key(token, tokenIsCurrency0);
        _buy(key, tokenIsCurrency0, 1_000e6);

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
        PoolKey memory fakeKey;
        EveFeeHook.Split memory s = _creatorSplit();
        vm.expectRevert(EveFeeHook.NotFactory.selector);
        hook.registerPool(fakeKey, creator, address(0), address(this), platform, address(1), s);
    }

    function test_secondFactory_canBeAllowed() public {
        address other = makeAddr("otherFactory");
        hook.setFactoryAllowed(other, true);
        assertTrue(hook.isFactory(address(factory)));
        assertTrue(hook.isFactory(other));
        hook.setFactoryAllowed(other, false);
        assertFalse(hook.isFactory(other));
        assertTrue(hook.isFactory(address(factory)));
    }

    function test_onlyPoolManager_canCallAfterSwap() public {
        PoolKey memory fakeKey;
        SwapParams memory p;
        vm.expectRevert(EveFeeHook.NotManager.selector);
        hook.afterSwap(address(this), fakeKey, p, BalanceDeltaLibrary.ZERO_DELTA, "");
    }

    function test_onlyOwner_guardsHookAdmin() public {
        vm.startPrank(trader);
        vm.expectRevert(EveFeeHook.NotOwner.selector);
        hook.setFactory(trader);
        vm.expectRevert(EveFeeHook.NotOwner.selector);
        hook.transferOwnership(trader);
        vm.stopPrank();

        hook.transferOwnership(trader);
        assertEq(hook.owner(), trader);
    }

    function test_onlyOwner_guardsFactoryAdmin() public {
        vm.startPrank(trader);
        vm.expectRevert(EveInstantV4Factory.NotOwner.selector);
        factory.setPlatformWallet(trader);
        vm.expectRevert(EveInstantV4Factory.NotOwner.selector);
        factory.transferOwnership(trader);
        vm.stopPrank();
    }

    // ── launchVirtualQuote + first buy ─────────────────────────────────────────────────────
    function test_virtualQuote_opensOffTheTickEdge() public {
        (address token, PoolId id,) = factory.createToken("VQ", "VQ", address(quote), creator, VQ_6DP, 0);
        bool tokenIsCurrency0 = token < address(quote);
        (uint160 sqrtPrice,,,) = StateLibrary.getSlot0(IPoolManager(address(manager)), id);

        int24 minU = TickMath.minUsableTick(factory.TICK_SPACING());
        int24 maxU = TickMath.maxUsableTick(factory.TICK_SPACING());
        uint160 edge = TickMath.getSqrtPriceAtTick(tokenIsCurrency0 ? minU : maxU - factory.TICK_SPACING());
        assertTrue(sqrtPrice != edge, "virtual quote should not sit on the usable-tick edge");

        uint160 ideal = VirtualQuote.sqrtPriceX96(tokenIsCurrency0, VQ_6DP, VirtualQuote.VIRTUAL_TOKEN_INIT);
        uint256 distIdeal = sqrtPrice > ideal ? sqrtPrice - ideal : ideal - sqrtPrice;
        uint256 distEdge = sqrtPrice > edge ? sqrtPrice - edge : edge - sqrtPrice;
        assertLt(distIdeal, distEdge);
        assertTrue(token != address(0));
    }

    function test_firstBuy_sameTxPullsQuoteAndPaysBuyer() public {
        uint256 buyIn = 100e6;
        quote.mint(creator, buyIn);
        vm.startPrank(creator);
        quote.approve(address(factory), buyIn);
        (address token,, uint256 tokensOut) = factory.createToken("FB", "FB", address(quote), creator, VQ_6DP, buyIn);
        vm.stopPrank();

        assertGt(tokensOut, 0);
        assertEq(IERC20Like(token).balanceOf(creator), tokensOut);
        assertEq(quote.balanceOf(address(factory)), 0);
        assertEq(quote.balanceOf(creator), 0);
        assertGt(hook.owed(creator, Currency.wrap(token)), 0);
        assertLt(tokensOut, factory.TOTAL_SUPPLY() / 10);
        assertGt(IERC20Like(token).balanceOf(hook.DEAD()), 0, "first buy is taxed; burn leg hits dead");
    }

    function test_firstBuy_zeroSkipsSwap() public {
        (address token,, uint256 tokensOut) = factory.createToken("Z", "Z", address(quote), creator, VQ_6DP, 0);
        assertEq(tokensOut, 0);
        assertEq(IERC20Like(token).balanceOf(creator), 0);
    }

    function test_setLaunchVirtualQuote_usedWhenPerCreateIsZero() public {
        factory.setLaunchVirtualQuote(VQ_6DP);
        (address token, PoolId id) = factory.createToken("DEF", "DEF", address(quote), creator);
        (uint160 sqrtPrice,,,) = StateLibrary.getSlot0(IPoolManager(address(manager)), id);
        bool tokenIsCurrency0 = token < address(quote);
        int24 minU = TickMath.minUsableTick(factory.TICK_SPACING());
        uint160 edge = TickMath.getSqrtPriceAtTick(
            tokenIsCurrency0
                ? minU
                : TickMath.maxUsableTick(factory.TICK_SPACING()) - factory.TICK_SPACING()
        );
        assertTrue(sqrtPrice != edge);
    }

    function _positionLiq(address token, PoolId id) internal view returns (uint128 liq) {
        (liq,,) = StateLibrary.getPositionInfo(
            IPoolManager(address(manager)),
            id,
            address(factory),
            factory.tickLowerOf(token),
            factory.tickUpperOf(token),
            bytes32(0)
        );
    }

    function test_flushAutoLp_noopWhenEmpty() public {
        (address token,,) = _launch();
        assertEq(factory.flushAutoLp(token), 0);
    }

    function test_flushAutoLp_unknownTokenReverts() public {
        vm.expectRevert(EveInstantV4Factory.ZeroAddress.selector);
        factory.flushAutoLp(address(0xBEEF));
    }

    function test_claimAutoLp_onlyFactory() public {
        (address token,, bool tokenIsCurrency0) = _launch();
        PoolKey memory key = _key(token, tokenIsCurrency0);
        vm.prank(trader);
        vm.expectRevert(EveFeeHook.NotAutoLp.selector);
        hook.claimAutoLp(key);
    }

    function test_flushAutoLp_restowsWhenOnlyBuySide() public {
        (address token, PoolId id, bool tokenIsCurrency0) = _launch();
        PoolKey memory key = _key(token, tokenIsCurrency0);
        _buy(key, tokenIsCurrency0, 10_000e6);

        Currency tokenCurrency = Currency.wrap(token);
        uint256 pending = hook.pendingAutoLp(id, tokenCurrency);
        assertGt(pending, 0);
        uint256 factoryTokBefore = IERC20Like(token).balanceOf(address(factory));
        uint128 liqBefore = _positionLiq(token, id);

        uint128 added = factory.flushAutoLp(token);
        assertEq(added, 0, "in-range single-sided inventory cannot mint");
        assertEq(hook.pendingAutoLp(id, tokenCurrency), pending, "restowed");
        assertEq(IERC20Like(token).balanceOf(address(factory)), factoryTokBefore, "factory does not keep the slice");
        assertEq(_positionLiq(token, id), liqBefore);
    }

    function test_flushAutoLp_mintsAfterBuyAndSell() public {
        (address token, PoolId id, bool tokenIsCurrency0) = _launch();
        PoolKey memory key = _key(token, tokenIsCurrency0);
        _buy(key, tokenIsCurrency0, 10_000e6);
        _sellHalf(token, key, tokenIsCurrency0);

        Currency tokenCurrency = Currency.wrap(token);
        Currency quoteCurrency = Currency.wrap(address(quote));
        uint256 pendingTok = hook.pendingAutoLp(id, tokenCurrency);
        uint256 pendingQuote = hook.pendingAutoLp(id, quoteCurrency);
        assertGt(pendingTok, 0);
        assertGt(pendingQuote, 0);

        uint128 liqBefore = _positionLiq(token, id);
        uint128 added = factory.flushAutoLp(token);
        assertGt(added, 0, "both sides in-range should mint");
        assertEq(_positionLiq(token, id), liqBefore + added);

        uint256 leftTok = hook.pendingAutoLp(id, tokenCurrency);
        uint256 leftQuote = hook.pendingAutoLp(id, quoteCurrency);
        assertTrue(leftTok < pendingTok || leftQuote < pendingQuote, "at least the limiting side is spent");
        assertLt(IERC20Like(token).balanceOf(address(factory)), factory.TOTAL_SUPPLY() / 100_000);
        assertEq(quote.balanceOf(address(factory)), 0);
    }

    function test_flushAutoLp_twoPoolsQuoteIsolated() public {
        (address tokenA, PoolId idA, bool zA) = _launch();
        (address tokenB, PoolId idB) = factory.createToken("Other", "OTHR", address(quote), creator);
        bool zB = tokenB < address(quote);

        _buy(_key(tokenA, zA), zA, 5_000e6);
        _buy(_key(tokenB, zB), zB, 5_000e6);
        _sellHalf(tokenA, _key(tokenA, zA), zA);
        _sellHalf(tokenB, _key(tokenB, zB), zB);

        Currency q = Currency.wrap(address(quote));
        uint256 pendingA = hook.pendingAutoLp(idA, q);
        uint256 pendingB = hook.pendingAutoLp(idB, q);
        assertGt(pendingA, 0);
        assertGt(pendingB, 0);

        factory.flushAutoLp(tokenA);
        assertEq(hook.pendingAutoLp(idB, q), pendingB, "pool B quote auto-LP must not mix into A");
        assertTrue(pendingA > 0);
    }

    function test_flushQuoteBurn_swapsQuoteToLaunchDead() public {
        (address token, PoolId id, bool tokenIsCurrency0) = _launch();
        PoolKey memory key = _key(token, tokenIsCurrency0);
        _buy(key, tokenIsCurrency0, 10_000e6);
        uint256 deadBefore = IERC20Like(token).balanceOf(hook.DEAD());
        _sellHalf(token, key, tokenIsCurrency0);

        Currency quoteCurrency = Currency.wrap(address(quote));
        uint256 pending = hook.pendingBurn(id, quoteCurrency);
        assertGt(pending, 0);
        uint256 creatorBefore = hook.owed(creator, Currency.wrap(token));

        vm.prank(trader);
        uint256 burned = hook.flushQuoteBurn(key, 0);
        assertGt(burned, 0);
        assertEq(hook.pendingBurn(id, quoteCurrency), 0);
        assertEq(IERC20Like(token).balanceOf(hook.DEAD()), deadBefore + burned, "flush is not re-taxed");
        assertEq(quote.balanceOf(hook.DEAD()), 0, "quote never goes to dead");
        assertEq(hook.owed(creator, Currency.wrap(token)), creatorBefore, "hook self-swap skips afterSwap");
    }

    function test_flushQuoteBurn_minOutSlippageRestoresPending() public {
        (address token, PoolId id, bool tokenIsCurrency0) = _launch();
        PoolKey memory key = _key(token, tokenIsCurrency0);
        _buy(key, tokenIsCurrency0, 10_000e6);
        _sellHalf(token, key, tokenIsCurrency0);

        Currency quoteCurrency = Currency.wrap(address(quote));
        uint256 pending = hook.pendingBurn(id, quoteCurrency);
        assertGt(pending, 0);

        vm.expectRevert(EveFeeHook.Slippage.selector);
        hook.flushQuoteBurn(key, type(uint256).max);
        assertEq(hook.pendingBurn(id, quoteCurrency), pending, "revert restores pendingBurn");
    }

    function test_flushBurn_quotePathMatchesFlushQuoteBurn() public {
        (address token, PoolId id, bool tokenIsCurrency0) = _launch();
        PoolKey memory key = _key(token, tokenIsCurrency0);
        _buy(key, tokenIsCurrency0, 10_000e6);
        _sellHalf(token, key, tokenIsCurrency0);

        Currency quoteCurrency = Currency.wrap(address(quote));
        uint256 pending = hook.pendingBurn(id, quoteCurrency);
        uint256 deadBefore = IERC20Like(token).balanceOf(hook.DEAD());
        uint256 burned = hook.flushBurn(key, quoteCurrency);
        assertGt(burned, 0);
        assertEq(hook.pendingBurn(id, quoteCurrency), 0);
        assertEq(IERC20Like(token).balanceOf(hook.DEAD()), deadBefore + burned);
        assertTrue(pending != 0);
    }

    function test_unlock_stamps365DayPlatformBeneficiary() public {
        uint64 t0 = uint64(block.timestamp);
        (address token,,) = _launch();
        (uint64 unlockAt, address beneficiary) = factory.lpLock(token);
        assertEq(beneficiary, platform);
        assertEq(unlockAt, t0 + factory.LOCK_DURATION());
        assertEq(factory.LOCK_DURATION(), 365 days);
    }

    function test_unlock_revertsBefore365() public {
        (address token,,) = _launch();
        vm.prank(platform);
        vm.expectRevert(EveInstantV4Factory.StillLocked.selector);
        factory.unlockLiquidity(token);
        vm.warp(block.timestamp + factory.LOCK_DURATION() - 1);
        vm.prank(platform);
        vm.expectRevert(EveInstantV4Factory.StillLocked.selector);
        factory.unlockLiquidity(token);
    }

    function test_unlock_creatorCannot() public {
        (address token,,) = _launch();
        vm.warp(block.timestamp + factory.LOCK_DURATION());
        vm.prank(creator);
        vm.expectRevert(EveInstantV4Factory.NotBeneficiary.selector);
        factory.unlockLiquidity(token);
        vm.prank(trader);
        vm.expectRevert(EveInstantV4Factory.NotBeneficiary.selector);
        factory.unlockLiquidity(token);
    }

    function test_unlock_platformReclaimsAfter365() public {
        (address token, PoolId id, bool tokenIsCurrency0) = _launch();
        PoolKey memory key = _key(token, tokenIsCurrency0);
        _buy(key, tokenIsCurrency0, 10_000e6);

        uint128 liqBefore = _positionLiq(token, id);
        assertGt(liqBefore, 0);
        uint256 platTokBefore = IERC20Like(token).balanceOf(platform);
        uint256 platQuoteBefore = quote.balanceOf(platform);

        vm.warp(block.timestamp + factory.LOCK_DURATION());
        vm.prank(platform);
        uint128 removed = factory.unlockLiquidity(token);
        assertEq(removed, liqBefore);
        assertEq(_positionLiq(token, id), 0);
        assertGt(IERC20Like(token).balanceOf(platform), platTokBefore);
        assertGt(quote.balanceOf(platform), platQuoteBefore);
        assertEq(quote.balanceOf(address(factory)), 0);
    }
}

interface IERC20Like {
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

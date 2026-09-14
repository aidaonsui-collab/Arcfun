// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/test/PoolModifyLiquidityTest.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LiquidityAmounts} from "../src/libraries/LiquidityAmounts.sol";

import {EveFeeHook} from "../src/EveFeeHook.sol";
import {RwaInstantV4Factory} from "../src/RwaInstantV4Factory.sol";
import {BundleSink} from "../src/BundleSink.sol";
import {MockRwaToken} from "./MockRwaToken.sol";
import {HookMiner} from "./utils/HookMiner.sol";

interface IERC20Like {
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

/// @dev A second, third RWA-style asset — "stocks" the bundle converts into. Plain 18dp ERC-20s;
///      what they represent doesn't matter to the contract, only that a real pool exists for them.
contract MockStock is MockRwaToken {
    string public stockName;

    constructor(string memory symbol_) {
        stockName = symbol_;
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }
}

/// @dev Proves BundleSink's on-chain, keeperless holder accounting end-to-end: pull real accrued
///      fees from EveFeeHook, convert them into a creator-configured basket via real v4 pools
///      (same swap logic BundleVault proved before this consolidation), and settle claim()s
///      against two genuinely different holders with no owner-gated disperse() anywhere — the
///      thing this rebuild actually removes versus the retired BundleVault.
contract BundleSinkTest is Test {
    using PoolIdLibrary for PoolKey;

    PoolManager manager;
    PoolSwapTest swapRouter;
    PoolModifyLiquidityTest liquidityRouter;
    EveFeeHook hook;
    RwaInstantV4Factory factory;
    MockRwaToken quote;
    MockStock stockA;
    MockStock stockB;

    address platform = makeAddr("platform");
    address creator = makeAddr("creator");
    address trader = makeAddr("trader");
    address holder2 = makeAddr("holder2");

    uint160 constant REQUIRED_FLAGS = uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);

    address token;
    PoolId launchPoolId;
    bool tokenIsCurrency0;
    BundleSink sink;

    function setUp() public {
        manager = new PoolManager(address(this));
        swapRouter = new PoolSwapTest(IPoolManager(address(manager)));
        liquidityRouter = new PoolModifyLiquidityTest(IPoolManager(address(manager)));

        (address hookAddr, bytes32 salt) = HookMiner.find(
            address(this), REQUIRED_FLAGS, type(EveFeeHook).creationCode, abi.encode(address(manager), address(this))
        );
        hook = new EveFeeHook{salt: salt}(IPoolManager(address(manager)), address(this));
        require(address(hook) == hookAddr, "hook address mismatch");

        factory = new RwaInstantV4Factory(IPoolManager(address(manager)), hook, platform);
        hook.setFactory(address(factory));

        quote = new MockRwaToken();
        stockA = new MockStock("STOCKA");
        stockB = new MockStock("STOCKB");

        quote.mint(trader, 10_000_000e6);
        vm.prank(trader);
        quote.approve(address(swapRouter), type(uint256).max);

        (address t,, uint256 tokensOut, address bundleSink) = factory.createTokenWithBundle(
            "Test RWA Token", "TRWA", address(quote), creator, 0, 0, _reflectSplit()
        );
        token = t;
        tokensOut;
        (,, launchPoolId) = _poolInfoOf(token);
        tokenIsCurrency0 = token < address(quote);
        sink = BundleSink(bundleSink);

        _seedPool(address(quote), address(stockA), 10_000_000e6, 10_000_000e18);
        _seedPool(address(quote), address(stockB), 10_000_000e6, 10_000_000e18);
    }

    function _poolInfoOf(address t) internal view returns (address, address, PoolId) {
        (,, address c, address h, PoolId id) = factory.poolOf(t);
        h;
        return (t, c, id);
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

    /// @dev See BundleVault.t.sol's original comment (this session, pre-consolidation): a pool
    ///      between a 6dp and an 18dp token needs its sqrtPriceX96 decimals-adjusted for a
    ///      "1 human unit ~= 1 human unit" fair-value start, and every pair here has an even
    ///      12-decimals gap so its sqrt stays a clean power of ten.
    function _sqrtPriceX96For(address t0, address t1) internal view returns (uint160) {
        uint256 Q96 = 79228162514264337593543950336;
        uint8 d0 = IERC20Like(t0).decimals();
        uint8 d1 = IERC20Like(t1).decimals();
        if (d1 > d0) return uint160(Q96 * (10 ** ((d1 - d0) / 2)));
        if (d0 > d1) return uint160(Q96 / (10 ** ((d0 - d1) / 2)));
        return uint160(Q96);
    }

    function _seedPool(address a, address b, uint256 amtA, uint256 amtB) internal {
        (address c0, address c1, uint256 amt0, uint256 amt1) = a < b ? (a, b, amtA, amtB) : (b, a, amtB, amtA);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(c0), currency1: Currency.wrap(c1), fee: 3_000, tickSpacing: 60, hooks: IHooks(address(0))
        });
        uint160 startSqrtPrice = _sqrtPriceX96For(c0, c1);
        int24 currentTick = manager.initialize(key, startSqrtPrice);
        deal(c0, address(this), amt0);
        deal(c1, address(this), amt1);
        IERC20Like(c0).approve(address(liquidityRouter), type(uint256).max);
        IERC20Like(c1).approve(address(liquidityRouter), type(uint256).max);

        int24 anchor = (currentTick / 60) * 60;
        int24 tickLower = anchor - 6_000;
        int24 tickUpper = anchor + 6_000;
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(tickUpper);
        uint128 liq0 = LiquidityAmounts.getLiquidityForAmount0(startSqrtPrice, sqrtB, amt0);
        uint128 liq1 = LiquidityAmounts.getLiquidityForAmount1(sqrtA, startSqrtPrice, amt1);
        uint128 liquidity = liq0 < liq1 ? liq0 : liq1;

        liquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: int256(uint256(liquidity)), salt: bytes32(0)}),
            ""
        );
    }

    function _quotePoolKey(address stock) internal view returns (PoolKey memory) {
        (address c0, address c1) = address(quote) < stock ? (address(quote), stock) : (stock, address(quote));
        return PoolKey({currency0: Currency.wrap(c0), currency1: Currency.wrap(c1), fee: 3_000, tickSpacing: 60, hooks: IHooks(address(0))});
    }

    function _launchKey() internal view returns (PoolKey memory) {
        return tokenIsCurrency0
            ? PoolKey({currency0: Currency.wrap(token), currency1: Currency.wrap(address(quote)), fee: 0, tickSpacing: factory.TICK_SPACING(), hooks: IHooks(address(hook))})
            : PoolKey({currency0: Currency.wrap(address(quote)), currency1: Currency.wrap(token), fee: 0, tickSpacing: factory.TICK_SPACING(), hooks: IHooks(address(hook))});
    }

    function _buyLaunchToken(address buyer, uint256 payIn) internal {
        // `_launchKey()` makes an internal staticcall (factory.TICK_SPACING()) — evaluating it
        // inline as a swap() argument would consume vm.prank's next-call before swap() itself
        // fires, so it's resolved into a local first, matching Foundry's "prank applies to the
        // very next external call" semantics.
        PoolKey memory key = _launchKey();
        bool zeroForOne = !tokenIsCurrency0;
        vm.prank(buyer);
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(payIn), sqrtPriceLimitX96: zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _sellHalf(address seller) internal {
        PoolKey memory key = _launchKey();
        uint256 bal = IERC20Like(token).balanceOf(seller);
        vm.prank(seller);
        IERC20Like(token).approve(address(swapRouter), type(uint256).max);
        bool sellZeroForOne = tokenIsCurrency0;
        vm.prank(seller);
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: sellZeroForOne, amountSpecified: -int256(bal / 2), sqrtPriceLimitX96: sellZeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _configureTwoAssetBundle(BundleSink.PayoutMode mode) internal {
        address[] memory assets = new address[](2);
        assets[0] = address(stockA);
        assets[1] = address(stockB);
        uint16[] memory weights = new uint16[](2);
        weights[0] = 7_000;
        weights[1] = 3_000;
        PoolKey[] memory keys = new PoolKey[](2);
        keys[0] = _quotePoolKey(address(stockA));
        keys[1] = _quotePoolKey(address(stockB));
        vm.prank(creator);
        sink.setBasket(assets, weights, keys, mode);
    }

    function _pullAndConvertHalfSell(address trader_, uint256 buyIn) internal {
        _buyLaunchToken(trader_, buyIn);
        _sellHalf(trader_);
        Currency quoteCurrency = Currency.wrap(address(quote));
        sink.pull(quoteCurrency);
        uint256[] memory minOuts = new uint256[](2);
        minOuts[0] = 1;
        minOuts[1] = 1;
        sink.convert(quoteCurrency, minOuts);
    }

    // ── launch wiring ──────────────────────────────────────────────────────────────────────
    function test_launchWithBundle_registersSinkAsHolders() public view {
        assertTrue(address(sink) != address(0));
        assertEq(sink.creator(), creator);
        (,,, address holders,) = factory.poolOf(token);
        assertEq(holders, address(sink));
    }

    function test_plainCreateToken_hasNoHolders() public {
        (address token2,) = factory.createToken("Other", "OTH", address(quote), creator);
        (,,, address holders,) = factory.poolOf(token2);
        assertEq(holders, address(0), "plain createToken must not get a bundle sink");
    }

    function test_createToken_rejectsHoldersWithoutBundle() public {
        EveFeeHook.Split memory s = _reflectSplit();
        vm.expectRevert(RwaInstantV4Factory.HoldersNotOnRwa.selector);
        factory.createToken("X", "X", address(quote), creator, 0, 0, s);
    }

    function test_createTokenWithBundle_rejectsZeroHoldersSlice() public {
        EveFeeHook.Split memory s = _reflectSplit();
        s.holdersBps = 0;
        s.creatorBps = 7_000; // keep the split summing to 10_000
        vm.expectRevert(RwaInstantV4Factory.BundleRequiresHoldersSlice.selector);
        factory.createTokenWithBundle("X", "X", address(quote), creator, 0, 0, s);
    }

    // ── bundle config ──────────────────────────────────────────────────────────────────────
    function test_onlyCreator_canSetBasket() public {
        address[] memory assets = new address[](1);
        assets[0] = address(stockA);
        uint16[] memory weights = new uint16[](1);
        weights[0] = 10_000;
        PoolKey[] memory keys = new PoolKey[](1);
        keys[0] = _quotePoolKey(address(stockA));

        vm.expectRevert(BundleSink.NotCreator.selector);
        sink.setBasket(assets, weights, keys, BundleSink.PayoutMode.AllAtOnce);

        vm.prank(creator);
        sink.setBasket(assets, weights, keys, BundleSink.PayoutMode.AllAtOnce);
        assertEq(sink.basketLength(), 1);
    }

    function test_allAtOnce_weightsMustSumTo10000() public {
        address[] memory assets = new address[](2);
        assets[0] = address(stockA);
        assets[1] = address(stockB);
        uint16[] memory weights = new uint16[](2);
        weights[0] = 6_000;
        weights[1] = 3_000; // sums to 9000, not 10000
        PoolKey[] memory keys = new PoolKey[](2);
        keys[0] = _quotePoolKey(address(stockA));
        keys[1] = _quotePoolKey(address(stockB));

        vm.prank(creator);
        vm.expectRevert(BundleSink.BadWeights.selector);
        sink.setBasket(assets, weights, keys, BundleSink.PayoutMode.AllAtOnce);
    }

    // ── pull + convert ─────────────────────────────────────────────────────────────────────
    function test_pull_and_convert_allAtOnce_accruesBothStocksByWeight() public {
        _configureTwoAssetBundle(BundleSink.PayoutMode.AllAtOnce);
        _pullAndConvertHalfSell(trader, 50_000e6);

        assertEq(sink.pendingConvert(Currency.wrap(address(quote))), 0);
        uint256 accA = sink.accPerShare(Currency.wrap(address(stockA)));
        uint256 accB = sink.accPerShare(Currency.wrap(address(stockB)));
        assertGt(accA, 0);
        assertGt(accB, 0);
        // 70/30 split of the input translates to roughly 70/30 of the output in a symmetric pool.
        assertGt(accA, accB);
    }

    function test_convert_rotating_cyclesThroughAssets() public {
        _configureTwoAssetBundle(BundleSink.PayoutMode.Rotating);
        Currency quoteCurrency = Currency.wrap(address(quote));

        _buyLaunchToken(trader, 20_000e6);
        _sellHalf(trader);
        sink.pull(quoteCurrency);
        uint256[] memory oneOut = new uint256[](1);
        oneOut[0] = 1;
        sink.convert(quoteCurrency, oneOut);
        assertGt(sink.accPerShare(Currency.wrap(address(stockA))), 0, "first rotation goes to asset 0");
        assertEq(sink.accPerShare(Currency.wrap(address(stockB))), 0);

        _buyLaunchToken(trader, 20_000e6);
        _sellHalf(trader);
        sink.pull(quoteCurrency);
        sink.convert(quoteCurrency, oneOut);
        assertGt(sink.accPerShare(Currency.wrap(address(stockB))), 0, "second rotation moves to asset 1");
    }

    function test_convert_revertsWithNothingPending() public {
        _configureTwoAssetBundle(BundleSink.PayoutMode.AllAtOnce);
        uint256[] memory minOuts = new uint256[](2);
        vm.expectRevert(BundleSink.NothingPending.selector);
        sink.convert(Currency.wrap(address(quote)), minOuts);
    }

    function test_convert_wrongMinOutsLength_reverts() public {
        _configureTwoAssetBundle(BundleSink.PayoutMode.AllAtOnce);
        _buyLaunchToken(trader, 20_000e6);
        _sellHalf(trader);
        sink.pull(Currency.wrap(address(quote)));
        uint256[] memory wrongLen = new uint256[](1);
        wrongLen[0] = 1;
        vm.expectRevert(BundleSink.LengthMismatch.selector);
        sink.convert(Currency.wrap(address(quote)), wrongLen);
    }

    // ── claim: the actual point of this rebuild — no keeper, no disperse(), no owner ─────────
    function test_claim_paysTwoRealHoldersProRataWithNoKeeperInvolved() public {
        _configureTwoAssetBundle(BundleSink.PayoutMode.AllAtOnce);

        // Trader buys, sends a quarter to holder2, THEN we generate the fee accrual by selling
        // half of what's left — so both addresses hold real, different balances of the tracked
        // token (trader 3/8 of the original buy, holder2 1/4) *before* any conversion happens,
        // and both should earn proportionally to those balances with no keeper involved.
        _buyLaunchToken(trader, 60_000e6);
        uint256 traderBal = IERC20Like(token).balanceOf(trader);
        vm.prank(trader);
        IERC20Like(token).transfer(holder2, traderBal / 4);

        uint256 holder2Bal = IERC20Like(token).balanceOf(holder2);
        assertGt(holder2Bal, 0);

        _sellHalf(trader);

        Currency quoteCurrency = Currency.wrap(address(quote));
        sink.pull(quoteCurrency);
        uint256[] memory minOuts = new uint256[](2);
        minOuts[0] = 1;
        minOuts[1] = 1;
        sink.convert(quoteCurrency, minOuts);

        (, uint256[] memory traderPreview) = sink.preview(trader);
        (, uint256[] memory holder2Preview) = sink.preview(holder2);
        assertGt(traderPreview[0], 0);
        assertGt(holder2Preview[0], 0);

        // No owner, no keeper, no batch — each holder claims their own share permissionlessly.
        vm.prank(trader);
        sink.claim();
        vm.prank(holder2);
        sink.claim();

        assertEq(IERC20Like(address(stockA)).balanceOf(trader), traderPreview[0]);
        assertEq(IERC20Like(address(stockA)).balanceOf(holder2), holder2Preview[0]);

        // Pro-rata by real balance, computed entirely on-chain: trader ends up holding 3/8 of
        // the original buy (3/4 after the transfer, half of that sold), holder2 holds 1/4 — a
        // 3:2 ratio — so trader's payout should be ~1.5x holder2's, not equal and not some other
        // split a keeper had to compute off-chain.
        assertApproxEqRel(traderPreview[0], (holder2Preview[0] * 3) / 2, 0.05e18);
    }

    function test_claim_stillWorksForAnAssetRotatedOutOfTheLiveBasket() public {
        _configureTwoAssetBundle(BundleSink.PayoutMode.AllAtOnce);
        _pullAndConvertHalfSell(trader, 50_000e6);

        (, uint256[] memory before) = sink.preview(trader);
        assertGt(before[0], 0); // stockA

        // Creator rotates the basket down to stockB only — stockA is no longer "live" but the
        // trader's already-accrued stockA balance must still be claimable.
        address[] memory assets = new address[](1);
        assets[0] = address(stockB);
        uint16[] memory weights = new uint16[](1);
        weights[0] = 10_000;
        PoolKey[] memory keys = new PoolKey[](1);
        keys[0] = _quotePoolKey(address(stockB));
        vm.prank(creator);
        sink.setBasket(assets, weights, keys, BundleSink.PayoutMode.AllAtOnce);

        vm.prank(trader);
        uint256 claimed = sink.claim(Currency.wrap(address(stockA)));
        assertEq(claimed, before[0]);
        assertEq(IERC20Like(address(stockA)).balanceOf(trader), before[0]);
    }
}

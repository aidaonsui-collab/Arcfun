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

import {RwaFeeHook} from "../src/RwaFeeHook.sol";
import {RwaInstantV4Factory} from "../src/RwaInstantV4Factory.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {MockRwaToken} from "./MockRwaToken.sol";
import {HookMiner} from "./utils/HookMiner.sol";

interface IERC20Like {
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

/// @dev A second, third RWA-style asset — "stocks" the basket converts into. Plain 18dp ERC-20s;
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

contract BasketVaultTest is Test {
    using PoolIdLibrary for PoolKey;

    PoolManager manager;
    PoolSwapTest swapRouter;
    PoolModifyLiquidityTest liquidityRouter;
    RwaFeeHook hook;
    RwaInstantV4Factory factory;
    MockRwaToken quote; // the RWA the launch is paired against — also what the vault pulls
    MockStock stockA;
    MockStock stockB;

    address platform = makeAddr("platform");
    address defaultCrucible = makeAddr("defaultCrucible");
    address creator = makeAddr("creator");
    address vaultOwner = makeAddr("vaultOwner");
    address trader = makeAddr("trader");
    address holder1 = makeAddr("holder1");
    address holder2 = makeAddr("holder2");

    uint160 constant REQUIRED_FLAGS = uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);

    address token;
    PoolId launchPoolId;
    bool tokenIsCurrency0;
    BasketVault vault;

    function setUp() public {
        manager = new PoolManager(address(this));
        swapRouter = new PoolSwapTest(IPoolManager(address(manager)));
        liquidityRouter = new PoolModifyLiquidityTest(IPoolManager(address(manager)));

        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), REQUIRED_FLAGS, type(RwaFeeHook).creationCode, abi.encode(address(manager)));
        hook = new RwaFeeHook{salt: salt}(IPoolManager(address(manager)));
        require(address(hook) == hookAddr, "hook address mismatch");

        factory = new RwaInstantV4Factory(IPoolManager(address(manager)), hook, platform, defaultCrucible);
        hook.setFactory(address(factory));

        quote = new MockRwaToken();
        stockA = new MockStock("STOCKA");
        stockB = new MockStock("STOCKB");

        quote.mint(trader, 10_000_000e6);
        vm.prank(trader);
        quote.approve(address(swapRouter), type(uint256).max);

        // Launch the token with a dedicated BasketVault instead of the plain crucible wallet.
        (token, launchPoolId, ) = factory.createTokenWithBasketVault("Test RWA Token", "TRWA", address(quote), creator, vaultOwner);
        tokenIsCurrency0 = token < address(quote);
        (,,, address regCrucible,,,,) = hook.configs(launchPoolId);
        vault = BasketVault(regCrucible);

        // Seed two-sided liquidity for quote<->stockA and quote<->stockB so the vault has
        // something real to swap against — plain vanilla pools, no hook, standard 0.3% tier.
        _seedPool(address(quote), address(stockA), 10_000_000e6, 10_000_000e18);
        _seedPool(address(quote), address(stockB), 10_000_000e6, 10_000_000e18);
    }

    /// @dev sqrtPriceX96 encodes the RAW-unit ratio, not a decimals-normalized human price — a
    ///      pool between a 6dp and an 18dp token at raw price 1 is wildly off (it says 1 microUSDC
    ///      unit equals 1e-18 of a stock unit). For a "1 human unit ~= 1 human unit" fair-value
    ///      start, price(token1 per token0) = 10^(decimals1-decimals0); since every token pair in
    ///      this file is 6dp vs 18dp, that exponent is always ±12 (even), so its sqrt is a clean
    ///      power of ten and this avoids needing a general on-chain sqrt for a test-only helper.
    function _sqrtPriceX96For(address token0, address token1) internal view returns (uint160) {
        uint256 Q96 = 79228162514264337593543950336;
        uint8 d0 = IERC20Like(token0).decimals();
        uint8 d1 = IERC20Like(token1).decimals();
        if (d1 > d0) {
            uint256 diff = d1 - d0;
            require(diff % 2 == 0, "test helper only supports even decimals diffs");
            return uint160(Q96 * (10 ** (diff / 2)));
        } else if (d0 > d1) {
            uint256 diff = d0 - d1;
            require(diff % 2 == 0, "test helper only supports even decimals diffs");
            return uint160(Q96 / (10 ** (diff / 2)));
        }
        return uint160(Q96);
    }

    function _seedPool(address a, address b, uint256 amtA, uint256 amtB) internal returns (PoolKey memory key) {
        (address c0, address c1, uint256 amt0, uint256 amt1) =
            a < b ? (a, b, amtA, amtB) : (b, a, amtB, amtA);
        key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 3_000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        uint160 startSqrtPrice = _sqrtPriceX96For(c0, c1);
        int24 currentTick = manager.initialize(key, startSqrtPrice);
        deal(c0, address(this), amt0);
        deal(c1, address(this), amt1);
        IERC20Like(c0).approve(address(liquidityRouter), type(uint256).max);
        IERC20Like(c1).approve(address(liquidityRouter), type(uint256).max);

        // A real full-range position (min/maxUsableTick) needs liquidity amounts far beyond what
        // 10M of each token can back — full range covers ~1e-39x to 1e39x the starting price, so
        // achieving any meaningful L over that whole span costs an enormous amount of capital.
        // Use a realistic concentrated band around the ACTUAL starting tick instead (not tick 0 —
        // the decimals-adjusted starting price above sits at roughly tick ±276,310 for a 6dp/18dp
        // pair, nowhere near 0), which is also the more realistic shape for real market-making.
        // Rather than guess a liquidityDelta and hope it fits the dealt amounts, compute the
        // largest liquidity actually affordable within (amt0, amt1) — the same two-sided-min
        // logic Uniswap's own LiquidityAmounts.getLiquidityForAmounts uses (trimmed copy in
        // src/libraries/ only has the single-sided halves; current price sits inside the range
        // here, so both halves matter and we take the tighter one, same result).
        int24 anchor = (currentTick / 60) * 60; // round down to a valid tickSpacing multiple
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
        (address c0, address c1) =
            address(quote) < stock ? (address(quote), stock) : (stock, address(quote));
        return PoolKey({currency0: Currency.wrap(c0), currency1: Currency.wrap(c1), fee: 3_000, tickSpacing: 60, hooks: IHooks(address(0))});
    }

    function _buyLaunchToken(uint256 payIn) internal {
        PoolKey memory launchKey = tokenIsCurrency0
            ? PoolKey({currency0: Currency.wrap(token), currency1: Currency.wrap(address(quote)), fee: 0, tickSpacing: factory.TICK_SPACING(), hooks: IHooks(address(hook))})
            : PoolKey({currency0: Currency.wrap(address(quote)), currency1: Currency.wrap(token), fee: 0, tickSpacing: factory.TICK_SPACING(), hooks: IHooks(address(hook))});
        bool zeroForOne = !tokenIsCurrency0;
        vm.prank(trader);
        swapRouter.swap(
            launchKey,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(payIn), sqrtPriceLimitX96: zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    // ── launch wiring ──────────────────────────────────────────────────────────────────────
    function test_launchWithVault_registersVaultAsCrucible() public view {
        assertTrue(address(vault) != address(0));
        assertEq(vault.creator(), creator);
        assertEq(vault.owner(), vaultOwner);
    }

    function test_plainCreateToken_stillUsesFactoryDefaultCrucible() public {
        (address token2, PoolId id2) = factory.createToken("Other", "OTH", address(quote), creator);
        (,,, address regCrucible,,,,) = hook.configs(id2);
        assertEq(regCrucible, defaultCrucible, "plain createToken must be unaffected by the vault feature");
        assertTrue(token2 != address(0));
    }

    // ── basket config ──────────────────────────────────────────────────────────────────────
    function test_onlyCreator_canSetBasket() public {
        address[] memory assets = new address[](1);
        assets[0] = address(stockA);
        uint16[] memory weights = new uint16[](1);
        weights[0] = 10_000;
        PoolKey[] memory keys = new PoolKey[](1);
        keys[0] = _quotePoolKey(address(stockA));

        vm.expectRevert(BasketVault.NotCreator.selector);
        vault.setBasket(assets, weights, keys, BasketVault.PayoutMode.AllAtOnce);

        vm.prank(creator);
        vault.setBasket(assets, weights, keys, BasketVault.PayoutMode.AllAtOnce);
        assertEq(vault.basketLength(), 1);
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
        vm.expectRevert(BasketVault.BadWeights.selector);
        vault.setBasket(assets, weights, keys, BasketVault.PayoutMode.AllAtOnce);
    }

    // ── pull + convert: the actual point ──────────────────────────────────────────────────
    function _configureTwoAssetBasket(BasketVault.PayoutMode mode) internal {
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
        vault.setBasket(assets, weights, keys, mode);
    }

    function test_pull_and_convert_allAtOnce_splitsIntoBothStocksByWeight() public {
        _configureTwoAssetBasket(BasketVault.PayoutMode.AllAtOnce);

        // Generate quote-side fee accrual: buy the launch token, so the "unspecified" (token)
        // side is taxed... we need the QUOTE side taxed instead, so sell after buying.
        _buyLaunchToken(50_000e6);
        uint256 tokBal = IERC20Like(token).balanceOf(trader);
        assertGt(tokBal, 0);
        vm.prank(trader);
        IERC20Like(token).approve(address(swapRouter), type(uint256).max);
        PoolKey memory launchKey = tokenIsCurrency0
            ? PoolKey({currency0: Currency.wrap(token), currency1: Currency.wrap(address(quote)), fee: 0, tickSpacing: factory.TICK_SPACING(), hooks: IHooks(address(hook))})
            : PoolKey({currency0: Currency.wrap(address(quote)), currency1: Currency.wrap(token), fee: 0, tickSpacing: factory.TICK_SPACING(), hooks: IHooks(address(hook))});
        bool sellZeroForOne = tokenIsCurrency0;
        vm.prank(trader);
        swapRouter.swap(
            launchKey,
            SwapParams({zeroForOne: sellZeroForOne, amountSpecified: -int256(tokBal / 2), sqrtPriceLimitX96: sellZeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        Currency quoteCurrency = Currency.wrap(address(quote));
        uint256 owedQuote = hook.owed(address(vault), quoteCurrency);
        assertGt(owedQuote, 0, "sell should have taxed the quote side, owed to the vault");

        uint256 pulled = vault.pull(quoteCurrency);
        assertEq(pulled, owedQuote);
        assertEq(vault.pendingConvert(quoteCurrency), owedQuote);

        uint256[] memory minOuts = new uint256[](2);
        minOuts[0] = 1;
        minOuts[1] = 1;
        vault.convert(quoteCurrency, minOuts);

        assertEq(vault.pendingConvert(quoteCurrency), 0);
        uint256 stockAOut = vault.pendingDistribution(Currency.wrap(address(stockA)));
        uint256 stockBOut = vault.pendingDistribution(Currency.wrap(address(stockB)));
        assertGt(stockAOut, 0);
        assertGt(stockBOut, 0);
        // 70/30 split of the input translates to roughly 70/30 of the output in a symmetric pool
        // (not exact — different pools, different slippage) — just assert the ordering holds.
        assertGt(stockAOut, stockBOut);
    }

    function test_convert_rotating_cyclesThroughAssets() public {
        _configureTwoAssetBasket(BasketVault.PayoutMode.Rotating);
        Currency quoteCurrency = Currency.wrap(address(quote));

        // Fund the vault directly via a real fee accrual is fiddly to repeat twice in one test;
        // simplest reliable way to prove rotation specifically: seed pendingConvert manually is
        // not exposed (by design — everything must come from a real pull()), so drive it via two
        // separate sell legs instead.
        _buyLaunchToken(20_000e6);
        _sellHalf();
        vault.pull(quoteCurrency);
        uint256[] memory oneOut = new uint256[](1);
        oneOut[0] = 1;
        vault.convert(quoteCurrency, oneOut);
        assertGt(vault.pendingDistribution(Currency.wrap(address(stockA))), 0, "first rotation goes to asset 0");
        assertEq(vault.pendingDistribution(Currency.wrap(address(stockB))), 0);

        _buyLaunchToken(20_000e6);
        _sellHalf();
        vault.pull(quoteCurrency);
        vault.convert(quoteCurrency, oneOut);
        assertGt(vault.pendingDistribution(Currency.wrap(address(stockB))), 0, "second rotation moves to asset 1");
    }

    function _sellHalf() internal {
        uint256 tokBal = IERC20Like(token).balanceOf(trader);
        vm.prank(trader);
        IERC20Like(token).approve(address(swapRouter), type(uint256).max);
        PoolKey memory launchKey = tokenIsCurrency0
            ? PoolKey({currency0: Currency.wrap(token), currency1: Currency.wrap(address(quote)), fee: 0, tickSpacing: factory.TICK_SPACING(), hooks: IHooks(address(hook))})
            : PoolKey({currency0: Currency.wrap(address(quote)), currency1: Currency.wrap(token), fee: 0, tickSpacing: factory.TICK_SPACING(), hooks: IHooks(address(hook))});
        bool sellZeroForOne = tokenIsCurrency0;
        vm.prank(trader);
        swapRouter.swap(
            launchKey,
            SwapParams({zeroForOne: sellZeroForOne, amountSpecified: -int256(tokBal / 2), sqrtPriceLimitX96: sellZeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function test_convert_revertsWithNothingPending() public {
        _configureTwoAssetBasket(BasketVault.PayoutMode.AllAtOnce);
        uint256[] memory minOuts = new uint256[](2);
        vm.expectRevert(BasketVault.NothingPending.selector);
        vault.convert(Currency.wrap(address(quote)), minOuts);
    }

    function test_convert_wrongMinOutsLength_reverts() public {
        _configureTwoAssetBasket(BasketVault.PayoutMode.AllAtOnce);
        _buyLaunchToken(20_000e6);
        _sellHalf();
        vault.pull(Currency.wrap(address(quote)));
        uint256[] memory wrongLen = new uint256[](1);
        wrongLen[0] = 1;
        vm.expectRevert(BasketVault.LengthMismatch.selector);
        vault.convert(Currency.wrap(address(quote)), wrongLen);
    }

    // ── disperse ───────────────────────────────────────────────────────────────────────────
    function test_disperse_paysHoldersAndEnforcesCap() public {
        _configureTwoAssetBasket(BasketVault.PayoutMode.AllAtOnce);
        _buyLaunchToken(50_000e6);
        _sellHalf();
        Currency quoteCurrency = Currency.wrap(address(quote));
        vault.pull(quoteCurrency);
        uint256[] memory minOuts = new uint256[](2);
        minOuts[0] = 1;
        minOuts[1] = 1;
        vault.convert(quoteCurrency, minOuts);

        Currency stockACur = Currency.wrap(address(stockA));
        uint256 pending = vault.pendingDistribution(stockACur);
        assertGt(pending, 0);

        address[] memory holders = new address[](2);
        holders[0] = holder1;
        holders[1] = holder2;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = pending / 2;
        amounts[1] = pending - amounts[0];

        // Not the vault owner — must revert.
        vm.expectRevert(BasketVault.NotOwner.selector);
        vault.disperse(stockACur, holders, amounts);

        // Cannot exceed pending, even from the real owner.
        uint256[] memory tooMuch = new uint256[](2);
        tooMuch[0] = pending;
        tooMuch[1] = pending;
        vm.prank(vaultOwner);
        vm.expectRevert(BasketVault.ExceedsPending.selector);
        vault.disperse(stockACur, holders, tooMuch);

        vm.prank(vaultOwner);
        vault.disperse(stockACur, holders, amounts);
        assertEq(IERC20Like(address(stockA)).balanceOf(holder1), amounts[0]);
        assertEq(IERC20Like(address(stockA)).balanceOf(holder2), amounts[1]);
        assertEq(vault.pendingDistribution(stockACur), 0);
    }

    function test_transferOwnership_onlyOwner() public {
        vm.expectRevert(BasketVault.NotOwner.selector);
        vault.transferOwnership(trader);

        vm.prank(vaultOwner);
        vault.transferOwnership(trader);
        assertEq(vault.owner(), trader);
    }
}

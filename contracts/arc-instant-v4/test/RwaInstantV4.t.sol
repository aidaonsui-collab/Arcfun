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
import {RwaInstantV4Factory} from "../src/RwaInstantV4Factory.sol";
import {BundleSinkDeployer} from "../src/BundleSinkDeployer.sol";
import {VirtualQuote} from "../src/libraries/VirtualQuote.sol";
import {MockRwaToken} from "./MockRwaToken.sol";
import {HookMiner} from "./utils/HookMiner.sol";

contract RwaInstantV4Test is Test {
    using PoolIdLibrary for PoolKey;

    PoolManager manager;
    PoolSwapTest swapRouter;
    EveFeeHook hook;
    RwaInstantV4Factory factory;
    MockRwaToken quote;

    address deployer = address(this);
    address platform = makeAddr("platform");
    address creator = makeAddr("creator");
    address trader = makeAddr("trader");

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

        factory = new RwaInstantV4Factory(
            IPoolManager(address(manager)), hook, platform, new BundleSinkDeployer()
        );
        hook.setFactory(address(factory));

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

    function _launch() internal returns (address token, PoolId id, bool tokenIsCurrency0) {
        (token, id) = factory.createToken("Test RWA Token", "TRWA", address(quote), creator);
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
        assertEq(feeBps, 100);
        assertEq(cBps, 7_000);
        assertEq(hBps, 0);
        assertEq(uint256(cBps) + bBps + hBps + aBps + pBps, 10_000);
    }

    function test_buySwap_feeSplitsAndBurnsLaunchToken() public {
        (address token,, bool tokenIsCurrency0) = _launch();
        PoolKey memory key = _key(token, tokenIsCurrency0);
        _buy(key, tokenIsCurrency0, 1_000e6);

        Currency tokenCurrency = Currency.wrap(token);
        uint256 creatorTok = hook.owed(creator, tokenCurrency);
        uint256 platformTok = hook.owed(platform, tokenCurrency);
        uint256 autoLpTok = hook.owed(address(factory), tokenCurrency);
        uint256 burnTok = IERC20Like(token).balanceOf(hook.DEAD());
        uint256 totalFeeTok = creatorTok + platformTok + autoLpTok + burnTok;
        assertGt(totalFeeTok, 0);
        assertEq(hook.owed(creator, Currency.wrap(address(quote))), 0);
        assertEq(creatorTok, (totalFeeTok * 7_000) / 10_000);
        assertEq(burnTok, (totalFeeTok * 1_000) / 10_000);
        assertEq(autoLpTok, (totalFeeTok * 1_000) / 10_000);
        assertEq(platformTok, totalFeeTok - creatorTok - burnTok - autoLpTok);
    }

    function test_create_rejectsHoldersSlice() public {
        EveFeeHook.Split memory s = _creatorSplit();
        s.holdersBps = 1_000;
        s.creatorBps = 6_000;
        vm.expectRevert(RwaInstantV4Factory.HoldersNotOnRwa.selector);
        factory.createToken("X", "X", address(quote), creator, 0, 0, s);
    }

    function test_withdraw_paysRealTokensAndZeroesOwed() public {
        (address token,, bool tokenIsCurrency0) = _launch();
        _buy(_key(token, tokenIsCurrency0), tokenIsCurrency0, 1_000e6);
        Currency tokenCurrency = Currency.wrap(token);
        uint256 owedBefore = hook.owed(creator, tokenCurrency);
        assertGt(owedBefore, 0);
        vm.prank(creator);
        uint256 got = hook.withdraw(tokenCurrency);
        assertEq(got, owedBefore);
        assertEq(IERC20Like(token).balanceOf(creator), owedBefore);
    }

    function test_onlyFactory_canRegisterPool() public {
        PoolKey memory fakeKey;
        vm.expectRevert(EveFeeHook.NotFactory.selector);
        hook.registerPool(fakeKey, creator, address(0), address(this), platform, address(1), _creatorSplit());
    }

    function test_onlyPoolManager_canCallAfterSwap() public {
        PoolKey memory fakeKey;
        SwapParams memory p;
        vm.expectRevert(EveFeeHook.NotManager.selector);
        hook.afterSwap(address(this), fakeKey, p, BalanceDeltaLibrary.ZERO_DELTA, "");
    }

    function test_onlyOwner_guardsFactoryAdmin() public {
        vm.startPrank(trader);
        vm.expectRevert(RwaInstantV4Factory.NotOwner.selector);
        factory.setPlatformWallet(trader);
        vm.stopPrank();
    }

    function test_virtualQuote_opensOffTheTickEdge() public {
        (address token, PoolId id,) = factory.createToken("VQ", "VQ", address(quote), creator, VQ_6DP, 0);
        bool tokenIsCurrency0 = token < address(quote);
        (uint160 sqrtPrice,,,) = StateLibrary.getSlot0(IPoolManager(address(manager)), id);
        int24 minU = TickMath.minUsableTick(factory.TICK_SPACING());
        int24 maxU = TickMath.maxUsableTick(factory.TICK_SPACING());
        uint160 edge = TickMath.getSqrtPriceAtTick(tokenIsCurrency0 ? minU : maxU - factory.TICK_SPACING());
        assertTrue(sqrtPrice != edge);
        uint160 ideal = VirtualQuote.sqrtPriceX96(tokenIsCurrency0, VQ_6DP, VirtualQuote.VIRTUAL_TOKEN_INIT);
        uint256 distIdeal = sqrtPrice > ideal ? sqrtPrice - ideal : ideal - sqrtPrice;
        uint256 distEdge = sqrtPrice > edge ? sqrtPrice - edge : edge - sqrtPrice;
        assertLt(distIdeal, distEdge);
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
        assertGt(hook.owed(creator, Currency.wrap(token)), 0);
        assertLt(tokensOut, factory.TOTAL_SUPPLY() / 10);
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
            tokenIsCurrency0 ? minU : TickMath.maxUsableTick(factory.TICK_SPACING()) - factory.TICK_SPACING()
        );
        assertTrue(sqrtPrice != edge);
        assertTrue(token != address(0));
    }
}

interface IERC20Like {
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

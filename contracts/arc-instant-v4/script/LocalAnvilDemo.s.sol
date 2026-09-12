// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {StdConstants} from "forge-std/StdConstants.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/test/PoolModifyLiquidityTest.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

import {RwaFeeHook} from "../src/RwaFeeHook.sol";
import {RwaInstantV4Factory} from "../src/RwaInstantV4Factory.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {LiquidityAmounts} from "../src/libraries/LiquidityAmounts.sol";
import {MockRwaToken} from "../test/MockRwaToken.sol";
import {HookMiner} from "../test/utils/HookMiner.sol";

interface IERC20Like {
    function decimals() external view returns (uint8);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/**
 * @title LocalAnvilDemo
 * @notice LOCAL DEV ONLY — not a testnet or mainnet deploy script. Stands up the whole
 *         BasketVault stack on a plain `anvil` node (no fork, no relation to Arc) so
 *         scripts/basket-vault-keeper.ts has something real to run against — nothing in this
 *         package is deployed anywhere else, see the README.
 *
 *         Deliberately mirrors test/BasketVault.t.sol's setUp() as real broadcast transactions
 *         instead of Foundry's in-memory test EVM: this is what proves the keeper script talks
 *         to a genuinely deployed contract over a real RPC, the same shape it'll use against Arc,
 *         not just against forge's test harness.
 *
 * Usage:
 *   anvil                                                        # separate terminal
 *   forge script script/LocalAnvilDemo.s.sol --rpc-url http://127.0.0.1:8545 \
 *     --broadcast --private-key <anvil default key 0>
 */
contract LocalAnvilDemo is Script {
    using PoolIdLibrary for PoolKey;

    uint160 internal constant REQUIRED_HOOK_FLAGS =
        uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        // Anvil's default account #1 — a second holder for the launched token so `disperse`
        // has more than one real recipient to pro-rate across.
        address holder2 = vm.envOr("HOLDER2", 0x70997970C51812dc3A010C7d01b50e0d17dc79C8);

        vm.startBroadcast(pk);

        PoolManager manager = new PoolManager(deployer);
        PoolSwapTest swapRouter = new PoolSwapTest(IPoolManager(address(manager)));
        PoolModifyLiquidityTest liquidityRouter = new PoolModifyLiquidityTest(IPoolManager(address(manager)));

        // `new RwaFeeHook{salt: salt}(...)` inside a broadcast tx from an EOA is relayed through
        // Foundry's canonical CREATE2 factory (forge-std's StdConstants.CREATE2_FACTORY), not
        // executed directly by `deployer` — mining against `deployer` here produced an address
        // whose low bits didn't carry the right hook permission flags at all (caught by actually
        // running this against Anvil; see LocalAnvilDemo's top comment). Separately, the
        // constructor takes owner_ explicitly rather than defaulting to msg.sender for the same
        // reason: msg.sender inside the constructor would be that factory contract, not
        // `deployer` — pass `deployer` explicitly so the setFactory call right below succeeds.
        (address hookAddr, bytes32 salt) = HookMiner.find(
            StdConstants.CREATE2_FACTORY, REQUIRED_HOOK_FLAGS, type(RwaFeeHook).creationCode, abi.encode(address(manager), deployer)
        );
        RwaFeeHook hook = new RwaFeeHook{salt: salt}(IPoolManager(address(manager)), deployer);
        require(address(hook) == hookAddr, "hook address mismatch");

        RwaInstantV4Factory factory =
            new RwaInstantV4Factory(IPoolManager(address(manager)), hook, deployer, deployer);
        hook.setFactory(address(factory));

        MockRwaToken quote = new MockRwaToken();
        MockRwaToken stockA = new MockRwaToken(); // 6dp per MockRwaToken; fine for a local demo
        MockRwaToken stockB = new MockRwaToken();
        quote.mint(deployer, 10_000_000e6);
        stockA.mint(deployer, 10_000_000e6);
        stockB.mint(deployer, 10_000_000e6);

        (address token, PoolId launchId, address vaultAddr) =
            factory.createTokenWithBasketVault("Local Demo Token", "DEMO", address(quote), deployer, deployer);
        BasketVault vault = BasketVault(vaultAddr);

        // Seed real two-sided liquidity for quote<->stockA and quote<->stockB (both 6dp here, so
        // raw price 1 is a fine 1:1 start — no decimals adjustment needed, unlike the Foundry
        // test's mixed 6dp/18dp mocks).
        PoolKey memory keyA = _seedPool(manager, liquidityRouter, address(quote), address(stockA));
        PoolKey memory keyB = _seedPool(manager, liquidityRouter, address(quote), address(stockB));

        // Configure a 70/30 all-at-once basket.
        address[] memory assets = new address[](2);
        assets[0] = address(stockA);
        assets[1] = address(stockB);
        uint16[] memory weights = new uint16[](2);
        weights[0] = 7_000;
        weights[1] = 3_000;
        PoolKey[] memory keys = new PoolKey[](2);
        keys[0] = keyA;
        keys[1] = keyB;
        vault.setBasket(assets, weights, keys, BasketVault.PayoutMode.AllAtOnce);

        // Buy, then sell half — the sell leg taxes the quote side, which is what the basket
        // converts. Also gives `deployer` a real launch-token balance; send a slice to holder2
        // so the keeper's disperse step has two real holders to pro-rate across.
        bool tokenIsCurrency0 = token < address(quote);
        PoolKey memory launchKey = tokenIsCurrency0
            ? PoolKey({currency0: Currency.wrap(token), currency1: Currency.wrap(address(quote)), fee: 0, tickSpacing: factory.TICK_SPACING(), hooks: IHooks(address(hook))})
            : PoolKey({currency0: Currency.wrap(address(quote)), currency1: Currency.wrap(token), fee: 0, tickSpacing: factory.TICK_SPACING(), hooks: IHooks(address(hook))});

        quote.approve(address(swapRouter), type(uint256).max);
        bool buyZeroForOne = !tokenIsCurrency0;
        swapRouter.swap(
            launchKey,
            SwapParams({
                zeroForOne: buyZeroForOne,
                amountSpecified: -int256(200_000e6),
                sqrtPriceLimitX96: buyZeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        uint256 tokBal = IERC20Like(token).balanceOf(deployer);
        IERC20Like(token).transfer(holder2, tokBal / 3);

        IERC20Like(token).approve(address(swapRouter), type(uint256).max);
        bool sellZeroForOne = tokenIsCurrency0;
        swapRouter.swap(
            launchKey,
            SwapParams({
                zeroForOne: sellZeroForOne,
                amountSpecified: -int256(tokBal / 2),
                sqrtPriceLimitX96: sellZeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        vm.stopBroadcast();

        console2.log("PoolManager   ", address(manager));
        console2.log("RwaFeeHook    ", address(hook));
        console2.log("Factory       ", address(factory));
        console2.log("Token (DEMO)  ", token);
        console2.log("Vault         ", vaultAddr);
        console2.log("Quote (mock)  ", address(quote));
        console2.log("StockA        ", address(stockA));
        console2.log("StockB        ", address(stockB));
        console2.log("Holder2       ", holder2);
        console2.log("launchPoolId  ", vm.toString(PoolId.unwrap(launchId)));
    }

    function _seedPool(PoolManager manager, PoolModifyLiquidityTest liquidityRouter, address a, address b)
        internal
        returns (PoolKey memory key)
    {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        key = PoolKey({currency0: Currency.wrap(c0), currency1: Currency.wrap(c1), fee: 3_000, tickSpacing: 60, hooks: IHooks(address(0))});
        manager.initialize(key, 79228162514264337593543950336); // raw price 1 — both sides 6dp here
        IERC20Like(c0).approve(address(liquidityRouter), type(uint256).max);
        IERC20Like(c1).approve(address(liquidityRouter), type(uint256).max);
        int24 tickLower = -6_000;
        int24 tickUpper = 6_000;
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(tickUpper);
        uint128 liq0 = LiquidityAmounts.getLiquidityForAmount0(79228162514264337593543950336, sqrtB, 1_000_000e6);
        uint128 liq1 = LiquidityAmounts.getLiquidityForAmount1(sqrtA, 79228162514264337593543950336, 1_000_000e6);
        uint128 liquidity = liq0 < liq1 ? liq0 : liq1;
        liquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: int256(uint256(liquidity)), salt: bytes32(0)}),
            ""
        );
    }
}

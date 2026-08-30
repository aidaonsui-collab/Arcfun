// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {InstantErc20QuoteFactoryProxyInit} from "../src/InstantErc20QuoteFactoryProxyInit.sol";
import {CrucibleLock} from "./vendor-crucible/src/CrucibleLock.sol";
import {Crucible} from "./vendor-crucible/src/Crucible.sol";
import {ReferralRegistry} from "./vendor-crucible/src/ReferralRegistry.sol";
import {InstantLockerAdapter} from "./vendor-crucible/src/InstantLockerAdapter.sol";

/**
 * @title DeployInstantCrucibleMainnet
 * @notice NEW Instant factory on Arc **mainnet 5042**, locking through InstantLockerAdapter
 *         into CrucibleLock. Canonical Uniswap V3 + live USDC + live $EVE.
 *
 *         Does **not** call the live Instant factory `0xd51E…` or MonLock `0x84F4…`.
 *         Those 22 tokens stay 70/30 on MonLock. This factory is only for launches after
 *         the app is pointed at it. No smoke create.
 *
 *         Collect split on this factory is CrucibleLock Meme 50/25/10/10/5 (creator 50%),
 *         not Instant ArcBpsSource 70/30. ArcBpsSource is still required by Instant
 *         initialize; the live 0xFCF6… source is reused as read-only dead config.
 *
 * Env:
 *   PRIVATE_KEY (required)
 *   TREASURY / OWNER / STAKING_POOL / PLATFORM_WALLET (optional; default deployer)
 *   LAUNCH_VIRTUAL_QUOTE (optional; default 5500e6)
 *   CREATION_FEE_WEI (optional; default 0)
 */
contract DeployInstantCrucibleMainnet is Script {
    uint256 internal constant CHAIN_ARC = 5042;

    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant EVE = 0x19209E55049bc613c5cC8b66B7DF7824096e78CF;
    address internal constant WETH9 = 0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f;
    address internal constant UNIV3_NFPM = 0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377;
    address internal constant UNIV3_SWAP_ROUTER = 0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77;
    /// Live Instant ArcBpsSource. CrucibleLock ignores its bps; Instant initialize requires non-zero.
    address internal constant BPS_SOURCE = 0xFCF6Bf9A66AA167BfE4F6165bb04baEd97B6C2aE;

    uint8 internal constant USDC_DECIMALS = 6;
    uint24 internal constant POOL_FEE = 10_000;
    int24 internal constant TICK_SPACING = 200;
    uint24 internal constant EVE_POOL_FEE = 10_000;

    function run() external {
        require(block.chainid == CHAIN_ARC, "not Arc mainnet 5042");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address treasury = vm.envOr("TREASURY", deployer);
        address owner = vm.envOr("OWNER", deployer);
        address staking = vm.envOr("STAKING_POOL", treasury);
        address platformWallet = vm.envOr("PLATFORM_WALLET", treasury);
        uint256 creationFee = vm.envOr("CREATION_FEE_WEI", uint256(0));
        uint256 launchVq = vm.envOr("LAUNCH_VIRTUAL_QUOTE", uint256(5_500_000_000));

        console2.log("Deployer", deployer);
        console2.log("Owner   ", owner);
        console2.log("Treasury", treasury);
        console2.log("Platform", platformWallet);

        vm.startBroadcast(pk);

        ReferralRegistry registry = new ReferralRegistry();
        Crucible crucible = new Crucible(USDC, UNIV3_SWAP_ROUTER, EVE, EVE_POOL_FEE);
        CrucibleLock lock = new CrucibleLock(
            UNIV3_NFPM, USDC, UNIV3_SWAP_ROUTER, address(crucible), address(registry), platformWallet
        );

        InstantErc20QuoteFactoryProxyInit factoryImpl =
            new InstantErc20QuoteFactoryProxyInit(USDC, USDC_DECIMALS, WETH9);
        TransparentUpgradeableProxy factoryProxy = new TransparentUpgradeableProxy(
            address(factoryImpl),
            owner,
            abi.encodeCall(
                InstantErc20QuoteFactoryProxyInit.initialize,
                (treasury, staking, owner, BPS_SOURCE, launchVq)
            )
        );
        InstantErc20QuoteFactoryProxyInit factory = InstantErc20QuoteFactoryProxyInit(payable(address(factoryProxy)));

        InstantLockerAdapter adapter = new InstantLockerAdapter(address(lock), UNIV3_NFPM, deployer);
        lock.setFactory(address(adapter));
        adapter.setInstantFactory(address(factory));
        factory.setUniV3Config(UNIV3_NFPM, POOL_FEE, TICK_SPACING, address(adapter), UNIV3_SWAP_ROUTER);
        if (creationFee > 0) factory.setCreationFee(creationFee);
        lock.setKeeper(deployer, true);
        crucible.setKeeper(deployer, true);

        if (owner != deployer) {
            adapter.transferOwnership(owner);
            lock.transferOwnership(owner);
            crucible.transferOwnership(owner);
        }

        vm.stopBroadcast();

        console2.log("=== Arc Instant-into-CrucibleLock MAINNET (new factory only) ===");
        console2.log("Did not call 0xd51E Instant factory or 0x84F4 MonLock.");
        console2.log("USDC                    ", USDC);
        console2.log("EVE                     ", EVE);
        console2.log("Uni NFPM                ", UNIV3_NFPM);
        console2.log("Uni SwapRouter02        ", UNIV3_SWAP_ROUTER);
        console2.log("ArcBpsSource (reused)   ", BPS_SOURCE);
        console2.log("ReferralRegistry        ", address(registry));
        console2.log("Crucible (burn sink)    ", address(crucible));
        console2.log("CrucibleLock            ", address(lock));
        console2.log("InstantLockerAdapter    ", address(adapter));
        console2.log("InstantFactory impl     ", address(factoryImpl));
        console2.log("InstantFactory (proxy)  ", address(factory));
        console2.log("launchVirtualQuote      ", launchVq);
        console2.log("Set NEXT_PUBLIC_ARC_INSTANT_FACTORY to the proxy.");
        console2.log("Set NEXT_PUBLIC_ARC_INSTANT_LOCKER to CrucibleLock (collect ABI), not the adapter.");
        console2.log("Keep catalog PREV factory 0xd51E and MonLock 0x84F4 for the 22 live tokens.");
    }
}

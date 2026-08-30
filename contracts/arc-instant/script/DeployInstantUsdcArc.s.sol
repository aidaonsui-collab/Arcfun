// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {InstantErc20QuoteFactoryProxyInit} from "../src/InstantErc20QuoteFactoryProxyInit.sol";
import {MonLockProxyInit} from "../src/MonLockProxyInit.sol";
import {ArcBpsSource} from "../src/ArcBpsSource.sol";

/**
 * @title DeployInstantUsdcArc
 * @notice Arc mainnet Instant meme pad: USDC-quoted single-sided Uni V3 pools.
 *         InstantErc20QuoteFactory + MonLock against **canonical Uniswap V3**.
 *         Tokens: LaunchToken18 (plain 18dp ERC-20, 1B supply) — DYOR-style.
 *
 * Env:
 *   PRIVATE_KEY (required)
 *   TREASURY / OWNER / LP_RECIPIENT / STAKING_POOL (optional; default deployer)
 *   LAUNCH_VIRTUAL_QUOTE (optional; default 5500e6 = $5,500 USDC virtual → ~$5.2k FDV, Radar-like)
 *   CREATION_FEE_WEI (optional; native USDC 18dp; default 0)
 *   LOCK_DURATION (optional; seconds; default 365 days)
 *   MEME_CREATOR_BPS / MEME_STAKER_BPS (optional; default 7000 / 0)
 *
 * After broadcast, set frontend:
 *   NEXT_PUBLIC_ARC_INSTANT_FACTORY / NEXT_PUBLIC_ARC_INSTANT_LOCKER / NEXT_PUBLIC_ARC_BPS_SOURCE
 */
contract DeployInstantUsdcArc is Script {
    uint256 internal constant CHAIN_ARC = 5042;

    // Canonical Uniswap V3 on Arc (probed 2026-08-02)
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant UNIV3_NFPM = 0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377;
    address internal constant UNIV3_SWAP_ROUTER = 0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77;
    address internal constant WETH9 = 0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f;

    uint8 internal constant USDC_DECIMALS = 6;
    uint24 internal constant POOL_FEE = 10_000;
    int24 internal constant TICK_SPACING = 200;

    function run() external {
        require(block.chainid == CHAIN_ARC, "not Arc mainnet 5042");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address treasury = vm.envOr("TREASURY", deployer);
        address owner = vm.envOr("OWNER", deployer);
        address lpRecipient = vm.envOr("LP_RECIPIENT", deployer);
        // No OFun staking on Arc yet — park staker leg address at treasury until a pool exists.
        address staking = vm.envOr("STAKING_POOL", treasury);
        uint64 lockDuration = uint64(vm.envOr("LOCK_DURATION", uint256(365 days)));
        uint256 creationFee = vm.envOr("CREATION_FEE_WEI", uint256(0));
        // ~$5.2k launch FDV (Radar-like): MC ≈ VQ * 1e9 / VIRTUAL_TOKEN_INIT_human
        uint256 launchVq = vm.envOr("LAUNCH_VIRTUAL_QUOTE", uint256(5_500_000_000)); // 5500 USDC (6dp)
        uint16 memeCreatorBps = uint16(vm.envOr("MEME_CREATOR_BPS", uint256(7000)));
        uint16 memeStakerBps = uint16(vm.envOr("MEME_STAKER_BPS", uint256(0)));

        console2.log("Deployer", deployer);
        console2.log("Owner   ", owner);
        console2.log("Treasury", treasury);

        vm.startBroadcast(pk);

        ArcBpsSource bps = new ArcBpsSource(owner);
        if (owner == deployer) {
            bps.setMemeBps(memeCreatorBps, memeStakerBps);
        }

        MonLockProxyInit lockerImpl = new MonLockProxyInit(UNIV3_NFPM);
        TransparentUpgradeableProxy lockerProxy = new TransparentUpgradeableProxy(
            address(lockerImpl),
            owner,
            abi.encodeCall(MonLockProxyInit.initialize, (lpRecipient, owner, lockDuration))
        );
        address locker = address(lockerProxy);

        InstantErc20QuoteFactoryProxyInit factoryImpl =
            new InstantErc20QuoteFactoryProxyInit(USDC, USDC_DECIMALS, WETH9);
        TransparentUpgradeableProxy factoryProxy = new TransparentUpgradeableProxy(
            address(factoryImpl),
            owner,
            abi.encodeCall(
                InstantErc20QuoteFactoryProxyInit.initialize,
                (treasury, staking, owner, address(bps), launchVq)
            )
        );
        InstantErc20QuoteFactoryProxyInit factory = InstantErc20QuoteFactoryProxyInit(payable(address(factoryProxy)));

        if (owner == deployer) {
            factory.setUniV3Config(UNIV3_NFPM, POOL_FEE, TICK_SPACING, locker, UNIV3_SWAP_ROUTER);
            if (creationFee > 0) factory.setCreationFee(creationFee);
            // Instant factory stamps meme locks via lockPositionMeme (stamper, not factory role).
            MonLockProxyInit(payable(locker)).setStamper(address(factory));
        }

        vm.stopBroadcast();

        console2.log("=== Arc Instant USDC deploy ===");
        console2.log("ArcBpsSource           ", address(bps));
        console2.log("MonLock (proxy)        ", locker);
        console2.log("InstantFactory (proxy) ", address(factory));
        console2.log("Uni NFPM               ", UNIV3_NFPM);
        console2.log("Uni SwapRouter02       ", UNIV3_SWAP_ROUTER);
        console2.log("USDC                   ", USDC);
        console2.log("launchVirtualQuote     ", launchVq);
        console2.log("Set NEXT_PUBLIC_ARC_BPS_SOURCE=%s", address(bps));
        console2.log("Set NEXT_PUBLIC_ARC_INSTANT_LOCKER=%s", locker);
        console2.log("Set NEXT_PUBLIC_ARC_INSTANT_FACTORY=%s", address(factory));
    }
}

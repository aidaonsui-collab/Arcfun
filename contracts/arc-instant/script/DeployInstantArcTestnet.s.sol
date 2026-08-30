// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {InstantErc20QuoteFactoryProxyInit} from "../src/InstantErc20QuoteFactoryProxyInit.sol";
import {InstantTestnetStack} from "./InstantTestnetStack.sol";
import {MockUSDC} from "./testnet/MockUSDC.sol";

/**
 * @title DeployInstantArcTestnet
 * @notice Throwaway Uniswap V3 + Instant/MonLock/ArcBpsSource on Arc **testnet** (chain id 5042002).
 *         Deploys a fresh Uni V3 factory — testnet factories are spam; do not pick a "canonical" one.
 *         Mock USDC is 6dp; do not assume mainnet USDC 0x3600…0000 exists here.
 *
 *         NOT a mainnet deploy. Does not retarget live Instant. PR #91 stays source-only.
 *
 * Env:
 *   PRIVATE_KEY (required)
 *   TREASURY / OWNER / LP_RECIPIENT / STAKING_POOL (optional; default deployer)
 *   LAUNCH_VIRTUAL_QUOTE (optional; default 5500e6)
 *   CREATION_FEE_WEI (optional; default 0)
 *   LOCK_DURATION (optional; seconds; default 365 days)
 *   MEME_CREATOR_BPS / MEME_STAKER_BPS (optional; default 7000 / 0)
 *   SMOKE_CREATE (optional; "true" mints mock USDC and creates Smoke/SMK with a 100 USDC first-buy)
 *
 * Addresses logged by this script are throwaway testnet addresses, not mainnet.
 */
contract DeployInstantArcTestnet is Script {
    uint256 internal constant CHAIN_ARC_TESTNET = 5_042_002;

    function run() external {
        require(block.chainid == CHAIN_ARC_TESTNET, "not Arc testnet 5042002");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address treasury = vm.envOr("TREASURY", deployer);
        address owner = vm.envOr("OWNER", deployer);
        address lpRecipient = vm.envOr("LP_RECIPIENT", deployer);
        address staking = vm.envOr("STAKING_POOL", treasury);
        uint64 lockDuration = uint64(vm.envOr("LOCK_DURATION", uint256(365 days)));
        uint256 creationFee = vm.envOr("CREATION_FEE_WEI", uint256(0));
        uint256 launchVq = vm.envOr("LAUNCH_VIRTUAL_QUOTE", uint256(5_500_000_000));
        uint16 memeCreatorBps = uint16(vm.envOr("MEME_CREATOR_BPS", uint256(7000)));
        uint16 memeStakerBps = uint16(vm.envOr("MEME_STAKER_BPS", uint256(0)));
        bool smoke = vm.envOr("SMOKE_CREATE", false);

        console2.log("Deployer", deployer);
        console2.log("Owner   ", owner);
        console2.log("Treasury", treasury);

        vm.startBroadcast(pk);

        InstantTestnetStack.Addresses memory s = InstantTestnetStack.deploy(
            InstantTestnetStack.DeployParams({
                owner: owner,
                treasury: treasury,
                lpRecipient: lpRecipient,
                stakingPool: staking,
                lockDuration: lockDuration,
                creationFee: creationFee,
                launchVirtualQuote: launchVq,
                memeCreatorBps: memeCreatorBps,
                memeStakerBps: memeStakerBps,
                wireOwner: owner == deployer
            })
        );

        address smokeToken;
        if (smoke) {
            MockUSDC(s.mockUsdc).mint(deployer, 100e6);
            MockUSDC(s.mockUsdc).approve(s.factory, 100e6);
            smokeToken = InstantErc20QuoteFactoryProxyInit(payable(s.factory)).createTokenMemeInstantQuote(
                "Smoke", "SMK", 100e6
            );
        }

        vm.stopBroadcast();

        console2.log("=== Arc Instant TESTNET throwaway deploy (chain 5042002) ===");
        console2.log("These are throwaway testnet addresses, NOT mainnet / NOT live Instant.");
        console2.log("MockUSDC (6dp)         ", s.mockUsdc);
        console2.log("WETH9                  ", s.weth);
        console2.log("UniswapV3Factory       ", s.uniFactory);
        console2.log("DummyNFTDescriptor     ", s.nftDescriptor);
        console2.log("Uni NFPM               ", s.nfpm);
        console2.log("Uni SwapRouter02       ", s.swapRouter02);
        console2.log("ArcBpsSource           ", s.bpsSource);
        console2.log("MonLock impl           ", s.lockerImpl);
        console2.log("MonLock (proxy)        ", s.locker);
        console2.log("InstantFactory impl    ", s.factoryImpl);
        console2.log("InstantFactory (proxy) ", s.factory);
        console2.log("launchVirtualQuote     ", launchVq);
        if (smoke) console2.log("Smoke token            ", smokeToken);
    }
}

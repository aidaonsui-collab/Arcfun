// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {InstantErc20QuoteFactoryProxyInit} from "../src/InstantErc20QuoteFactoryProxyInit.sol";
import {InstantCrucibleTestnetStack} from "./InstantCrucibleTestnetStack.sol";
import {MockUSDC} from "./testnet/MockUSDC.sol";

/**
 * @title DeployInstantCrucibleTestnet
 * @notice Throwaway Uniswap V3 + Instant, routed through CrucibleLock (via InstantLockerAdapter)
 *         instead of MonLock, on Arc **testnet** (chain id 5042002). Sibling to
 *         DeployInstantArcTestnet.s.sol (which stays on MonLock, 70/30) — this is the dry run
 *         for whether Instant can be pointed at CrucibleLock's 50/25/10/10/5 for real.
 *
 *         Fresh throwaway Uni V3 factory + mock USDC/EVE, same as DeployInstantArcTestnet.s.sol.
 *         NOT a mainnet deploy. Does not touch the live factory, the live locker (0x84F4…), or
 *         any of the 22 live tokens. Addresses logged by this script are throwaway testnet
 *         addresses, not mainnet.
 *
 * Env:
 *   PRIVATE_KEY (required)
 *   TREASURY / OWNER / STAKING_POOL / PLATFORM_WALLET (optional; default deployer)
 *   LAUNCH_VIRTUAL_QUOTE (optional; default 5500e6)
 *   CREATION_FEE_WEI (optional; default 0)
 *   SMOKE_CREATE (optional; "true" mints mock USDC and creates Smoke/SMKC with a 100 USDC
 *                 first-buy — proves create() actually succeeds through CrucibleLock, which
 *                 the prior mainnet cutover (#94/#97) never verified: CrucibleLock has no
 *                 lockPositionMeme, so every create() through that pairing could only revert)
 *
 * After a successful SMOKE_CREATE, do the collect check by hand (this script deliberately does
 * NOT automate it — a human watching real balances move is stronger evidence than a script's
 * own printed numbers). With the addresses this script logs:
 *
 *   1. Buy more of the smoke token to generate LP fees:
 *      cast send $MOCK_USDC "mint(address,uint256)" $YOUR_ADDR 500000000 --rpc-url $ARC_TESTNET_RPC --private-key $PRIVATE_KEY
 *      cast send $MOCK_USDC "approve(address,uint256)" $SWAP_ROUTER 500000000 --rpc-url $ARC_TESTNET_RPC --private-key $PRIVATE_KEY
 *      cast send $SWAP_ROUTER "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))" \
 *        "($MOCK_USDC,$SMOKE_TOKEN,10000,$YOUR_ADDR,500000000,0,0)" --rpc-url $ARC_TESTNET_RPC --private-key $PRIVATE_KEY
 *
 *   2. Collect (permissionless — anyone can call it):
 *      cast send $CRUCIBLE_LOCK "collectFees(uint256)" $POSITION_ID --rpc-url $ARC_TESTNET_RPC --private-key $PRIVATE_KEY
 *
 *   3. Check the split landed as creator 50% / platform 10% / crucible 30% (25%+5% unpaid
 *      referrer) / project-burn 10% accrued:
 *      cast call $MOCK_USDC "balanceOf(address)(uint256)" $YOUR_ADDR --rpc-url $ARC_TESTNET_RPC        # creator (you, as create() sender)
 *      cast call $MOCK_USDC "balanceOf(address)(uint256)" $PLATFORM_WALLET --rpc-url $ARC_TESTNET_RPC
 *      cast call $MOCK_USDC "balanceOf(address)(uint256)" $CRUCIBLE --rpc-url $ARC_TESTNET_RPC
 *      cast call $CRUCIBLE_LOCK "pendingProjectBurn(uint256)(uint256)" $POSITION_ID --rpc-url $ARC_TESTNET_RPC
 */
contract DeployInstantCrucibleTestnet is Script {
    uint256 internal constant CHAIN_ARC_TESTNET = 5_042_002;

    function run() external {
        require(block.chainid == CHAIN_ARC_TESTNET, "not Arc testnet 5042002");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address treasury = vm.envOr("TREASURY", deployer);
        address owner = vm.envOr("OWNER", deployer);
        address staking = vm.envOr("STAKING_POOL", treasury);
        address platformWallet = vm.envOr("PLATFORM_WALLET", treasury);
        uint256 creationFee = vm.envOr("CREATION_FEE_WEI", uint256(0));
        uint256 launchVq = vm.envOr("LAUNCH_VIRTUAL_QUOTE", uint256(5_500_000_000));
        bool smoke = vm.envOr("SMOKE_CREATE", false);

        console2.log("Deployer", deployer);
        console2.log("Owner   ", owner);
        console2.log("Treasury", treasury);

        vm.startBroadcast(pk);

        InstantCrucibleTestnetStack.Addresses memory s = InstantCrucibleTestnetStack.deploy(
            InstantCrucibleTestnetStack.DeployParams({
                owner: owner,
                treasury: treasury,
                stakingPool: staking,
                platformWallet: platformWallet,
                creationFee: creationFee,
                launchVirtualQuote: launchVq,
                wireOwner: owner == deployer
            })
        );

        address smokeToken;
        uint256 smokePositionId;
        if (smoke) {
            MockUSDC(s.mockUsdc).mint(deployer, 100e6);
            MockUSDC(s.mockUsdc).approve(s.factory, 100e6);
            smokeToken = InstantErc20QuoteFactoryProxyInit(payable(s.factory)).createTokenMemeInstantQuote(
                "Smoke Crucible", "SMKC", 100e6
            );
            smokePositionId = InstantErc20QuoteFactoryProxyInit(payable(s.factory)).getPool(smokeToken).positionId;
        }

        vm.stopBroadcast();

        console2.log("=== Arc Instant-into-CrucibleLock TESTNET throwaway deploy (chain 5042002) ===");
        console2.log("These are throwaway testnet addresses, NOT mainnet / NOT live Instant.");
        console2.log("MockUSDC (6dp)          ", s.mockUsdc);
        console2.log("MockEve (18dp)          ", s.mockEve);
        console2.log("WETH9                   ", s.weth);
        console2.log("UniswapV3Factory        ", s.uniFactory);
        console2.log("DummyNFTDescriptor      ", s.nftDescriptor);
        console2.log("Uni NFPM                ", s.nfpm);
        console2.log("Uni SwapRouter02        ", s.swapRouter02);
        console2.log("ArcBpsSource (unused)   ", s.bpsSource);
        console2.log("ReferralRegistry        ", s.referralRegistry);
        console2.log("Crucible (burn sink)    ", s.crucible);
        console2.log("CrucibleLock            ", s.crucibleLock);
        console2.log("InstantLockerAdapter    ", s.adapter);
        console2.log("InstantFactory impl     ", s.factoryImpl);
        console2.log("InstantFactory (proxy)  ", s.factory);
        console2.log("launchVirtualQuote      ", launchVq);
        if (smoke) {
            console2.log("Smoke token             ", smokeToken);
            console2.log("Smoke positionId        ", smokePositionId);
            console2.log("create() succeeded through CrucibleLock -- see header comment for the collect check.");
        }
    }
}

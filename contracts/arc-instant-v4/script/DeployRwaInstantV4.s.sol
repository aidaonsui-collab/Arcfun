// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {EveFeeHook} from "../src/EveFeeHook.sol";
import {RwaInstantV4Factory} from "../src/RwaInstantV4Factory.sol";
import {BundleSinkDeployer} from "../src/BundleSinkDeployer.sol";

/**
 * @title DeployRwaInstantV4
 * @notice Arc mainnet (5042) deploy of RwaInstantV4Factory onto the live EveFeeHook.
 *
 * Reuses Uniswap's official Arc PoolManager and the EveFeeHook from DeployEveInstantV4.
 * Does not deploy a second hook or a second router. Auth is hook.isFactory; this calls
 * setFactoryAllowed so the USDC EveInstantV4Factory stays allowed.
 *
 * Quote is per-create (USYC / BUIDL / CRCL / …). This script does not bake a quote token.
 *
 * Env:
 *   PRIVATE_KEY (required; must be EveFeeHook.owner)
 *   PLATFORM_WALLET / OWNER (optional; default deployer)
 *   POOL_MANAGER (optional; default official Arc v4 PoolManager)
 *   HOOK (optional; default live EveFeeHook)
 *   LAUNCH_VIRTUAL_QUOTE (optional; default 5500e6, same 6dp encoding as Instant V3)
 */
contract DeployRwaInstantV4 is Script {
    uint256 internal constant CHAIN_ARC_MAINNET = 5_042;
    address internal constant ARC_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant LIVE_HOOK = 0x8fa4B88e4052302FBd9E8419eeC6E9FdAC210044;
    uint256 internal constant DEFAULT_VIRTUAL_QUOTE = 5_500e6;

    function run() external {
        require(block.chainid == CHAIN_ARC_MAINNET, "not Arc mainnet 5042");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address platformWallet = vm.envOr("PLATFORM_WALLET", deployer);
        address owner = vm.envOr("OWNER", deployer);
        address poolManagerAddr = vm.envOr("POOL_MANAGER", ARC_POOL_MANAGER);
        address hookAddr = vm.envOr("HOOK", LIVE_HOOK);
        uint256 virtualQuote = vm.envOr("LAUNCH_VIRTUAL_QUOTE", DEFAULT_VIRTUAL_QUOTE);

        require(poolManagerAddr.code.length > 0, "PoolManager has no code");
        require(hookAddr.code.length > 0, "EveFeeHook has no code");

        EveFeeHook hook = EveFeeHook(hookAddr);
        require(address(hook.poolManager()) == poolManagerAddr, "hook/manager mismatch");
        require(hook.owner() == deployer, "deployer is not hook owner");

        console2.log("Deployer      ", deployer);
        console2.log("Platform      ", platformWallet);
        console2.log("Owner         ", owner);
        console2.log("PoolManager   ", poolManagerAddr);
        console2.log("EveFeeHook    ", hookAddr);

        IPoolManager manager = IPoolManager(poolManagerAddr);

        vm.startBroadcast(pk);

        BundleSinkDeployer sinkDeployer = new BundleSinkDeployer();
        RwaInstantV4Factory factory = new RwaInstantV4Factory(manager, hook, platformWallet, sinkDeployer);
        hook.setFactoryAllowed(address(factory), true);
        factory.setLaunchVirtualQuote(virtualQuote);

        if (owner != deployer) {
            factory.transferOwnership(owner);
        }

        vm.stopBroadcast();

        console2.log("BundleSinkDeployer    ", address(sinkDeployer));
        console2.log("RwaInstantV4Factory   ", address(factory));
        console2.log("EveFeeHook            ", hookAddr);
        console2.log("PoolManager           ", poolManagerAddr);
    }
}

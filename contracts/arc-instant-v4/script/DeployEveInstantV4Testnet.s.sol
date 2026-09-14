// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {EveFeeHook} from "../src/EveFeeHook.sol";
import {EveInstantV4Factory} from "../src/EveInstantV4Factory.sol";
import {HookMiner} from "../test/utils/HookMiner.sol";

/**
 * @title DeployEveInstantV4Testnet
 * @notice Arc testnet (5042002) throwaway deploy of the shared EveFeeHook + USDC Instant factory.
 *
 * Does not replace the live V3 Instant factory. Testnet deploys a fresh PoolManager unless
 * POOL_MANAGER is set. Arc mainnet Instant uses Uniswap's official PoolManager
 * `0x8366a39CC670B4001A1121B8F6A443A643e40951` via DeployEveInstantV4.s.sol.
 *
 * Env:
 *   PRIVATE_KEY (required)
 *   PLATFORM_WALLET / OWNER (optional; default deployer)
 *   POOL_MANAGER (optional; default deploys a fresh PoolManager)
 */
contract DeployEveInstantV4Testnet is Script {
    uint256 internal constant CHAIN_ARC_TESTNET = 5_042_002;
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 internal constant REQUIRED_HOOK_FLAGS =
        uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);

    function run() external {
        require(block.chainid == CHAIN_ARC_TESTNET, "not Arc testnet 5042002");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address platformWallet = vm.envOr("PLATFORM_WALLET", deployer);
        address owner = vm.envOr("OWNER", deployer);
        address poolManagerOverride = vm.envOr("POOL_MANAGER", address(0));

        console2.log("Deployer      ", deployer);
        console2.log("Platform      ", platformWallet);

        vm.startBroadcast(pk);

        IPoolManager manager;
        if (poolManagerOverride != address(0)) {
            manager = IPoolManager(poolManagerOverride);
            console2.log("PoolManager (existing)", poolManagerOverride);
        } else {
            manager = IPoolManager(address(new PoolManager(deployer)));
            console2.log("PoolManager (fresh)   ", address(manager));
        }

        (address predicted, bytes32 salt) = HookMiner.find(
            CREATE2_DEPLOYER,
            REQUIRED_HOOK_FLAGS,
            type(EveFeeHook).creationCode,
            abi.encode(address(manager), deployer)
        );

        EveFeeHook hook = new EveFeeHook{salt: salt}(manager, deployer);
        require(address(hook) == predicted, "hook address mismatch - salt mining and deploy sender disagree");

        EveInstantV4Factory factory = new EveInstantV4Factory(manager, hook, platformWallet);
        hook.setFactory(address(factory));

        if (owner != deployer) {
            hook.transferOwnership(owner);
            factory.transferOwnership(owner);
        }

        vm.stopBroadcast();

        console2.log("EveFeeHook            ", address(hook));
        console2.log("EveInstantV4Factory   ", address(factory));
    }
}

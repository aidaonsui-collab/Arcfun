// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {StdConstants} from "forge-std/StdConstants.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {RwaFeeHook} from "../src/RwaFeeHook.sol";
import {RwaInstantV4Factory} from "../src/RwaInstantV4Factory.sol";
import {HookMiner} from "../test/utils/HookMiner.sol";

/**
 * @title DeployRwaInstantV4Testnet
 * @notice Arc testnet (5042002) throwaway deploy.
 *
 * Deploys a FRESH v4 PoolManager rather than pointing at an existing one — same reasoning as
 * contracts/arc-instant's testnet script uses for Uniswap V3: an address on Arc that looks like
 * it could be the canonical PoolManager (0x8366a39cc670b4001a1121b8f6a443a643e40951 — inferred
 * from watching it hold the LP for a couple of independently-launched tokens, see the session
 * this shipped from) is NOT the same as a confirmed one. Do not hardcode it here until someone
 * has actually verified it against Uniswap's own deployment records for Arc. Pass
 * POOL_MANAGER=0x... to point at a real one once that's done; unset, this deploys its own.
 *
 * Env:
 *   PRIVATE_KEY (required)
 *   PLATFORM_WALLET / CRUCIBLE / OWNER (optional; default deployer)
 *   POOL_MANAGER (optional; default deploys a fresh PoolManager)
 */
contract DeployRwaInstantV4Testnet is Script {
    uint256 internal constant CHAIN_ARC_TESTNET = 5_042_002;
    uint160 internal constant REQUIRED_HOOK_FLAGS =
        uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);

    function run() external {
        require(block.chainid == CHAIN_ARC_TESTNET, "not Arc testnet 5042002");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address platformWallet = vm.envOr("PLATFORM_WALLET", deployer);
        address crucible = vm.envOr("CRUCIBLE", deployer);
        address owner = vm.envOr("OWNER", deployer);
        address poolManagerOverride = vm.envOr("POOL_MANAGER", address(0));

        console2.log("Deployer      ", deployer);
        console2.log("Platform      ", platformWallet);
        console2.log("Crucible      ", crucible);

        vm.startBroadcast(pk);

        IPoolManager manager;
        if (poolManagerOverride != address(0)) {
            manager = IPoolManager(poolManagerOverride);
            console2.log("PoolManager (existing)", poolManagerOverride);
        } else {
            manager = IPoolManager(address(new PoolManager(deployer)));
            console2.log("PoolManager (fresh)   ", address(manager));
        }

        // Salt-mine against forge-std's CREATE2_FACTORY, NOT `deployer` — a salted
        // `new X{salt}()` inside a broadcast from an EOA is relayed through that canonical
        // factory (forge-std's StdConstants.CREATE2_FACTORY), so that factory is the real CREATE2
        // sender, and `msg.sender` inside RwaFeeHook's own constructor is that factory too (which
        // is why the constructor takes an explicit owner_ instead of defaulting to msg.sender).
        // Hook owner starts as `deployer` (the broadcasting EOA) so the setFactory call right
        // below — sent from `deployer` — succeeds; handed off to the real `owner` at the end
        // alongside the factory, same as before. Originally mined against `deployer` here and
        // never caught because the test suite deploys the hook directly (no broadcast, no proxy)
        // — caught by actually running this path against a live Anvil node (see
        // script/LocalAnvilDemo.s.sol) rather than shipping it only forge-test-verified.
        (address predicted, bytes32 salt) = HookMiner.find(
            StdConstants.CREATE2_FACTORY, REQUIRED_HOOK_FLAGS, type(RwaFeeHook).creationCode, abi.encode(address(manager), deployer)
        );

        RwaFeeHook hook = new RwaFeeHook{salt: salt}(manager, deployer);
        require(address(hook) == predicted, "hook address mismatch - salt mining and deploy sender disagree");

        RwaInstantV4Factory factory = new RwaInstantV4Factory(manager, hook, platformWallet, crucible);
        hook.setFactory(address(factory));

        if (owner != deployer) {
            hook.transferOwnership(owner);
            factory.transferOwnership(owner);
        }

        vm.stopBroadcast();

        console2.log("RwaFeeHook           ", address(hook));
        console2.log("RwaInstantV4Factory  ", address(factory));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {EveFeeHook} from "../src/EveFeeHook.sol";
import {EveInstantV4Factory} from "../src/EveInstantV4Factory.sol";
import {EveV4Router} from "../src/EveV4Router.sol";
import {HookMiner} from "../test/utils/HookMiner.sol";

/**
 * @title DeployEveInstantV4
 * @notice Arc mainnet (5042) deploy of EveFeeHook + EveInstantV4Factory + EveV4Router.
 *
 * Points at Uniswap's official Arc PoolManager
 * `0x8366a39CC670B4001A1121B8F6A443A643e40951` (Uniswap/contracts deployments/json/5042.json).
 * Does not replace the live V3 Instant factory.
 *
 * Hook address is CREATE2-mined through the canonical CREATE2 deployer
 * `0x4e59b44847b379578588920cA78FbF26c0B4956C` so AFTER_SWAP flags sit in the low bits.
 * Constructor takes an explicit owner so the CREATE2 factory is not locked as owner.
 *
 * Env:
 *   PRIVATE_KEY (required)
 *   PLATFORM_WALLET / OWNER (optional; default deployer)
 *   POOL_MANAGER (optional; default official Arc v4 PoolManager)
 *   ROUTER (optional; reuse an already-deployed EveV4Router instead of deploying another)
 *   HOOK (optional; reuse an already-deployed EveFeeHook and only deploy a new factory)
 *   LAUNCH_VIRTUAL_QUOTE (optional; default 5500e6)
 */
contract DeployEveInstantV4 is Script {
    uint256 internal constant CHAIN_ARC_MAINNET = 5_042;
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal constant ARC_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    uint160 internal constant REQUIRED_HOOK_FLAGS =
        uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);
    uint256 internal constant DEFAULT_VIRTUAL_QUOTE = 5_500e6;

    function run() external {
        require(block.chainid == CHAIN_ARC_MAINNET, "not Arc mainnet 5042");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address platformWallet = vm.envOr("PLATFORM_WALLET", deployer);
        address owner = vm.envOr("OWNER", deployer);
        address poolManagerAddr = vm.envOr("POOL_MANAGER", ARC_POOL_MANAGER);
        address existingRouter = vm.envOr("ROUTER", address(0));
        address existingHook = vm.envOr("HOOK", address(0));
        uint256 virtualQuote = vm.envOr("LAUNCH_VIRTUAL_QUOTE", DEFAULT_VIRTUAL_QUOTE);

        require(poolManagerAddr.code.length > 0, "PoolManager has no code");

        console2.log("Deployer      ", deployer);
        console2.log("Platform      ", platformWallet);
        console2.log("Owner         ", owner);
        console2.log("PoolManager   ", poolManagerAddr);

        IPoolManager manager = IPoolManager(poolManagerAddr);

        address predicted;
        bytes32 salt;
        if (existingHook == address(0)) {
            require(CREATE2_DEPLOYER.code.length > 0, "CREATE2 deployer has no code");
            (predicted, salt) = HookMiner.find(
                CREATE2_DEPLOYER,
                REQUIRED_HOOK_FLAGS,
                type(EveFeeHook).creationCode,
                abi.encode(address(manager), deployer)
            );
        }

        vm.startBroadcast(pk);

        EveFeeHook hook;
        if (existingHook != address(0)) {
            require(existingHook.code.length > 0, "HOOK has no code");
            hook = EveFeeHook(existingHook);
            require(address(hook.poolManager()) == poolManagerAddr, "hook/manager mismatch");
            require(hook.owner() == deployer, "deployer is not hook owner");
        } else {
            hook = new EveFeeHook{salt: salt}(manager, deployer);
            require(address(hook) == predicted, "hook address mismatch");
        }

        EveInstantV4Factory factory = new EveInstantV4Factory(manager, hook, platformWallet);
        if (existingHook != address(0)) {
            hook.setFactoryAllowed(address(factory), true);
        } else {
            hook.setFactory(address(factory));
        }
        factory.setLaunchVirtualQuote(virtualQuote);

        EveV4Router router;
        if (existingRouter != address(0)) {
            require(existingRouter.code.length > 0, "ROUTER has no code");
            router = EveV4Router(existingRouter);
        } else {
            router = new EveV4Router(manager);
        }

        if (owner != deployer) {
            if (existingHook == address(0)) hook.transferOwnership(owner);
            factory.transferOwnership(owner);
        }

        vm.stopBroadcast();

        console2.log("EveFeeHook            ", address(hook));
        console2.log("EveInstantV4Factory   ", address(factory));
        console2.log("InstantAutoLpHelper   ", address(factory.autoLpHelper()));
        console2.log("EveV4Router           ", address(router));
        console2.log("PoolManager           ", poolManagerAddr);
    }
}

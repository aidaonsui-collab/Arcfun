// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ArcNS} from "../src/ArcNS.sol";
import {ArcNSResolver} from "../src/ArcNSResolver.sol";

/**
 * @title DeployArcNSTestnet
 * @notice ArcNS on Arc **testnet** (chain id 5042002). Uses the real Arc USDC address (0x3600…000
 *         is a fixed predeploy on every Arc environment, not something a testnet redeploys — see
 *         lib/contracts-arc.ts's ARC.USDC comment).
 *
 *         There is no real Crucible burn sink on testnet (it's a mainnet-only contract). Rather
 *         than invent a fake burn destination, CRUCIBLE_SINK here defaults to the treasury address
 *         so testnet registration fees just go 100% to whoever you set as treasury — swap in the
 *         real sink (0x0B3Eb6Cef8B2b3b158c560898Ead0127f08AE6B6) only in the mainnet script.
 *
 * Env:
 *   PRIVATE_KEY (required)
 *   TREASURY (optional; default deployer) — also doubles as the testnet burn-sink stand-in
 *   OWNER (optional; default deployer)
 *   CRUCIBLE_SINK (optional; default TREASURY)
 */
contract DeployArcNSTestnet is Script {
    uint256 internal constant CHAIN_ARC_TESTNET = 5_042_002;
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external {
        require(block.chainid == CHAIN_ARC_TESTNET, "not Arc testnet 5042002");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address treasury = vm.envOr("TREASURY", deployer);
        address owner = vm.envOr("OWNER", deployer);
        address crucibleSink = vm.envOr("CRUCIBLE_SINK", treasury);

        console2.log("Deployer     ", deployer);
        console2.log("Owner        ", owner);
        console2.log("Treasury     ", treasury);
        console2.log("Crucible sink", crucibleSink);
        if (crucibleSink == treasury) {
            console2.log("(no real burn sink on testnet - using treasury as stand-in)");
        }

        vm.startBroadcast(pk);

        ArcNS ns = new ArcNS(ARC_USDC, crucibleSink, treasury);
        ArcNSResolver resolver = new ArcNSResolver(address(ns));
        if (owner != deployer) ns.transferOwnership(owner);

        vm.stopBroadcast();

        console2.log("ArcNS        ", address(ns));
        console2.log("ArcNSResolver", address(resolver));
    }
}

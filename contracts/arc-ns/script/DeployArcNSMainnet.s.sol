// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ArcNS} from "../src/ArcNS.sol";
import {ArcNSResolver} from "../src/ArcNSResolver.sol";

/**
 * @title DeployArcNSMainnet
 * @notice ArcNS on Arc **mainnet** (chain id 5042). Defaults CRUCIBLE_SINK to the real, live
 *         Crucible burn sink (0x0B3Eb6Cef8B2b3b158c560898Ead0127f08AE6B6) — the same address
 *         CrucibleLock's own `crucible` fee leg already pays into (see
 *         contracts/arc-instant/script/vendor-crucible/src/CrucibleLock.sol). Registration fees
 *         land there as plain USDC and get swept into an EVE buyback-and-burn the next time
 *         someone runs `cook()` (npm run cook-crucible) — no new burn plumbing needed.
 *
 * Env:
 *   PRIVATE_KEY (required)
 *   TREASURY (optional; default deployer) — receives the platform-fee leg
 *   OWNER (optional; default deployer)
 *   CRUCIBLE_SINK (optional; default the real mainnet sink above — only override this for a
 *                  deliberate migration, not by accident)
 */
contract DeployArcNSMainnet is Script {
    uint256 internal constant CHAIN_ARC_MAINNET = 5_042;
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    address internal constant CRUCIBLE_SINK_DEFAULT = 0x0B3Eb6Cef8B2b3b158c560898Ead0127f08AE6B6;

    function run() external {
        require(block.chainid == CHAIN_ARC_MAINNET, "not Arc mainnet 5042");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address treasury = vm.envOr("TREASURY", deployer);
        address owner = vm.envOr("OWNER", deployer);
        address crucibleSink = vm.envOr("CRUCIBLE_SINK", CRUCIBLE_SINK_DEFAULT);

        console2.log("Deployer     ", deployer);
        console2.log("Owner        ", owner);
        console2.log("Treasury     ", treasury);
        console2.log("Crucible sink", crucibleSink);
        if (crucibleSink != CRUCIBLE_SINK_DEFAULT) {
            console2.log("(CRUCIBLE_SINK overridden away from the known live sink - make sure that's deliberate)");
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

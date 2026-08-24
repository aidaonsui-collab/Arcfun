// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ArcDisperse} from "../src/ArcDisperse.sol";

contract DeployDisperse is Script {
    function run() external {
        vm.startBroadcast();
        ArcDisperse d = new ArcDisperse();
        vm.stopBroadcast();
        console2.log("ArcDisperse", address(d));
    }
}

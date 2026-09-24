// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {BasketVaultFactory} from "../src/BasketVaultFactory.sol";

/// @notice Arc mainnet deploy of the basket share factory. No Dinari tokens are pulled.
///         Env: PRIVATE_KEY
contract DeployBasketVaultFactory is Script {
    uint256 internal constant CHAIN_ARC_MAINNET = 5_042;

    function run() external {
        require(block.chainid == CHAIN_ARC_MAINNET, "not Arc mainnet 5042");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        BasketVaultFactory factory = new BasketVaultFactory();
        vm.stopBroadcast();
        console2.log("BasketVaultFactory", address(factory));
    }
}

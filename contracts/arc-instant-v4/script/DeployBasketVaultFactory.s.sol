// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {BasketVaultFactory} from "../src/BasketVaultFactory.sol";
import {BasketUsdcRouter} from "../src/BasketUsdcRouter.sol";

/// @notice Arc mainnet deploy of the basket share factory. No assets are pulled.
///         Env: PRIVATE_KEY, PROTOCOL_FEE_RECIPIENT (defaults to the eve platform wallet).
contract DeployBasketVaultFactory is Script {
    uint256 internal constant CHAIN_ARC_MAINNET = 5_042;
    address internal constant PLATFORM = 0x26bD491560b5175ee8bD1DA4998Fe260FfC413c9;
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant SWAP_ROUTER = 0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77;

    function run() external {
        require(block.chainid == CHAIN_ARC_MAINNET, "not Arc mainnet 5042");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address recipient = vm.envOr("PROTOCOL_FEE_RECIPIENT", PLATFORM);
        vm.startBroadcast(pk);
        BasketVaultFactory factory = new BasketVaultFactory(recipient);
        BasketUsdcRouter router = new BasketUsdcRouter(USDC, SWAP_ROUTER);
        vm.stopBroadcast();
        console2.log("BasketVaultFactory", address(factory));
        console2.log("BasketUsdcRouter", address(router));
        console2.log("protocolFeeRecipient", recipient);
    }
}

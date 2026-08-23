// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ArcNftCollectionFactory} from "../src/ArcNftCollectionFactory.sol";
import {ArcNft721} from "../src/ArcNft721.sol";

/// @dev Arc mainnet: USDC 6dp at 0x3600…0000, treasury 0x26bD…c9, creation fee 0.1e18.
contract Deploy is Script {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    address constant TREASURY = 0x26bD491560b5175ee8bD1DA4998Fe260FfC413c9;
    address constant INSTANT_FACTORY = 0xd51E6217bb3bC7586866713854Ea75B7BefF1009;
    address constant REFLECTION_FACTORY = 0xa4957E724696b740b323fF3536415bB945e46828;
    uint256 constant CREATION_FEE = 0.1 ether;

    function run() external {
        address owner = vm.envAddress("ARCPORT_OWNER");
        vm.startBroadcast();
        ArcNft721 nftImpl = new ArcNft721();
        ArcNftCollectionFactory factoryImpl = new ArcNftCollectionFactory();
        address proxy = address(
            new ERC1967Proxy(
                address(factoryImpl),
                abi.encodeCall(
                    ArcNftCollectionFactory.initialize,
                    (owner, TREASURY, ARC_USDC, address(nftImpl), CREATION_FEE, INSTANT_FACTORY, REFLECTION_FACTORY)
                )
            )
        );
        vm.stopBroadcast();
        require(proxy != address(0), "proxy");
        console2.log("nftImpl", address(nftImpl));
        console2.log("factoryImpl", address(factoryImpl));
        console2.log("factoryProxy", proxy);
        console2.log("owner", owner);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ArcNftCollectionFactory} from "../src/ArcNftCollectionFactory.sol";
import {ArcNft721} from "../src/ArcNft721.sol";

/// @dev Deploy a new ArcNft721 implementation and point the factory at it.
///      Existing clones keep the old bytecode. New collections get price/metadata locks + mint caps.
contract SetImplementation is Script {
    address constant FACTORY = 0x0b7aD72020BDF5efECac11890DA8646f1339307e;

    function run() external {
        vm.startBroadcast();
        ArcNft721 nftImpl = new ArcNft721();
        ArcNftCollectionFactory(FACTORY).setImplementation(address(nftImpl));
        vm.stopBroadcast();
        console2.log("nftImpl", address(nftImpl));
        console2.log("factory", FACTORY);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ArcNftCollectionFactory} from "../src/ArcNftCollectionFactory.sol";
import {ArcNft721} from "../src/ArcNft721.sol";

/// @dev Deploy new factory + NFT implementations, UUPS-upgrade the live factory proxy,
///      and point setImplementation at the new ArcNft721 (paymentToken / payInOriginToken).
///      Existing clones keep their old NFT bytecode; only new collections get the new impl.
contract UpgradeOriginMint is Script {
    address constant FACTORY = 0x0b7aD72020BDF5efECac11890DA8646f1339307e;

    function run() external {
        vm.startBroadcast();
        ArcNft721 nftImpl = new ArcNft721();
        ArcNftCollectionFactory factoryImpl = new ArcNftCollectionFactory();
        ArcNftCollectionFactory(FACTORY).upgradeToAndCall(address(factoryImpl), bytes(""));
        ArcNftCollectionFactory(FACTORY).setImplementation(address(nftImpl));
        vm.stopBroadcast();
        console2.log("nftImpl", address(nftImpl));
        console2.log("factoryImpl", address(factoryImpl));
        console2.log("factoryProxy", FACTORY);
    }
}

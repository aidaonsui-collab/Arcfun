// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {HandlePayFactory} from "../src/HandlePay.sol";

/**
 * Deploy HandlePayFactory (X-handle creator-fee vaults) on Arc.
 *
 *   SIGNER=0x… \
 *   forge script script/DeployHandlePayFactory.s.sol --rpc-url $ARC_RPC --broadcast -vvv
 *
 * SIGNER = HANDLE_PAY_SIGNER_KEY's address (voucher signer for claims).
 * Owner  = the deploying key (rotate later with setOwner).
 *
 * After deploy, set on Vercel:
 *   NEXT_PUBLIC_ARC_HANDLE_PAY_FACTORY=<deployed address>
 *   HANDLE_PAY_SIGNER_KEY=<matching private key, server-only>
 */
contract DeployHandlePayFactory is Script {
    uint256 internal constant CHAIN_ARC = 5042;

    function run() external {
        require(block.chainid == CHAIN_ARC, "not Arc mainnet 5042");
        address signer = vm.envAddress("SIGNER");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        HandlePayFactory f = new HandlePayFactory(signer);
        vm.stopBroadcast();
        console2.log("HandlePayFactory:", address(f));
        console2.log("  signer:", signer);
        console2.log("  owner: ", f.owner());
    }
}

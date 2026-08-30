// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice NFPM constructor requires a token descriptor. Instant never calls tokenURI.
contract DummyNFTDescriptor {
    function tokenURI(address, uint256) external pure returns (string memory) {
        return "";
    }
}

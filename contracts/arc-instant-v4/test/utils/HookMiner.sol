// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @dev Standard CREATE2 salt-mining for a v4 hook address whose low bits must encode its
///      permission flags — same technique as Uniswap's own v4-periphery HookMiner (not vendored
///      here since only tests need it), reimplemented for this repo's test suite.
library HookMiner {
    uint160 internal constant FLAG_MASK = (1 << 14) - 1;
    uint256 internal constant MAX_LOOP = 200_000;

    function find(address deployer, uint160 flags, bytes memory creationCode, bytes memory constructorArgs)
        internal
        pure
        returns (address hookAddress, bytes32 salt)
    {
        bytes memory init = abi.encodePacked(creationCode, constructorArgs);
        bytes32 initCodeHash = keccak256(init);
        flags = flags & FLAG_MASK;
        for (uint256 i; i < MAX_LOOP; i++) {
            salt = bytes32(i);
            hookAddress = computeAddress(deployer, salt, initCodeHash);
            if (uint160(hookAddress) & FLAG_MASK == flags) return (hookAddress, salt);
        }
        revert("HookMiner: no salt found");
    }

    function computeAddress(address deployer, bytes32 salt, bytes32 initCodeHash) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BasketShareVault} from "./BasketShareVault.sol";

/// @title BasketVaultFactory
/// @notice Deploys one fixed-recipe share vault per basket. The creator then calls `seed`.
contract BasketVaultFactory {
    event VaultCreated(address indexed vault, address indexed creator, string symbol);

    function create(
        string calldata name,
        string calldata symbol,
        address[] calldata tokens,
        uint256[] calldata units,
        uint256 seedShares,
        uint256 shareCap
    ) external returns (BasketShareVault vault) {
        vault = new BasketShareVault(name, symbol, msg.sender, tokens, units, seedShares, shareCap);
        emit VaultCreated(address(vault), msg.sender, symbol);
    }
}

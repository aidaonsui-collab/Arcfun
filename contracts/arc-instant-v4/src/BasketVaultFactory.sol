// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BasketShareVault} from "./BasketShareVault.sol";

/// @title BasketVaultFactory
/// @notice Deploys one fixed-recipe share vault. The first mint is what fills it.
contract BasketVaultFactory {
    address public immutable protocolFeeRecipient;

    event VaultCreated(address indexed vault, address indexed creator, string symbol);

    constructor(address protocolFeeRecipient_) {
        require(protocolFeeRecipient_ != address(0), "recipient");
        protocolFeeRecipient = protocolFeeRecipient_;
    }

    function create(
        string calldata name,
        string calldata symbol,
        address[] calldata tokens,
        uint256[] calldata units,
        uint16 mintFeeBps,
        uint16 redeemFeeBps
    ) external returns (BasketShareVault vault) {
        vault = new BasketShareVault(
            name, symbol, msg.sender, protocolFeeRecipient, tokens, units, mintFeeBps, redeemFeeBps
        );
        emit VaultCreated(address(vault), msg.sender, symbol);
    }
}

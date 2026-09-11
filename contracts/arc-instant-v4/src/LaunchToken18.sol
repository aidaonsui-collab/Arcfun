// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title LaunchToken18
/// @notice Plain DYOR-style launch ERC-20: 18 decimals, fixed 1B supply, mint once to recipient.
///         No owner, no tax, no factory surface, no anti-snipe — standard OpenZeppelin ERC-20 only.
///         Used by Arc Instant + Arc bonding curve (token 18dp, quote USDC 6dp).
contract LaunchToken18 is ERC20 {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether; // 1B, 18dp

    /// @param recipient the factory — holds full supply until LP mint / curve sale.
    constructor(string memory name_, string memory symbol_, address recipient) ERC20(name_, symbol_) {
        require(recipient != address(0), "zero");
        _mint(recipient, TOTAL_SUPPLY);
    }
}

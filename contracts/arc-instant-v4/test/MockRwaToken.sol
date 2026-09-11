// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Stand-in for USYC/BUIDL in tests. 6dp like the real USYC (see lib/arc-rwa-assets.ts).
contract MockRwaToken is ERC20 {
    constructor() ERC20("US Yield Coin (mock)", "USYC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

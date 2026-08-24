// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title ArcDisperse
/// @notice Pull ERC-20 from the caller and send to many wallets in one tx.
///         Used by ArcStudio creator airdrops. Stateless; anyone may call.
contract ArcDisperse {
    using SafeERC20 for IERC20;

    error Len();

    event Dispersed(address indexed token, address indexed from, uint256 recipients, uint256 total);

    function disperseToken(IERC20 token, address[] calldata recipients, uint256[] calldata amounts) external {
        uint256 n = recipients.length;
        if (n == 0 || n != amounts.length) revert Len();
        uint256 total;
        for (uint256 i; i < n; ++i) total += amounts[i];
        if (total > 0) token.safeTransferFrom(msg.sender, address(this), total);
        for (uint256 i; i < n; ++i) {
            if (amounts[i] == 0) continue;
            token.safeTransfer(recipients[i], amounts[i]);
        }
        emit Dispersed(address(token), msg.sender, n, total);
    }
}

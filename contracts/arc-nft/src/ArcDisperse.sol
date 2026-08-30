// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title ArcDisperse
/// @notice Send ERC-20 from the caller to many wallets in one tx.
///         Used by ArcStudio creator airdrops. Stateless; anyone may call.
/// @dev Transfers go straight from the sender to each recipient. Routing them
///      through this contract instead would make the hop observable to
///      fee-on-transfer and rebasing tokens: the pull arrives short, the last
///      payout reverts, and any balance left here by an earlier such call is
///      spendable by the next caller. Holding nothing removes the question.
contract ArcDisperse {
    using SafeERC20 for IERC20;

    error Len();

    event Dispersed(address indexed token, address indexed from, uint256 recipients, uint256 total);

    function disperseToken(IERC20 token, address[] calldata recipients, uint256[] calldata amounts) external {
        uint256 n = recipients.length;
        if (n == 0 || n != amounts.length) revert Len();
        uint256 total;
        for (uint256 i; i < n; ++i) {
            uint256 amount = amounts[i];
            if (amount == 0) continue;
            total += amount;
            token.safeTransferFrom(msg.sender, recipients[i], amount);
        }
        emit Dispersed(address(token), msg.sender, n, total);
    }
}

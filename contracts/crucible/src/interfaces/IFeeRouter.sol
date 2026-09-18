// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Live Arc RobinSwap fee router. `swapExactInput` sends `tokenOut` to msg.sender.
interface IFeeRouter {
    function swapExactInput(
        address router,
        address tokenIn,
        address tokenOut,
        uint24 poolFee,
        uint256 amountIn,
        uint256 amountOutMinimum
    ) external returns (uint256 amountOut);
}

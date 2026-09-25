// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {BasketShareVault} from "./BasketShareVault.sol";

/// @title BasketUsdcRouter
/// @notice Buy a basket share with USDC, or sell it back to USDC, in one transaction.
///         Each asset is swapped on Uniswap v3 through SwapRouter02, then the vault
///         mints or redeems. A dead asset can be skipped on the sell.
contract BasketUsdcRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable usdc;
    address public immutable swapRouter;

    error Expired();
    error Slippage();
    error Nothing();

    event Bought(address indexed vault, address indexed buyer, uint256 shares, uint256 usdcIn);
    event Sold(address indexed vault, address indexed seller, uint256 shares, uint256 usdcOut);

    constructor(address usdc_, address swapRouter_) {
        require(usdc_ != address(0) && swapRouter_ != address(0), "router");
        usdc = usdc_;
        swapRouter = swapRouter_;
    }

    /// @notice Spend at most `maxUsdc` to mint exactly `shares`. Leftover USDC is returned.
    function buyExact(address vault, uint256 shares, uint256 maxUsdc, uint24 fee, uint256 deadline)
        external
        nonReentrant
        returns (uint256 spent)
    {
        if (block.timestamp > deadline) revert Expired();
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), maxUsdc);
        (address[] memory tokens, uint256[] memory required) = BasketShareVault(vault).previewMint(shares);
        uint256 left = maxUsdc;
        uint256 n = tokens.length;
        for (uint256 i; i < n; ++i) {
            if (required[i] == 0) continue;
            IERC20(usdc).forceApprove(swapRouter, left);
            uint256 inAmt = ISwapRouter02(swapRouter).exactOutputSingle(
                ISwapRouter02.ExactOutputSingleParams({
                    tokenIn: usdc,
                    tokenOut: tokens[i],
                    fee: fee,
                    recipient: address(this),
                    amountOut: required[i],
                    amountInMaximum: left,
                    sqrtPriceLimitX96: 0
                })
            );
            left -= inAmt;
            IERC20(tokens[i]).forceApprove(vault, required[i]);
        }
        BasketShareVault(vault).mint(shares, msg.sender);
        spent = maxUsdc - left;
        if (spent == 0) revert Nothing();
        if (left > 0) IERC20(usdc).safeTransfer(msg.sender, left);
        emit Bought(vault, msg.sender, shares, spent);
    }

    /// @notice Redeem `shares` and swap every received asset to USDC. `skip` forfeits those legs.
    function sell(address vault, uint256 shares, uint256 minUsdc, address[] calldata skip, uint24 fee, uint256 deadline)
        external
        nonReentrant
        returns (uint256 out)
    {
        if (block.timestamp > deadline) revert Expired();
        IERC20(vault).safeTransferFrom(msg.sender, address(this), shares);
        address[] memory tokens = BasketShareVault(vault).legs();
        BasketShareVault(vault).redeemExcluding(shares, address(this), skip);
        uint256 beforeUsdc = IERC20(usdc).balanceOf(address(this));
        uint256 n = tokens.length;
        for (uint256 i; i < n; ++i) {
            if (_skipped(tokens[i], skip)) continue;
            uint256 bal = IERC20(tokens[i]).balanceOf(address(this));
            if (bal == 0) continue;
            IERC20(tokens[i]).forceApprove(swapRouter, bal);
            ISwapRouter02(swapRouter).exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: tokens[i],
                    tokenOut: usdc,
                    fee: fee,
                    recipient: address(this),
                    amountIn: bal,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
        }
        out = IERC20(usdc).balanceOf(address(this)) - beforeUsdc;
        if (out < minUsdc) revert Slippage();
        if (out > 0) IERC20(usdc).safeTransfer(msg.sender, out);
        emit Sold(vault, msg.sender, shares, out);
    }

    function _skipped(address token, address[] calldata skip) internal pure returns (bool) {
        uint256 n = skip.length;
        for (uint256 i; i < n; ++i) {
            if (skip[i] == token) return true;
        }
        return false;
    }
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
    function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256 amountIn);
}

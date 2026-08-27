// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";
import {ISwapRouter02} from "./interfaces/ISwapRouter02.sol";
import {IFeeRouter} from "./interfaces/IFeeRouter.sol";
import {IReferralRegistry} from "./interfaces/IReferralRegistry.sol";

/// @title ReferralRouter
/// @notice Buy-side wrapper: USDC → launch token. If `code` resolves to a payout other than the
///         buyer, skims 5 bps of the USDC in (same dollars as 5% of the 1% pool fee) and pays it
///         immediately. Then swaps the rest through the live FeeRouter (or SwapRouter02 if unset).
///         Sells are not routed here. Empty / unknown / self codes do not skim.
/// @dev Collect on CrucibleLock cannot see who referred a given buy. This is the per-trade path.
contract ReferralRouter {
    uint16 public constant BPS_DENOM = 10_000;
    uint16 public constant REF_BPS = 5;

    address public owner;
    address public usdc;
    address public swapRouter;
    address public feeRouter;
    address public registry;

    uint256 private _unlocked = 1;

    event OwnerTransferred(address indexed previous, address indexed next);
    event FeeRouterSet(address indexed feeRouter);
    event SwapRouterSet(address indexed router);
    event RegistrySet(address indexed registry);
    event ReferralPaid(
        string code, address indexed payout, address indexed token, uint256 usdcCut, uint256 amountIn
    );

    error NotOwner();
    error ZeroAddress();
    error ZeroIn();
    error Reentrancy();
    error TransferFailed();
    error ApproveFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_unlocked != 1) revert Reentrancy();
        _unlocked = 0;
        _;
        _unlocked = 1;
    }

    constructor(address usdc_, address swapRouter_, address feeRouter_, address registry_) {
        if (usdc_ == address(0) || swapRouter_ == address(0) || registry_ == address(0)) {
            revert ZeroAddress();
        }
        owner = msg.sender;
        usdc = usdc_;
        swapRouter = swapRouter_;
        feeRouter = feeRouter_;
        registry = registry_;
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, next);
        owner = next;
    }

    function setFeeRouter(address feeRouter_) external onlyOwner {
        feeRouter = feeRouter_;
        emit FeeRouterSet(feeRouter_);
    }

    function setSwapRouter(address router) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        swapRouter = router;
        emit SwapRouterSet(router);
    }

    function setRegistry(address registry_) external onlyOwner {
        if (registry_ == address(0)) revert ZeroAddress();
        registry = registry_;
        emit RegistrySet(registry_);
    }

    /// @notice Buy `tokenOut` with USDC. `amountOutMinimum` applies to the post-skim swap.
    function buy(
        address tokenOut,
        uint24 poolFee,
        uint256 amountIn,
        uint256 amountOutMinimum,
        string calldata code
    ) external nonReentrant returns (uint256 amountOut) {
        if (tokenOut == address(0)) revert ZeroAddress();
        if (amountIn == 0) revert ZeroIn();

        _pull(usdc, msg.sender, amountIn);

        uint256 cut;
        address payout;
        if (bytes(code).length != 0) {
            payout = IReferralRegistry(registry).payoutOf(code);
            if (payout != address(0) && payout != msg.sender) {
                cut = (amountIn * REF_BPS) / BPS_DENOM;
                if (cut > 0) _pay(usdc, payout, cut);
            } else {
                payout = address(0);
            }
        }

        uint256 swapIn = amountIn - cut;
        if (swapIn == 0) revert ZeroIn();

        uint256 userBefore = IERC20Minimal(tokenOut).balanceOf(msg.sender);
        _swap(tokenOut, poolFee, swapIn, amountOutMinimum);
        amountOut = IERC20Minimal(tokenOut).balanceOf(msg.sender) - userBefore;

        emit ReferralPaid(code, payout, tokenOut, cut, amountIn);
    }

    function _swap(address tokenOut, uint24 poolFee, uint256 swapIn, uint256 minOut) internal {
        address fee = feeRouter;
        if (fee != address(0)) {
            uint256 hereBefore = IERC20Minimal(tokenOut).balanceOf(address(this));
            _approveMax(usdc, fee, swapIn);
            IFeeRouter(fee).swapExactInput(swapRouter, usdc, tokenOut, poolFee, swapIn, minOut);
            uint256 got = IERC20Minimal(tokenOut).balanceOf(address(this)) - hereBefore;
            if (got > 0) _pay(tokenOut, msg.sender, got);
            return;
        }
        _approveMax(usdc, swapRouter, swapIn);
        ISwapRouter02(swapRouter).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: usdc,
                tokenOut: tokenOut,
                fee: poolFee,
                recipient: msg.sender,
                amountIn: swapIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function _pull(address token, address from, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, address(this), amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _pay(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _approveMax(address token, address spender, uint256 needed) internal {
        uint256 allowance = IERC20Minimal(token).allowance(address(this), spender);
        if (allowance >= needed) return;
        if (allowance != 0) _approve(token, spender, 0);
        _approve(token, spender, type(uint256).max);
    }

    function _approve(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20Minimal.approve.selector, spender, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert ApproveFailed();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";
import {ISwapRouter02} from "./interfaces/ISwapRouter02.sol";

/// @title Crucible
/// @notice Holds quote-side Crucible USDC and, once `$ARCFUN` is set, cooks it:
///         USDC → ARCFUN on SwapRouter02, ARCFUN to `0x…dead`. Burn tape event is `Burn`.
/// @dev `$ARCFUN` is not launched yet. While `arcfun == address(0)` USDC is HELD here —
///      cook() reverts, nothing is bought, nothing is sent to dead.
///      `setArcfun` is one-shot. cook is never called from collect; a keeper passes minOut.
contract Crucible {
    address public owner;
    address public usdc;
    address public swapRouter;
    address public arcfun;
    uint24 public arcfunPoolFee;
    bool public cookPaused;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint256 private _unlocked = 1;

    event OwnerTransferred(address indexed previous, address indexed next);
    event ArcfunSet(address indexed token);
    event ArcfunPoolFeeSet(uint24 fee);
    event CookPausedSet(bool paused);
    event SwapRouterSet(address indexed router);
    /// @notice Burn tape row. `token` is the ARCFUN that was bought and sent to dead.
    event Burn(address indexed token, uint256 usdcIn, uint256 arcfunOut, uint256 ts);

    error NotOwner();
    error ZeroAddress();
    error ArcfunUnset();
    error ArcfunAlreadySet();
    error ZeroFee();
    error ZeroMinOut();
    error InsufficientUsdc();
    error CookIsPaused();
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

    constructor(address usdc_, address swapRouter_, uint24 arcfunPoolFee_) {
        if (usdc_ == address(0) || swapRouter_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        usdc = usdc_;
        swapRouter = swapRouter_;
        arcfunPoolFee = arcfunPoolFee_ == 0 ? 10_000 : arcfunPoolFee_;
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, next);
        owner = next;
    }

    /// @notice One-shot. Points the burn target. Cannot unset or repoint.
    function setArcfun(address token) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (arcfun != address(0)) revert ArcfunAlreadySet();
        arcfun = token;
        emit ArcfunSet(token);
    }

    function setArcfunPoolFee(uint24 fee) external onlyOwner {
        if (fee == 0) revert ZeroFee();
        arcfunPoolFee = fee;
        emit ArcfunPoolFeeSet(fee);
    }

    /// @notice Rotate the router and revoke the old one's USDC allowance.
    function setSwapRouter(address router) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        address old = swapRouter;
        if (old != router) _approve(usdc, old, 0);
        swapRouter = router;
        emit SwapRouterSet(router);
    }

    function setCookPaused(bool paused) external onlyOwner {
        cookPaused = paused;
        emit CookPausedSet(paused);
    }

    /// @notice Permissionless. Swaps `amountIn` USDC for ARCFUN and sends it to dead.
    ///         Reverts while `arcfun` is unset or cook is paused. `amountIn == 0` is a no-op.
    ///         `minArcfunOut` must be > 0 when swapping; there is no zero-slippage overload.
    function cook(uint256 amountIn, uint256 minArcfunOut) external returns (uint256 arcfunOut) {
        return _cook(amountIn, minArcfunOut);
    }

    function _cook(uint256 amountIn, uint256 minArcfunOut) internal nonReentrant returns (uint256 arcfunOut) {
        address token = arcfun;
        if (token == address(0)) revert ArcfunUnset();
        if (cookPaused) revert CookIsPaused();
        if (amountIn == 0) return 0;

        uint256 bal = IERC20Minimal(usdc).balanceOf(address(this));
        if (amountIn > bal) revert InsufficientUsdc();
        if (minArcfunOut == 0) revert ZeroMinOut();

        _approveMax(usdc, swapRouter, amountIn);

        arcfunOut = ISwapRouter02(swapRouter).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: usdc,
                tokenOut: token,
                fee: arcfunPoolFee,
                recipient: DEAD,
                amountIn: amountIn,
                amountOutMinimum: minArcfunOut,
                sqrtPriceLimitX96: 0
            })
        );

        emit Burn(token, amountIn, arcfunOut, block.timestamp);
    }

    function _approveMax(address token, address spender, uint256 needed) internal {
        uint256 allowance = IERC20Minimal(token).allowance(address(this), spender);
        if (allowance >= needed) return;
        if (allowance != 0) {
            _approve(token, spender, 0);
        }
        _approve(token, spender, type(uint256).max);
    }

    function _approve(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20Minimal.approve.selector, spender, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert ApproveFailed();
    }
}

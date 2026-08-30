// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";
import {ISwapRouter02} from "./interfaces/ISwapRouter02.sol";

/// @title Crucible
/// @notice Holds quote-side Crucible USDC and cooks it: USDC → `$EVE` on SwapRouter02,
///         `$EVE` to `0x…dead`. Burn tape event is `Burn`.
/// @dev The burn target is `$EVE` and is fixed at construction. It was previously a one-shot
///      `setArcfun` setter, which existed only because the protocol token did not exist yet when
///      this was written. It does now (`0x19209E55049bc613c5cC8b66B7DF7824096e78CF`), so the
///      setter is gone: an immutable cannot be pointed at the wrong token by a mistaken or
///      compromised owner call, and there is no window in which USDC accrues against an unset
///      target. Same shape as EveBurn. Use `cookPaused` to stop cooking.
///      cook is never called from collect; a keeper passes minOut.
contract Crucible {
    address public owner;
    address public usdc;
    address public swapRouter;
    address public immutable eve;
    uint24 public evePoolFee;
    bool public cookPaused;

    /// @notice Addresses allowed to execute the swap. The owner is always allowed.
    mapping(address => bool) public keepers;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint256 private _unlocked = 1;

    event OwnerTransferred(address indexed previous, address indexed next);
    event EvePoolFeeSet(uint24 fee);
    event CookPausedSet(bool paused);
    event KeeperSet(address indexed keeper, bool allowed);
    event SwapRouterSet(address indexed router);
    /// @notice Burn tape row. `token` is the ARCFUN that was bought and sent to dead.
    event Burn(address indexed token, uint256 usdcIn, uint256 eveOut, uint256 ts);

    error NotOwner();
    error NotKeeper();
    error ZeroAddress();
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

    /// @dev Swap execution is keeper-gated. `minEveOut` is supplied by the caller, so leaving
    ///      this open let anyone pass 1 and accept a manipulated price — the ZeroMinOut guard only
    ///      rejects a literal zero. A caller-chosen bound cannot protect against the caller.
    modifier onlyKeeper() {
        if (msg.sender != owner && !keepers[msg.sender]) revert NotKeeper();
        _;
    }

    modifier nonReentrant() {
        if (_unlocked != 1) revert Reentrancy();
        _unlocked = 0;
        _;
        _unlocked = 1;
    }

    constructor(address usdc_, address swapRouter_, address eve_, uint24 evePoolFee_) {
        if (usdc_ == address(0) || swapRouter_ == address(0) || eve_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        usdc = usdc_;
        swapRouter = swapRouter_;
        eve = eve_;
        evePoolFee = evePoolFee_ == 0 ? 10_000 : evePoolFee_;
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, next);
        owner = next;
    }

    /// @notice One-shot. Points the burn target. Cannot unset or repoint.

    function setEvePoolFee(uint24 fee) external onlyOwner {
        if (fee == 0) revert ZeroFee();
        evePoolFee = fee;
        emit EvePoolFeeSet(fee);
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

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        if (keeper == address(0)) revert ZeroAddress();
        keepers[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    /// @notice Permissionless. Swaps `amountIn` USDC for ARCFUN and sends it to dead.
    ///         Reverts while cook is paused. `amountIn == 0` is a no-op.
    ///         `minEveOut` must be > 0 when swapping; there is no zero-slippage overload.
    function cook(uint256 amountIn, uint256 minEveOut) external onlyKeeper returns (uint256 eveOut) {
        return _cook(amountIn, minEveOut);
    }

    function _cook(uint256 amountIn, uint256 minEveOut) internal nonReentrant returns (uint256 eveOut) {
        address token = eve;
        if (cookPaused) revert CookIsPaused();
        if (amountIn == 0) return 0;

        uint256 bal = IERC20Minimal(usdc).balanceOf(address(this));
        if (amountIn > bal) revert InsufficientUsdc();
        if (minEveOut == 0) revert ZeroMinOut();

        _approveMax(usdc, swapRouter, amountIn);

        eveOut = ISwapRouter02(swapRouter).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: usdc,
                tokenOut: token,
                fee: evePoolFee,
                recipient: DEAD,
                amountIn: amountIn,
                amountOutMinimum: minEveOut,
                sqrtPriceLimitX96: 0
            })
        );

        emit Burn(token, amountIn, eveOut, block.timestamp);
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

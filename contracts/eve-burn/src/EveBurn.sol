// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title EveBurn
/// @notice Holds Instant-creator USDC from @watch_eve launches, then cooks it:
///         USDC → $EVE on SwapRouter02, $EVE to `0x…dead`.
/// @dev Instant MonLock just ERC-20 transfers USDC here (no hook). A keeper must call cook.
contract EveBurn {
    address public owner;
    address public immutable usdc;
    address public immutable eve;
    address public swapRouter;
    uint24 public evePoolFee;
    bool public cookPaused;
    mapping(address => bool) public keepers;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 private _unlocked = 1;

    event OwnerTransferred(address indexed previous, address indexed next);
    event EvePoolFeeSet(uint24 fee);
    event CookPausedSet(bool paused);
    event KeeperSet(address indexed keeper, bool allowed);
    event SwapRouterSet(address indexed router);
    event Burn(address indexed token, uint256 usdcIn, uint256 eveOut, uint256 ts);

    error NotOwner();
    error NotKeeper();
    error ZeroAddress();
    error ZeroFee();
    error ZeroMinOut();
    error InsufficientUsdc();
    error CookIsPaused();
    error Reentrancy();
    error ApproveFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

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

    function setEvePoolFee(uint24 fee) external onlyOwner {
        if (fee == 0) revert ZeroFee();
        evePoolFee = fee;
        emit EvePoolFeeSet(fee);
    }

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

    function cook(uint256 amountIn, uint256 minEveOut) external onlyKeeper returns (uint256 eveOut) {
        if (cookPaused) revert CookIsPaused();
        if (amountIn == 0) return 0;
        uint256 bal = IERC20Minimal(usdc).balanceOf(address(this));
        if (amountIn > bal) revert InsufficientUsdc();
        if (minEveOut == 0) revert ZeroMinOut();

        _approveMax(usdc, swapRouter, amountIn);
        eveOut = ISwapRouter02(swapRouter).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: usdc,
                tokenOut: eve,
                fee: evePoolFee,
                recipient: DEAD,
                amountIn: amountIn,
                amountOutMinimum: minEveOut,
                sqrtPriceLimitX96: 0
            })
        );
        emit Burn(eve, amountIn, eveOut, block.timestamp);
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

interface IERC20Minimal {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
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
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

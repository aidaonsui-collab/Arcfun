// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {CurrencySettler} from "./libraries/CurrencySettler.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title EveV4Router
/// @notice Thin exact-in swapper for eve.fun Instant v4 pools. PoolSwapTest is not
///         a production router. Payer approves this contract; output goes to `recipient`.
contract EveV4Router is IUnlockCallback {
    using CurrencySettler for Currency;
    using SafeCast for int256;

    error NotManager();
    error ZeroAddress();
    error Slippage();
    error ZeroOut();

    IPoolManager public immutable poolManager;

    struct SwapCall {
        address payer;
        address recipient;
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
        uint256 minOut;
    }

    constructor(IPoolManager manager_) {
        if (address(manager_) == address(0)) revert ZeroAddress();
        poolManager = manager_;
    }

    function swapExactIn(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minOut, address recipient)
        external
        returns (uint256 amountOut)
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (amountIn == 0) revert ZeroOut();
        bytes memory result = poolManager.unlock(
            abi.encode(SwapCall({
                payer: msg.sender,
                recipient: recipient,
                key: key,
                zeroForOne: zeroForOne,
                amountIn: amountIn,
                minOut: minOut
            }))
        );
        amountOut = abi.decode(result, (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotManager();
        SwapCall memory c = abi.decode(data, (SwapCall));
        BalanceDelta d = poolManager.swap(
            c.key,
            SwapParams({
                zeroForOne: c.zeroForOne,
                amountSpecified: -int256(c.amountIn),
                sqrtPriceLimitX96: c.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int256 a0 = int256(d.amount0());
        int256 a1 = int256(d.amount1());
        if (a0 < 0) c.key.currency0.settle(poolManager, c.payer, uint256(-a0), false);
        if (a1 < 0) c.key.currency1.settle(poolManager, c.payer, uint256(-a1), false);
        uint256 amountOut;
        if (a0 > 0) {
            amountOut = a0.toUint256();
            c.key.currency0.take(poolManager, c.recipient, amountOut, false);
        }
        if (a1 > 0) {
            amountOut = a1.toUint256();
            c.key.currency1.take(poolManager, c.recipient, amountOut, false);
        }
        if (amountOut == 0) revert ZeroOut();
        if (amountOut < c.minOut) revert Slippage();
        return abi.encode(amountOut);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {EveFeeHook} from "./EveFeeHook.sol";
import {InstantAutoLp} from "./libraries/InstantAutoLp.sol";
import {VirtualQuote} from "./libraries/VirtualQuote.sol";

/// @notice Bytecode the USDC factory does not have room for under EIP-170.
///         `mintClaimed` is always `delegatecall`ed (so the position stays factory-owned).
///         `range` is a pure CALL (no `address(this)`). Do not CALL `mintClaimed`.
contract InstantAutoLpHelper {
    function range(bool tokenIsCurrency0, uint256 vq, int24 ts)
        external
        pure
        returns (int24 tickLower, int24 tickUpper, uint160 startSqrt)
    {
        tickLower = TickMath.minUsableTick(ts);
        tickUpper = TickMath.maxUsableTick(ts);
        if (vq == 0) {
            int24 startTick = tokenIsCurrency0 ? tickLower : tickUpper;
            return (tickLower, tickUpper, TickMath.getSqrtPriceAtTick(startTick));
        }

        uint160 idealSqrt = VirtualQuote.sqrtPriceX96(tokenIsCurrency0, vq, VirtualQuote.VIRTUAL_TOKEN_INIT);
        int24 idealTick = TickMath.getTickAtSqrtPrice(idealSqrt);
        if (idealTick <= tickLower) idealTick = tickLower + ts;
        if (idealTick >= tickUpper) idealTick = tickUpper - ts;

        if (tokenIsCurrency0) {
            tickLower = _floorToSpacing(idealTick, ts);
            if (tickUpper <= tickLower) tickUpper = tickLower + ts;
            startSqrt = TickMath.getSqrtPriceAtTick(tickLower);
        } else {
            tickUpper = _ceilToSpacing(idealTick, ts);
            if (tickUpper <= tickLower) tickLower = tickUpper - ts;
            startSqrt = TickMath.getSqrtPriceAtTick(tickUpper);
        }
    }

    function mintClaimed(
        IPoolManager manager,
        EveFeeHook hook,
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        uint256 claimed0,
        uint256 claimed1
    ) external returns (uint128 liquidity) {
        return InstantAutoLp.mintClaimed(manager, hook, key, tickLower, tickUpper, claimed0, claimed1);
    }

    function _floorToSpacing(int24 tick, int24 ts) internal pure returns (int24) {
        int24 compressed = tick / ts;
        if (tick < 0 && tick % ts != 0) compressed--;
        return compressed * ts;
    }

    function _ceilToSpacing(int24 tick, int24 ts) internal pure returns (int24) {
        int24 floored = _floorToSpacing(tick, ts);
        return floored == tick ? tick : floored + ts;
    }
}

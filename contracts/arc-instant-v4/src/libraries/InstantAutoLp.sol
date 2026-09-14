// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {LiquidityAmounts} from "./LiquidityAmounts.sol";
import {CurrencySettler} from "./CurrencySettler.sol";
import {EveFeeHook} from "../EveFeeHook.sol";

/// @notice Shared auto-LP mint: spend claimed fee tokens sitting on `address(this)` into
///         the factory-owned position (same ticks / salt 0 as the create mint). Leftover
///         (wrong-side inventory at the current tick, or the excess of an in-range pair)
///         is restowed on the hook for the next flush.
///
///         `donate` is the wrong primitive here: these pools have LP fee 0, so donated
///         amounts become collectable fees instead of active liquidity. The only remove
///         is `burnPosition`, gated by the factory's 365-day platform reclaim.
library InstantAutoLp {
    using CurrencySettler for Currency;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using SafeCast for int256;

    function mintClaimed(
        IPoolManager manager,
        EveFeeHook hook,
        PoolKey memory key,
        int24 tickLower,
        int24 tickUpper,
        uint256 claimed0,
        uint256 claimed1
    ) internal returns (uint128 liquidity) {
        uint256 bal0 = key.currency0.balanceOfSelf();
        uint256 bal1 = key.currency1.balanceOfSelf();
        uint256 a0 = bal0 > claimed0 ? claimed0 : bal0;
        uint256 a1 = bal1 > claimed1 ? claimed1 : bal1;
        if (a0 == 0 && a1 == 0) return 0;
        uint256 keep0 = bal0 - a0;
        uint256 keep1 = bal1 - a1;

        (uint160 sqrtP,,,) = manager.getSlot0(key.toId());
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(tickUpper);
        liquidity = LiquidityAmounts.getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, a0, a1);
        if (liquidity == 0) {
            _restow(hook, key, a0, a1);
            return 0;
        }

        (BalanceDelta delta,) = manager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(0)
            }),
            ""
        );
        int256 d0 = int256(delta.amount0());
        int256 d1 = int256(delta.amount1());
        if (d0 < 0) key.currency0.settle(manager, address(this), (-d0).toUint256(), false);
        if (d1 < 0) key.currency1.settle(manager, address(this), (-d1).toUint256(), false);
        if (d0 > 0) key.currency0.take(manager, address(this), d0.toUint256(), false);
        if (d1 > 0) key.currency1.take(manager, address(this), d1.toUint256(), false);

        uint256 left0 = key.currency0.balanceOfSelf();
        uint256 left1 = key.currency1.balanceOfSelf();
        uint256 restow0 = left0 > keep0 ? left0 - keep0 : 0;
        uint256 restow1 = left1 > keep1 ? left1 - keep1 : 0;
        if (restow0 > 0 || restow1 > 0) _restow(hook, key, restow0, restow1);
    }

    /// @notice Pull the factory-owned position (same ticks / salt 0) and take both sides
    ///         to `recipient`. Must run via factory `delegatecall` so PoolManager attributes
    ///         the burn to the factory.
    function burnPosition(
        IPoolManager manager,
        PoolKey memory key,
        int24 tickLower,
        int24 tickUpper,
        address recipient
    ) internal returns (uint128 liquidity) {
        if (recipient == address(0)) return 0;
        (liquidity,,) = manager.getPositionInfo(key.toId(), address(this), tickLower, tickUpper, bytes32(0));
        if (liquidity == 0) return 0;

        (BalanceDelta delta,) = manager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: -int256(uint256(liquidity)),
                salt: bytes32(0)
            }),
            ""
        );
        int256 d0 = int256(delta.amount0());
        int256 d1 = int256(delta.amount1());
        if (d0 < 0) key.currency0.settle(manager, address(this), (-d0).toUint256(), false);
        if (d1 < 0) key.currency1.settle(manager, address(this), (-d1).toUint256(), false);
        if (d0 > 0) key.currency0.take(manager, recipient, d0.toUint256(), false);
        if (d1 > 0) key.currency1.take(manager, recipient, d1.toUint256(), false);
    }

    function _restow(EveFeeHook hook, PoolKey memory key, uint256 a0, uint256 a1) private {
        if (a0 > 0) {
            key.currency0.transfer(address(hook), a0);
            hook.creditAutoLp(key, key.currency0, a0);
        }
        if (a1 > 0) {
            key.currency1.transfer(address(hook), a1);
            hook.creditAutoLp(key, key.currency1, a1);
        }
    }
}

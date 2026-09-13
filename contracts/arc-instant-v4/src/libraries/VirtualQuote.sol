// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "v4-core/libraries/FullMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Same sqrt-price encoding Instant V3 uses (`BondingCurveDexSeed.sqrtPriceX96`):
///         `launchVirtualQuote` raw quote units vs `VIRTUAL_TOKEN_INIT` raw token units.
library VirtualQuote {
    /// @dev Matches InstantErc20QuoteFactory.VIRTUAL_TOKEN_INIT (18dp).
    uint256 internal constant VIRTUAL_TOKEN_INIT = 1_066_666_666_666_666_666_666_666_666;

    function sqrtPriceX96(bool launchIsToken0, uint256 vQuote, uint256 vToken) internal pure returns (uint160) {
        (uint256 num, uint256 den) = launchIsToken0 ? (vQuote, vToken) : (vToken, vQuote);
        uint256 ratioX192 = FullMath.mulDiv(num, uint256(1) << 192, den);
        uint256 s = Math.sqrt(ratioX192);
        require(s > 0 && s <= type(uint160).max, "sqrt");
        return uint160(s);
    }
}

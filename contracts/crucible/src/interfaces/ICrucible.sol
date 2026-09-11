// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface ICrucible {
    function eve() external view returns (address);
    function cookPaused() external view returns (bool);
    function cook(uint256 amountIn, uint256 minEveOut) external returns (uint256 eveOut);
}

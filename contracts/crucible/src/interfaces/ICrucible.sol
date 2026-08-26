// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface ICrucible {
    function arcfun() external view returns (address);
    function cookPaused() external view returns (bool);
    function cook(uint256 amountIn, uint256 minArcfunOut) external returns (uint256 arcfunOut);
}

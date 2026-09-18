// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IReferralRegistry {
    function isRegisteredPayout(address payout) external view returns (bool);
    function payoutOf(string calldata code) external view returns (address);
    function payoutOfHash(bytes32 codeHash) external view returns (address);
}

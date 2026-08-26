// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ReferralRegistry
/// @notice Public first-come referral codes → payout wallets.
///         Codes are opaque strings (https://www.arcfun.co/r/{code}), never 0x addresses.
contract ReferralRegistry {
    struct Code {
        address owner;
        address payout;
    }

    mapping(bytes32 => Code) public codes;
    mapping(address => uint256) public payoutRefs;

    event Registered(bytes32 indexed codeHash, string code, address indexed owner, address indexed payout);
    event PayoutRotated(bytes32 indexed codeHash, address indexed oldPayout, address indexed newPayout);

    error EmptyCode();
    error CodeTooLong();
    error CodeLooksLikeAddress();
    error BadCharset();
    error Taken();
    error ZeroAddress();
    error NotOwner();
    error SamePayout();

    uint256 public constant MAX_CODE_LEN = 32;

    function codeHash(string memory code) public pure returns (bytes32) {
        return keccak256(bytes(code));
    }

    function register(string calldata code, address payout) external {
        if (payout == address(0)) revert ZeroAddress();
        _validateCode(code);
        bytes32 h = keccak256(bytes(code));
        if (codes[h].owner != address(0)) revert Taken();
        codes[h] = Code({owner: msg.sender, payout: payout});
        unchecked {
            payoutRefs[payout] += 1;
        }
        emit Registered(h, code, msg.sender, payout);
    }

    function rotatePayout(string calldata code, address newPayout) external {
        if (newPayout == address(0)) revert ZeroAddress();
        bytes32 h = keccak256(bytes(code));
        Code storage c = codes[h];
        if (c.owner != msg.sender) revert NotOwner();
        address old = c.payout;
        if (old == newPayout) revert SamePayout();
        c.payout = newPayout;
        unchecked {
            payoutRefs[old] -= 1;
            payoutRefs[newPayout] += 1;
        }
        emit PayoutRotated(h, old, newPayout);
    }

    function payoutOf(string calldata code) external view returns (address) {
        return codes[keccak256(bytes(code))].payout;
    }

    function ownerOf(string calldata code) external view returns (address) {
        return codes[keccak256(bytes(code))].owner;
    }

    function isRegisteredPayout(address payout) public view returns (bool) {
        return payout != address(0) && payoutRefs[payout] > 0;
    }

    function _validateCode(string calldata code) internal pure {
        bytes memory b = bytes(code);
        uint256 n = b.length;
        if (n == 0) revert EmptyCode();
        if (n > MAX_CODE_LEN) revert CodeTooLong();
        if (_looksLikeAddress(b)) revert CodeLooksLikeAddress();
        for (uint256 i; i < n; ++i) {
            bytes1 ch = b[i];
            bool ok = (ch >= 0x30 && ch <= 0x39) // 0-9
                || (ch >= 0x41 && ch <= 0x5A) // A-Z
                || (ch >= 0x61 && ch <= 0x7A) // a-z
                || ch == 0x5F // _
                || ch == 0x2D; // -
            if (!ok) revert BadCharset();
        }
    }

    function _looksLikeAddress(bytes memory b) internal pure returns (bool) {
        // Codes are never 0x-prefixed. A full 20-byte address is 42 chars (blocked by MAX_CODE_LEN),
        // but a truncated `0x` + hex string must not sneak in either.
        if (b.length < 2) return false;
        return b[0] == 0x30 && (b[1] == 0x78 || b[1] == 0x58);
    }
}

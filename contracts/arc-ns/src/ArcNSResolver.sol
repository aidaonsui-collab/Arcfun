// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @title ArcNSResolver
/// @notice Forward (label -> address), reverse (address -> primary label), and simple text
///         records for ArcNS names. Deliberately not a full ENS-style pluggable-per-name resolver
///         registry — there's one resolver, it asks ArcNS who currently owns a label, and that's
///         the only authorization check anywhere in this contract.
///
///         Reverse resolution isn't the ENS `addr.reverse` node-tree trick (that exists to let an
///         *unprivileged* reverse-record claim happen before you own any forward name — not
///         needed here, since setting a primary name already requires owning that exact name).
contract ArcNSResolver {
    IERC721 public immutable registry;

    error NotNameOwner();
    error NotRegistered();

    mapping(uint256 => address) public addrOf; // labelhash -> resolved address
    mapping(address => string) public primaryLabel; // address -> label it displays as
    mapping(uint256 => mapping(string => string)) public textOf; // labelhash -> key -> value

    event AddrSet(uint256 indexed tokenId, address indexed addr);
    event PrimarySet(address indexed addr, string label);
    event TextSet(uint256 indexed tokenId, string key, string value);

    constructor(address registry_) {
        registry = IERC721(registry_);
    }

    function labelhash(string memory label) public pure returns (uint256) {
        return uint256(keccak256(bytes(label)));
    }

    function _requireNameOwner(uint256 tokenId) internal view {
        address o;
        try registry.ownerOf(tokenId) returns (address o_) {
            o = o_;
        } catch {
            revert NotRegistered();
        }
        if (o != msg.sender) revert NotNameOwner();
    }

    /// @notice Point `label` at an address. Only that name's current NFT owner may call this —
    ///         ownership is re-checked live against the registry every call, so a name that
    ///         changes hands (sale, expiry + re-registration) can't leave a stale resolution
    ///         behind pointing at the previous owner.
    function setAddr(string calldata label, address resolved) external {
        uint256 tokenId = labelhash(label);
        _requireNameOwner(tokenId);
        addrOf[tokenId] = resolved;
        emit AddrSet(tokenId, resolved);
    }

    function addr(string calldata label) external view returns (address) {
        return addrOf[labelhash(label)];
    }

    /// @notice Set the name that resolves back to msg.sender (shown in place of the raw address
    ///         across eve.fun — trade tape, leaderboard, profile). Caller must currently own the
    ///         label they're claiming as their reverse record.
    function setPrimaryName(string calldata label) external {
        uint256 tokenId = labelhash(label);
        _requireNameOwner(tokenId);
        primaryLabel[msg.sender] = label;
        emit PrimarySet(msg.sender, label);
    }

    function clearPrimaryName() external {
        delete primaryLabel[msg.sender];
        emit PrimarySet(msg.sender, "");
    }

    /// @notice Reverse lookup, with the ownership check re-applied at read time: if `addr` no
    ///         longer owns the name it once set as primary (sold it, let it lapse), this returns
    ///         empty rather than a stale name that isn't really theirs anymore.
    function nameOf(address addr_) external view returns (string memory) {
        string memory label = primaryLabel[addr_];
        if (bytes(label).length == 0) return "";
        uint256 tokenId = labelhash(label);
        address o;
        try registry.ownerOf(tokenId) returns (address o_) {
            o = o_;
        } catch {
            return "";
        }
        if (o != addr_) return "";
        return label;
    }

    function setText(string calldata label, string calldata key, string calldata value) external {
        uint256 tokenId = labelhash(label);
        _requireNameOwner(tokenId);
        textOf[tokenId][key] = value;
        emit TextSet(tokenId, key, value);
    }

    function text(string calldata label, string calldata key) external view returns (string memory) {
        return textOf[labelhash(label)][key];
    }
}

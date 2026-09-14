// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IHolderSinkNotify {
    function onTransfer(address from, address to, uint256 amount) external;
}

/// @title LaunchToken18Tracked
/// @notice Same 1B / 18dp Instant token as LaunchToken18, plus a one-time sink so
///         HolderSink can checkpoint balances on transfer. No tax. Used only when
///         a launch allocates a holders slice.
contract LaunchToken18Tracked is ERC20 {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;

    address public immutable factory;
    address public sink;

    error NotFactory();
    error SinkSet();
    error ZeroAddress();

    constructor(string memory name_, string memory symbol_, address factory_) ERC20(name_, symbol_) {
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        _mint(factory_, TOTAL_SUPPLY);
    }

    function setSink(address sink_) external {
        if (msg.sender != factory) revert NotFactory();
        if (sink != address(0)) revert SinkSet();
        if (sink_ == address(0)) revert ZeroAddress();
        sink = sink_;
    }

    function _update(address from, address to, uint256 value) internal override {
        address s = sink;
        if (s != address(0) && value > 0) {
            IHolderSinkNotify(s).onTransfer(from, to, value);
        }
        super._update(from, to, value);
    }
}

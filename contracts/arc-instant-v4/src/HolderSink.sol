// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {EveFeeHook} from "./EveFeeHook.sol";

/// @title HolderSink
/// @notice Per-token destination for the holders slice of EveFeeHook. `distribute()`
///         pulls `owed` from the hook and accrues per eligible token. `claim()` is
///         pull-based. LaunchToken18Tracked notifies `onTransfer` so debt stays
///         correct across transfers. PoolManager / hook / factory / dead / this
///         contract are excluded from the eligible supply (LP + protocol balances
///         do not earn).
contract HolderSink {
    uint256 public constant SCALE = 1e18;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    error NotToken();
    error ZeroAddress();

    event Distributed(Currency indexed currency, uint256 amount, uint256 eligible);
    event Claimed(address indexed user, Currency indexed currency, uint256 amount);

    EveFeeHook public immutable hook;
    IERC20 public immutable token;
    address public immutable factory;
    Currency public immutable launch;
    Currency public immutable quote;

    mapping(Currency => uint256) public accPerShare;
    mapping(address => mapping(Currency => uint256)) public debt;
    mapping(address => mapping(Currency => uint256)) public unclaimed;

    constructor(EveFeeHook hook_, IERC20 token_, address quote_, address factory_) {
        if (address(hook_) == address(0) || address(token_) == address(0) || quote_ == address(0) || factory_ == address(0)) {
            revert ZeroAddress();
        }
        hook = hook_;
        token = token_;
        factory = factory_;
        launch = Currency.wrap(address(token_));
        quote = Currency.wrap(quote_);
    }

    function onTransfer(address from, address to, uint256 amount) external {
        if (msg.sender != address(token)) revert NotToken();
        // Called by LaunchToken18Tracked *before* balances change.
        _checkpoint(from, _bal(from));
        _checkpoint(to, _bal(to));
        if (from != address(0) && !_excluded(from)) {
            uint256 next = _bal(from) - amount;
            debt[from][launch] = (next * accPerShare[launch]) / SCALE;
            debt[from][quote] = (next * accPerShare[quote]) / SCALE;
        }
        if (to != address(0) && !_excluded(to)) {
            uint256 next = _bal(to) + amount;
            debt[to][launch] = (next * accPerShare[launch]) / SCALE;
            debt[to][quote] = (next * accPerShare[quote]) / SCALE;
        }
    }

    function distribute() external returns (uint256 launchAmt, uint256 quoteAmt) {
        launchAmt = _distribute(launch);
        quoteAmt = _distribute(quote);
    }

    function distribute(Currency currency) public returns (uint256 amount) {
        return _distribute(currency);
    }

    function claim() external returns (uint256 launchAmt, uint256 quoteAmt) {
        launchAmt = _claim(msg.sender, launch);
        quoteAmt = _claim(msg.sender, quote);
    }

    function claim(Currency currency) external returns (uint256 amount) {
        return _claim(msg.sender, currency);
    }

    function preview(address user) external view returns (uint256 launchAmt, uint256 quoteAmt) {
        launchAmt = _pending(user, launch, _bal(user));
        quoteAmt = _pending(user, quote, _bal(user));
    }

    function eligibleSupply() public view returns (uint256) {
        uint256 ts = token.totalSupply();
        uint256 ex = _excludedBalance();
        return ts > ex ? ts - ex : 0;
    }

    function _distribute(Currency currency) internal returns (uint256 amount) {
        amount = hook.withdraw(currency);
        if (amount == 0) return 0;
        uint256 elig = eligibleSupply();
        if (elig == 0) {
            emit Distributed(currency, amount, 0);
            return amount;
        }
        accPerShare[currency] += (amount * SCALE) / elig;
        emit Distributed(currency, amount, elig);
    }

    function _claim(address user, Currency currency) internal returns (uint256 amount) {
        _checkpoint(user, _bal(user));
        amount = unclaimed[user][currency];
        if (amount == 0) return 0;
        unclaimed[user][currency] = 0;
        currency.transfer(user, amount);
        emit Claimed(user, currency, amount);
    }

    function _checkpoint(address user, uint256 bal) internal {
        if (user == address(0) || _excluded(user)) return;
        unclaimed[user][launch] += _pending(user, launch, bal);
        debt[user][launch] = (bal * accPerShare[launch]) / SCALE;
        unclaimed[user][quote] += _pending(user, quote, bal);
        debt[user][quote] = (bal * accPerShare[quote]) / SCALE;
    }

    function _pending(address user, Currency currency, uint256 bal) internal view returns (uint256) {
        if (user == address(0) || _excluded(user)) return unclaimed[user][currency];
        uint256 accrued = (bal * accPerShare[currency]) / SCALE;
        uint256 d = debt[user][currency];
        uint256 extra = accrued > d ? accrued - d : 0;
        return unclaimed[user][currency] + extra;
    }

    function _bal(address a) internal view returns (uint256) {
        if (a == address(0)) return 0;
        return token.balanceOf(a);
    }

    function _excluded(address a) internal view returns (bool) {
        return a == DEAD || a == factory || a == address(this) || a == address(hook)
            || a == address(hook.poolManager());
    }

    function _excludedBalance() internal view returns (uint256 n) {
        n += token.balanceOf(DEAD);
        n += token.balanceOf(factory);
        n += token.balanceOf(address(this));
        n += token.balanceOf(address(hook));
        n += token.balanceOf(address(hook.poolManager()));
    }
}

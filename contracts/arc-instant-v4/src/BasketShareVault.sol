// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title BasketShareVault
/// @notice ERC-20 share backed by a fixed amount of each asset. Prices move the
///         percentage mix. The tokens inside do not rebalance.
///
///         A mint pulls the backing, rounded up, plus an owner fee and a protocol
///         fee on each asset. A redeem pays the backing, rounded down, minus those
///         fees. Holder backing, the owner's treasury, and protocol fees are
///         separate. The owner cannot withdraw holder backing.
///
///         The share is 18 decimals and can be the Instant quote. The pool holds
///         the share. The assets stay here.
contract BasketShareVault is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MIN_LEGS = 2;
    uint256 public constant MAX_LEGS = 3;
    uint16 public constant MAX_FEE_BPS = 100;
    uint16 public constant PROTOCOL_MINT_FEE_BPS = 35;
    uint16 public constant PROTOCOL_REDEEM_FEE_BPS = 20;
    /// @dev 0.001 share. Small mints make the round-up dominate.
    uint256 public constant MIN_MINT = 0.001 ether;
    uint256 public constant MAX_ACCRETE_STEP_BPS = 50;
    uint256 public constant HOUR = 1 hours;
    /// @dev Redemption cannot be configured below 10% of supply per hour.
    uint256 public constant MIN_REDEEM_PCT_BPS = 1_000;
    uint256 public constant FORCE_EXCLUDE_DELAY = 1 days;

    address public immutable owner;
    address public immutable protocolFeeRecipient;
    uint16 public mintFeeBps;
    uint16 public redeemFeeBps;
    bool public paused;

    address[] private _legs;
    mapping(address => uint256) public unitsPerShare;
    mapping(address => uint256) public backing;
    mapping(address => uint256) public treasury;
    mapping(address => uint256) public protocolFees;
    mapping(address => uint256) public forfeited;
    mapping(address => bool) public excluded;
    mapping(address => uint256) public deathProbedAt;

    /// @dev 0 on an axis means that axis is unlimited. Redeem is never tighter than 10% of supply per hour.
    uint128 public issuanceAmtRate;
    uint128 public issuancePctBps;
    uint128 public redeemAmtRate;
    uint128 public redeemPctBps;
    uint256 public issuanceUsed;
    uint256 public issuanceRefreshedAt;
    uint256 public redeemUsed;
    uint256 public redeemRefreshedAt;

    error BadRecipe();
    error FeeTooHigh();
    error NotOwner();
    error ZeroAmount();
    error FeeOnTransfer();
    error ShortBacking();
    error Paused();
    error Throttled();
    error ThrottleTooLow();
    error NotALeg();
    error StillAlive();
    error TooSoon();

    event Minted(address indexed minter, address indexed to, uint256 shares);
    event Redeemed(address indexed redeemer, address indexed to, uint256 shares);
    event TreasuryWithdrawn(address indexed token, uint256 amount);
    event ProtocolFeesSwept(address indexed token, uint256 amount);
    event Accreted(address indexed token, uint256 unitsDelta, uint256 assets);
    event FeesSet(uint16 mintFeeBps, uint16 redeemFeeBps);
    event PausedSet(bool paused);
    event ThrottlesSet(uint128 issuanceAmt, uint128 issuancePct, uint128 redeemAmt, uint128 redeemPct);
    event Excluded(address indexed token);
    event Restored(address indexed token, uint256 units);
    event Probed(address indexed token);
    event Resynced(address indexed token, uint256 balance, uint256 booked);

    constructor(
        string memory name_,
        string memory symbol_,
        address owner_,
        address protocolFeeRecipient_,
        address[] memory tokens,
        uint256[] memory units,
        uint16 mintFeeBps_,
        uint16 redeemFeeBps_
    ) ERC20(name_, symbol_) {
        if (owner_ == address(0) || protocolFeeRecipient_ == address(0)) revert BadRecipe();
        if (mintFeeBps_ > MAX_FEE_BPS || redeemFeeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        uint256 n = tokens.length;
        if (n != units.length || n < MIN_LEGS || n > MAX_LEGS) revert BadRecipe();
        for (uint256 i; i < n; ++i) {
            address token = tokens[i];
            uint256 unit = units[i];
            if (token == address(0) || token == address(this) || unit == 0 || unitsPerShare[token] != 0) {
                revert BadRecipe();
            }
            unitsPerShare[token] = unit;
            _legs.push(token);
        }
        owner = owner_;
        protocolFeeRecipient = protocolFeeRecipient_;
        mintFeeBps = mintFeeBps_;
        redeemFeeBps = redeemFeeBps_;
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function legs() external view returns (address[] memory) {
        return _legs;
    }

    /// @notice Assets a mint will pull, including owner and protocol fees. Excluded legs are zero.
    function previewMint(uint256 shares) external view returns (address[] memory tokens, uint256[] memory required) {
        uint256 n = _legs.length;
        tokens = _legs;
        required = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            address token = _legs[i];
            if (excluded[token] || unitsPerShare[token] == 0) continue;
            uint256 base = _ceilDiv(shares * unitsPerShare[token], 1 ether);
            required[i] = base + _ceilDiv(base * mintFeeBps, 10_000) + _ceilDiv(base * PROTOCOL_MINT_FEE_BPS, 10_000);
        }
    }

    /// @notice Pull backing plus fees for `shares` and mint them to `to`.
    function mint(uint256 shares, address to) external nonReentrant {
        if (paused) revert Paused();
        if (shares < MIN_MINT || to == address(0)) revert ZeroAmount();
        _consume(true, shares);
        uint256 n = _legs.length;
        for (uint256 i; i < n; ++i) {
            address token = _legs[i];
            if (excluded[token] || unitsPerShare[token] == 0) continue;
            uint256 base = _ceilDiv(shares * unitsPerShare[token], 1 ether);
            uint256 ownerFee = _ceilDiv(base * mintFeeBps, 10_000);
            uint256 protocolFee = _ceilDiv(base * PROTOCOL_MINT_FEE_BPS, 10_000);
            _pull(token, base + ownerFee + protocolFee);
            backing[token] += base;
            treasury[token] += ownerFee;
            protocolFees[token] += protocolFee;
        }
        _mint(to, shares);
        emit Minted(msg.sender, to, shares);
    }

    /// @notice Burn `shares` from the caller and pay each asset, after fees, to `to`.
    function redeem(uint256 shares, address to) external nonReentrant {
        _settle(shares, to, new address[](0));
    }

    /// @notice Redeem, but a listed leg is not transferred. Its backing is forfeited. No fee on that leg.
    function redeemExcluding(uint256 shares, address to, address[] calldata skip) external nonReentrant {
        _settle(shares, to, skip);
    }

    /// @notice Stop new mints. Redemption stays open.
    function setPaused(bool value) external {
        if (msg.sender != owner) revert NotOwner();
        paused = value;
        emit PausedSet(value);
    }

    /// @notice Hourly issuance and redemption budgets, in shares. A zero axis is unlimited.
    ///         Redemption percent cannot be set below 10% of supply per hour.
    function setThrottles(uint128 issuanceAmt, uint128 issuancePct, uint128 redeemAmt, uint128 redeemPct) external {
        if (msg.sender != owner) revert NotOwner();
        if (redeemPct != 0 && redeemPct < MIN_REDEEM_PCT_BPS) revert ThrottleTooLow();
        issuanceAmtRate = issuanceAmt;
        issuancePctBps = issuancePct;
        redeemAmtRate = redeemAmt;
        redeemPctBps = redeemPct;
        emit ThrottlesSet(issuanceAmt, issuancePct, redeemAmt, redeemPct);
    }

    /// @notice Record that `token` reverted on transfer. Anyone can exclude it a day later.
    function probeDead(address token) external {
        if (unitsPerShare[token] == 0 && !excluded[token]) revert NotALeg();
        (bool ok,) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, address(this), uint256(0)));
        if (ok) revert StillAlive();
        deathProbedAt[token] = block.timestamp;
        emit Probed(token);
    }

    /// @notice Owner can exclude a dead leg now. Anyone can after a failed probe has aged a day.
    function forceExclude(address token) external {
        if (!_isLeg(token)) revert NotALeg();
        if (msg.sender != owner) {
            uint256 probed = deathProbedAt[token];
            if (probed == 0 || block.timestamp < probed + FORCE_EXCLUDE_DELAY) revert TooSoon();
        }
        _exclude(token);
    }

    /// @notice Put an excluded leg back if it transfers again. Forfeited tokens become backing.
    function restore(address token) external {
        if (!excluded[token]) revert NotALeg();
        (bool ok,) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, address(this), uint256(0)));
        if (!ok) revert StillAlive();
        uint256 supply = totalSupply();
        uint256 amount = forfeited[token];
        uint256 units;
        if (supply >= 1 ether && amount > 0) {
            units = (amount * 1 ether) / supply;
            uint256 booked = (units * supply) / 1 ether;
            unitsPerShare[token] = units;
            backing[token] = booked;
            forfeited[token] = amount - booked;
        }
        excluded[token] = false;
        emit Restored(token, units);
    }

    /// @notice Match the books to the token balance. A deficit hits protocol fees, then the owner, then holders.
    ///         A surplus is forfeited value holders can get back through restore or a later redeem of that leg.
    function resync(address token) external {
        if (!_isLeg(token)) revert NotALeg();
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 booked = backing[token] + treasury[token] + protocolFees[token] + forfeited[token];
        if (bal > booked) forfeited[token] += bal - booked;
        else if (bal < booked) {
            uint256 deficit = booked - bal;
            deficit = _eat(token, deficit, 0);
            deficit = _eat(token, deficit, 1);
            deficit = _eat(token, deficit, 2);
            deficit = _eat(token, deficit, 3);
        }
        emit Resynced(token, bal, booked);
    }

    /// @notice Basket owner takes the owner-fee bucket. Holder backing stays.
    function withdrawTreasury(address token) external nonReentrant {
        if (msg.sender != owner) revert NotOwner();
        uint256 amount = treasury[token];
        if (amount == 0) revert ZeroAmount();
        treasury[token] = 0;
        IERC20(token).safeTransfer(owner, amount);
        emit TreasuryWithdrawn(token, amount);
    }

    /// @notice Anyone sends the protocol-fee bucket to the protocol recipient.
    function sweepProtocolFees(address token) external nonReentrant {
        uint256 amount = protocolFees[token];
        if (amount == 0) revert ZeroAmount();
        protocolFees[token] = 0;
        IERC20(token).safeTransfer(protocolFeeRecipient, amount);
        emit ProtocolFeesSwept(token, amount);
    }

    /// @notice Move owner fees into holder backing by raising units, at most 0.50% per call.
    function accrete(address token) external nonReentrant {
        uint256 supply = totalSupply();
        uint256 units = unitsPerShare[token];
        if (supply < 1 ether || units == 0) revert ZeroAmount();
        uint256 room = (units * MAX_ACCRETE_STEP_BPS) / 10_000;
        if (room == 0) revert ZeroAmount();
        uint256 pool = forfeited[token] + treasury[token];
        uint256 affordable = (pool * 1 ether) / supply;
        uint256 delta = affordable < room ? affordable : room;
        if (delta == 0) revert ZeroAmount();
        uint256 assets = (delta * supply) / 1 ether;
        uint256 fromForfeit = assets <= forfeited[token] ? assets : forfeited[token];
        forfeited[token] -= fromForfeit;
        treasury[token] -= assets - fromForfeit;
        backing[token] += assets;
        unitsPerShare[token] = units + delta;
        emit Accreted(token, delta, assets);
    }

    function setFees(uint16 mintFeeBps_, uint16 redeemFeeBps_) external {
        if (msg.sender != owner) revert NotOwner();
        if (mintFeeBps_ > MAX_FEE_BPS || redeemFeeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        mintFeeBps = mintFeeBps_;
        redeemFeeBps = redeemFeeBps_;
        emit FeesSet(mintFeeBps_, redeemFeeBps_);
    }

    function _settle(uint256 shares, address to, address[] memory skip) internal {
        if (shares == 0 || to == address(0)) revert ZeroAmount();
        _consume(false, shares);
        _burn(msg.sender, shares);
        uint256 supplyAfter = totalSupply();
        uint256 n = _legs.length;
        for (uint256 i; i < n; ++i) {
            address token = _legs[i];
            bool dead = excluded[token] || _skipped(token, skip);
            uint256 gross = supplyAfter == 0 ? backing[token] : (shares * unitsPerShare[token]) / 1 ether;
            if (gross > backing[token]) revert ShortBacking();
            if (dead) {
                backing[token] -= gross;
                forfeited[token] += gross;
                continue;
            }
            uint256 ownerFee = (gross * redeemFeeBps) / 10_000;
            uint256 protocolFee = (gross * PROTOCOL_REDEEM_FEE_BPS) / 10_000;
            uint256 payout = gross - ownerFee - protocolFee;
            backing[token] -= gross;
            treasury[token] += ownerFee;
            protocolFees[token] += protocolFee;
            if (payout > 0) IERC20(token).safeTransfer(to, payout);
        }
        emit Redeemed(msg.sender, to, shares);
    }

    function _consume(bool issuing, uint256 amount) internal {
        uint256 limit = issuing ? _configured(issuanceAmtRate, issuancePctBps) : _redeemLimit();
        if (limit == type(uint256).max) return;
        uint256 used = issuing ? issuanceUsed : redeemUsed;
        uint256 at = issuing ? issuanceRefreshedAt : redeemRefreshedAt;
        uint256 elapsed = block.timestamp - at;
        if (elapsed >= HOUR) used = 0;
        else if (used > 0) {
            uint256 refund = (used * elapsed) / HOUR;
            used = used > refund ? used - refund : 0;
        }
        if (used + amount > limit) revert Throttled();
        if (issuing) {
            issuanceUsed = used + amount;
            issuanceRefreshedAt = block.timestamp;
        } else {
            redeemUsed = used + amount;
            redeemRefreshedAt = block.timestamp;
        }
    }

    function _configured(uint128 amt, uint128 pct) internal view returns (uint256) {
        if (amt == 0 && pct == 0) return type(uint256).max;
        uint256 fromAmt = amt == 0 ? type(uint256).max : uint256(amt);
        uint256 fromPct = pct == 0 ? type(uint256).max : (totalSupply() * pct) / 10_000;
        return fromPct < fromAmt ? fromPct : fromAmt;
    }

    function _redeemLimit() internal view returns (uint256) {
        uint256 floor = totalSupply() / 10;
        uint256 cap = _configured(redeemAmtRate, redeemPctBps);
        if (cap == type(uint256).max) return cap;
        return cap < floor ? floor : cap;
    }

    function _exclude(address token) internal {
        if (!excluded[token]) {
            forfeited[token] += backing[token];
            backing[token] = 0;
            unitsPerShare[token] = 0;
            excluded[token] = true;
            emit Excluded(token);
        }
    }

    function _eat(address token, uint256 deficit, uint256 which) internal returns (uint256) {
        if (deficit == 0) return 0;
        uint256 bucket = which == 0 ? protocolFees[token] : which == 1 ? treasury[token] : which == 2 ? forfeited[token] : backing[token];
        uint256 take = deficit <= bucket ? deficit : bucket;
        if (which == 0) protocolFees[token] = bucket - take;
        else if (which == 1) treasury[token] = bucket - take;
        else if (which == 2) forfeited[token] = bucket - take;
        else backing[token] = bucket - take;
        return deficit - take;
    }

    function _isLeg(address token) internal view returns (bool) {
        uint256 n = _legs.length;
        for (uint256 i; i < n; ++i) {
            if (_legs[i] == token) return true;
        }
        return false;
    }

    function _skipped(address token, address[] memory skip) internal pure returns (bool) {
        uint256 n = skip.length;
        for (uint256 i; i < n; ++i) {
            if (skip[i] == token) return true;
        }
        return false;
    }

    function _pull(address token, uint256 amount) internal {
        if (amount == 0) return;
        IERC20 erc = IERC20(token);
        uint256 beforeBal = erc.balanceOf(address(this));
        erc.safeTransferFrom(msg.sender, address(this), amount);
        if (erc.balanceOf(address(this)) - beforeBal != amount) revert FeeOnTransfer();
    }

    function _ceilDiv(uint256 a, uint256 d) internal pure returns (uint256) {
        if (a == 0) return 0;
        return (a + d - 1) / d;
    }
}

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

    address public immutable owner;
    address public immutable protocolFeeRecipient;
    uint16 public mintFeeBps;
    uint16 public redeemFeeBps;

    address[] private _legs;
    mapping(address => uint256) public unitsPerShare;
    mapping(address => uint256) public backing;
    mapping(address => uint256) public treasury;
    mapping(address => uint256) public protocolFees;

    error BadRecipe();
    error FeeTooHigh();
    error NotOwner();
    error ZeroAmount();
    error FeeOnTransfer();
    error ShortBacking();

    event Minted(address indexed minter, address indexed to, uint256 shares);
    event Redeemed(address indexed redeemer, address indexed to, uint256 shares);
    event TreasuryWithdrawn(address indexed token, uint256 amount);
    event ProtocolFeesSwept(address indexed token, uint256 amount);
    event Accreted(address indexed token, uint256 unitsDelta, uint256 assets);
    event FeesSet(uint16 mintFeeBps, uint16 redeemFeeBps);

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

    /// @notice Pull backing plus fees for `shares` and mint them to `to`.
    function mint(uint256 shares, address to) external nonReentrant {
        if (shares < MIN_MINT || to == address(0)) revert ZeroAmount();
        uint256 n = _legs.length;
        for (uint256 i; i < n; ++i) {
            address token = _legs[i];
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
        if (shares == 0 || to == address(0)) revert ZeroAmount();
        _burn(msg.sender, shares);
        uint256 n = _legs.length;
        uint256 supplyAfter = totalSupply();
        for (uint256 i; i < n; ++i) {
            address token = _legs[i];
            uint256 gross = supplyAfter == 0 ? backing[token] : (shares * unitsPerShare[token]) / 1 ether;
            if (gross > backing[token]) revert ShortBacking();
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
        uint256 affordable = (treasury[token] * 1 ether) / supply;
        uint256 delta = affordable < room ? affordable : room;
        if (delta == 0) revert ZeroAmount();
        uint256 assets = (delta * supply) / 1 ether;
        treasury[token] -= assets;
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

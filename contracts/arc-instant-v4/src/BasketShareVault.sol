// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title BasketShareVault
/// @notice Fixed-recipe share token, two or three legs. Mint pulls a set amount of each leg. Redeem pays
///         pro-rata of whatever the vault holds. Seed shares stay locked here so redeem
///         cannot empty the recipe. No admin withdraw and no recipe edit.
///
///         The share is a normal 18-decimal ERC-20. Instant quotes it on the existing
///         RWA factory; the pool never holds the underlying stocks.
contract BasketShareVault is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MIN_LEGS = 2;
    uint256 public constant MAX_LEGS = 3;

    address public immutable creator;
    uint256 public immutable seedShares;
    uint256 public immutable shareCap;

    address[] private _legs;
    mapping(address => uint256) public unitsPerShare;
    bool public seeded;

    error BadRecipe();
    error NotCreator();
    error AlreadySeeded();
    error NotSeeded();
    error Cap();
    error SeedFloor();
    error ZeroAmount();
    error FeeOnTransfer();

    event Seeded(address indexed creator, uint256 seedShares);
    event Minted(address indexed minter, uint256 shares);
    event Redeemed(address indexed redeemer, uint256 shares);

    constructor(
        string memory name_,
        string memory symbol_,
        address creator_,
        address[] memory tokens,
        uint256[] memory units,
        uint256 seedShares_,
        uint256 shareCap_
    ) ERC20(name_, symbol_) {
        if (creator_ == address(0) || seedShares_ == 0) revert BadRecipe();
        if (shareCap_ < seedShares_) revert Cap();
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
        creator = creator_;
        seedShares = seedShares_;
        shareCap = shareCap_;
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function legs() external view returns (address[] memory) {
        return _legs;
    }

    /// @notice Pull the seed recipe and lock those shares in this contract.
    function seed() external nonReentrant {
        if (msg.sender != creator) revert NotCreator();
        if (seeded) revert AlreadySeeded();
        _pull(msg.sender, seedShares);
        _mint(address(this), seedShares);
        seeded = true;
        emit Seeded(msg.sender, seedShares);
    }

    /// @notice Pull `shares` times each leg and mint shares to the caller.
    function mint(uint256 shares) external nonReentrant {
        if (!seeded) revert NotSeeded();
        if (shares == 0) revert ZeroAmount();
        if (totalSupply() + shares > shareCap) revert Cap();
        _pull(msg.sender, shares);
        _mint(msg.sender, shares);
        emit Minted(msg.sender, shares);
    }

    /// @notice Burn shares and pay each leg pro-rata. Seed shares cannot be redeemed.
    function redeem(uint256 shares) external nonReentrant {
        if (shares == 0) revert ZeroAmount();
        uint256 supplyBefore = totalSupply();
        if (shares > supplyBefore || supplyBefore - shares < seedShares) revert SeedFloor();
        _burn(msg.sender, shares);
        uint256 n = _legs.length;
        for (uint256 i; i < n; ++i) {
            IERC20 token = IERC20(_legs[i]);
            uint256 bal = token.balanceOf(address(this));
            uint256 out = (bal * shares) / supplyBefore;
            if (out > 0) token.safeTransfer(msg.sender, out);
        }
        emit Redeemed(msg.sender, shares);
    }

    function _pull(address from, uint256 shares) internal {
        uint256 n = _legs.length;
        for (uint256 i; i < n; ++i) {
            IERC20 token = IERC20(_legs[i]);
            uint256 unit = unitsPerShare[address(token)];
            uint256 scaled = unit * shares;
            uint256 need = scaled / 1 ether;
            if (need == 0 || scaled % 1 ether != 0) revert ZeroAmount();
            uint256 beforeBal = token.balanceOf(address(this));
            token.safeTransferFrom(from, address(this), need);
            if (token.balanceOf(address(this)) - beforeBal != need) revert FeeOnTransfer();
        }
    }
}

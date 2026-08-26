// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ISwapRouter02} from "../../src/interfaces/ISwapRouter02.sol";
import {INonfungiblePositionManager} from "../../src/interfaces/INonfungiblePositionManager.sol";

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "ALLOW");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "BAL");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @notice Pays `amountOut = amountIn * outPerIn / 1e6` of tokenOut (USDC 6dp in → 18dp out at 1e12).
contract MockSwapRouter {
    uint256 public outPerIn = 1e18; // 1 USDC (1e6) → 1e18 token

    function setOutPerIn(uint256 v) external {
        outPerIn = v;
    }

    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut)
    {
        require(
            MockERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn),
            "IN"
        );
        amountOut = (params.amountIn * outPerIn) / 1e6;
        require(amountOut >= params.amountOutMinimum, "MIN");
        require(MockERC20(params.tokenOut).transfer(params.recipient, amountOut), "OUT");
    }
}

contract MockNFPM {
    struct Pos {
        address owner;
        address token0;
        address token1;
        uint24 fee;
        uint128 owed0;
        uint128 owed1;
        address operator;
    }

    mapping(uint256 => Pos) internal _pos;

    function mint(uint256 tokenId, address to, address token0, address token1, uint24 fee) external {
        _pos[tokenId] = Pos({
            owner: to,
            token0: token0,
            token1: token1,
            fee: fee,
            owed0: 0,
            owed1: 0,
            operator: address(0)
        });
    }

    function setOwed(uint256 tokenId, uint128 amount0, uint128 amount1) external {
        _pos[tokenId].owed0 = amount0;
        _pos[tokenId].owed1 = amount1;
    }

    function approve(address operator, uint256 tokenId) external {
        require(_pos[tokenId].owner == msg.sender, "NOT_OWNER");
        _pos[tokenId].operator = operator;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address o = _pos[tokenId].owner;
        require(o != address(0), "NONE");
        return o;
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        Pos storage p = _pos[tokenId];
        require(p.owner == from, "FROM");
        require(msg.sender == from || msg.sender == p.operator, "OP");
        p.owner = to;
        p.operator = address(0);
    }

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        Pos storage p = _pos[tokenId];
        return (0, p.operator, p.token0, p.token1, p.fee, -887200, 887200, 1, 0, 0, p.owed0, p.owed1);
    }

    function collect(INonfungiblePositionManager.CollectParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        Pos storage p = _pos[params.tokenId];
        require(p.owner == msg.sender, "NOT_OWNER");
        amount0 = p.owed0;
        amount1 = p.owed1;
        if (amount0 > params.amount0Max) amount0 = params.amount0Max;
        if (amount1 > params.amount1Max) amount1 = params.amount1Max;
        p.owed0 = 0;
        p.owed1 = 0;
        if (amount0 > 0) require(MockERC20(p.token0).transfer(params.recipient, amount0), "T0");
        if (amount1 > 0) require(MockERC20(p.token1).transfer(params.recipient, amount1), "T1");
    }
}

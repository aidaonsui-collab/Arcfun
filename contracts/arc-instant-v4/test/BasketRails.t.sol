// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BasketShareVault} from "../src/BasketShareVault.sol";
import {BasketVaultFactory} from "../src/BasketVaultFactory.sol";
import {BasketUsdcRouter, ISwapRouter02} from "../src/BasketUsdcRouter.sol";

contract RailLeg is ERC20 {
    bool public dead;

    constructor(string memory symbol_) ERC20(symbol_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function kill() external {
        dead = true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (dead) revert("dead");
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (dead) revert("dead");
        return super.transferFrom(from, to, amount);
    }
}

contract RailUsdc is ERC20 {
    constructor() ERC20("USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev 1e18 of a leg costs `usdcPerToken` base units of USDC.
contract MockDex {
    uint256 public immutable usdcPerToken;

    constructor(uint256 usdcPerToken_) {
        usdcPerToken = usdcPerToken_;
    }

    function exactOutputSingle(ISwapRouter02.ExactOutputSingleParams calldata p) external returns (uint256 amountIn) {
        amountIn = (p.amountOut * usdcPerToken) / 1 ether;
        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(p.tokenOut).transfer(p.recipient, p.amountOut);
    }

    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata p) external returns (uint256 amountOut) {
        amountOut = (p.amountIn * usdcPerToken) / 1 ether;
        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        IERC20(p.tokenOut).transfer(p.recipient, amountOut);
    }
}

contract BasketRailsTest is Test {
    BasketVaultFactory factory;
    BasketUsdcRouter router;
    RailUsdc usdc;
    RailLeg nvda;
    RailLeg aapl;
    MockDex dex;
    address creator = makeAddr("creator");
    address buyer = makeAddr("buyer");

    function setUp() public {
        usdc = new RailUsdc();
        dex = new MockDex(1e6);
        router = new BasketUsdcRouter(address(usdc), address(dex));
        factory = new BasketVaultFactory(makeAddr("protocol"));
        nvda = new RailLeg("NVDA");
        aapl = new RailLeg("AAPL");
        nvda.mint(address(dex), 1_000 ether);
        aapl.mint(address(dex), 1_000 ether);
        usdc.mint(buyer, 1_000_000e6);
        usdc.mint(address(dex), 1_000_000e6);
    }

    function _vault() internal returns (BasketShareVault vault) {
        address[] memory tokens = new address[](2);
        uint256[] memory units = new uint256[](2);
        tokens[0] = address(nvda);
        tokens[1] = address(aapl);
        units[0] = 1 ether;
        units[1] = 1 ether;
        vm.prank(creator);
        vault = factory.create("NA", "NA", tokens, units, 0, 0);
    }

    function testBuyExactAndSellForUsdc() public {
        BasketShareVault vault = _vault();
        vm.startPrank(buyer);
        usdc.approve(address(router), type(uint256).max);
        uint256 spent = router.buyExact(address(vault), 10 ether, 100e6, 3000, block.timestamp + 1 hours);
        assertEq(vault.balanceOf(buyer), 10 ether);
        assertGt(spent, 0);
        assertLt(spent, 100e6);

        vault.approve(address(router), type(uint256).max);
        uint256 out = router.sell(address(vault), 10 ether, 1, new address[](0), 3000, block.timestamp + 1 hours);
        vm.stopPrank();
        assertEq(vault.balanceOf(buyer), 0);
        assertGt(out, 0);
    }

    function testHourlyMintAndRedeemFloor() public {
        BasketShareVault vault = _vault();
        nvda.mint(creator, 100 ether);
        aapl.mint(creator, 100 ether);
        vm.startPrank(creator);
        nvda.approve(address(vault), type(uint256).max);
        aapl.approve(address(vault), type(uint256).max);
        vault.mint(10 ether, creator);
        vault.setThrottles(1 ether, 0, 0, 1_000);
        vm.expectRevert(BasketShareVault.Throttled.selector);
        vault.mint(2 ether, creator);
        vm.expectRevert(BasketShareVault.ThrottleTooLow.selector);
        vault.setThrottles(0, 0, 0, 100);
        vm.expectRevert(BasketShareVault.Throttled.selector);
        vault.redeem(2 ether, creator);
        vm.warp(block.timestamp + 1 hours);
        vault.redeem(1 ether, creator);
        vm.stopPrank();
        assertEq(vault.balanceOf(creator), 9 ether);
    }

    function testPauseBlocksMintAndRedeemStaysOpen() public {
        BasketShareVault vault = _vault();
        nvda.mint(creator, 10 ether);
        aapl.mint(creator, 10 ether);
        vm.startPrank(creator);
        nvda.approve(address(vault), type(uint256).max);
        aapl.approve(address(vault), type(uint256).max);
        vault.mint(1 ether, creator);
        vault.setPaused(true);
        vm.expectRevert(BasketShareVault.Paused.selector);
        vault.mint(1 ether, creator);
        vault.redeem(1 ether, creator);
        vm.stopPrank();
        assertEq(vault.totalSupply(), 0);
    }

    function testDeadLegCanBeSkippedThenExcluded() public {
        BasketShareVault vault = _vault();
        nvda.mint(creator, 10 ether);
        aapl.mint(creator, 10 ether);
        vm.startPrank(creator);
        nvda.approve(address(vault), type(uint256).max);
        aapl.approve(address(vault), type(uint256).max);
        vault.mint(1 ether, creator);
        vm.stopPrank();

        aapl.kill();
        address[] memory skip = new address[](1);
        skip[0] = address(aapl);
        uint256 nvdaBefore = nvda.balanceOf(creator);
        vm.prank(creator);
        vault.redeemExcluding(1 ether, creator, skip);
        assertGt(nvda.balanceOf(creator), nvdaBefore);
        assertEq(vault.forfeited(address(aapl)), 1 ether);
        assertEq(aapl.balanceOf(creator), 10 ether - 1 ether - 0.0035 ether);

        vm.prank(creator);
        vault.probeDead(address(aapl));
        vm.prank(buyer);
        vm.expectRevert(BasketShareVault.TooSoon.selector);
        vault.forceExclude(address(aapl));
        vm.prank(creator);
        vault.forceExclude(address(aapl));
        assertEq(vault.unitsPerShare(address(aapl)), 0);
        assertTrue(vault.excluded(address(aapl)));
    }

    function testResyncEatsProtocolFeesFirst() public {
        address[] memory tokens = _two(address(nvda), address(aapl));
        vm.prank(creator);
        BasketShareVault vault = factory.create("F", "F", tokens, _units(), 100, 0);
        nvda.mint(creator, 10 ether);
        aapl.mint(creator, 10 ether);
        vm.startPrank(creator);
        nvda.approve(address(vault), type(uint256).max);
        aapl.approve(address(vault), type(uint256).max);
        vault.mint(1 ether, creator);
        vm.stopPrank();
        uint256 fee = vault.protocolFees(address(nvda));
        assertGt(fee, 0);
        vm.prank(address(vault));
        nvda.transfer(address(0xdead), fee);
        vault.resync(address(nvda));
        assertEq(vault.protocolFees(address(nvda)), 0);
        assertEq(vault.backing(address(nvda)), 1 ether);
    }

    function _two(address a, address b) internal pure returns (address[] memory tokens) {
        tokens = new address[](2);
        tokens[0] = a;
        tokens[1] = b;
    }

    function _units() internal pure returns (uint256[] memory units) {
        units = new uint256[](2);
        units[0] = 1 ether;
        units[1] = 1 ether;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";

import {BasketShareVault} from "../src/BasketShareVault.sol";
import {BasketVaultFactory} from "../src/BasketVaultFactory.sol";
import {EveFeeHook} from "../src/EveFeeHook.sol";
import {RwaInstantV4Factory} from "../src/RwaInstantV4Factory.sol";
import {BundleSinkDeployer} from "../src/BundleSinkDeployer.sol";
import {HookMiner} from "./utils/HookMiner.sol";

contract Leg is ERC20 {
    constructor(string memory symbol_) ERC20(symbol_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Charges 1 wei on transferFrom so the vault must reject it.
contract SkimLeg is ERC20 {
    constructor() ERC20("Skim", "SKIM") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        _spendAllowance(from, _msgSender(), value);
        _transfer(from, to, value - 1);
        return true;
    }
}

contract BasketShareVaultTest is Test {
    BasketVaultFactory factory;
    Leg nvda;
    Leg aapl;
    address creator = makeAddr("creator");
    address trader = makeAddr("trader");

    uint256 constant UNIT = 1 ether;
    uint256 constant SEED = 100 ether;
    uint256 constant CAP = 1_000 ether;

    function setUp() public {
        factory = new BasketVaultFactory();
        nvda = new Leg("NVDA");
        aapl = new Leg("AAPL");
        nvda.mint(creator, 10_000 ether);
        aapl.mint(creator, 10_000 ether);
        nvda.mint(trader, 10_000 ether);
        aapl.mint(trader, 10_000 ether);
    }

    function _recipe() internal view returns (address[] memory tokens, uint256[] memory units) {
        tokens = new address[](2);
        units = new uint256[](2);
        tokens[0] = address(nvda);
        tokens[1] = address(aapl);
        units[0] = UNIT;
        units[1] = 2 * UNIT;
    }

    function _deploy() internal returns (BasketShareVault vault) {
        (address[] memory tokens, uint256[] memory units) = _recipe();
        vm.prank(creator);
        vault = factory.create("NVDA AAPL", "NA", tokens, units, SEED, CAP);
    }

    function _approveSeed(BasketShareVault vault) internal {
        vm.startPrank(creator);
        nvda.approve(address(vault), type(uint256).max);
        aapl.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    function testSeedMintRedeem() public {
        BasketShareVault vault = _deploy();
        _approveSeed(vault);
        vm.prank(creator);
        vault.seed();

        assertEq(vault.totalSupply(), SEED);
        assertEq(vault.balanceOf(address(vault)), SEED);
        assertEq(nvda.balanceOf(address(vault)), UNIT * 100);
        assertEq(aapl.balanceOf(address(vault)), 2 * UNIT * 100);

        vm.startPrank(trader);
        nvda.approve(address(vault), type(uint256).max);
        aapl.approve(address(vault), type(uint256).max);
        vault.mint(10 ether);
        vm.stopPrank();

        assertEq(vault.balanceOf(trader), 10 ether);
        assertEq(vault.totalSupply(), 110 ether);

        uint256 nvdaBefore = nvda.balanceOf(trader);
        uint256 aaplBefore = aapl.balanceOf(trader);
        vm.prank(trader);
        vault.redeem(4 ether);

        assertEq(nvda.balanceOf(trader) - nvdaBefore, 4 ether);
        assertEq(aapl.balanceOf(trader) - aaplBefore, 8 ether);
        assertEq(vault.totalSupply(), 106 ether);
    }

    function testSeedFloor() public {
        BasketShareVault vault = _deploy();
        _approveSeed(vault);
        vm.prank(creator);
        vault.seed();

        vm.startPrank(trader);
        nvda.approve(address(vault), type(uint256).max);
        aapl.approve(address(vault), type(uint256).max);
        vault.mint(SEED);
        vm.stopPrank();

        vm.prank(trader);
        vault.redeem(SEED);
        assertEq(vault.totalSupply(), SEED);

        vm.prank(trader);
        vm.expectRevert(BasketShareVault.SeedFloor.selector);
        vault.redeem(1);
    }

    function testDonationStaysProRata() public {
        BasketShareVault vault = _deploy();
        _approveSeed(vault);
        vm.prank(creator);
        vault.seed();

        nvda.mint(address(vault), 50 ether);

        vm.startPrank(trader);
        nvda.approve(address(vault), type(uint256).max);
        aapl.approve(address(vault), type(uint256).max);
        vault.mint(SEED);
        vm.stopPrank();

        uint256 supply = 200 ether;
        uint256 nvdaBal = 250 ether;
        uint256 before = nvda.balanceOf(trader);
        vm.prank(trader);
        vault.redeem(SEED);
        assertEq(nvda.balanceOf(trader) - before, (nvdaBal * SEED) / supply);
        assertGt(nvda.balanceOf(address(vault)), 0);
    }

    function testRejectsBadRecipe() public {
        address[] memory one = new address[](1);
        uint256[] memory oneU = new uint256[](1);
        one[0] = address(nvda);
        oneU[0] = UNIT;
        vm.expectRevert(BasketShareVault.BadRecipe.selector);
        factory.create("One", "ONE", one, oneU, SEED, CAP);

        address[] memory dup = new address[](2);
        uint256[] memory dupU = new uint256[](2);
        dup[0] = address(nvda);
        dup[1] = address(nvda);
        dupU[0] = UNIT;
        dupU[1] = UNIT;
        vm.expectRevert(BasketShareVault.BadRecipe.selector);
        factory.create("Dup", "DUP", dup, dupU, SEED, CAP);
    }

    function testOnlyCreatorSeedsOnce() public {
        BasketShareVault vault = _deploy();
        _approveSeed(vault);
        vm.prank(trader);
        vm.expectRevert(BasketShareVault.NotCreator.selector);
        vault.seed();

        vm.prank(creator);
        vault.seed();
        vm.prank(creator);
        vm.expectRevert(BasketShareVault.AlreadySeeded.selector);
        vault.seed();
    }

    function testCapAndShort() public {
        BasketShareVault vault = _deploy();
        _approveSeed(vault);
        vm.prank(creator);
        vault.seed();

        vm.startPrank(trader);
        nvda.approve(address(vault), type(uint256).max);
        aapl.approve(address(vault), type(uint256).max);
        vm.expectRevert(BasketShareVault.Cap.selector);
        vault.mint(CAP);
        vm.stopPrank();

        Leg poor = new Leg("POOR");
        address[] memory tokens = new address[](2);
        uint256[] memory units = new uint256[](2);
        tokens[0] = address(nvda);
        tokens[1] = address(poor);
        units[0] = UNIT;
        units[1] = UNIT;
        vm.prank(creator);
        BasketShareVault other = factory.create("Short", "SH", tokens, units, 1 ether, 10 ether);
        nvda.mint(creator, 1 ether);
        vm.startPrank(creator);
        nvda.approve(address(other), type(uint256).max);
        poor.approve(address(other), type(uint256).max);
        vm.expectRevert();
        other.seed();
        vm.stopPrank();
    }

    function testFeeOnTransferRejected() public {
        SkimLeg skim = new SkimLeg();
        skim.mint(creator, 1000 ether);
        address[] memory tokens = new address[](2);
        uint256[] memory units = new uint256[](2);
        tokens[0] = address(nvda);
        tokens[1] = address(skim);
        units[0] = UNIT;
        units[1] = UNIT;
        vm.prank(creator);
        BasketShareVault vault = factory.create("Skim", "SK", tokens, units, 10 ether, 100 ether);
        vm.startPrank(creator);
        nvda.approve(address(vault), type(uint256).max);
        skim.approve(address(vault), type(uint256).max);
        vm.expectRevert(BasketShareVault.FeeOnTransfer.selector);
        vault.seed();
        vm.stopPrank();
    }

    function testShareIsInstantQuote() public {
        BasketShareVault vault = _deploy();
        _approveSeed(vault);
        vm.prank(creator);
        vault.seed();

        vm.startPrank(creator);
        nvda.approve(address(vault), type(uint256).max);
        aapl.approve(address(vault), type(uint256).max);
        vault.mint(10 ether);
        vm.stopPrank();

        PoolManager manager = new PoolManager(address(this));
        (address hookAddr, bytes32 salt) = HookMiner.find(
            address(this),
            uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG),
            type(EveFeeHook).creationCode,
            abi.encode(address(manager), address(this))
        );
        EveFeeHook hook = new EveFeeHook{salt: salt}(IPoolManager(address(manager)), address(this));
        require(address(hook) == hookAddr, "hook");
        RwaInstantV4Factory rwa = new RwaInstantV4Factory(
            IPoolManager(address(manager)), hook, address(this), new BundleSinkDeployer()
        );
        hook.setFactory(address(rwa));

        vm.startPrank(creator);
        vault.approve(address(rwa), 1 ether);
        (address token,,) = rwa.createToken(
            "Basket Meme", "BMEME", address(vault), creator, 30 ether, 1 ether
        );
        vm.stopPrank();

        (, address quote,,,) = rwa.poolOf(token);
        assertEq(quote, address(vault));
        assertEq(IERC20(token).totalSupply(), 1_000_000_000 ether);
        assertEq(vault.balanceOf(creator), 9 ether);
    }
}

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
    address protocol = makeAddr("protocol");

    uint256 constant UNIT = 1 ether;
    uint16 constant MINT_FEE = 100;
    uint16 constant REDEEM_FEE = 100;

    function setUp() public {
        factory = new BasketVaultFactory(protocol);
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
        vault = factory.create("NVDA AAPL", "NA", tokens, units, MINT_FEE, REDEEM_FEE);
    }

    function _approve(address who, BasketShareVault vault) internal {
        vm.startPrank(who);
        nvda.approve(address(vault), type(uint256).max);
        aapl.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    function testMintChargesBackingAndFees() public {
        BasketShareVault vault = _deploy();
        _approve(creator, vault);
        uint256 shares = 10 ether;
        uint256 base = 10 ether;
        uint256 ownerFee = (base * 100 + 9_999) / 10_000;
        uint256 protocolFee = (base * 35 + 9_999) / 10_000;

        vm.prank(creator);
        vault.mint(shares, creator);

        assertEq(vault.balanceOf(creator), shares);
        assertEq(vault.backing(address(nvda)), base);
        assertEq(vault.backing(address(aapl)), base * 2);
        assertEq(vault.treasury(address(nvda)), ownerFee);
        assertEq(vault.protocolFees(address(nvda)), protocolFee);
        assertEq(nvda.balanceOf(address(vault)), base + ownerFee + protocolFee);
    }

    function testRedeemPaysAfterFeesAndLeavesBuckets() public {
        BasketShareVault vault = _deploy();
        _approve(creator, vault);
        vm.prank(creator);
        vault.mint(10 ether, creator);

        uint256 before = nvda.balanceOf(creator);
        vm.prank(creator);
        vault.redeem(10 ether, creator);

        uint256 gross = 10 ether;
        uint256 ownerFee = (gross * 100) / 10_000;
        uint256 protocolFee = (gross * 20) / 10_000;
        assertEq(nvda.balanceOf(creator) - before, gross - ownerFee - protocolFee);
        assertEq(vault.backing(address(nvda)), 0);
        assertEq(vault.totalSupply(), 0);
        assertGt(vault.treasury(address(nvda)), 0);
        assertGt(vault.protocolFees(address(nvda)), 0);
    }

    function testHolderCannotTakeFeeBuckets() public {
        BasketShareVault vault = _deploy();
        _approve(creator, vault);
        _approve(trader, vault);
        vm.prank(creator);
        vault.mint(10 ether, creator);
        vm.prank(trader);
        vault.mint(10 ether, trader);

        uint256 treasuryBefore = vault.treasury(address(nvda));
        uint256 protocolBefore = vault.protocolFees(address(nvda));
        vm.prank(trader);
        vault.redeem(10 ether, trader);
        assertEq(vault.treasury(address(nvda)), treasuryBefore + (10 ether * 100) / 10_000);
        assertEq(vault.protocolFees(address(nvda)), protocolBefore + (10 ether * 20) / 10_000);

        vm.prank(trader);
        vm.expectRevert(BasketShareVault.NotOwner.selector);
        vault.withdrawTreasury(address(nvda));

        uint256 owed = vault.protocolFees(address(nvda));
        vault.sweepProtocolFees(address(nvda));
        assertEq(nvda.balanceOf(protocol), owed);
        assertEq(vault.protocolFees(address(nvda)), 0);

        uint256 ownerCut = vault.treasury(address(nvda));
        vm.prank(creator);
        vault.withdrawTreasury(address(nvda));
        assertEq(nvda.balanceOf(creator) > 0, true);
        assertEq(vault.treasury(address(nvda)), 0);
        assertEq(ownerCut > 0, true);
    }

    function testAccreteRaisesUnitsFromTreasury() public {
        BasketShareVault vault = _deploy();
        _approve(creator, vault);
        vm.prank(creator);
        vault.mint(10 ether, creator);
        uint256 unitsBefore = vault.unitsPerShare(address(nvda));
        uint256 treasuryBefore = vault.treasury(address(nvda));
        vault.accrete(address(nvda));
        assertGt(vault.unitsPerShare(address(nvda)), unitsBefore);
        assertLt(vault.treasury(address(nvda)), treasuryBefore);
        assertGt(vault.backing(address(nvda)), 10 ether);
    }

    function testRejectsBadRecipeAndHighFee() public {
        address[] memory one = new address[](1);
        uint256[] memory oneU = new uint256[](1);
        one[0] = address(nvda);
        oneU[0] = UNIT;
        vm.expectRevert(BasketShareVault.BadRecipe.selector);
        factory.create("One", "ONE", one, oneU, MINT_FEE, REDEEM_FEE);

        Leg msft = new Leg("MSFT");
        Leg googl = new Leg("GOOGL");
        address[] memory four = new address[](4);
        uint256[] memory fourU = new uint256[](4);
        four[0] = address(nvda);
        four[1] = address(aapl);
        four[2] = address(msft);
        four[3] = address(googl);
        fourU[0] = UNIT;
        fourU[1] = UNIT;
        fourU[2] = UNIT;
        fourU[3] = UNIT;
        vm.expectRevert(BasketShareVault.BadRecipe.selector);
        factory.create("Four", "FOUR", four, fourU, MINT_FEE, REDEEM_FEE);

        (address[] memory tokens, uint256[] memory units) = _recipe();
        vm.expectRevert(BasketShareVault.FeeTooHigh.selector);
        factory.create("High", "HIGH", tokens, units, 101, 0);
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
        BasketShareVault vault = factory.create("Skim", "SK", tokens, units, 0, 0);
        vm.startPrank(creator);
        nvda.approve(address(vault), type(uint256).max);
        skim.approve(address(vault), type(uint256).max);
        vm.expectRevert(BasketShareVault.FeeOnTransfer.selector);
        vault.mint(1 ether, creator);
        vm.stopPrank();
    }

    function testShareIsInstantQuote() public {
        BasketShareVault vault = _deploy();
        _approve(creator, vault);
        vm.prank(creator);
        vault.mint(10 ether, creator);

        PoolManager manager = new PoolManager(address(this));
        (, bytes32 salt) = HookMiner.find(
            address(this),
            uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG),
            type(EveFeeHook).creationCode,
            abi.encode(address(manager), address(this))
        );
        EveFeeHook hook = new EveFeeHook{salt: salt}(IPoolManager(address(manager)), address(this));
        RwaInstantV4Factory rwa = new RwaInstantV4Factory(
            IPoolManager(address(manager)), hook, address(this), new BundleSinkDeployer()
        );
        hook.setFactory(address(rwa));

        vm.startPrank(creator);
        vault.approve(address(rwa), 1 ether);
        (address token,,) = rwa.createToken("Basket Meme", "BMEME", address(vault), creator, 30 ether, 1 ether);
        vm.stopPrank();

        (, address quote,,,) = rwa.poolOf(token);
        assertEq(quote, address(vault));
        assertEq(IERC20(token).totalSupply(), 1_000_000_000 ether);
        assertEq(vault.balanceOf(creator), 9 ether);
    }
}

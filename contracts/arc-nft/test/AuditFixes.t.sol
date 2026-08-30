// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArcNftCollectionFactory} from "../src/ArcNftCollectionFactory.sol";
import {ArcNft721} from "../src/ArcNft721.sol";
import {ArcDisperse} from "../src/ArcDisperse.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// Regression tests for the audit findings. Each fails on the previous code.
contract AuditFixesTest is Test {
    ArcNftCollectionFactory factory;
    ArcNft721 implementation;
    MockUSDC usdc;

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address creator = makeAddr("creator");
    address payout = makeAddr("payout");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant CREATION_FEE = 0.1 ether;
    uint256 constant PRICE = 10_000_000;

    function setUp() public {
        usdc = new MockUSDC();
        implementation = new ArcNft721();
        ArcNftCollectionFactory impl = new ArcNftCollectionFactory();
        bytes memory data = abi.encodeCall(
            ArcNftCollectionFactory.initialize,
            (owner, treasury, address(usdc), address(implementation), CREATION_FEE, address(0), address(0))
        );
        factory = ArcNftCollectionFactory(address(new ERC1967Proxy(address(impl), data)));

        usdc.mint(alice, 1_000_000_000);
        usdc.mint(bob, 1_000_000_000);
        vm.deal(creator, 10 ether);
    }

    function _params() internal view returns (ArcNftCollectionFactory.CreateParams memory p) {
        p = ArcNftCollectionFactory.CreateParams({
            name: "Arc Port",
            symbol: "ARCP",
            unrevealedURI: "ipfs://hidden.json",
            baseURI: "ipfs://cid/",
            revealed: false,
            maxSupply: 100,
            maxPerWallet: 3,
            price: PRICE,
            publicMintStart: uint64(block.timestamp + 1 days),
            allowlistMintStart: uint64(block.timestamp),
            allowlistMintEnd: uint64(block.timestamp + 1 days),
            allowlistRoot: bytes32(0),
            royaltyBps: 500,
            creatorRewardsWallet: payout,
            originToken: address(0)
        });
    }

    function _create(ArcNftCollectionFactory.CreateParams memory p) internal returns (ArcNft721) {
        vm.prank(creator);
        return ArcNft721(factory.createCollection{value: CREATION_FEE}(p));
    }

    // -- ownerMint must not spend the recipient's public allowance -----------

    /// A reserved mint used to increment `mintedBy`, so airdropping to a
    /// collector silently ate the public-mint allowance they had not used.
    function test_ownerMintDoesNotConsumePublicAllowance() public {
        ArcNft721 col = _create(_params());

        vm.prank(creator);
        col.ownerMint(alice, 3); // exactly maxPerWallet
        assertEq(col.balanceOf(alice), 3, "airdrop received");
        assertEq(col.mintedBy(alice), 0, "allowance untouched");

        // Alice can still buy her full public allocation.
        vm.warp(block.timestamp + 2 days);
        vm.startPrank(alice);
        usdc.approve(address(col), type(uint256).max);
        col.mint(3);
        vm.stopPrank();

        assertEq(col.balanceOf(alice), 6, "airdrop + full public mint");
        assertEq(col.mintedBy(alice), 3);

        // And the cap still binds on the public path.
        vm.startPrank(alice);
        vm.expectRevert(ArcNft721.WalletCap.selector);
        col.mint(1);
        vm.stopPrank();
    }

    // -- price must not move under a live allowlist --------------------------

    /// `setPrice` checked only `_publicLive()`, so the price was movable
    /// underneath an allowlist that was already minting, as long as nobody had
    /// minted yet.
    function test_setPriceLockedOnceAllowlistOpens() public {
        ArcNftCollectionFactory.CreateParams memory p = _params();
        p.allowlistRoot = keccak256("root");
        ArcNft721 col = _create(p);

        // Allowlist window is open (start == deploy time), public is not.
        vm.prank(creator);
        vm.expectRevert(ArcNft721.PriceLocked.selector);
        col.setPrice(1);
    }

    /// Before the allowlist opens it is still editable.
    function test_setPriceOpenBeforeAnyWindow() public {
        ArcNftCollectionFactory.CreateParams memory p = _params();
        p.allowlistRoot = keccak256("root");
        p.allowlistMintStart = uint64(block.timestamp + 12 hours);
        p.allowlistMintEnd = uint64(block.timestamp + 1 days);
        ArcNft721 col = _create(p);

        vm.prank(creator);
        col.setPrice(1);
        assertEq(col.price(), 1);
    }

    // -- a window that closes before it opens is a misconfiguration ----------

    /// `setSchedule` rejected this; `initialize` did not, so a collection could
    /// deploy with an allowlist that is never live and never mints.
    function test_initializeRejectsInvertedAllowlistWindow() public {
        ArcNftCollectionFactory.CreateParams memory p = _params();
        p.allowlistMintStart = uint64(block.timestamp + 1 days);
        p.allowlistMintEnd = uint64(block.timestamp + 1 hours);

        vm.prank(creator);
        vm.expectRevert(ArcNft721.BadN.selector);
        factory.createCollection{value: CREATION_FEE}(p);
    }

    // -- the implementation must actually be a contract ----------------------

    /// `Clones.clone` of an address with no code yields a proxy that delegates
    /// into nothing: `initialize` succeeds having done nothing, and every
    /// collection minted afterwards is dead. `BadImpl` was declared and never
    /// used.
    function test_setImplementationRejectsNonContract() public {
        vm.prank(owner);
        vm.expectRevert(ArcNftCollectionFactory.BadImpl.selector);
        factory.setImplementation(makeAddr("eoa"));

        vm.prank(owner);
        vm.expectRevert(ArcNftCollectionFactory.ZeroAddr.selector);
        factory.setImplementation(address(0));

        // A real implementation is still accepted.
        ArcNft721 fresh = new ArcNft721();
        vm.prank(owner);
        factory.setImplementation(address(fresh));
        assertEq(factory.implementation(), address(fresh));
    }

    function test_initializeRejectsNonContractImplementation() public {
        ArcNftCollectionFactory impl = new ArcNftCollectionFactory();
        bytes memory data = abi.encodeCall(
            ArcNftCollectionFactory.initialize,
            (owner, treasury, address(usdc), makeAddr("eoa"), CREATION_FEE, address(0), address(0))
        );
        vm.expectRevert(ArcNftCollectionFactory.BadImpl.selector);
        new ERC1967Proxy(address(impl), data);
    }

    // -- ArcDisperse must never hold a balance -------------------------------

    /// Funds used to be pulled into the contract and paid out from there. A
    /// fee-on-transfer token makes that hop observable: the pull arrives short,
    /// so the payouts have to come from somewhere. Whatever an earlier such
    /// call stranded here covers the gap — one caller's leftovers silently pay
    /// the next caller's airdrop. Paying straight from the sender removes it.
    function test_disperseDoesNotSpendStrandedBalance() public {
        ArcDisperse d = new ArcDisperse();
        MockFeeToken fot = new MockFeeToken(); // 1% on every transfer

        // A previous fee-on-transfer disperse left dust behind.
        fot.mint(address(d), 5_000);

        address[] memory to = new address[](2);
        to[0] = alice;
        to[1] = bob;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 10_000;
        amounts[1] = 10_000;

        vm.startPrank(creator);
        fot.mint(creator, 100_000);
        fot.approve(address(d), type(uint256).max);
        d.disperseToken(IERC20(address(fot)), to, amounts);
        vm.stopPrank();

        // Recipients are paid straight from the sender, each net of the token's
        // own fee. Nothing routes through this contract.
        assertEq(fot.balanceOf(alice), 9_900, "alice paid net of token fee");
        assertEq(fot.balanceOf(bob), 9_900, "bob paid net of token fee");
        assertEq(fot.balanceOf(creator), 100_000 - 20_000, "debited from sender");
        assertEq(fot.balanceOf(address(d)), 5_000, "stranded balance untouched");
    }

    /// Zero-amount rows are skipped without pulling anything for them.
    function test_disperseSkipsZeroRows() public {
        ArcDisperse d = new ArcDisperse();

        address[] memory to = new address[](2);
        to[0] = alice;
        to[1] = bob;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 0;
        amounts[1] = 7;

        vm.startPrank(creator);
        usdc.mint(creator, 1_000);
        usdc.approve(address(d), type(uint256).max);
        d.disperseToken(IERC20(address(usdc)), to, amounts);
        vm.stopPrank();

        assertEq(usdc.balanceOf(alice), 1_000_000_000);
        assertEq(usdc.balanceOf(bob), 1_000_000_000 + 7);
        assertEq(usdc.balanceOf(address(d)), 0);
    }
}

/// 1% fee-on-transfer ERC-20. The recipient receives less than was sent.
contract MockFeeToken {
    string public name = "Fee";
    string public symbol = "FEE";
    uint8 public decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "ALLOW");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "BAL");
        uint256 fee = amount / 100;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
    }
}

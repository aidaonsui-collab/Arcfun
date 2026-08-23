// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {ArcNftCollectionFactory} from "../src/ArcNftCollectionFactory.sol";
import {ArcNft721} from "../src/ArcNft721.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract ArcNftTest is Test {
    ArcNftCollectionFactory factory;
    ArcNft721 implementation;
    MockUSDC usdc;
    MockInstant instant;

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address creator = makeAddr("creator");
    address payout = makeAddr("payout");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant CREATION_FEE = 0.1 ether; // native USDC 18dp
    uint256 constant PRICE = 10_000_000; // 10 USDC 6dp

    function setUp() public {
        usdc = new MockUSDC();
        implementation = new ArcNft721();

        instant = new MockInstant();
        ArcNftCollectionFactory impl = new ArcNftCollectionFactory();
        bytes memory data = abi.encodeCall(
            ArcNftCollectionFactory.initialize,
            (owner, treasury, address(usdc), address(implementation), CREATION_FEE, address(instant), address(0))
        );
        factory = ArcNftCollectionFactory(address(new ERC1967Proxy(address(impl), data)));

        usdc.mint(alice, 1_000_000_000);
        usdc.mint(bob, 1_000_000_000);
        vm.deal(creator, 10 ether);
        vm.deal(owner, 10 ether);
        vm.deal(alice, 1 ether);
        vm.deal(bob, 10 ether);
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

    function _create(address who, uint256 value) internal returns (ArcNft721 col) {
        vm.prank(who);
        address a = factory.createCollection{value: value}(_params());
        col = ArcNft721(a);
    }

    function test_creationFee_nonOwnerPays_ownerFree() public {
        uint256 due = factory.creationFeeDue(creator);
        assertEq(due, CREATION_FEE);
        assertEq(factory.creationFeeDue(owner), 0);
        assertEq(factory.CREATION_FEE(), CREATION_FEE);

        uint256 t0 = treasury.balance;
        ArcNft721 col = _create(creator, CREATION_FEE);
        assertEq(treasury.balance, t0 + CREATION_FEE);
        assertTrue(factory.isCollection(address(col)));
        assertEq(factory.creatorOf(address(col)), creator);
        assertEq(factory.allCollectionsLength(), 1);
        assertEq(col.owner(), creator);
        assertEq(col.creatorPayout(), payout);
        assertEq(col.treasury(), treasury);

        uint256 t1 = treasury.balance;
        vm.prank(owner);
        factory.createCollection{value: 0}(_params());
        assertEq(treasury.balance, t1);
        assertEq(factory.allCollectionsLength(), 2);
    }

    function test_creationFee_tooLowReverts_excessRefunded() public {
        vm.prank(creator);
        vm.expectRevert(ArcNftCollectionFactory.FeeTooLow.selector);
        factory.createCollection{value: CREATION_FEE - 1}(_params());

        uint256 before = creator.balance;
        vm.prank(creator);
        factory.createCollection{value: CREATION_FEE + 0.5 ether}(_params());
        assertEq(creator.balance, before - CREATION_FEE);
    }

    function test_publicMint_splitAndCap() public {
        ArcNftCollectionFactory.CreateParams memory p = _params();
        p.allowlistRoot = bytes32(0);
        p.publicMintStart = uint64(block.timestamp);
        vm.prank(creator);
        ArcNft721 col = ArcNft721(factory.createCollection{value: CREATION_FEE}(p));

        vm.startPrank(alice);
        usdc.approve(address(col), type(uint256).max);
        col.mint(2);
        vm.stopPrank();

        assertEq(col.balanceOf(alice), 2);
        assertEq(col.ownerOf(1), alice);
        assertEq(col.ownerOf(2), alice);
        assertEq(col.totalMinted(), 2);
        assertEq(col.mintedBy(alice), 2);
        // 20 USDC * 5% = 1 to treasury, 19 to creator
        assertEq(usdc.balanceOf(treasury), 1_000_000);
        assertEq(usdc.balanceOf(payout), 19_000_000);

        vm.prank(alice);
        vm.expectRevert(ArcNft721.WalletCap.selector);
        col.mint(2); // 2+2 > 3

        vm.prank(alice);
        col.mint(1);
        assertEq(col.balanceOf(alice), 3);
    }

    function test_mint_notLive_soldOut() public {
        ArcNft721 col = _create(creator, CREATION_FEE);
        vm.prank(alice);
        vm.expectRevert(ArcNft721.NotLive.selector);
        col.mint(1);

        ArcNftCollectionFactory.CreateParams memory p = _params();
        p.publicMintStart = uint64(block.timestamp);
        p.maxSupply = 2;
        p.maxPerWallet = 5;
        vm.prank(creator);
        ArcNft721 tiny = ArcNft721(factory.createCollection{value: CREATION_FEE}(p));
        vm.startPrank(alice);
        usdc.approve(address(tiny), type(uint256).max);
        tiny.mint(2);
        vm.expectRevert(ArcNft721.SoldOut.selector);
        tiny.mint(1);
        vm.stopPrank();
    }

    function test_allowlist() public {
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(alice))));
        ArcNftCollectionFactory.CreateParams memory p = _params();
        p.allowlistRoot = leaf; // single-leaf tree
        p.publicMintStart = uint64(block.timestamp + 10 days);
        p.allowlistMintStart = uint64(block.timestamp);
        p.allowlistMintEnd = uint64(block.timestamp + 1 days);
        vm.prank(creator);
        ArcNft721 col = ArcNft721(factory.createCollection{value: CREATION_FEE}(p));

        bytes32[] memory proof;
        vm.startPrank(alice);
        usdc.approve(address(col), type(uint256).max);
        col.mintAllowlist(1, proof);
        vm.stopPrank();
        assertEq(col.ownerOf(1), alice);

        vm.startPrank(bob);
        usdc.approve(address(col), type(uint256).max);
        vm.expectRevert(ArcNft721.BadProof.selector);
        col.mintAllowlist(1, proof);
        vm.expectRevert(ArcNft721.NotLive.selector);
        col.mint(1);
        vm.stopPrank();

        vm.warp(block.timestamp + 2 days);
        vm.prank(alice);
        vm.expectRevert(ArcNft721.NotLive.selector);
        col.mintAllowlist(1, proof);
    }

    function test_eip2981() public {
        ArcNft721 col = _create(creator, CREATION_FEE);
        (address recv, uint256 amt) = IERC2981(address(col)).royaltyInfo(1, 10_000);
        assertEq(recv, payout);
        assertEq(amt, 500); // 5% of 10000

        vm.prank(creator);
        col.setRoyalty(payout, 1_000);
        (, amt) = IERC2981(address(col)).royaltyInfo(1, 10_000);
        assertEq(amt, 1_000);

        vm.prank(creator);
        vm.expectRevert(ArcNft721.RoyaltyTooHigh.selector);
        col.setRoyalty(payout, 1_001);

        assertTrue(col.supportsInterface(type(IERC2981).interfaceId));
    }

    function test_reveal() public {
        ArcNftCollectionFactory.CreateParams memory p = _params();
        p.publicMintStart = uint64(block.timestamp);
        vm.prank(creator);
        ArcNft721 col = ArcNft721(factory.createCollection{value: CREATION_FEE}(p));

        vm.startPrank(alice);
        usdc.approve(address(col), type(uint256).max);
        col.mint(1);
        vm.stopPrank();

        assertEq(col.tokenURI(1), "ipfs://hidden.json");
        assertFalse(col.revealed());

        vm.prank(alice);
        vm.expectRevert(); // not owner
        col.reveal("ipfs://cid/");

        vm.prank(creator);
        col.reveal("ipfs://cid/");
        assertTrue(col.revealed());
        assertEq(col.tokenURI(1), "ipfs://cid/1");
    }

    function test_freeMint_zeroPrice() public {
        ArcNftCollectionFactory.CreateParams memory p = _params();
        p.price = 0;
        p.publicMintStart = uint64(block.timestamp);
        vm.prank(creator);
        ArcNft721 col = ArcNft721(factory.createCollection{value: CREATION_FEE}(p));
        vm.prank(alice);
        col.mint(1);
        assertEq(col.ownerOf(1), alice);
        assertEq(usdc.balanceOf(payout), 0);
    }

    function test_originToken_onlyCreator_oneCollection() public {
        address eve = makeAddr("eveToken");
        address pool = makeAddr("pool");
        instant.set(eve, creator, pool);

        ArcNftCollectionFactory.CreateParams memory p = _params();
        p.originToken = eve;
        p.publicMintStart = uint64(block.timestamp);

        vm.prank(bob);
        vm.expectRevert(ArcNftCollectionFactory.NotTokenCreator.selector);
        factory.createCollection{value: CREATION_FEE}(p);

        vm.prank(creator);
        ArcNft721 col = ArcNft721(factory.createCollection{value: CREATION_FEE}(p));
        assertEq(col.originToken(), eve);
        assertEq(factory.originTokenOf(address(col)), eve);
        assertEq(factory.collectionOfToken(eve), address(col));
        assertEq(factory.tokenCreator(eve), creator);

        vm.prank(creator);
        vm.expectRevert(ArcNftCollectionFactory.TokenAlreadyLinked.selector);
        factory.createCollection{value: CREATION_FEE}(p);

        p.originToken = makeAddr("unknown");
        vm.prank(creator);
        vm.expectRevert(ArcNftCollectionFactory.UnknownToken.selector);
        factory.createCollection{value: CREATION_FEE}(p);
    }

    function test_setHidden_ownerOnly_freesOrigin() public {
        address eve = makeAddr("eveToken");
        instant.set(eve, creator, makeAddr("pool"));
        ArcNftCollectionFactory.CreateParams memory p = _params();
        p.originToken = eve;
        vm.prank(creator);
        ArcNft721 col = ArcNft721(factory.createCollection{value: CREATION_FEE}(p));

        vm.prank(creator);
        vm.expectRevert();
        factory.setHidden(address(col), true);

        vm.prank(owner);
        factory.setHidden(address(col), true);
        assertTrue(factory.hidden(address(col)));
        assertEq(factory.collectionOfToken(eve), address(0));

        vm.prank(creator);
        ArcNft721 col2 = ArcNft721(factory.createCollection{value: CREATION_FEE}(p));
        assertEq(factory.collectionOfToken(eve), address(col2));

        vm.prank(owner);
        factory.setHidden(address(col), false);
        assertFalse(factory.hidden(address(col)));
        // origin already taken by col2
        assertEq(factory.collectionOfToken(eve), address(col2));
    }
}

contract MockInstant {
    struct Pool {
        address creator;
        address uniPool;
        uint256 positionId;
        uint128 liquidity;
        int24 tickLower;
        int24 tickUpper;
    }

    mapping(address => Pool) internal _pools;

    function set(address token, address creator, address uniPool) external {
        _pools[token] = Pool(creator, uniPool, 1, 1, 0, 0);
    }

    function getPool(address token) external view returns (Pool memory) {
        return _pools[token];
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ArcNS} from "../src/ArcNS.sol";
import {ArcNSResolver} from "../src/ArcNSResolver.sol";
import {MockUSDC} from "./MockUSDC.sol";

contract ArcNSTest is Test {
    ArcNS ns;
    ArcNSResolver resolver;
    MockUSDC usdc;

    address deployer = address(this);
    address crucible = makeAddr("crucible");
    address platform = makeAddr("platform");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        usdc = new MockUSDC();
        ns = new ArcNS(address(usdc), crucible, platform);
        resolver = new ArcNSResolver(address(ns));

        usdc.mint(alice, 10_000e6);
        usdc.mint(bob, 10_000e6);
        vm.prank(alice);
        usdc.approve(address(ns), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(ns), type(uint256).max);
    }

    function _register(address who, string memory label, uint256 duration) internal returns (uint256 tokenId) {
        bytes32 secret = keccak256(abi.encode(who, label, block.timestamp));
        bytes32 commitment = ns.makeCommitment(label, who, secret);
        vm.prank(who);
        ns.commit(commitment);
        vm.warp(block.timestamp + ns.MIN_COMMIT_AGE());
        vm.prank(who);
        ns.register(label, who, duration, secret);
        tokenId = ns.labelhash(label);
    }

    // ── constructor ────────────────────────────────────────────────────────────────────────
    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(ArcNS.ZeroAddress.selector);
        new ArcNS(address(0), crucible, platform);
        vm.expectRevert(ArcNS.ZeroAddress.selector);
        new ArcNS(address(usdc), address(0), platform);
        vm.expectRevert(ArcNS.ZeroAddress.selector);
        new ArcNS(address(usdc), crucible, address(0));
    }

    // ── label validation ───────────────────────────────────────────────────────────────────
    function test_available_rejectsBadLabels() public view {
        assertFalse(ns.available("ab")); // too short
        assertFalse(ns.available("-eve")); // leading hyphen
        assertFalse(ns.available("eve-")); // trailing hyphen
        assertFalse(ns.available("Eve")); // uppercase
        assertFalse(ns.available("e v e")); // space
        assertTrue(ns.available("eve"));
        assertTrue(ns.available("eve-fun"));
        assertTrue(ns.available("a1b2c3"));
    }

    // ── commit-reveal happy path ───────────────────────────────────────────────────────────
    function test_register_happyPath_mintsAndSplitsPayment() public {
        uint256 cost = ns.priceOf("eve", 365 days); // 3-char tier
        uint256 tokenId = _register(alice, "eve", 365 days);

        assertEq(ns.ownerOf(tokenId), alice);
        assertEq(ns.labelOf(tokenId), "eve");
        assertFalse(ns.available("eve"));
        assertEq(ns.expiries(tokenId), block.timestamp + 365 days);

        uint256 expectedBurn = (cost * ns.burnBps()) / ns.BPS_DENOM();
        uint256 expectedPlatform = cost - expectedBurn;
        assertEq(usdc.balanceOf(crucible), expectedBurn);
        assertEq(usdc.balanceOf(platform), expectedPlatform);
        assertEq(usdc.balanceOf(address(ns)), 0); // nothing stranded in the contract itself
    }

    function test_priceOf_scalesByLengthAndDuration() public view {
        uint256 threeChar = ns.priceOf("eve", 365 days);
        uint256 sevenChar = ns.priceOf("eveisgreat", 365 days); // 10 chars -> last bucket
        assertGt(threeChar, sevenChar);

        uint256 oneYear = ns.priceOf("eve", 365 days);
        uint256 twoYear = ns.priceOf("eve", 730 days);
        assertEq(twoYear, oneYear * 2);
    }

    function test_commit_tooYoung_reverts() public {
        bytes32 secret = keccak256("s");
        bytes32 commitment = ns.makeCommitment("eve", alice, secret);
        vm.prank(alice);
        ns.commit(commitment);
        vm.prank(alice);
        vm.expectRevert(ArcNS.CommitTooYoung.selector);
        ns.register("eve", alice, 365 days, secret);
    }

    function test_commit_tooOld_reverts() public {
        bytes32 secret = keccak256("s");
        bytes32 commitment = ns.makeCommitment("eve", alice, secret);
        vm.prank(alice);
        ns.commit(commitment);
        vm.warp(block.timestamp + ns.MAX_COMMIT_AGE() + 1);
        vm.prank(alice);
        vm.expectRevert(ArcNS.CommitTooOld.selector);
        ns.register("eve", alice, 365 days, secret);
    }

    function test_register_withoutCommit_reverts() public {
        vm.prank(alice);
        vm.expectRevert(ArcNS.CommitNotFound.selector);
        ns.register("eve", alice, 365 days, keccak256("nope"));
    }

    /// @notice The whole point of commit-reveal: a copy-cat who saw only the *commitment* on
    ///         chain (not the secret) cannot register the name themselves before the real owner
    ///         reveals — their forged commitment hashes differently, so it was never committed.
    function test_frontrunProtection_copyingCommitmentAloneFails() public {
        bytes32 secret = keccak256("alice-secret");
        bytes32 commitment = ns.makeCommitment("eve", alice, secret);
        vm.prank(alice);
        ns.commit(commitment);
        vm.warp(block.timestamp + ns.MIN_COMMIT_AGE());

        // bob tries to register the same label for himself without knowing alice's secret
        vm.prank(bob);
        vm.expectRevert(ArcNS.CommitNotFound.selector);
        ns.register("eve", bob, 365 days, keccak256("bob-guess"));
    }

    function test_register_duplicateWhileActive_reverts() public {
        _register(alice, "eve", 365 days);
        bytes32 secret = keccak256("bob-secret");
        bytes32 commitment = ns.makeCommitment("eve", bob, secret);
        vm.prank(bob);
        ns.commit(commitment);
        vm.warp(block.timestamp + ns.MIN_COMMIT_AGE());
        vm.prank(bob);
        vm.expectRevert(ArcNS.NotAvailable.selector);
        ns.register("eve", bob, 365 days, secret);
    }

    // ── expiry / grace / re-registration ───────────────────────────────────────────────────
    function test_renew_extendsExpiry() public {
        uint256 tokenId = _register(alice, "eve", 365 days);
        uint256 expBefore = ns.expiries(tokenId);
        vm.prank(alice);
        ns.renew("eve", 365 days);
        assertEq(ns.expiries(tokenId), expBefore + 365 days);
    }

    function test_renew_afterGraceLapsed_reverts() public {
        _register(alice, "eve", 365 days);
        vm.warp(block.timestamp + 365 days + ns.GRACE_PERIOD() + 1);
        vm.expectRevert(ArcNS.NotAvailable.selector);
        ns.renew("eve", 365 days);
    }

    function test_expiredName_becomesAvailable_andReassignable() public {
        uint256 tokenId = _register(alice, "eve", 365 days);
        assertFalse(ns.available("eve"));

        // still owned by alice during grace
        vm.warp(block.timestamp + 365 days + 1);
        assertFalse(ns.available("eve")); // grace period not over yet
        assertEq(ns.ownerOf(tokenId), alice);

        // past grace: available again, bob can take it
        vm.warp(block.timestamp + ns.GRACE_PERIOD());
        assertTrue(ns.available("eve"));

        uint256 newTokenId = _register(bob, "eve", 365 days);
        assertEq(newTokenId, tokenId); // same labelhash
        assertEq(ns.ownerOf(tokenId), bob); // reassigned away from alice without alice's say-so
    }

    // ── admin ──────────────────────────────────────────────────────────────────────────────
    function test_onlyOwner_gatesAdminFunctions() public {
        vm.startPrank(alice);
        vm.expectRevert(ArcNS.NotOwner.selector);
        ns.setPlatformWallet(bob);
        vm.expectRevert(ArcNS.NotOwner.selector);
        ns.setSplit(5_000, 5_000);
        vm.expectRevert(ArcNS.NotOwner.selector);
        ns.transferOwnership(bob);
        vm.stopPrank();
    }

    function test_setSplit_mustSumToDenom() public {
        vm.expectRevert(ArcNS.BadSplit.selector);
        ns.setSplit(6_000, 3_000); // sums to 9000, not 10000
        ns.setSplit(6_000, 4_000); // valid
        assertEq(ns.burnBps(), 6_000);
        assertEq(ns.platformBps(), 4_000);
    }

    // ── resolver ───────────────────────────────────────────────────────────────────────────
    function test_resolver_setAddr_onlyNameOwner() public {
        _register(alice, "eve", 365 days);
        vm.prank(bob);
        vm.expectRevert(ArcNSResolver.NotNameOwner.selector);
        resolver.setAddr("eve", bob);

        vm.prank(alice);
        resolver.setAddr("eve", alice);
        assertEq(resolver.addr("eve"), alice);
    }

    function test_resolver_primaryName_roundTrip() public {
        _register(alice, "eve", 365 days);
        vm.prank(alice);
        resolver.setPrimaryName("eve");
        assertEq(resolver.nameOf(alice), "eve");
    }

    /// @notice If alice sells/transfers the NFT away, her stale primary-name claim must stop
    ///         resolving — otherwise the new owner's name would still show up as pointing at her.
    function test_resolver_primaryName_goesStaleAfterTransfer() public {
        uint256 tokenId = _register(alice, "eve", 365 days);
        vm.prank(alice);
        resolver.setPrimaryName("eve");
        assertEq(resolver.nameOf(alice), "eve");

        vm.prank(alice);
        ns.transferFrom(alice, bob, tokenId);
        assertEq(resolver.nameOf(alice), ""); // no longer hers
    }

    function test_resolver_setText() public {
        _register(alice, "eve", 365 days);
        vm.prank(alice);
        resolver.setText("eve", "twitter", "@eve_fun");
        assertEq(resolver.text("eve", "twitter"), "@eve_fun");
    }
}

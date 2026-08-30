// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MonLock, INonfungiblePositionManager} from "../src/MonLock.sol";

/// @dev NFPM stand-in. `collect` returns fixed "fees" and records the recipient; `transferFrom`
///      moves the NFT. Used to prove MonLock's invariants without a UniV3 fork.
contract MockNFPM {
    mapping(uint256 => address) public ownerOf;
    address public lastCollectRecipient;
    uint256 public collectCalls;

    function mintTo(address to, uint256 tokenId) external {
        ownerOf[tokenId] = to;
    }

    function collect(INonfungiblePositionManager.CollectParams calldata p)
        external
        payable
        returns (uint256, uint256)
    {
        lastCollectRecipient = p.recipient;
        collectCalls++;
        return (111, 222); // tokensOwed only — NEVER principal
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        require(ownerOf[tokenId] == from, "not owner");
        ownerOf[tokenId] = to;
    }
}

/// @dev Hostile NFPM: on every external call back from MonLock it re-enters a MonLock entrypoint,
///      catching the revert so we can assert the guard fired (rather than the whole tx unwinding).
contract ReentrantNFPM {
    mapping(uint256 => address) public ownerOf;
    MonLock public target;
    bool public reentryAttempted;
    bool public reentryBlocked;
    uint8 public mode; // 0 = reenter collectFees, 1 = reenter withdraw

    function setTarget(MonLock t) external {
        target = t;
    }

    function setMode(uint8 m) external {
        mode = m;
    }

    function mintTo(address to, uint256 tokenId) external {
        ownerOf[tokenId] = to;
    }

    function _attack(uint256 tokenId) internal {
        reentryAttempted = true;
        if (mode == 0) {
            try target.collectFees(tokenId) { reentryBlocked = false; }
            catch { reentryBlocked = true; }
        } else {
            try target.withdraw(tokenId) { reentryBlocked = false; }
            catch { reentryBlocked = true; }
        }
    }

    function collect(INonfungiblePositionManager.CollectParams calldata p)
        external
        payable
        returns (uint256, uint256)
    {
        _attack(p.tokenId);
        return (111, 222);
    }

    function transferFrom(address, address to, uint256 tokenId) external {
        _attack(tokenId);
        ownerOf[tokenId] = to;
    }
}

/// @notice Adversarial / stress suite for MonLock (the locker RobinLock deploys on RH). Every test
///         takes the attacker's seat and proves the exploit reverts or is neutralized.
contract MonLockSecurityTest is Test {
    MonLock internal lock;
    MockNFPM internal nfpm;

    address internal beneficiary = makeAddr("beneficiary"); // platform deployer / fee wallet
    address internal owner = makeAddr("owner");
    address internal attacker = makeAddr("attacker");
    address internal treasury = makeAddr("treasury");
    uint64 internal constant DUR = 365 days;
    uint256 internal constant TOKEN_ID = 7;

    function setUp() public {
        nfpm = new MockNFPM();
        lock = new MonLock(address(nfpm), beneficiary, owner, DUR);
    }

    function _mintAndLock(uint256 tokenId) internal returns (uint64 unlockTime) {
        nfpm.mintTo(address(lock), tokenId);
        unlockTime = lock.lockPosition(tokenId);
    }

    // ───────────────── early / unauthorized withdrawal ─────────────────

    function test_attacker_cannotWithdrawAnyPosition() public {
        uint64 unlockTime = _mintAndLock(TOKEN_ID);
        vm.warp(unlockTime + 1); // even AFTER unlock
        vm.prank(attacker);
        vm.expectRevert(MonLock.NotBeneficiary.selector);
        lock.withdraw(TOKEN_ID);
        assertEq(nfpm.ownerOf(TOKEN_ID), address(lock)); // NFT never moved
    }

    function test_beneficiary_cannotWithdrawOneSecondEarly() public {
        uint64 unlockTime = _mintAndLock(TOKEN_ID);
        vm.warp(unlockTime - 1);
        vm.prank(beneficiary);
        vm.expectRevert(MonLock.StillLocked.selector);
        lock.withdraw(TOKEN_ID);
    }

    function test_beneficiary_canWithdrawExactlyAtUnlock() public {
        uint64 unlockTime = _mintAndLock(TOKEN_ID);
        vm.warp(unlockTime);
        vm.prank(beneficiary);
        lock.withdraw(TOKEN_ID);
        assertEq(nfpm.ownerOf(TOKEN_ID), beneficiary);
    }

    function test_cannotDoubleWithdraw() public {
        uint64 unlockTime = _mintAndLock(TOKEN_ID);
        vm.warp(unlockTime);
        vm.startPrank(beneficiary);
        lock.withdraw(TOKEN_ID);
        vm.expectRevert(MonLock.AlreadyWithdrawn.selector);
        lock.withdraw(TOKEN_ID);
        vm.stopPrank();
    }

    // ───────────────── owner cannot rug an existing lock ─────────────────

    function test_owner_cannotWithdrawExistingLock() public {
        uint64 unlockTime = _mintAndLock(TOKEN_ID);
        vm.warp(unlockTime + 1);
        vm.prank(owner);
        vm.expectRevert(MonLock.NotBeneficiary.selector);
        lock.withdraw(TOKEN_ID);
    }

    function test_owner_setDefaults_cannotRedirectOrShortenExistingLock() public {
        uint64 unlockTime = _mintAndLock(TOKEN_ID);

        // Owner tries to hijack: point defaults at the attacker with a 1-second term.
        vm.prank(owner);
        vm.expectRevert(MonLock.DurationTooShort.selector);
        lock.setDefaults(attacker, 1);

        // The EXISTING lock is untouched — same beneficiary, same unlock time.
        (address ben, uint64 ut, bool withdrawn,,) = lock.locks(TOKEN_ID);
        assertEq(ben, beneficiary);
        assertEq(ut, unlockTime);
        assertFalse(withdrawn);

        // And the attacker still can't pull it after the "1s" they tried to set.
        vm.warp(block.timestamp + 2);
        vm.prank(attacker);
        vm.expectRevert(MonLock.NotBeneficiary.selector);
        lock.withdraw(TOKEN_ID);
    }

    function test_newOwner_stillCannotTouchExistingLocks() public {
        uint64 unlockTime = _mintAndLock(TOKEN_ID);
        vm.prank(owner);
        lock.transferOwnership(attacker); // attacker is now owner

        vm.startPrank(attacker);
        vm.expectRevert(MonLock.DurationTooShort.selector);
        lock.setDefaults(attacker, 1); // owner powers = defaults only
        vm.warp(unlockTime + 1);
        vm.expectRevert(MonLock.NotBeneficiary.selector);
        lock.withdraw(TOKEN_ID); // ...which still don't reach an existing lock
        vm.stopPrank();
    }

    function test_onlyOwner_canSetDefaultsAndTransferOwnership() public {
        vm.startPrank(attacker);
        vm.expectRevert(MonLock.NotOwner.selector);
        lock.setDefaults(attacker, DUR);
        vm.expectRevert(MonLock.NotOwner.selector);
        lock.transferOwnership(attacker);
        vm.stopPrank();
    }

    // ───────────────── fees: redirectable? principal extractable? ─────────────────

    function test_attackerCallingCollect_feesStillGoToBeneficiary() public {
        _mintAndLock(TOKEN_ID);
        vm.prank(attacker); // permissionless to call...
        lock.collectFees(TOKEN_ID);
        assertEq(nfpm.lastCollectRecipient(), beneficiary); // ...but recipient is fixed
        assertEq(nfpm.ownerOf(TOKEN_ID), address(lock)); // principal untouched
    }

    function test_collectFees_neverMovesPrincipal() public {
        _mintAndLock(TOKEN_ID);
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(beneficiary);
            lock.collectFees(TOKEN_ID);
            assertEq(nfpm.ownerOf(TOKEN_ID), address(lock)); // NFT stays locked across many collects
        }
        assertEq(nfpm.collectCalls(), 5);
    }

    // ───────────────── reentrancy (cross-function, via hostile NFPM) ─────────────────

    function test_reentrancy_collectFees_blocked() public {
        ReentrantNFPM evil = new ReentrantNFPM();
        MonLock l = new MonLock(address(evil), beneficiary, owner, DUR);
        evil.setTarget(l);
        evil.setMode(0); // reenter collectFees during collect
        evil.mintTo(address(l), TOKEN_ID);
        l.lockPosition(TOKEN_ID);

        l.collectFees(TOKEN_ID); // outer call completes
        assertTrue(evil.reentryAttempted());
        assertTrue(evil.reentryBlocked()); // the guard caught the re-entry
    }

    function test_reentrancy_withdraw_crossCalls_blocked() public {
        ReentrantNFPM evil = new ReentrantNFPM();
        MonLock l = new MonLock(address(evil), beneficiary, owner, DUR);
        evil.setTarget(l);
        evil.setMode(0); // during withdraw's transferFrom, try to reenter collectFees
        evil.mintTo(address(l), TOKEN_ID);
        uint64 unlockTime = l.lockPosition(TOKEN_ID);

        vm.warp(unlockTime);
        vm.prank(beneficiary);
        l.withdraw(TOKEN_ID); // outer withdraw completes
        assertTrue(evil.reentryAttempted());
        assertTrue(evil.reentryBlocked()); // cross-function re-entry blocked by the shared guard
        assertEq(evil.ownerOf(TOKEN_ID), beneficiary);
    }

    // ───────────────── lock-term integrity ─────────────────

    function test_extendLock_cannotShorten_andOnlyBeneficiary() public {
        uint64 unlockTime = _mintAndLock(TOKEN_ID);

        vm.prank(attacker);
        vm.expectRevert(MonLock.NotBeneficiary.selector);
        lock.extendLock(TOKEN_ID, unlockTime + 30 days);

        vm.prank(beneficiary);
        vm.expectRevert(MonLock.MustExtend.selector);
        lock.extendLock(TOKEN_ID, unlockTime - 1); // shorter is rejected

        vm.prank(beneficiary);
        lock.extendLock(TOKEN_ID, unlockTime + 30 days); // longer is fine
        (, uint64 ut,,,) = lock.locks(TOKEN_ID);
        assertEq(ut, unlockTime + 30 days);
    }

    function test_setLockBeneficiary_onlyBeneficiary_notZero_revokesOld() public {
        _mintAndLock(TOKEN_ID);

        vm.prank(attacker);
        vm.expectRevert(MonLock.NotBeneficiary.selector);
        lock.setLockBeneficiary(TOKEN_ID, attacker);

        vm.prank(beneficiary);
        vm.expectRevert(MonLock.ZeroAddress.selector);
        lock.setLockBeneficiary(TOKEN_ID, address(0));

        vm.prank(beneficiary);
        lock.setLockBeneficiary(TOKEN_ID, treasury); // legit handoff

        // Old beneficiary is now powerless.
        vm.prank(beneficiary);
        vm.expectRevert(MonLock.NotBeneficiary.selector);
        lock.setLockBeneficiary(TOKEN_ID, beneficiary);
    }

    // ───────────────── registration / deposit integrity ─────────────────

    function test_lockPosition_requiresActuallyHeld() public {
        // Attacker references an NFT MonLock doesn't hold → can't stamp a fake lock.
        nfpm.mintTo(attacker, TOKEN_ID);
        vm.prank(attacker);
        vm.expectRevert(MonLock.NotHeld.selector);
        lock.lockPosition(TOKEN_ID);
    }

    function test_lockPosition_idempotent_attackerCannotRestamp() public {
        _mintAndLock(TOKEN_ID);
        vm.prank(attacker);
        vm.expectRevert(MonLock.AlreadyLocked.selector);
        lock.lockPosition(TOKEN_ID); // can't re-stamp to reset terms
    }

    function test_onERC721Received_rejectsNonNFPM() public {
        // A random caller (not the position manager) can't inject a lock record.
        vm.prank(attacker);
        vm.expectRevert(MonLock.NotPositionManager.selector);
        lock.onERC721Received(attacker, attacker, TOKEN_ID, "");
    }

    // ───────────────── documented footgun (low severity, self-inflicted) ─────────────────

    function test_redepositWithdrawnPosition_reverts() public {
        uint64 unlockTime = _mintAndLock(TOKEN_ID);
        vm.warp(unlockTime);
        vm.prank(beneficiary);
        lock.withdraw(TOKEN_ID);
        assertEq(nfpm.ownerOf(TOKEN_ID), beneficiary);

        vm.prank(address(nfpm));
        vm.expectRevert(MonLock.AlreadyWithdrawn.selector);
        lock.onERC721Received(beneficiary, beneficiary, TOKEN_ID, "");
    }

    // ───────────────── fuzz: no early exit, ever ─────────────────

    function testFuzz_neverWithdrawableBeforeUnlock(uint64 dur, uint256 warpBy, address caller) public {
        dur = uint64(bound(dur, uint256(lock.MIN_LOCK_DURATION()), 3650 days));
        warpBy = bound(warpBy, 0, uint256(dur) - 1); // strictly before unlock
        vm.assume(caller != address(0));

        vm.prank(owner);
        lock.setDefaults(beneficiary, dur);
        uint64 unlockTime = _mintAndLock(TOKEN_ID);

        vm.warp(uint256(block.timestamp) + warpBy);
        vm.prank(caller);
        vm.expectRevert(); // StillLocked (beneficiary) or NotBeneficiary (anyone else) — never succeeds
        lock.withdraw(TOKEN_ID);

        // Invariant: still held by the locker.
        assertEq(nfpm.ownerOf(TOKEN_ID), address(lock));
        assertLe(block.timestamp, unlockTime - 1);
    }
}

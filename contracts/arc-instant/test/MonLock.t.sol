// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MonLock, INonfungiblePositionManager} from "../src/MonLock.sol";

/// @dev Minimal NFPM stand-in: tracks ownerOf, records collect calls (returns fixed "fees"), and
///      supports transferFrom — enough to exercise MonLock without a live UniV3 fork.
contract MockNFPM {
    uint256 public constant FEE0 = 111;
    uint256 public constant FEE1 = 222;

    mapping(uint256 => address) public ownerOf;
    address public lastRecipient;
    uint256 public lastTokenId;
    uint256 public collectCalls;

    function mintTo(address to, uint256 tokenId) external {
        ownerOf[tokenId] = to;
    }

    function collect(INonfungiblePositionManager.CollectParams calldata p)
        external
        payable
        returns (uint256, uint256)
    {
        lastRecipient = p.recipient;
        lastTokenId = p.tokenId;
        collectCalls++;
        return (FEE0, FEE1);
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        require(ownerOf[tokenId] == from, "not owner");
        ownerOf[tokenId] = to;
    }
}

contract MonLockTest is Test {
    MonLock internal lock;
    MockNFPM internal nfpm;
    address internal beneficiary = makeAddr("beneficiary"); // deployer / fee wallet
    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");
    uint64 internal constant DUR = 365 days;

    function setUp() public {
        nfpm = new MockNFPM();
        lock = new MonLock(address(nfpm), beneficiary, owner, DUR);
    }

    function _mintAndLock(uint256 tokenId) internal {
        nfpm.mintTo(address(lock), tokenId);
        lock.lockPosition(tokenId);
    }

    // ── registration ──
    function test_lockPosition_requiresHeld() public {
        vm.expectRevert(MonLock.NotHeld.selector);
        lock.lockPosition(1); // NFPM ownerOf == 0, not the locker
    }

    function test_lockPosition_stamps() public {
        nfpm.mintTo(address(lock), 7);
        uint64 t0 = uint64(block.timestamp);
        lock.lockPosition(7);
        (address b, uint64 unlockTime, bool withdrawn,,) = lock.locks(7);
        assertEq(b, beneficiary);
        assertEq(unlockTime, t0 + DUR);
        assertFalse(withdrawn);
        assertEq(lock.lockedCount(), 1);
    }

    function test_lockPosition_doubleReverts() public {
        _mintAndLock(7);
        vm.expectRevert(MonLock.AlreadyLocked.selector);
        lock.lockPosition(7);
    }

    function test_onERC721Received_onlyNFPM() public {
        vm.prank(stranger);
        vm.expectRevert(MonLock.NotPositionManager.selector);
        lock.onERC721Received(address(0), address(0), 1, "");

        vm.prank(address(nfpm));
        bytes4 sel = lock.onERC721Received(address(0), address(0), 1, "");
        assertEq(sel, lock.onERC721Received.selector);
        assertTrue(lock.seen(1));
    }

    // ── fees ──
    function test_collectFees_routesToBeneficiary() public {
        _mintAndLock(7);
        (uint256 a0, uint256 a1) = lock.collectFees(7);
        assertEq(a0, nfpm.FEE0());
        assertEq(a1, nfpm.FEE1());
        assertEq(nfpm.lastRecipient(), beneficiary, "fees must go to beneficiary");
    }

    function test_collectFees_notLockedReverts() public {
        vm.expectRevert(MonLock.NotLocked.selector);
        lock.collectFees(99);
    }

    // ── reclaim ──
    function test_withdraw_beforeUnlockReverts() public {
        _mintAndLock(7);
        vm.prank(beneficiary);
        vm.expectRevert(MonLock.StillLocked.selector);
        lock.withdraw(7);
    }

    function test_withdraw_afterUnlock() public {
        _mintAndLock(7);
        vm.warp(block.timestamp + DUR + 1);
        vm.prank(beneficiary);
        lock.withdraw(7);
        assertEq(nfpm.ownerOf(7), beneficiary, "NFT returned to beneficiary");
        (, , bool withdrawn,,) = lock.locks(7);
        assertTrue(withdrawn);
        // fees no longer collectable post-withdraw
        vm.expectRevert(MonLock.AlreadyWithdrawn.selector);
        lock.collectFees(7);
    }

    function test_withdraw_onlyBeneficiary() public {
        _mintAndLock(7);
        vm.warp(block.timestamp + DUR + 1);
        vm.prank(stranger);
        vm.expectRevert(MonLock.NotBeneficiary.selector);
        lock.withdraw(7);
    }

    // ── extend (longer only) ──
    function test_extendLock() public {
        _mintAndLock(7);
        (, uint64 unlock0, ,,) = lock.locks(7);
        vm.prank(beneficiary);
        lock.extendLock(7, unlock0 + 30 days);
        (, uint64 unlock1, ,,) = lock.locks(7);
        assertEq(unlock1, unlock0 + 30 days);

        vm.prank(beneficiary);
        vm.expectRevert(MonLock.MustExtend.selector);
        lock.extendLock(7, unlock0); // shorter → revert
    }

    function test_setLockBeneficiary() public {
        _mintAndLock(7);
        vm.prank(beneficiary);
        lock.setLockBeneficiary(7, stranger);
        lock.collectFees(7);
        assertEq(nfpm.lastRecipient(), stranger, "fees now route to new beneficiary");
    }

    // ── admin defaults can't retro-change existing locks (the trust property) ──
    function test_setDefaults_onlyFutureLocks() public {
        _mintAndLock(7); // beneficiary, +DUR
        (address b7, uint64 u7, ,,) = lock.locks(7);

        vm.prank(stranger);
        vm.expectRevert(MonLock.NotOwner.selector);
        lock.setDefaults(stranger, 30 days);

        vm.prank(owner);
        lock.setDefaults(stranger, 30 days);

        // existing lock untouched
        (address b7b, uint64 u7b, ,,) = lock.locks(7);
        assertEq(b7b, b7);
        assertEq(u7b, u7);

        // new lock uses new defaults
        nfpm.mintTo(address(lock), 8);
        uint64 t = uint64(block.timestamp);
        lock.lockPosition(8);
        (address b8, uint64 u8, ,,) = lock.locks(8);
        assertEq(b8, stranger);
        assertEq(u8, t + 30 days);
    }
}

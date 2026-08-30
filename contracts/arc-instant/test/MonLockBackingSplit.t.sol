// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MonLock, INonfungiblePositionManager} from "../src/MonLock.sol";

contract FeeToken is ERC20 {
    constructor(string memory n) ERC20(n, n) {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// @dev NFPM mock that pays real fee tokens on `collect` (to the requested recipient) and reports the
///      position's two token addresses via `positions` — enough to exercise MonLock's fee split.
contract MockNFPM {
    mapping(uint256 => address) public ownerOf;
    address public t0;
    address public t1;
    uint128 public fee0;
    uint128 public fee1;

    function mintTo(address to, uint256 id) external { ownerOf[id] = to; }
    function setTokens(address a, address b) external { t0 = a; t1 = b; }
    function setFees(uint128 f0, uint128 f1) external { fee0 = f0; fee1 = f1; }

    function collect(INonfungiblePositionManager.CollectParams calldata p)
        external
        payable
        returns (uint256, uint256)
    {
        uint256 a0 = fee0;
        uint256 a1 = fee1;
        if (a0 > 0) IERC20(t0).transfer(p.recipient, a0);
        if (a1 > 0) IERC20(t1).transfer(p.recipient, a1);
        return (a0, a1);
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from, "not owner");
        ownerOf[id] = to;
    }

    function positions(uint256)
        external
        view
        returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)
    {
        return (0, address(0), t0, t1, 0, 0, 0, 0, 0, 0, 0, 0);
    }
}

/// @notice Tests for the 70/30 (configurable) backing-split locks. Proves the split routes only FEE
///         tokens (never principal), is stamper-gated, bps-immutable after stamp (recipients may be
///         retargeted by owner), and that the legacy plain-lock path is unchanged.
contract MonLockBackingSplitTest is Test {
    MonLock internal lock;
    MockNFPM internal nfpm;
    FeeToken internal feeA; // token0 (e.g. the launch token)
    FeeToken internal feeB; // token1 (e.g. WETH/quote)

    address internal beneficiary = makeAddr("beneficiary"); // platform / treasury
    address internal backing = makeAddr("backing"); // RWA NAV-floor / perp-margin wallet
    address internal staker = makeAddr("staker"); // the staking pool (post-bond 3-way leg)
    address internal owner = makeAddr("owner");
    address internal stamper = makeAddr("stamper"); // the curve factory
    address internal attacker = makeAddr("attacker");
    uint64 internal constant DUR = 365 days;
    uint16 internal constant BPS = 7000; // 70% to backing
    uint256 internal constant ID = 42;

    function setUp() public {
        nfpm = new MockNFPM();
        feeA = new FeeToken("FEEA");
        feeB = new FeeToken("FEEB");
        nfpm.setTokens(address(feeA), address(feeB));
        feeA.mint(address(nfpm), 1_000_000 ether); // the NFPM's fee reservoir
        feeB.mint(address(nfpm), 1_000_000 ether);

        lock = new MonLock(address(nfpm), beneficiary, owner, DUR);
        vm.prank(owner);
        lock.setStamper(stamper);
    }

    function _stampBacking(uint256 id, uint16 bps) internal {
        nfpm.mintTo(address(lock), id);
        vm.prank(stamper);
        lock.lockPositionWithBacking(id, backing, bps);
    }

    // ───────────────── the split: 70/30 across both fee tokens ─────────────────

    function test_split_routes70ToBacking_30ToBeneficiary() public {
        _stampBacking(ID, BPS);
        nfpm.setFees(1000 ether, 500 ether);

        lock.collectFees(ID);

        assertEq(feeA.balanceOf(backing), 700 ether); // 70% of 1000
        assertEq(feeA.balanceOf(beneficiary), 300 ether); // 30%
        assertEq(feeB.balanceOf(backing), 350 ether); // 70% of 500
        assertEq(feeB.balanceOf(beneficiary), 150 ether); // 30%
        // The locker keeps nothing — it's a pure pass-through.
        assertEq(feeA.balanceOf(address(lock)), 0);
        assertEq(feeB.balanceOf(address(lock)), 0);
    }

    // ───────────── 3-way (post-bond perp): 50 backing / 20 staker / 30 beneficiary ─────────────

    function test_split3way_routesBackingStakerBeneficiary() public {
        nfpm.mintTo(address(lock), ID);
        vm.prank(stamper);
        lock.lockPositionWithSplit(ID, backing, 5000, staker, 2000); // 50% backing, 20% staker
        nfpm.setFees(1000 ether, 500 ether);

        lock.collectFees(ID);

        assertEq(feeA.balanceOf(backing), 500 ether); // 50%
        assertEq(feeA.balanceOf(staker), 200 ether); // 20%
        assertEq(feeA.balanceOf(beneficiary), 300 ether); // 30% remainder
        assertEq(feeB.balanceOf(backing), 250 ether); // 50% of 500
        assertEq(feeB.balanceOf(staker), 100 ether); // 20%
        assertEq(feeB.balanceOf(beneficiary), 150 ether); // 30%
        assertEq(feeA.balanceOf(address(lock)), 0); // pure pass-through
        assertEq(feeB.balanceOf(address(lock)), 0);
        (address w, uint16 bps) = lock.stakerSplits(ID); // leg recorded off the Lock struct
        assertEq(w, staker);
        assertEq(bps, 2000);

        // This lock was stamped via the non-launch 3-way path (lockPositionWithSplit), which never
        // touches creatorSplits -- proves a lock with no creator leg defaults to the zero value and
        // its routing above is unaffected by the creator leg's existence elsewhere in the contract.
        (address cWallet, uint16 cBps) = lock.creatorSplits(ID);
        assertEq(cWallet, address(0), "no creator leg for a lock stamped via the non-launch 3-way path");
        assertEq(cBps, 0);
    }

    function test_split3way_rejectsCombinedOver100pct() public {
        nfpm.mintTo(address(lock), ID);
        vm.prank(stamper);
        vm.expectRevert(); // backing 7000 + staker 3001 > 100%
        lock.lockPositionWithSplit(ID, backing, 7000, staker, 3001);
    }

    function test_split_neverMovesPrincipal() public {
        _stampBacking(ID, BPS);
        for (uint256 i = 0; i < 4; i++) {
            nfpm.setFees(100 ether, 100 ether);
            lock.collectFees(ID);
            assertEq(nfpm.ownerOf(ID), address(lock)); // NFT stays locked across many splits
        }
    }

    function test_split_withdrawReturnsPrincipalToBeneficiaryNotBacking() public {
        _stampBacking(ID, BPS);
        // accrue + split some fees first
        nfpm.setFees(10 ether, 10 ether);
        lock.collectFees(ID);

        vm.warp(block.timestamp + DUR);
        vm.prank(beneficiary);
        lock.withdraw(ID);
        assertEq(nfpm.ownerOf(ID), beneficiary); // principal → beneficiary, NOT the backing wallet
    }

    // ───────────────── authorization ─────────────────

    function test_onlyStamper_canSetBacking() public {
        nfpm.mintTo(address(lock), ID);
        vm.prank(attacker);
        vm.expectRevert(MonLock.NotStamper.selector);
        lock.lockPositionWithBacking(ID, attacker, BPS);

        // even the owner is not the stamper unless explicitly set
        vm.prank(owner);
        vm.expectRevert(MonLock.NotStamper.selector);
        lock.lockPositionWithBacking(ID, owner, BPS);
    }

    function test_badBps_andZeroBackingRevert() public {
        nfpm.mintTo(address(lock), ID);
        vm.startPrank(stamper);
        vm.expectRevert(MonLock.BadBps.selector);
        lock.lockPositionWithBacking(ID, backing, 10_001); // > 100%
        vm.expectRevert(MonLock.ZeroAddress.selector);
        lock.lockPositionWithBacking(ID, address(0), BPS); // split set but no backing wallet
        vm.stopPrank();
    }

    // ───────────────── stamp immutability + owner recipient retarget ─────────────────

    function test_split_cannotRestamp_butOwnerCanRetargetRecipients() public {
        nfpm.mintTo(address(lock), ID);
        vm.prank(stamper);
        lock.lockPositionWithSplit(ID, backing, 5000, staker, 2000); // mirrors $ROBIN #1753

        // Re-stamp via a rotated stamper is still blocked by `seen` (bps stay fixed).
        vm.prank(owner);
        lock.setStamper(attacker);
        vm.prank(attacker);
        vm.expectRevert(MonLock.AlreadyLocked.selector);
        lock.lockPositionWithSplit(ID, attacker, 10_000, attacker, 0);

        // Stranger cannot retarget.
        vm.prank(attacker);
        vm.expectRevert(MonLock.NotOwner.selector);
        lock.retargetFeeRecipients(ID, attacker, attacker);

        // Owner retargets backing + staker wallets to platform (bps unchanged).
        address platform = makeAddr("platform");
        vm.prank(owner);
        lock.retargetFeeRecipients(ID, platform, platform);

        (address bWallet, uint64 unlockTime, bool withdrawn, address newBacking, uint16 backingBps) = lock.locks(ID);
        assertEq(bWallet, beneficiary);
        assertFalse(withdrawn);
        assertTrue(unlockTime > 0);
        assertEq(newBacking, platform);
        assertEq(backingBps, 5000);
        (address sWallet, uint16 sBps) = lock.stakerSplits(ID);
        assertEq(sWallet, platform);
        assertEq(sBps, 2000);

        nfpm.setFees(1000 ether, 0);
        lock.collectFees(ID);
        assertEq(feeA.balanceOf(platform), 700 ether); // 50% + 20%
        assertEq(feeA.balanceOf(beneficiary), 300 ether); // remainder
        assertEq(feeA.balanceOf(backing), 0);
        assertEq(feeA.balanceOf(staker), 0);
    }

    function test_retargetFeeRecipients_zeroMeansLeaveUntouched() public {
        nfpm.mintTo(address(lock), ID);
        vm.prank(stamper);
        lock.lockPositionWithSplit(ID, backing, 5000, staker, 2000);

        // Only move staker; leave backing.
        address platform = makeAddr("platform");
        vm.prank(owner);
        lock.retargetFeeRecipients(ID, address(0), platform);

        (,,, address newBacking, uint16 backingBps) = lock.locks(ID);
        assertEq(newBacking, backing);
        assertEq(backingBps, 5000);
        (address sWallet, uint16 sBps) = lock.stakerSplits(ID);
        assertEq(sWallet, platform);
        assertEq(sBps, 2000);
    }

    // ───────────────── legacy plain-lock path unchanged ─────────────────

    function test_plainLock_stillCollects100ToBeneficiary() public {
        nfpm.mintTo(address(lock), ID);
        lock.lockPosition(ID); // permissionless, no split
        nfpm.setFees(1000 ether, 500 ether);
        lock.collectFees(ID);
        assertEq(feeA.balanceOf(beneficiary), 1000 ether); // 100%
        assertEq(feeB.balanceOf(beneficiary), 500 ether);
        assertEq(feeA.balanceOf(backing), 0);
    }

    function test_zeroBps_viaStamper_behavesLikePlain() public {
        nfpm.mintTo(address(lock), ID);
        vm.prank(stamper);
        lock.lockPositionWithBacking(ID, address(0), 0); // 0 bps + no wallet is allowed (= plain)
        nfpm.setFees(1000 ether, 0);
        lock.collectFees(ID);
        assertEq(feeA.balanceOf(beneficiary), 1000 ether);
    }
}

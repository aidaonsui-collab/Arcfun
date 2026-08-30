// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CrucibleLock} from "../src/CrucibleLock.sol";
import {Crucible} from "../src/Crucible.sol";
import {ReferralRegistry} from "../src/ReferralRegistry.sol";
import {MockERC20, MockSwapRouter, MockNFPM} from "./mocks/Mocks.sol";

/// Regression tests for the review findings. These used to pass as exploit PoCs.
/// Green now means the hole is closed.
contract ReviewPoCTest is Test {
    CrucibleLock internal locker;
    Crucible internal crucible;
    ReferralRegistry internal registry;
    MockERC20 internal usdc;
    MockERC20 internal launch;
    MockERC20 internal arcfun;
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
        arcfun = new MockERC20("EVE", "EVE", 18);
        router = new MockSwapRouter();
        nfpm = new MockNFPM();
        registry = new ReferralRegistry();
        crucible = new Crucible(address(usdc), address(router), address(arcfun), 10_000);
        locker = new CrucibleLock(
            address(nfpm), address(usdc), address(router), address(crucible), address(registry), platform
        );
        nfpm.mint(TOKEN_ID, address(this), address(usdc), address(launch), 10_000);
        nfpm.approve(address(locker), TOKEN_ID);
        locker.lock(TOKEN_ID, creator, CrucibleLock.Kind.Meme, address(0), "");
        launch.mint(address(router), 1_000_000e18);
    }

    function _seedFees(uint256 usdcFee) internal {
        usdc.mint(address(nfpm), usdcFee);
        nfpm.setOwed(TOKEN_ID, uint128(usdcFee), 0);
    }

    function test_PoC_anyoneCanSelfAssignReferrerLeg() public {
        vm.prank(attacker);
        registry.register("totally-unrelated", attacker);

        _seedFees(10_000e6);
        vm.prank(attacker);
        locker.collectFees(TOKEN_ID);

        assertEq(usdc.balanceOf(attacker), 0);
        assertEq(usdc.balanceOf(address(crucible)), 3_000e6);
    }

    function test_PoC_projectBurnAcceptsAnyOutput() public {
        _seedFees(10_000e6);
        locker.collectFees(TOKEN_ID);
        // collect no longer swaps
        assertEq(launch.balanceOf(dead), 0);
        assertEq(locker.pendingProjectBurn(TOKEN_ID), 1_000e6);

        router.setOutPerIn(1);
        vm.expectRevert();
        locker.projectBurn(TOKEN_ID, 1_000e18);
        assertEq(launch.balanceOf(dead), 0);
        assertEq(locker.pendingProjectBurn(TOKEN_ID), 1_000e6);
    }

    function test_PoC_oneBlockedRecipientFreezesEveryone() public {
        BlockingERC20 bUsdc = new BlockingERC20();
        MockNFPM n2 = new MockNFPM();
        Crucible c2 = new Crucible(address(bUsdc), address(router), address(launch), 10_000);
        CrucibleLock l2 = new CrucibleLock(
            address(n2), address(bUsdc), address(router), address(c2), address(registry), platform
        );
        n2.mint(TOKEN_ID, address(this), address(bUsdc), address(launch), 10_000);
        n2.approve(address(l2), TOKEN_ID);
        l2.lock(TOKEN_ID, creator, CrucibleLock.Kind.Meme, address(0), "");

        bUsdc.mint(address(n2), 10_000e6);
        n2.setOwed(TOKEN_ID, uint128(10_000e6), 0);
        bUsdc.setBlocked(creator, true);

        l2.collectFees(TOKEN_ID);

        assertEq(bUsdc.balanceOf(platform), 1_000e6);
        assertEq(bUsdc.balanceOf(address(c2)), 3_000e6);
        assertEq(bUsdc.balanceOf(creator), 0);
        assertEq(l2.owed(address(bUsdc), creator), 5_000e6);

        bUsdc.setBlocked(creator, false);
        l2.withdrawOwed(address(bUsdc), creator);
        assertEq(bUsdc.balanceOf(creator), 5_000e6);
        assertEq(l2.owed(address(bUsdc), creator), 0);
    }
}

contract BlockingERC20 {
    string public name = "USD Coin";
    string public symbol = "USDC";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;

    function setBlocked(address who, bool v) external {
        blocked[who] = v;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

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

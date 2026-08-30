// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CrucibleLock} from "../src/CrucibleLock.sol";
import {Crucible} from "../src/Crucible.sol";
import {ReferralRegistry} from "../src/ReferralRegistry.sol";
import {MockERC20, MockSwapRouter, MockNFPM} from "./mocks/Mocks.sol";

contract CrucibleSplitsTest is Test {
    CrucibleLock internal lock;
    MockERC20 internal usdc;
    MockSwapRouter internal router;
    MockNFPM internal nfpm;
    Crucible internal crucible;
    ReferralRegistry internal registry;
    MockERC20 internal arcfun;

    address internal platform = makeAddr("platform");

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        arcfun = new MockERC20("EVE", "EVE", 18);
        router = new MockSwapRouter();
        nfpm = new MockNFPM();
        registry = new ReferralRegistry();
        crucible = new Crucible(address(usdc), address(router), address(arcfun), 10_000);
        lock = new CrucibleLock(
            address(nfpm), address(usdc), address(router), address(crucible), address(registry), platform
        );
    }

    function test_memeBpsSumToDenom() public pure {
        uint256 sum = uint256(5000) + 2500 + 1000 + 1000 + 500;
        assertEq(sum, 10_000);
    }

    function test_reflectBpsSumToDenom() public pure {
        uint256 sum = uint256(2000) + 3000 + 2000 + 1500 + 1000 + 500;
        assertEq(sum, 10_000);
    }

    function test_memeSplitExact() public view {
        CrucibleLock.Split memory s = lock.quoteSplit(10_000, CrucibleLock.Kind.Meme, true);
        assertEq(s.creator, 5_000);
        assertEq(s.crucible, 2_500);
        assertEq(s.projectBurn, 1_000);
        assertEq(s.platform, 1_000);
        assertEq(s.referrer, 500);
        assertEq(s.holders, 0);
        assertEq(s.creator + s.crucible + s.projectBurn + s.platform + s.referrer + s.holders, 10_000);
    }

    function test_reflectSplitExact() public view {
        CrucibleLock.Split memory s = lock.quoteSplit(10_000, CrucibleLock.Kind.Reflect, true);
        assertEq(s.holders, 2_000);
        assertEq(s.crucible, 3_000);
        assertEq(s.creator, 2_000);
        assertEq(s.projectBurn, 1_500);
        assertEq(s.platform, 1_000);
        assertEq(s.referrer, 500);
        assertEq(s.creator + s.crucible + s.projectBurn + s.platform + s.referrer + s.holders, 10_000);
    }

    function test_unknownReferrerFoldsIntoCrucible_meme() public view {
        CrucibleLock.Split memory s = lock.quoteSplit(10_000, CrucibleLock.Kind.Meme, false);
        assertEq(s.referrer, 0);
        assertEq(s.crucible, 3_000); // 2500 + 500
        assertEq(s.creator, 5_000);
        assertEq(s.creator + s.crucible + s.projectBurn + s.platform + s.referrer + s.holders, 10_000);
    }

    function test_unknownReferrerFoldsIntoCrucible_reflect() public view {
        CrucibleLock.Split memory s = lock.quoteSplit(10_000, CrucibleLock.Kind.Reflect, false);
        assertEq(s.referrer, 0);
        assertEq(s.crucible, 3_500); // 3000 + 500
        assertEq(s.holders, 2_000);
        assertEq(s.creator + s.crucible + s.projectBurn + s.platform + s.referrer + s.holders, 10_000);
    }

    function test_remainderDustGoesToCrucible(uint256 usdcAmount) public view {
        usdcAmount = bound(usdcAmount, 1, 1e18);
        CrucibleLock.Split memory s = lock.quoteSplit(usdcAmount, CrucibleLock.Kind.Meme, true);
        uint256 used = s.creator + s.crucible + s.projectBurn + s.platform + s.referrer + s.holders;
        assertEq(used, usdcAmount);
    }

    function test_remainderDustGoesToCrucible_noReferrer(uint256 usdcAmount) public view {
        usdcAmount = bound(usdcAmount, 1, 1e18);
        CrucibleLock.Split memory s = lock.quoteSplit(usdcAmount, CrucibleLock.Kind.Reflect, false);
        uint256 used = s.creator + s.crucible + s.projectBurn + s.platform + s.referrer + s.holders;
        assertEq(used, usdcAmount);
    }
}

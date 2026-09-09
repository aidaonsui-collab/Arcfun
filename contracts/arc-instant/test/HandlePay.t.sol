// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HandlePay, HandlePayFactory} from "../src/HandlePay.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockPayToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}
    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

contract HandlePayTest is Test {
    HandlePayFactory factory;
    MockPayToken usdc;

    uint256 signerKey = 0xA11CE;
    address signerAddr;
    address launcher = address(0xBEEF);
    address recipient = address(0xCAFE);
    bytes32 constant HANDLE = keccak256("bluefongarc");

    function setUp() public {
        signerAddr = vm.addr(signerKey);
        factory = new HandlePayFactory(signerAddr);
        usdc = new MockPayToken();
        vm.deal(launcher, 10 ether);
    }

    function _vault() internal returns (HandlePay) {
        return HandlePay(payable(factory.deployVault(HANDLE)));
    }

    function _sign(HandlePay v, address to, uint256 nonce, uint256 key) internal view returns (bytes memory) {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                v.domainSeparator(),
                keccak256(abi.encode(keccak256("Claim(address recipient,uint256 nonce)"), to, nonce))
            )
        );
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, vv);
    }

    function test_computeVault_matchesDeployment() public {
        address predicted = factory.computeVault(HANDLE);
        address deployed = factory.deployVault(HANDLE);
        assertEq(predicted, deployed);
        assertEq(factory.deployVault(HANDLE), deployed); // idempotent
        assertEq(factory.vaultOf(HANDLE), deployed);
    }

    function test_computeVault_differentHandles() public {
        bytes32 other = keccak256("someoneelse");
        assertTrue(factory.computeVault(HANDLE) != factory.computeVault(other));
    }

    function test_claim_sweepsEthAndTokens_andIncrementsNonce() public {
        HandlePay v = _vault();
        vm.deal(address(v), 3 ether);
        usdc.mint(address(v), 5e6);

        IERC20[] memory toks = new IERC20[](1);
        toks[0] = IERC20(address(usdc));
        v.claim(recipient, toks, _sign(v, recipient, 0, signerKey));

        assertEq(recipient.balance, 3 ether);
        assertEq(usdc.balanceOf(recipient), 5e6);
        assertEq(v.nonce(), 1);
        assertEq(uint256(v.lastClaimAt()), block.timestamp);
    }

    function test_claim_replayRejected_and_repeatableWithNewVoucher() public {
        HandlePay v = _vault();
        vm.deal(address(v), 1 ether);
        IERC20[] memory none = new IERC20[](0);
        bytes memory sig0 = _sign(v, recipient, 0, signerKey);
        v.claim(recipient, none, sig0);

        vm.deal(address(v), 1 ether);
        vm.expectRevert(HandlePay.BadSignature.selector);
        v.claim(recipient, none, sig0);

        v.claim(recipient, none, _sign(v, recipient, 1, signerKey));
        assertEq(recipient.balance, 2 ether);
    }

    function test_claim_wrongSigner_reverts() public {
        HandlePay v = _vault();
        vm.deal(address(v), 1 ether);
        IERC20[] memory none = new IERC20[](0);
        bytes memory badSig = _sign(v, recipient, 0, 0xBAD);
        vm.expectRevert(HandlePay.BadSignature.selector);
        v.claim(recipient, none, badSig);
    }

    function test_signerRotation_appliesToExistingVaults() public {
        HandlePay v = _vault();
        vm.deal(address(v), 1 ether);
        uint256 newKey = 0xD00D;
        factory.setSigner(vm.addr(newKey));
        IERC20[] memory none = new IERC20[](0);
        bytes memory oldSig = _sign(v, recipient, 0, signerKey);
        bytes memory newSig = _sign(v, recipient, 0, newKey);
        vm.expectRevert(HandlePay.BadSignature.selector);
        v.claim(recipient, none, oldSig);
        v.claim(recipient, none, newSig);
        assertEq(recipient.balance, 1 ether);
    }

    function test_rescue_onlyAfterOneYear_andOnlyOwner() public {
        HandlePay v = _vault();
        vm.deal(address(v), 2 ether);
        IERC20[] memory none = new IERC20[](0);

        vm.expectRevert(HandlePay.NotDormant.selector);
        v.rescue(address(this), none);

        vm.warp(block.timestamp + 365 days);
        vm.prank(launcher);
        vm.expectRevert(HandlePay.NotOwner.selector);
        v.rescue(launcher, none);

        uint256 before = address(this).balance;
        v.rescue(address(this), none);
        assertEq(address(this).balance - before, 2 ether);
    }

    function test_claim_resetsDormancyClock() public {
        HandlePay v = _vault();
        vm.deal(address(v), 1 ether);
        IERC20[] memory none = new IERC20[](0);
        vm.warp(block.timestamp + 300 days);
        v.claim(recipient, none, _sign(v, recipient, 0, signerKey));
        vm.deal(address(v), 1 ether);
        vm.warp(block.timestamp + 100 days);
        vm.expectRevert(HandlePay.NotDormant.selector);
        v.rescue(address(this), none);
        vm.warp(block.timestamp + 266 days);
        v.rescue(address(this), none);
    }

    function test_constructor_zeroSigner_reverts() public {
        vm.expectRevert(HandlePayFactory.ZeroAddress.selector);
        new HandlePayFactory(address(0));
    }

    receive() external payable {}
}

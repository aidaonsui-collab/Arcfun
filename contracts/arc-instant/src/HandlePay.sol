// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title HandlePay — creator-fee escrow bound to an X handle.
 *
 * One vault per handle, deployed at a CREATE2 address derived from
 * keccak256(lowercase handle). No private key exists; the only exits are:
 *
 *   - claim(recipient, tokens, sig): backend-signed EIP-712 voucher, issued
 *     only after the caller proves control of the handle via X OAuth.
 *     Repeatable forever — no expiry. Nonce'd against replay; each claim
 *     resets the dormancy clock.
 *   - rescue(...): platform owner only, and only after 365 days with zero
 *     claims (since deploy or since the last claim). Dormancy recovery for
 *     handles that never show up — not a backdoor while the owner is active
 *     within the window.
 *
 * The voucher signer + platform owner are read live from HandlePayFactory,
 * so rotating the signer key never bricks old vaults.
 *
 * Instant launches stamp this vault as `creatorRewardsWallet` on the locker
 * (createTokenMemeInstantQuoteTo). The factory here does not wrap Instant
 * create — the frontend deploys the vault, then passes its address.
 */
contract HandlePay {
    using SafeERC20 for IERC20;

    HandlePayFactory public immutable factory;
    bytes32 public immutable handleHash;
    uint64 public immutable deployedAt;

    uint64 public lastClaimAt; // 0 until the first claim
    uint256 public nonce;

    uint256 public constant RESCUE_DELAY = 365 days;

    bytes32 private constant CLAIM_TYPEHASH = keccak256("Claim(address recipient,uint256 nonce)");

    event Claimed(address indexed recipient, uint256 ethAmount, uint256 indexed nonce);
    event ClaimedToken(address indexed token, address indexed recipient, uint256 amount);
    event Rescued(address indexed to, uint256 ethAmount);

    error BadSignature();
    error NotOwner();
    error NotDormant();
    error EthSendFailed();

    constructor(bytes32 handleHash_) {
        factory = HandlePayFactory(msg.sender);
        handleHash = handleHash_;
        deployedAt = uint64(block.timestamp);
    }

    receive() external payable {}

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("HandlePay")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice Sweep the vault to `recipient`. `sig` is the backend voucher over
    ///         (recipient, current nonce) in this vault's EIP-712 domain — the domain
    ///         binds the handle, since the vault address derives from it.
    function claim(address recipient, IERC20[] calldata tokens, bytes calldata sig) external {
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", domainSeparator(), keccak256(abi.encode(CLAIM_TYPEHASH, recipient, nonce)))
        );
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        if (err != ECDSA.RecoverError.NoError || recovered != factory.signer()) revert BadSignature();
        nonce++;
        lastClaimAt = uint64(block.timestamp);

        uint256 ethBal = address(this).balance;
        if (ethBal > 0) {
            (bool ok,) = recipient.call{value: ethBal}("");
            if (!ok) revert EthSendFailed();
        }
        emit Claimed(recipient, ethBal, nonce - 1);
        _sweepTokens(recipient, tokens);
    }

    /// @notice True once the platform owner may rescue: 365 days with no claim,
    ///         measured from deploy or from the most recent claim.
    function rescuable() public view returns (bool) {
        uint64 anchor = lastClaimAt == 0 ? deployedAt : lastClaimAt;
        return block.timestamp >= uint256(anchor) + RESCUE_DELAY;
    }

    function rescue(address to, IERC20[] calldata tokens) external {
        if (msg.sender != factory.owner()) revert NotOwner();
        if (!rescuable()) revert NotDormant();
        uint256 ethBal = address(this).balance;
        if (ethBal > 0) {
            (bool ok,) = to.call{value: ethBal}("");
            if (!ok) revert EthSendFailed();
        }
        emit Rescued(to, ethBal);
        _sweepTokens(to, tokens);
    }

    function _sweepTokens(address to, IERC20[] calldata tokens) private {
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 bal = tokens[i].balanceOf(address(this));
            if (bal > 0) {
                tokens[i].safeTransfer(to, bal);
                emit ClaimedToken(address(tokens[i]), to, bal);
            }
        }
    }
}

/**
 * @title HandlePayFactory — deterministic per-handle vaults.
 *
 * Permissionless deployVault: anyone can route Instant creator fees to a handle
 * by deploying its vault and passing that address as creatorRewardsWallet.
 * There is no createTokenFor wrapper — Instant already has
 * createTokenMemeInstantQuoteTo.
 */
contract HandlePayFactory {
    address public owner;
    address public signer;

    mapping(bytes32 => address) public vaultOf; // handleHash → deployed vault (0 = not yet)

    event VaultDeployed(bytes32 indexed handleHash, address vault);
    event SignerUpdated(address signer);
    event OwnerUpdated(address owner);

    error NotOwner();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address signer_) {
        if (signer_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        signer = signer_;
    }

    function setSigner(address s) external onlyOwner {
        if (s == address(0)) revert ZeroAddress();
        signer = s;
        emit SignerUpdated(s);
    }

    function setOwner(address o) external onlyOwner {
        if (o == address(0)) revert ZeroAddress();
        owner = o;
        emit OwnerUpdated(o);
    }

    /// @notice The vault address for a handle — valid before deployment (CREATE2).
    function computeVault(bytes32 handleHash) public view returns (address) {
        bytes32 initHash = keccak256(abi.encodePacked(type(HandlePay).creationCode, abi.encode(handleHash)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), handleHash, initHash)))));
    }

    /// @notice Deploy (or return) the vault for a handle. Permissionless — fees can be
    ///         routed to a handle by anyone.
    function deployVault(bytes32 handleHash) public returns (address vault) {
        vault = vaultOf[handleHash];
        if (vault != address(0)) return vault;
        vault = address(new HandlePay{salt: handleHash}(handleHash));
        vaultOf[handleHash] = vault;
        emit VaultDeployed(handleHash, vault);
    }
}

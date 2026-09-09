// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title ArcNS
/// @notice The ".arc" name registrar. Each registered label is an ERC-721 (tokenId =
///         uint256(keccak256(bytes(label))), i.e. a "labelhash" — there is no subdomain tree,
///         this is a single flat namespace of "<label>.arc" names, not full ENS).
///
///         Commit-reveal registration (same shape as ENS's ETHRegistrarController) so nobody can
///         front-run a visible mempool registration tx and steal the name. Pricing is a simple
///         per-length USDC/year table, owner-tunable. Names expire; there's a grace period after
///         expiry before anyone else can take them.
///
/// Payment split: there's no "creator" here the way there is for a launched token, so this does
/// NOT reuse CrucibleLock's quoteSplit() (that's shaped around paying an LP position's creator —
/// wrong fit for a flat registration fee). Every registration/renewal instead splits straight
/// into two legs:
///   - BURN_BPS   -> sent directly to the Crucible burn sink (same address CrucibleLock's own
///                   `crucible` leg pays into). It just sits there as USDC until `cook()` sweeps
///                   the sink's whole balance into an EVE buyback-and-burn — see
///                   contracts/eve-burn (or scripts/cook-crucible.ts) for that half. No new burn
///                   mechanism needed: a plain ERC-20 transfer to that address is all `cook()`
///                   expects, exactly like CrucibleLock's own `_payOrAccrue(quote, crucible, ...)`.
///   - PLATFORM_BPS -> platformWallet.
/// Split constants are set at deploy time, not hardcoded, so this doesn't need redeploying if the
/// split ever changes — see setSplit().
contract ArcNS is ERC721 {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    // ── constants ──────────────────────────────────────────────────────────────────────────
    uint16 public constant BPS_DENOM = 10_000;
    uint256 public constant MIN_COMMIT_AGE = 60; // seconds — must elapse before a commit can register
    uint256 public constant MAX_COMMIT_AGE = 1 days; // commit expires — forces a fresh one, no stockpiling
    uint256 public constant GRACE_PERIOD = 30 days; // usable-but-not-renewable window after expiry
    uint256 public constant MIN_LABEL_LEN = 3;
    uint256 public constant MAX_LABEL_LEN = 63;
    uint256 public constant MIN_DURATION = 30 days;
    uint256 public constant MAX_YEARS_PER_TX = 10;

    // ── errors ─────────────────────────────────────────────────────────────────────────────
    error ZeroAddress();
    error NotOwner();
    error BadLabel();
    error NotAvailable();
    error CommitTooYoung();
    error CommitTooOld();
    error CommitNotFound();
    error DurationTooShort();
    error DurationTooLong();
    error NotRegistered();
    error NotNameOwner();
    error StillValid();
    error BadSplit();
    error TransferFailed();

    // ── config / admin (immutable core, mutable knobs) ────────────────────────────────────
    address public owner;
    IERC20 public immutable usdc;
    address public immutable crucible; // Crucible burn sink — see contracts/eve-burn
    address public platformWallet;

    uint16 public burnBps = 7_000; // 70%
    uint16 public platformBps = 3_000; // 30%

    /// @notice USDC price per year, in usdc's own decimals (6), keyed by label length.
    ///         Index 0 = length 3, index 1 = length 4, ... last bucket applies to every longer
    ///         length too. Defaults roughly track what the third-party ".arc" registrars
    ///         (arcname.services et al) were already charging when we surveyed them.
    uint256[] public priceByLength = [50e6, 20e6, 10e6, 5e6, 2e6]; // 3,4,5,6,7+ chars

    // ── registration state ─────────────────────────────────────────────────────────────────
    mapping(bytes32 => uint256) public commitments; // commitment -> block.timestamp of commit()
    mapping(uint256 => uint256) public expiries; // tokenId (labelhash) -> unix expiry
    mapping(uint256 => string) public labelOf; // tokenId -> original label, for tokenURI/back-lookup

    event OwnerTransferred(address indexed previous, address indexed next);
    event PlatformWalletSet(address indexed wallet);
    event SplitSet(uint16 burnBps, uint16 platformBps);
    event PriceTableSet(uint256[] priceByLength);
    event Committed(bytes32 indexed commitment);
    event NameRegistered(uint256 indexed tokenId, string label, address indexed owner, uint256 expires, uint256 paid);
    event NameRenewed(uint256 indexed tokenId, string label, uint256 expires, uint256 paid);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address usdc_, address crucible_, address platformWallet_)
        ERC721("Arc Name Service", "ARCNAME")
    {
        if (usdc_ == address(0) || crucible_ == address(0) || platformWallet_ == address(0)) {
            revert ZeroAddress();
        }
        owner = msg.sender;
        usdc = IERC20(usdc_);
        crucible = crucible_;
        platformWallet = platformWallet_;
    }

    // ── admin ──────────────────────────────────────────────────────────────────────────────
    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, next);
        owner = next;
    }

    function setPlatformWallet(address wallet) external onlyOwner {
        if (wallet == address(0)) revert ZeroAddress();
        platformWallet = wallet;
        emit PlatformWalletSet(wallet);
    }

    function setSplit(uint16 burnBps_, uint16 platformBps_) external onlyOwner {
        if (burnBps_ + platformBps_ != BPS_DENOM) revert BadSplit();
        burnBps = burnBps_;
        platformBps = platformBps_;
        emit SplitSet(burnBps_, platformBps_);
    }

    function setPriceTable(uint256[] calldata table) external onlyOwner {
        if (table.length == 0) revert BadLabel();
        priceByLength = table;
        emit PriceTableSet(table);
    }

    // ── pricing / availability ─────────────────────────────────────────────────────────────
    function priceOf(string memory label, uint256 duration) public view returns (uint256) {
        uint256 len = bytes(label).length;
        uint256 idx = len - MIN_LABEL_LEN;
        if (idx >= priceByLength.length) idx = priceByLength.length - 1;
        uint256 perYear = priceByLength[idx];
        return (perYear * duration) / 365 days;
    }

    function available(string memory label) public view returns (bool) {
        if (!_validLabel(label)) return false;
        uint256 tokenId = labelhash(label);
        uint256 exp = expiries[tokenId];
        return exp == 0 || block.timestamp > exp + GRACE_PERIOD;
    }

    function nameExpires(string memory label) external view returns (uint256) {
        return expiries[labelhash(label)];
    }

    function labelhash(string memory label) public pure returns (uint256) {
        return uint256(keccak256(bytes(label)));
    }

    // ── commit-reveal registration ─────────────────────────────────────────────────────────
    /// @notice `secret` is any value the caller keeps private until reveal; commitment binds the
    ///         label + intended owner so nobody watching the mempool can copy a bare commit and
    ///         win the race — they'd need the secret too, which never appears on-chain until the
    ///         matching register() call, by which point it's too late to front-run.
    function makeCommitment(string memory label, address nameOwner, bytes32 secret) public pure returns (bytes32) {
        return keccak256(abi.encode(label, nameOwner, secret));
    }

    function commit(bytes32 commitment) external {
        // Overwriting an existing commitment just resets its clock — fine, it's the same cost
        // either way and saves adding a "already committed" revert nobody benefits from.
        commitments[commitment] = block.timestamp;
        emit Committed(commitment);
    }

    function register(string calldata label, address nameOwner, uint256 duration, bytes32 secret) external {
        if (nameOwner == address(0)) revert ZeroAddress();
        if (!_validLabel(label)) revert BadLabel();
        if (duration < MIN_DURATION) revert DurationTooShort();
        if (duration > MAX_YEARS_PER_TX * 365 days) revert DurationTooLong();
        if (!available(label)) revert NotAvailable();

        bytes32 commitment = makeCommitment(label, nameOwner, secret);
        uint256 committedAt = commitments[commitment];
        if (committedAt == 0) revert CommitNotFound();
        if (block.timestamp < committedAt + MIN_COMMIT_AGE) revert CommitTooYoung();
        if (block.timestamp > committedAt + MAX_COMMIT_AGE) revert CommitTooOld();
        delete commitments[commitment];

        uint256 cost = priceOf(label, duration);
        if (cost > 0) _collect(cost);

        uint256 tokenId = labelhash(label);
        // Re-registering an expired (past grace) name: the old owner still holds the NFT, so mint
        // would revert on the duplicate tokenId. Force it back to the zero-holder state first —
        // this is the one place a transfer happens without the current holder's say-so, and it's
        // only reachable once `available()` has already confirmed the grace period is over.
        if (_ownerOf(tokenId) != address(0)) {
            _update(address(0), tokenId, address(0));
        }
        expiries[tokenId] = block.timestamp + duration;
        labelOf[tokenId] = label;
        _safeMint(nameOwner, tokenId);

        emit NameRegistered(tokenId, label, nameOwner, expiries[tokenId], cost);
    }

    function renew(string calldata label, uint256 duration) external {
        uint256 tokenId = labelhash(label);
        uint256 exp = expiries[tokenId];
        if (exp == 0) revert NotRegistered();
        if (block.timestamp > exp + GRACE_PERIOD) revert NotAvailable(); // lapsed — needs register(), not renew()
        if (duration > MAX_YEARS_PER_TX * 365 days) revert DurationTooLong();

        uint256 cost = priceOf(label, duration);
        if (cost > 0) _collect(cost);

        expiries[tokenId] = exp + duration;
        emit NameRenewed(tokenId, label, expiries[tokenId], cost);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        string memory label = labelOf[tokenId];
        return string.concat("data:application/json;utf8,{\"name\":\"", label, ".arc\"}");
    }

    // ── internal ───────────────────────────────────────────────────────────────────────────
    function _collect(uint256 amount) internal {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        uint256 burnAmt = (amount * burnBps) / BPS_DENOM;
        uint256 platAmt = amount - burnAmt; // remainder to platform — avoids rounding dust getting stranded
        if (burnAmt > 0) usdc.safeTransfer(crucible, burnAmt);
        if (platAmt > 0) usdc.safeTransfer(platformWallet, platAmt);
    }

    /// @dev DNS-label-ish rules: lowercase [a-z0-9-], 3-63 chars, no leading/trailing hyphen.
    ///      Rejecting uppercase and non-ASCII up front means "Eve" / "eve" / "𝐞𝐯𝐞" can't be
    ///      registered as distinct look-alike names — every one of the third-party registrars we
    ///      looked at skips this, which is exactly how homoglyph squatting happens.
    function _validLabel(string memory label) internal pure returns (bool) {
        bytes memory b = bytes(label);
        uint256 len = b.length;
        if (len < MIN_LABEL_LEN || len > MAX_LABEL_LEN) return false;
        if (b[0] == "-" || b[len - 1] == "-") return false;
        for (uint256 i; i < len; ++i) {
            bytes1 c = b[i];
            bool isDigit = c >= 0x30 && c <= 0x39;
            bool isLower = c >= 0x61 && c <= 0x7A;
            bool isHyphen = c == 0x2D;
            if (!isDigit && !isLower && !isHyphen) return false;
        }
        return true;
    }
}

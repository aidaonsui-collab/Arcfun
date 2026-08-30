// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";
import {ISwapRouter02} from "./interfaces/ISwapRouter02.sol";
import {INonfungiblePositionManager} from "./interfaces/INonfungiblePositionManager.sol";

/// @title CrucibleLock
/// @notice Holds Uniswap V3 LP NFTs for NEW launches. Permissionless `collectFees(tokenId)`
///         matches live MonLock so a keeper can collect. Stamps creator wallet + bps at lock.
///         There is no NFT withdraw — owner cannot rug LP.
///
/// Quote USDC split of the collected 1% (10_000 = 100% of that USDC fee):
///   Meme:    Creator 5000, Crucible 3000 (2500+500), Project burn 1000, Platform 1000
///   Reflect: Holders 2000, Crucible 3500 (3000+500), Creator 2000, Project burn 1500, Platform 1000
///
/// Sell path: collected launch token is 100% sent to dead. No USDC from sells.
/// Project burn: that USDC slice is accrued, then `projectBurn(tokenId, minOut)` buys the launch
/// token on the same pool and sends it to dead. Collect does not swap.
///
/// Referrer 500 bps of the LP fee is folded into Crucible on collect. Per-trade referral is
/// ReferralRouter (5 bps of buy notional when a live code is passed). Collect cannot attribute
/// per-trade; do not pay a stamped code from this path or we double-pay.
contract CrucibleLock {
    enum Kind {
        Meme,
        Reflect
    }

    struct Position {
        address creator;
        address holders;
        uint16 creatorBps;
        Kind kind;
        bool locked;
        bytes32 referrerCodeHash;
    }

    struct Split {
        uint256 creator;
        uint256 crucible;
        uint256 projectBurn;
        uint256 platform;
        uint256 referrer;
        uint256 holders;
    }

    uint16 public constant BPS_DENOM = 10_000;

    uint16 public constant MEME_CREATOR_BPS = 5_000;
    uint16 public constant MEME_CRUCIBLE_BPS = 2_500;
    uint16 public constant MEME_PROJECT_BURN_BPS = 1_000;
    uint16 public constant MEME_PLATFORM_BPS = 1_000;
    uint16 public constant MEME_REFERRER_BPS = 500;
    uint16 public constant MEME_HOLDERS_BPS = 0;

    uint16 public constant REFLECT_HOLDERS_BPS = 2_000;
    uint16 public constant REFLECT_CRUCIBLE_BPS = 3_000;
    uint16 public constant REFLECT_CREATOR_BPS = 2_000;
    uint16 public constant REFLECT_PROJECT_BURN_BPS = 1_500;
    uint16 public constant REFLECT_PLATFORM_BPS = 1_000;
    uint16 public constant REFLECT_REFERRER_BPS = 500;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public owner;
    address public factory;
    address public nfpm;
    address public usdc;
    address public swapRouter;
    address public crucible;
    address public referralRegistry;
    address public platformWallet;

    /// @notice Addresses allowed to execute the project-burn swap. The owner is always allowed.
    mapping(address => bool) public keepers;

    mapping(uint256 => Position) public positions;
    mapping(uint256 => uint256) public pendingProjectBurn;
    /// @notice token => account => USDC (or other) that failed to push (e.g. Circle blacklist).
    mapping(address => mapping(address => uint256)) public owed;

    uint256 private _unlocked = 1;

    event OwnerTransferred(address indexed previous, address indexed next);
    event FactorySet(address indexed factory);
    event PlatformWalletSet(address indexed wallet);
    event KeeperSet(address indexed keeper, bool allowed);
    event CrucibleSet(address indexed crucible);
    event ReferralRegistrySet(address indexed registry);
    event Locked(
        uint256 indexed tokenId,
        address indexed creator,
        Kind kind,
        address holders,
        uint16 creatorBps,
        bytes32 referrerCodeHash
    );
    event FeesCollected(
        uint256 indexed tokenId,
        uint256 usdcAmount,
        uint256 launchAmount,
        address referrer,
        uint256 referrerPaid,
        uint256 cruciblePaid
    );
    event ProjectBurn(address indexed token, uint256 usdcIn, uint256 tokenOut);
    event Accrued(address indexed token, address indexed to, uint256 amount);

    error NotOwner();
    error NotKeeper();
    error NotFactory();
    error NotNfpm();
    error ZeroAddress();
    error AlreadyLocked();
    error NotLocked();
    error BadKind();
    error HoldersRequired();
    error NotUsdcPool();
    error Reentrancy();
    error TransferFailed();
    error ApproveFailed();
    error NoNftWithdraw();
    error ZeroMinOut();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Only the swap is gated; collectFees stays permissionless because it no longer swaps.
    ///      `minLaunchOut` is chosen by the caller, so an open entrypoint let an attacker pass 1,
    ///      clearing the ZeroMinOut guard while accepting any price. A caller-supplied floor is
    ///      not a defence against that caller.
    modifier onlyKeeper() {
        if (msg.sender != owner && !keepers[msg.sender]) revert NotKeeper();
        _;
    }

    modifier onlyFactoryOrOwner() {
        if (msg.sender != factory && msg.sender != owner) revert NotFactory();
        _;
    }

    modifier nonReentrant() {
        if (_unlocked != 1) revert Reentrancy();
        _unlocked = 0;
        _;
        _unlocked = 1;
    }

    constructor(
        address nfpm_,
        address usdc_,
        address swapRouter_,
        address crucible_,
        address referralRegistry_,
        address platformWallet_
    ) {
        if (
            nfpm_ == address(0) || usdc_ == address(0) || swapRouter_ == address(0) || crucible_ == address(0)
                || referralRegistry_ == address(0) || platformWallet_ == address(0)
        ) revert ZeroAddress();
        owner = msg.sender;
        nfpm = nfpm_;
        usdc = usdc_;
        swapRouter = swapRouter_;
        crucible = crucible_;
        referralRegistry = referralRegistry_;
        platformWallet = platformWallet_;
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, next);
        owner = next;
    }

    function setFactory(address factory_) external onlyOwner {
        factory = factory_;
        emit FactorySet(factory_);
    }

    function setPlatformWallet(address wallet) external onlyOwner {
        if (wallet == address(0)) revert ZeroAddress();
        platformWallet = wallet;
        emit PlatformWalletSet(wallet);
    }

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        if (keeper == address(0)) revert ZeroAddress();
        keepers[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    function setCrucible(address crucible_) external onlyOwner {
        if (crucible_ == address(0)) revert ZeroAddress();
        crucible = crucible_;
        emit CrucibleSet(crucible_);
    }

    function setReferralRegistry(address registry) external onlyOwner {
        if (registry == address(0)) revert ZeroAddress();
        referralRegistry = registry;
        emit ReferralRegistrySet(registry);
    }

    /// @notice Intentionally unimplemented. LP NFT stays in this contract forever.
    function withdrawNft(uint256) external view onlyOwner {
        revert NoNftWithdraw();
    }

    /// @notice Stamp creator + kind + referrer code and take the LP NFT. Factory (or owner) only.
    ///         Empty `referrerCode` means no referrer (500 bps → Crucible). Code need not be
    ///         registered yet; collect resolves the current payout from the registry.
    function lock(
        uint256 tokenId,
        address creatorWallet,
        Kind kind,
        address holdersWallet,
        string calldata referrerCode
    ) external onlyFactoryOrOwner nonReentrant {
        if (creatorWallet == address(0)) revert ZeroAddress();
        if (uint8(kind) > uint8(Kind.Reflect)) revert BadKind();
        if (kind == Kind.Reflect && holdersWallet == address(0)) revert HoldersRequired();
        if (positions[tokenId].locked) revert AlreadyLocked();

        // There is no NFT withdraw, so a position this contract cannot service is one nobody can
        // ever recover. `collectFees` and `projectBurn` both need one side of the pair to be the
        // quote, so check that here rather than after the NFT is already stuck.
        {
            (,, address token0, address token1,,,,,,,,) = INonfungiblePositionManager(nfpm).positions(tokenId);
            address quote = usdc;
            if (token0 != quote && token1 != quote) revert NotUsdcPool();
        }

        address nftOwner = INonfungiblePositionManager(nfpm).ownerOf(tokenId);
        if (nftOwner != address(this)) {
            INonfungiblePositionManager(nfpm).transferFrom(nftOwner, address(this), tokenId);
        }

        bytes32 refHash;
        if (bytes(referrerCode).length != 0) {
            refHash = keccak256(bytes(referrerCode));
        }

        uint16 creatorBps = kind == Kind.Meme ? MEME_CREATOR_BPS : REFLECT_CREATOR_BPS;
        positions[tokenId] = Position({
            creator: creatorWallet,
            holders: kind == Kind.Reflect ? holdersWallet : address(0),
            creatorBps: creatorBps,
            kind: kind,
            locked: true,
            referrerCodeHash: refHash
        });
        emit Locked(tokenId, creatorWallet, kind, holdersWallet, creatorBps, refHash);
    }

    /// @notice MonLock-compatible. Permissionless keeper collect. Pays USDC legs, burns sell-side
    ///         launch token, accrues project-burn USDC. Does not swap. Does not cook.
    function collectFees(uint256 tokenId) external returns (uint256 amount0, uint256 amount1) {
        return _collect(tokenId);
    }

    /// @notice Swap accrued project-burn USDC for the launch token and send it to dead.
    ///         Keeper-gated: `minLaunchOut` is caller-supplied, so an open entrypoint could pass 1
    ///         and accept a manipulated price. Reverts on a collapsed price instead of burning dust.
    function projectBurn(uint256 tokenId, uint256 minLaunchOut)
        external
        onlyKeeper
        nonReentrant
        returns (uint256 tokenOut)
    {
        Position memory pos = positions[tokenId];
        if (!pos.locked) revert NotLocked();
        uint256 usdcIn = pendingProjectBurn[tokenId];
        if (usdcIn == 0) return 0;
        if (minLaunchOut == 0) revert ZeroMinOut();

        address quote = usdc;
        address launch;
        uint24 poolFee;
        {
            (,, address token0, address token1, uint24 fee,,,,,,,) =
                INonfungiblePositionManager(nfpm).positions(tokenId);
            poolFee = fee;
            if (token0 == quote) launch = token1;
            else if (token1 == quote) launch = token0;
            else revert NotUsdcPool();
        }

        // Clear before the swap. `nonReentrant` already covers this, but the swap calls a router we
        // do not control and the pending balance has no business reading as unspent while it runs.
        pendingProjectBurn[tokenId] = 0;
        tokenOut = _projectBurn(quote, launch, poolFee, usdcIn, minLaunchOut);
        emit ProjectBurn(launch, usdcIn, tokenOut);
    }

    /// @notice Pull a failed push (blacklist, etc.). Anyone may push to `to`.
    function withdrawOwed(address token, address to) external nonReentrant {
        uint256 amount = owed[token][to];
        if (amount == 0) return;
        // Clear first: `token` is caller-supplied, so `_pay` is a call into arbitrary code with this
        // balance still on the books otherwise.
        owed[token][to] = 0;
        _pay(token, to, amount);
    }

    /// @notice MonLock-compatible view: stamped creator wallet + bps.
    function creatorSplits(uint256 tokenId) external view returns (address wallet, uint16 bps) {
        Position storage p = positions[tokenId];
        return (p.creator, p.creatorBps);
    }

    function holdersSplits(uint256 tokenId) external view returns (address wallet, uint16 bps) {
        Position storage p = positions[tokenId];
        uint16 bps_ = p.kind == Kind.Reflect ? REFLECT_HOLDERS_BPS : MEME_HOLDERS_BPS;
        return (p.holders, bps_);
    }

    /// @notice Pure split of a USDC fee amount. Remainder (rounding dust) goes to Crucible.
    function quoteSplit(uint256 usdcAmount, Kind kind, bool payReferrer) public pure returns (Split memory s) {
        uint16 creatorBps = kind == Kind.Meme ? MEME_CREATOR_BPS : REFLECT_CREATOR_BPS;
        uint16 crucibleBps = kind == Kind.Meme ? MEME_CRUCIBLE_BPS : REFLECT_CRUCIBLE_BPS;
        uint16 projectBps = kind == Kind.Meme ? MEME_PROJECT_BURN_BPS : REFLECT_PROJECT_BURN_BPS;
        uint16 platformBps = kind == Kind.Meme ? MEME_PLATFORM_BPS : REFLECT_PLATFORM_BPS;
        uint16 referrerBps = kind == Kind.Meme ? MEME_REFERRER_BPS : REFLECT_REFERRER_BPS;
        uint16 holdersBps = kind == Kind.Meme ? MEME_HOLDERS_BPS : REFLECT_HOLDERS_BPS;

        if (!payReferrer) {
            crucibleBps += referrerBps;
            referrerBps = 0;
        }

        s.creator = (usdcAmount * creatorBps) / BPS_DENOM;
        s.crucible = (usdcAmount * crucibleBps) / BPS_DENOM;
        s.projectBurn = (usdcAmount * projectBps) / BPS_DENOM;
        s.platform = (usdcAmount * platformBps) / BPS_DENOM;
        s.referrer = (usdcAmount * referrerBps) / BPS_DENOM;
        s.holders = (usdcAmount * holdersBps) / BPS_DENOM;

        uint256 used = s.creator + s.crucible + s.projectBurn + s.platform + s.referrer + s.holders;
        if (usdcAmount > used) s.crucible += usdcAmount - used;
    }

    struct CollectCache {
        address quote;
        address launch;
        address creator;
        address holders;
        address paidReferrer;
        uint24 poolFee;
        Kind kind;
        uint256 usdcGot;
        uint256 launchGot;
        bytes32 referrerCodeHash;
        bool payReferrer;
    }

    function _collect(uint256 tokenId) internal nonReentrant returns (uint256 amount0, uint256 amount1) {
        Position memory pos = positions[tokenId];
        if (!pos.locked) revert NotLocked();

        CollectCache memory c;
        c.quote = usdc;
        c.creator = pos.creator;
        c.holders = pos.holders;
        c.kind = pos.kind;
        c.referrerCodeHash = pos.referrerCodeHash;
        {
            (,, address token0, address token1, uint24 poolFee,,,,,,,) =
                INonfungiblePositionManager(nfpm).positions(tokenId);
            c.poolFee = poolFee;
            if (token0 == c.quote) c.launch = token1;
            else if (token1 == c.quote) c.launch = token0;
            else revert NotUsdcPool();
        }

        uint256 usdcBefore = IERC20Minimal(c.quote).balanceOf(address(this));
        uint256 launchBefore = IERC20Minimal(c.launch).balanceOf(address(this));

        (amount0, amount1) = INonfungiblePositionManager(nfpm).collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        c.usdcGot = IERC20Minimal(c.quote).balanceOf(address(this)) - usdcBefore;
        c.launchGot = IERC20Minimal(c.launch).balanceOf(address(this)) - launchBefore;

        // Sell path: 100% of collected launch token is burned. Nobody is paid.
        // Accrue rather than revert on failure. The launch token is the project's code, not ours:
        // one that pauses, blacklists, or reverts on a transfer to `dead` would otherwise take the
        // whole collect down with it, stranding the creator's, the platform's and Crucible's USDC
        // behind a burn that cannot happen. `withdrawOwed(launch, DEAD)` retries it, open to anyone.
        if (c.launchGot > 0) _payOrAccrue(c.launch, DEAD, c.launchGot);

        // Referrer is paid at swap time by ReferralRouter, not from the batched LP collect.
        c.paidReferrer = address(0);
        c.payReferrer = false;
        Split memory s = quoteSplit(c.usdcGot, c.kind, false);
        _payoutLegs(tokenId, c, s);

        emit FeesCollected(tokenId, c.usdcGot, c.launchGot, c.paidReferrer, s.referrer, s.crucible);
    }

    function _payoutLegs(uint256 tokenId, CollectCache memory c, Split memory s) internal {
        if (s.creator > 0) _payOrAccrue(c.quote, c.creator, s.creator);
        if (s.platform > 0) _payOrAccrue(c.quote, platformWallet, s.platform);
        if (s.holders > 0) _payOrAccrue(c.quote, c.holders, s.holders);
        if (s.referrer > 0) _payOrAccrue(c.quote, c.paidReferrer, s.referrer);
        if (s.projectBurn > 0) pendingProjectBurn[tokenId] += s.projectBurn;
        if (s.crucible > 0) _payOrAccrue(c.quote, crucible, s.crucible);
    }

    function _projectBurn(address quote, address launch, uint24 poolFee, uint256 usdcIn, uint256 minLaunchOut)
        internal
        returns (uint256 tokenOut)
    {
        _approveMax(quote, swapRouter, usdcIn);
        tokenOut = ISwapRouter02(swapRouter).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: quote,
                tokenOut: launch,
                fee: poolFee,
                recipient: DEAD,
                amountIn: usdcIn,
                amountOutMinimum: minLaunchOut,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != nfpm) revert NotNfpm();
        return this.onERC721Received.selector;
    }

    function _payOrAccrue(address token, address to, uint256 amount) internal {
        if (amount == 0 || to == address(0)) return;
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        if (ok && (data.length == 0 || abi.decode(data, (bool)))) return;
        owed[token][to] += amount;
        emit Accrued(token, to, amount);
    }

    function _pay(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _approveMax(address token, address spender, uint256 needed) internal {
        uint256 allowance = IERC20Minimal(token).allowance(address(this), spender);
        if (allowance >= needed) return;
        if (allowance != 0) _approve(token, spender, 0);
        _approve(token, spender, type(uint256).max);
    }

    function _approve(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20Minimal.approve.selector, spender, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert ApproveFailed();
    }
}

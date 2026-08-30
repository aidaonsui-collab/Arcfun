// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Minimal Uniswap V3 NonfungiblePositionManager surface MonLock needs. `collect` only ever
///      transfers `tokensOwed` (accrued swap fees) — never position principal (that requires a
///      `decreaseLiquidity` call, which MonLock never makes). `transferFrom` is used only to return
///      a position to its beneficiary AFTER its unlock time. `positions` is read only to learn a
///      locked position's two token addresses, so a backing-split lock can route the collected fee
///      tokens (never principal). `increaseLiquidity` is factory-only (dex-seed graduation merge).
interface INonfungiblePositionManager {
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    struct IncreaseLiquidityParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
    function increaseLiquidity(IncreaseLiquidityParams calldata params)
        external
        payable
        returns (uint128 liquidity, uint256 amount0, uint256 amount1);
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );
}

/// @notice WETH9 unwrap — MonLock unwraps the staker's quote slice and `call{value:}` pushes native
///         to the staking pool (WETH9's `transfer` only forwards 2300 gas, too little for staking).
interface IWETH9 {
    function withdraw(uint256 amount) external;
}

/// @dev Current LP-creator-fee-leg recipient for a launch token, per the factory that stamped this
///      lock. `InstantErc20QuoteFactory` / `InstantReflectionUsdcFactory` both expose
///      `getCreatorRewards(token)`: the platform owner's `setCreatorRewards` override if one was set
///      (the CTO / abandoned-token-handoff path), else the wallet stamped at creation. Curve
///      factories predate this function and don't have it — `syncCreatorSplit` is Instant/Reflection
///      only for that reason.
interface ICreatorSource {
    function getCreatorRewards(address token) external view returns (address);
}

/**
 * @title MonLock
 * @notice Timed Uniswap V3 LP locker for graduated Odyssey-on-Monad pools — the EVM analogue of
 *         SuiLock's `token_locker`. Each graduated token/WMON position NFT is locked here until an
 *         `unlockTime`; throughout the lock the position's `beneficiary` (the platform deployer)
 *         sweeps the 1% swap fees, and once the term elapses the beneficiary can reclaim the NFT.
 *
 *         Trust model (what makes "LP locked" credible):
 *           • Nobody can withdraw a position before its `unlockTime` — not the owner, not the
 *             beneficiary. `collect` only ever pays out accrued fees, never principal.
 *           • The owner may set DEFAULTS for FUTURE locks and rotate ownership — it can NOT shorten
 *             or withdraw any existing lock. Fee *recipient* wallets for backing/staker legs may be
 *             retargeted via `retargetFeeRecipients` (bps stay fixed; principal still locked).
 *           • Lock terms are extend-only (a beneficiary can re-lock longer, never shorter).
 *
 *         Auto-graduation flow: set MonLock as the factory's `lpRecipient`. The factory MINTS the LP
 *         NFT straight here; because UniV3 `mint` uses `_mint` (no ERC721 receive hook), call the
 *         permissionless `lockPosition(tokenId)` once after graduation (a keeper/UI, or anyone) to
 *         stamp the lock. Manual `safeTransferFrom` deposits are auto-stamped via `onERC721Received`.
 */
contract MonLock is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 internal constant BPS_DENOM = 10_000;
    address internal constant BURN_ADDR = 0x000000000000000000000000000000000000dEaD;
    /// @dev Floor on `defaultLockDuration` — owner cannot shorten future stamps below this.
    uint64 public constant MIN_LOCK_DURATION = 30 days;

    INonfungiblePositionManager public immutable POSITION_MANAGER;

    /// @notice Owner may ONLY change defaults for future locks, set the stamper, + transfer ownership.
    address public owner;
    /// @notice Beneficiary stamped onto new locks (fees + post-unlock reclaim) — the deployer wallet.
    address public defaultBeneficiary;
    /// @notice Lock term applied to new locks, in seconds (default 365 days).
    uint64 public defaultLockDuration;
    /// @notice The only address allowed to stamp a lock WITH a backing split (the curve factory).
    ///         Owner-set; rotatable. The permissionless `lockPosition` path never sets a split.
    address public stamper;

    struct Lock {
        address beneficiary; // collects fees + reclaims after unlock
        uint64 unlockTime; // when the position becomes withdrawable
        bool withdrawn; // terminal: NFT returned to beneficiary
        // Fee split (immutable after stamp): `backingBps` of every fee collection routes to
        // `backingWallet`, the remainder to `beneficiary`. An optional staker leg lives in
        // `stakerSplits` (off this struct so the public `locks` ABI stays stable). Principal is never
        // split (collect only moves accrued swap fees). Zero backing+staker bps = 100%-to-beneficiary.
        address backingWallet;
        uint16 backingBps;
    }

    /// @notice Optional post-bond staker fee leg for a locked position — `bps` of every fee collection
    ///         routes to `wallet` (the staking pool), stamped alongside the backing split.
    struct StakerSplit {
        address wallet;
        uint16 bps;
    }

    /// @notice Optional post-bond creator fee leg for a locked position — `bps` of every fee collection
    ///         routes to `wallet` (the token's creator), stamped alongside the backing/staker splits.
    ///         Mirrors `StakerSplit`. Set via `lockPositionMeme` / `lockPositionWithSplitLaunch` /
    ///         `lockDexSeedPosition`.
    struct CreatorSplit {
        address wallet;
        uint16 bps;
    }

    mapping(uint256 => Lock) public locks; // tokenId => lock
    mapping(uint256 => StakerSplit) public stakerSplits; // tokenId => staker fee leg (0 bps = none)
    /// @notice Launch token for token-aware post-bond routing (burn on collect). Zero = legacy path.
    mapping(uint256 => address) public launchTokens;
    /// @notice Quote token (WMON/WETH) for meme-mode routing. Zero = infer from pool at collect.
    mapping(uint256 => address) public quoteTokens;
    /// @notice Meme positions: quote-side LP fees split staker/platform (launch side always burns).
    mapping(uint256 => bool) public memeMode;
    mapping(uint256 => bool) public seen; // append-only registration guard
    uint256[] public lockedPositions;
    /// @notice Creator fee leg (tokenId => creator wallet + bps, 0 bps = none). Declared AFTER every
    ///         other state variable so upgrading the proxy in place never disturbs an existing lock's
    ///         storage — a tokenId locked before this variable existed simply reads the zero value here.
    mapping(uint256 => CreatorSplit) public creatorSplits;
    /// @notice Dex-seed positions awaiting graduation finalize. Fees collectable; principal withdraw
    ///         blocked until `finalizeDexSeedLock` (which clears this flag and starts the 365d timer).
    ///         Appended after `creatorSplits` for the same storage-safety reason.
    mapping(uint256 => bool) public dexSeedPending;
    /// @notice Only this address may call `finalizeDexSeedLock` (the curve factory). Owner-set;
    ///         independent of `stamper` so graduation can finalize without going through the stamper.
    address public factory;

    event PositionLocked(uint256 indexed tokenId, address indexed beneficiary, uint64 unlockTime);
    event PositionLockedWithBacking(uint256 indexed tokenId, address indexed backingWallet, uint16 backingBps);
    event PositionLockedMeme(uint256 indexed tokenId, address indexed launchToken, address indexed stakerWallet);
    event PositionLockedWithLaunch(
        uint256 indexed tokenId, address indexed launchToken, address backingWallet, uint16 backingBps
    );
    event PositionLockedWithCreator(uint256 indexed tokenId, address indexed creatorWallet, uint16 creatorBps);
    /// @notice Thin UniV3 seed LP stamped at meme launch — fees active, principal locked only after finalize.
    event DexSeedLocked(
        uint256 indexed tokenId,
        address indexed launchToken,
        address quoteToken,
        address creator,
        uint16 creatorBps,
        uint16 stakerBps
    );
    /// @notice Dex-seed principal lock started at graduation (`unlockTime = now + defaultLockDuration`).
    event DexSeedFinalized(uint256 indexed tokenId, uint64 unlockTime);
    event FeesCollected(uint256 indexed tokenId, address indexed to, uint256 amount0, uint256 amount1);
    event FeesSplit(uint256 indexed tokenId, address indexed backingWallet, uint256 backing0, uint256 backing1);
    event LaunchFeesBurned(uint256 indexed tokenId, address indexed token, uint256 amount);
    event CreatorSplitSynced(uint256 indexed tokenId, address indexed oldWallet, address indexed newWallet);
    event PositionWithdrawn(uint256 indexed tokenId, address indexed to);
    event LockExtended(uint256 indexed tokenId, uint64 newUnlockTime);
    event LockBeneficiaryChanged(uint256 indexed tokenId, address indexed next);
    /// @notice Owner retargeted backing and/or staker fee recipients for an existing lock (bps unchanged).
    event FeeRecipientsRetargeted(
        uint256 indexed tokenId, address backingWallet, address stakerWallet, uint16 backingBps, uint16 stakerBps
    );
    event DefaultsChanged(address indexed beneficiary, uint64 duration);
    event StamperChanged(address indexed stamper);
    event FactoryChanged(address indexed factory);
    event OwnerChanged(address indexed previous, address indexed next);

    error NotOwner();
    error NotBeneficiary();
    error NotStamper();
    error NotFactory();
    error NotPositionManager();
    error NotHeld();
    error AlreadyLocked();
    error NotLocked();
    error StillLocked();
    error AlreadyWithdrawn();
    error MustExtend();
    error ZeroAddress();
    error ZeroDuration();
    error DurationTooShort();
    error BadBps();
    error NotDexSeedLock();
    error AlreadyFinalized();
    error NoLaunchToken();

    constructor(address positionManager_, address defaultBeneficiary_, address owner_, uint64 defaultLockDuration_) {
        if (positionManager_ == address(0) || defaultBeneficiary_ == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        if (defaultLockDuration_ == 0) revert ZeroDuration();
        if (defaultLockDuration_ < MIN_LOCK_DURATION) revert DurationTooShort();
        POSITION_MANAGER = INonfungiblePositionManager(positionManager_);
        defaultBeneficiary = defaultBeneficiary_;
        owner = owner_;
        defaultLockDuration = defaultLockDuration_;
    }

    // ─── Registration ─────────────────────────────────────────────────────────────────────────

    /// @notice Lock a position the factory MINTED to this contract (the mint fires no receive hook).
    ///         Permissionless — the lock terms come from the current defaults, and it only works if
    ///         MonLock actually holds the NFT, so there's nothing to game.
    function lockPosition(uint256 tokenId) external returns (uint64 unlockTime) {
        if (seen[tokenId]) revert AlreadyLocked();
        if (POSITION_MANAGER.ownerOf(tokenId) != address(this)) revert NotHeld();
        unlockTime = _stamp(tokenId, address(0), 0, address(0), 0);
    }

    /// @notice Stamp a lock WITH a fee split — `backingBps` of every fee collection routes to
    ///         `backingWallet` (e.g. an RWA NAV-floor / perp-margin wallet), the remainder to the
    ///         beneficiary. Only the `stamper` (the curve factory) may set a split, so nobody can
    ///         redirect fees to an arbitrary address; like `lockPosition` it only works if MonLock
    ///         actually holds the NFT. The split is immutable once stamped.
    function lockPositionWithBacking(uint256 tokenId, address backingWallet, uint16 backingBps)
        external
        returns (uint64 unlockTime)
    {
        if (msg.sender != stamper) revert NotStamper();
        if (backingBps > BPS_DENOM) revert BadBps();
        if (backingBps > 0 && backingWallet == address(0)) revert ZeroAddress();
        if (seen[tokenId]) revert AlreadyLocked();
        if (POSITION_MANAGER.ownerOf(tokenId) != address(this)) revert NotHeld();
        unlockTime = _stamp(tokenId, backingWallet, backingBps, address(0), 0);
    }

    /// @notice Stamp a lock with a THREE-way fee split — `backingBps` to `backingWallet`, `stakerBps`
    ///         to `stakerWallet` (the staking pool), the remainder to the beneficiary. Stamper-only;
    ///         the split is immutable once stamped. (`lockPositionWithBacking` is the 2-way subset.)
    function lockPositionWithSplit(
        uint256 tokenId,
        address backingWallet,
        uint16 backingBps,
        address stakerWallet,
        uint16 stakerBps
    ) external returns (uint64 unlockTime) {
        if (msg.sender != stamper) revert NotStamper();
        if (uint256(backingBps) + stakerBps > BPS_DENOM) revert BadBps();
        if (backingBps > 0 && backingWallet == address(0)) revert ZeroAddress();
        if (stakerBps > 0 && stakerWallet == address(0)) revert ZeroAddress();
        if (seen[tokenId]) revert AlreadyLocked();
        if (POSITION_MANAGER.ownerOf(tokenId) != address(this)) revert NotHeld();
        unlockTime = _stamp(tokenId, backingWallet, backingBps, stakerWallet, stakerBps);
    }

    /// @notice Meme-token post-bond lock: launch-token LP fees → burn; quote (WETH/WMON) →
    ///         `stakerBps` to stakers / `creatorBps` to the token's creator / remainder to the
    ///         platform beneficiary. Stamper-only (the curve factory at graduation). Unlike the
    ///         backed path, `stakerWallet` is required unconditionally (memes always route a staker
    ///         leg) rather than only when `stakerBps > 0` — a deliberate divergence, not an oversight.
    function lockPositionMeme(
        uint256 tokenId,
        address launchToken,
        address quoteToken,
        address stakerWallet,
        uint16 stakerBps,
        address creatorWallet,
        uint16 creatorBps
    ) external returns (uint64 unlockTime) {
        if (msg.sender != stamper) revert NotStamper();
        if (launchToken == address(0) || quoteToken == address(0) || stakerWallet == address(0)) revert ZeroAddress();
        if (uint256(stakerBps) + creatorBps > BPS_DENOM) revert BadBps();
        if (creatorBps > 0 && creatorWallet == address(0)) revert ZeroAddress();
        if (seen[tokenId]) revert AlreadyLocked();
        if (POSITION_MANAGER.ownerOf(tokenId) != address(this)) revert NotHeld();
        unlockTime = _stamp(tokenId, address(0), 0, stakerWallet, stakerBps);
        if (creatorWallet != address(0)) creatorSplits[tokenId] = CreatorSplit({wallet: creatorWallet, bps: creatorBps});
        launchTokens[tokenId] = launchToken;
        quoteTokens[tokenId] = quoteToken;
        memeMode[tokenId] = true;
        emit PositionLockedMeme(tokenId, launchToken, stakerWallet);
        if (creatorBps > 0) emit PositionLockedWithCreator(tokenId, creatorWallet, creatorBps);
    }

    /// @notice Backed-token post-bond lock with launch-token burn on every slice: launch fees → burn;
    ///         quote fees → `backingBps` / `stakerBps` / `creatorBps` / beneficiary (e.g. 50/5/35/10).
    ///         Stamper-only.
    function lockPositionWithSplitLaunch(
        uint256 tokenId,
        address launchToken,
        address quoteToken,
        address backingWallet,
        uint16 backingBps,
        address stakerWallet,
        uint16 stakerBps,
        address creatorWallet,
        uint16 creatorBps
    ) external returns (uint64 unlockTime) {
        if (msg.sender != stamper) revert NotStamper();
        if (launchToken == address(0) || quoteToken == address(0)) revert ZeroAddress();
        if (uint256(backingBps) + stakerBps + creatorBps > BPS_DENOM) revert BadBps();
        if (backingBps > 0 && backingWallet == address(0)) revert ZeroAddress();
        if (stakerBps > 0 && stakerWallet == address(0)) revert ZeroAddress();
        if (creatorBps > 0 && creatorWallet == address(0)) revert ZeroAddress();
        if (seen[tokenId]) revert AlreadyLocked();
        if (POSITION_MANAGER.ownerOf(tokenId) != address(this)) revert NotHeld();
        unlockTime = _stamp(tokenId, backingWallet, backingBps, stakerWallet, stakerBps);
        if (creatorWallet != address(0)) creatorSplits[tokenId] = CreatorSplit({wallet: creatorWallet, bps: creatorBps});
        launchTokens[tokenId] = launchToken;
        quoteTokens[tokenId] = quoteToken;
        emit PositionLockedWithLaunch(tokenId, launchToken, backingWallet, backingBps);
        if (creatorBps > 0) emit PositionLockedWithCreator(tokenId, creatorWallet, creatorBps);
    }

    /// @notice Dex-seed meme lock at launch: same fee routing as `lockPositionMeme`, but principal is
    ///         NOT withdrawable until `finalizeDexSeedLock` at graduation. `unlockTime` is 0 until
    ///         finalize starts the normal `defaultLockDuration` timer. Stamper-only (GraduationStamper
    ///         via `stampDexSeed`). Prevents pulling thin seed LP before the bonding curve completes.
    function lockDexSeedPosition(
        uint256 tokenId,
        address launchToken,
        address quoteToken,
        address creatorWallet,
        address stakerWallet,
        uint16 creatorBps,
        uint16 stakerBps
    ) external returns (uint64 unlockTime) {
        if (msg.sender != stamper) revert NotStamper();
        if (launchToken == address(0) || quoteToken == address(0) || stakerWallet == address(0)) revert ZeroAddress();
        if (uint256(stakerBps) + creatorBps > BPS_DENOM) revert BadBps();
        if (creatorBps > 0 && creatorWallet == address(0)) revert ZeroAddress();
        if (seen[tokenId]) revert AlreadyLocked();
        if (POSITION_MANAGER.ownerOf(tokenId) != address(this)) revert NotHeld();

        // unlockTime=0 until finalize — do NOT use _stamp (which would start the 365d timer at launch).
        unlockTime = 0;
        locks[tokenId] = Lock({
            beneficiary: defaultBeneficiary,
            unlockTime: 0,
            withdrawn: false,
            backingWallet: address(0),
            backingBps: 0
        });
        stakerSplits[tokenId] = StakerSplit({wallet: stakerWallet, bps: stakerBps});
        if (creatorWallet != address(0)) {
            creatorSplits[tokenId] = CreatorSplit({wallet: creatorWallet, bps: creatorBps});
        }
        launchTokens[tokenId] = launchToken;
        quoteTokens[tokenId] = quoteToken;
        memeMode[tokenId] = true;
        dexSeedPending[tokenId] = true;
        seen[tokenId] = true;
        lockedPositions.push(tokenId);

        emit PositionLocked(tokenId, defaultBeneficiary, 0);
        emit PositionLockedMeme(tokenId, launchToken, stakerWallet);
        emit DexSeedLocked(tokenId, launchToken, quoteToken, creatorWallet, creatorBps, stakerBps);
        if (creatorBps > 0) emit PositionLockedWithCreator(tokenId, creatorWallet, creatorBps);
    }

    /// @notice Dex-seed lock for RWA/perp-backed launches: same deferred principal as meme dex-seed,
    ///         but quote fees use the backed LP split (backing/staker/creator/platform) matching
    ///         `lockPositionWithSplitLaunch`. Stamper-only.
    function lockDexSeedPositionBacked(
        uint256 tokenId,
        address launchToken,
        address quoteToken,
        address backingWallet,
        uint16 backingBps,
        address stakerWallet,
        uint16 stakerBps,
        address creatorWallet,
        uint16 creatorBps
    ) external returns (uint64 unlockTime) {
        if (msg.sender != stamper) revert NotStamper();
        if (launchToken == address(0) || quoteToken == address(0)) revert ZeroAddress();
        if (uint256(backingBps) + stakerBps + creatorBps > BPS_DENOM) revert BadBps();
        if (backingBps > 0 && backingWallet == address(0)) revert ZeroAddress();
        if (stakerBps > 0 && stakerWallet == address(0)) revert ZeroAddress();
        if (creatorBps > 0 && creatorWallet == address(0)) revert ZeroAddress();
        if (seen[tokenId]) revert AlreadyLocked();
        if (POSITION_MANAGER.ownerOf(tokenId) != address(this)) revert NotHeld();

        unlockTime = 0;
        locks[tokenId] = Lock({
            beneficiary: defaultBeneficiary,
            unlockTime: 0,
            withdrawn: false,
            backingWallet: backingWallet,
            backingBps: backingBps
        });
        if (stakerWallet != address(0)) stakerSplits[tokenId] = StakerSplit({wallet: stakerWallet, bps: stakerBps});
        if (creatorWallet != address(0)) {
            creatorSplits[tokenId] = CreatorSplit({wallet: creatorWallet, bps: creatorBps});
        }
        launchTokens[tokenId] = launchToken;
        quoteTokens[tokenId] = quoteToken;
        memeMode[tokenId] = false;
        dexSeedPending[tokenId] = true;
        seen[tokenId] = true;
        lockedPositions.push(tokenId);

        emit PositionLocked(tokenId, defaultBeneficiary, 0);
        emit PositionLockedWithLaunch(tokenId, launchToken, backingWallet, backingBps);
        emit DexSeedLocked(tokenId, launchToken, quoteToken, creatorWallet, creatorBps, stakerBps);
        if (creatorBps > 0) emit PositionLockedWithCreator(tokenId, creatorWallet, creatorBps);
    }

    /// @notice Start the principal lock timer on a dex-seed position at curve graduation. Factory-only.
    ///         Sets `unlockTime = now + defaultLockDuration` and clears `dexSeedPending` so withdraw
    ///         is allowed after the term (same as a normal graduated meme lock).
    function finalizeDexSeedLock(uint256 tokenId) external returns (uint64 unlockTime) {
        if (msg.sender != factory) revert NotFactory();
        Lock storage l = locks[tokenId];
        if (l.beneficiary == address(0)) revert NotLocked();
        if (l.withdrawn) revert AlreadyWithdrawn();
        if (!dexSeedPending[tokenId]) {
            // Already finalized (or never a dex-seed lock). Distinguish for clearer reverts.
            if (l.unlockTime != 0) revert AlreadyFinalized();
            revert NotDexSeedLock();
        }
        unlockTime = uint64(block.timestamp) + defaultLockDuration;
        l.unlockTime = unlockTime;
        dexSeedPending[tokenId] = false;
        emit DexSeedFinalized(tokenId, unlockTime);
    }

    /// @notice Factory-only: add liquidity to a held position (dex-seed graduation merge). Pulls
    ///         `amount0Desired`/`amount1Desired` from the factory via `transferFrom`, mints into the
    ///         existing NFT, refunds unused amounts to the factory. Atomic — if increase reverts,
    ///         the whole call reverts and no tokens leave the factory.
    function increaseLiquidity(uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired)
        external
        nonReentrant
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        if (msg.sender != factory) revert NotFactory();
        Lock storage l = locks[tokenId];
        if (l.beneficiary == address(0)) revert NotLocked();
        if (l.withdrawn) revert AlreadyWithdrawn();
        if (POSITION_MANAGER.ownerOf(tokenId) != address(this)) revert NotHeld();

        (,, address token0, address token1,,,,,,,,) = POSITION_MANAGER.positions(tokenId);
        if (amount0Desired > 0) IERC20(token0).safeTransferFrom(msg.sender, address(this), amount0Desired);
        if (amount1Desired > 0) IERC20(token1).safeTransferFrom(msg.sender, address(this), amount1Desired);

        IERC20(token0).forceApprove(address(POSITION_MANAGER), amount0Desired);
        IERC20(token1).forceApprove(address(POSITION_MANAGER), amount1Desired);
        (liquidity, amount0, amount1) = POSITION_MANAGER.increaseLiquidity(
            INonfungiblePositionManager.IncreaseLiquidityParams({
                tokenId: tokenId,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp
            })
        );
        IERC20(token0).forceApprove(address(POSITION_MANAGER), 0);
        IERC20(token1).forceApprove(address(POSITION_MANAGER), 0);

        uint256 left0 = amount0Desired - amount0;
        uint256 left1 = amount1Desired - amount1;
        if (left0 > 0) IERC20(token0).safeTransfer(msg.sender, left0);
        if (left1 > 0) IERC20(token1).safeTransfer(msg.sender, left1);
    }

    /// @notice Auto-stamp positions sent via `safeTransferFrom` (manual deposits). Only the position
    ///         manager may deposit NFTs this way. Manual deposits never carry a fee split.
    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        if (msg.sender != address(POSITION_MANAGER)) revert NotPositionManager();
        if (seen[tokenId] && locks[tokenId].withdrawn) revert AlreadyWithdrawn();
        if (!seen[tokenId]) _stamp(tokenId, address(0), 0, address(0), 0);
        return this.onERC721Received.selector;
    }

    function _stamp(uint256 tokenId, address backingWallet, uint16 backingBps, address stakerWallet, uint16 stakerBps)
        internal
        returns (uint64 unlockTime)
    {
        unlockTime = uint64(block.timestamp) + defaultLockDuration;
        locks[tokenId] = Lock({
            beneficiary: defaultBeneficiary,
            unlockTime: unlockTime,
            withdrawn: false,
            backingWallet: backingWallet,
            backingBps: backingBps
        });
        if (stakerWallet != address(0)) stakerSplits[tokenId] = StakerSplit({wallet: stakerWallet, bps: stakerBps});
        seen[tokenId] = true;
        lockedPositions.push(tokenId);
        emit PositionLocked(tokenId, defaultBeneficiary, unlockTime);
        if (backingBps > 0) emit PositionLockedWithBacking(tokenId, backingWallet, backingBps);
    }

    // ─── Fees (collectable throughout the lock; never touches principal) ──────────────────────

    /// @notice Sweep a position's accrued swap fees to its beneficiary. Permissionless to call (the
    ///         destination is fixed to the lock's beneficiary).
    function collectFees(uint256 tokenId) public nonReentrant returns (uint256 amount0, uint256 amount1) {
        (amount0, amount1) = _collectFees(tokenId);
    }

    function collectFeesBatch(uint256[] calldata tokenIds) external nonReentrant {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            _collectFees(tokenIds[i]);
        }
    }

    /// @notice Re-stamp a position's creator-fee-leg recipient from the factory's CURRENT
    ///         `getCreatorRewards(launchToken)`. Bps is untouched — only the recipient wallet moves.
    ///
    ///         Why this exists: `factory.setCreatorRewards(token, newWallet)` only updates the
    ///         factory's own record. A locked position's fee sweep pays whatever wallet was stamped
    ///         into `creatorSplits[tokenId]` at LOCK time (see `_stampLock`) — a factory-side
    ///         reassignment (abandoned-token handoff, voluntary creator transfer) has zero effect on
    ///         an already-locked token's payouts until this is called once.
    ///
    ///         Permissionless: it only ever pulls the factory's current on-chain truth into the
    ///         locker, the same authority `setCreatorRewards` itself already gates (platform owner
    ///         only) — this function grants no new privilege, it just propagates one that already
    ///         took effect factory-side.
    function syncCreatorSplit(uint256 tokenId) external returns (address newWallet) {
        address token = launchTokens[tokenId];
        if (token == address(0)) revert NoLaunchToken();
        newWallet = ICreatorSource(factory).getCreatorRewards(token);
        if (newWallet == address(0)) revert ZeroAddress();
        CreatorSplit storage c = creatorSplits[tokenId];
        address old = c.wallet;
        if (old == newWallet) return newWallet; // already in sync
        c.wallet = newWallet;
        emit CreatorSplitSynced(tokenId, old, newWallet);
    }

    /// @dev Shared fee-collection core. Guarded by `nonReentrant` at every external entrypoint
    ///      (`collectFees` / `collectFeesBatch`); the batch path calls this directly so it does not
    ///      re-enter the single-call guard.
    function _collectFees(uint256 tokenId) internal returns (uint256 amount0, uint256 amount1) {
        Lock storage l = locks[tokenId];
        if (l.beneficiary == address(0)) revert NotLocked();
        if (l.withdrawn) revert AlreadyWithdrawn();

        StakerSplit storage s = stakerSplits[tokenId];
        CreatorSplit storage c = creatorSplits[tokenId];
        address launch = launchTokens[tokenId];
        bool routed = launch != address(0) || memeMode[tokenId] || l.backingBps > 0 || s.bps > 0 || c.bps > 0;

        if (!routed) {
            // Legacy path: collect straight to the beneficiary (1 transfer, no split).
            (amount0, amount1) = POSITION_MANAGER.collect(
                INonfungiblePositionManager.CollectParams({
                    tokenId: tokenId,
                    recipient: l.beneficiary,
                    amount0Max: type(uint128).max,
                    amount1Max: type(uint128).max
                })
            );
            emit FeesCollected(tokenId, l.beneficiary, amount0, amount1);
            return (amount0, amount1);
        }

        // Routed path: collect to this contract, then apply per-token policy (burn launch / split quote).
        (amount0, amount1) = POSITION_MANAGER.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        (,, address token0, address token1,,,,,,,,) = POSITION_MANAGER.positions(tokenId);
        uint256 b0 = _routeFee(tokenId, token0, amount0, l, s, c);
        uint256 b1 = _routeFee(tokenId, token1, amount1, l, s, c);
        emit FeesCollected(tokenId, l.beneficiary, amount0, amount1);
        if (l.backingBps > 0) emit FeesSplit(tokenId, l.backingWallet, b0, b1);
    }

    /// @dev Per-token post-bond routing. Launch side → burn when stamped; quote side → the stamped
    ///      staker/creator/platform (meme) or backing/staker/creator/platform (backed) split.
    ///      Returns backing slice (for FeesSplit event) on quote path only.
    function _routeFee(
        uint256 tokenId,
        address token,
        uint256 amount,
        Lock storage l,
        StakerSplit storage s,
        CreatorSplit storage c
    ) internal returns (uint256 toBacking) {
        if (amount == 0) return 0;
        address launch = launchTokens[tokenId];
        address quote = quoteTokens[tokenId];
        if (launch != address(0) && token == launch) {
            IERC20(token).safeTransfer(BURN_ADDR, amount);
            emit LaunchFeesBurned(tokenId, token, amount);
            return 0;
        }
        if (quote != address(0) && token != quote) {
            IERC20(token).safeTransfer(BURN_ADDR, amount);
            emit LaunchFeesBurned(tokenId, token, amount);
            return 0;
        }
        return _splitQuote(token, amount, l.backingWallet, l.backingBps, s.wallet, s.bps, c.wallet, c.bps, l.beneficiary);
    }

    /// @dev Quote-side split for backed tokens. Staker leg is unwrapped to native before push; creator
    ///      leg is a plain ERC-20 transfer (creators expect the quote token directly, same as backing).
    function _splitQuote(
        address token,
        uint256 amount,
        address backing,
        uint16 backingBps,
        address staker,
        uint16 stakerBps,
        address creator,
        uint16 creatorBps,
        address beneficiary
    ) internal returns (uint256 toBacking) {
        if (amount == 0) return 0;
        toBacking = (amount * backingBps) / BPS_DENOM;
        uint256 toStaker = (amount * stakerBps) / BPS_DENOM;
        uint256 toCreator = (amount * creatorBps) / BPS_DENOM;
        uint256 toBeneficiary = amount - toBacking - toStaker - toCreator;
        if (toBacking > 0) IERC20(token).safeTransfer(backing, toBacking);
        if (toStaker > 0) _pushQuoteToStaking(staker, token, toStaker, beneficiary);
        if (toCreator > 0) IERC20(token).safeTransfer(creator, toCreator);
        if (toBeneficiary > 0) IERC20(token).safeTransfer(beneficiary, toBeneficiary);
    }

    /// @dev Push a quote-token fee slice to the staker leg.
    ///      - Prefer unwrap WETH/WMON → native for sinks that only `receive()` (Stable InstantReflection).
    ///      - If unwrap fails (plain ERC-20 quote, e.g. Arc USDC 0x3600…), transfer the ERC-20 to the
    ///        staker so InstantReflectionUsdc fee sinks can `forwardFees()` into the factory.
    ///      - EOA stakers always get an ERC-20 transfer.
    function _pushQuoteToStaking(address staker, address quote, uint256 amount, address /* beneficiary */) internal {
        if (amount == 0) return;
        if (staker.code.length == 0) {
            IERC20(quote).safeTransfer(staker, amount);
            return;
        }
        try IWETH9(quote).withdraw(amount) {
            (bool ok,) = payable(staker).call{value: amount}("");
            if (!ok) IERC20(quote).safeTransfer(staker, amount);
        } catch {
            // Not a WETH9 (or withdraw reverts) — push ERC-20 quote to staker (fee sink / pool).
            // Do NOT fall back to beneficiary: that silently steals the holder leg on USDC-quoted memes.
            IERC20(quote).safeTransfer(staker, amount);
        }
    }

    // ─── Reclaim (only the beneficiary, only after unlock) ────────────────────────────────────

    function withdraw(uint256 tokenId) external nonReentrant {
        Lock storage l = locks[tokenId];
        if (msg.sender != l.beneficiary) revert NotBeneficiary();
        if (l.withdrawn) revert AlreadyWithdrawn();
        // Dex-seed pre-grad: unlockTime is 0, so the timestamp check alone would pass — block until finalize.
        if (dexSeedPending[tokenId]) revert StillLocked();
        if (block.timestamp < l.unlockTime) revert StillLocked();
        l.withdrawn = true;
        POSITION_MANAGER.transferFrom(address(this), l.beneficiary, tokenId);
        emit PositionWithdrawn(tokenId, l.beneficiary);
    }

    /// @notice Extend a lock (only longer — never shorter). Re-lock to keep liquidity locked.
    function extendLock(uint256 tokenId, uint64 newUnlockTime) external {
        Lock storage l = locks[tokenId];
        if (msg.sender != l.beneficiary) revert NotBeneficiary();
        if (l.withdrawn) revert AlreadyWithdrawn();
        // Block bypass of dex-seed principal hold via extendLock(unlockTime=1) before graduation.
        if (dexSeedPending[tokenId]) revert StillLocked();
        if (newUnlockTime <= l.unlockTime) revert MustExtend();
        l.unlockTime = newUnlockTime;
        emit LockExtended(tokenId, newUnlockTime);
    }

    /// @notice Reassign a lock's beneficiary (e.g., deployer → treasury). Only the current beneficiary.
    function setLockBeneficiary(uint256 tokenId, address next) external {
        Lock storage l = locks[tokenId];
        if (msg.sender != l.beneficiary) revert NotBeneficiary();
        if (next == address(0)) revert ZeroAddress();
        l.beneficiary = next;
        emit LockBeneficiaryChanged(tokenId, next);
    }

    /// @notice Owner retargets backing and/or staker fee *recipients* for an existing lock.
    ///         Bps are unchanged. Pass `address(0)` for a leg to leave that wallet untouched.
    ///         Used to collapse buyback/staking sinks onto the platform treasury without a re-lock.
    function retargetFeeRecipients(uint256 tokenId, address newBackingWallet, address newStakerWallet)
        external
    {
        if (msg.sender != owner) revert NotOwner();
        Lock storage l = locks[tokenId];
        if (l.beneficiary == address(0)) revert NotLocked();
        if (l.withdrawn) revert AlreadyWithdrawn();

        if (newBackingWallet != address(0)) {
            l.backingWallet = newBackingWallet;
        }
        StakerSplit storage s = stakerSplits[tokenId];
        if (newStakerWallet != address(0)) {
            s.wallet = newStakerWallet;
        }
        emit FeeRecipientsRetargeted(tokenId, l.backingWallet, s.wallet, l.backingBps, s.bps);
    }

    // ─── Admin (defaults for FUTURE locks; recipient retarget for EXISTING locks above) ───────

    function setDefaults(address beneficiary_, uint64 duration_) external {
        if (msg.sender != owner) revert NotOwner();
        if (beneficiary_ == address(0)) revert ZeroAddress();
        if (duration_ == 0) revert ZeroDuration();
        if (duration_ < MIN_LOCK_DURATION) revert DurationTooShort();
        defaultBeneficiary = beneficiary_;
        defaultLockDuration = duration_;
        emit DefaultsChanged(beneficiary_, duration_);
    }

    /// @notice Authorize the curve factory to stamp backing-split locks. Setting/rotating this only
    ///         affects FUTURE locks — existing locks' *bps* stay fixed (recipients can still be
    ///         moved via `retargetFeeRecipients`).
    function setStamper(address s) external {
        if (msg.sender != owner) revert NotOwner();
        stamper = s;
        emit StamperChanged(s);
    }

    /// @notice Authorize the curve factory to finalize dex-seed principal locks at graduation.
    ///         Independent of `stamper` (which is typically GraduationStamper, not the factory).
    function setFactory(address f) external {
        if (msg.sender != owner) revert NotOwner();
        factory = f;
        emit FactoryChanged(f);
    }

    function transferOwnership(address next) external {
        if (msg.sender != owner) revert NotOwner();
        if (next == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, next);
        owner = next;
    }

    // ─── Views ────────────────────────────────────────────────────────────────────────────────

    function lockedCount() external view returns (uint256) {
        return lockedPositions.length;
    }

    function allLockedPositions() external view returns (uint256[] memory) {
        return lockedPositions;
    }

    /// @notice Accept native ETH from WETH9 `withdraw` during staker quote pushes.
    receive() external payable {}
}

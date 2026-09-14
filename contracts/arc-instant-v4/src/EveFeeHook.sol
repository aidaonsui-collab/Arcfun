// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "v4-core/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {CurrencySettler} from "./libraries/CurrencySettler.sol";

/// @title EveFeeHook
/// @notice Shared v4 afterSwap hook for eve.fun Instant (meme, reflect, RWA).
///         One swap fee (0.3–3%), same on buy and sell. 100% of that fee is allocated
///         creator / burn / holders / auto-LP / platform. Platform floor 10%.
///
///         Fee is levied on the unspecified currency (what the swapper receives).
///         Burn: if that currency is the launch token, send to dead in this tx; if it is
///         quote, accrue to pendingBurn. `flushQuoteBurn` swaps quote -> launch outside
///         afterSwap and sends the launch token to dead. Auto-LP accrues per-pool
///         (`pendingAutoLp`); the factory mints it back into the locked position.
contract EveFeeHook is IHooks, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using CurrencySettler for Currency;
    using SafeCast for uint256;
    using SafeCast for int256;
    using StateLibrary for IPoolManager;

    uint16 public constant BPS_DENOM = 10_000;
    uint16 public constant MIN_FEE_BPS = 30; // 0.3%
    uint16 public constant MAX_FEE_BPS = 300; // 3%
    uint16 public constant MIN_PLATFORM_BPS = 1_000; // 10%
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice A pool's spot price snapshot only refreshes once it is this old, and is only
    ///         trusted (by `flushQuoteBurn` and `InstantAutoLp.mintClaimed`) once it is this
    ///         old again *after* that refresh. A manipulate-then-flush in one transaction
    ///         always reads a snapshot that predates the manipulation: either the anchor was
    ///         already fresh (so the manipulation swap did not touch it) or it was stale and
    ///         the manipulation swap just refreshed it (so it fails the age check until real
    ///         time — and real arbitrage exposure for the manipulator — has passed).
    uint32 public constant ANCHOR_MIN_AGE = 300; // 5 minutes
    /// @notice Max the pool's spot price may have moved from the anchor before a
    ///         permissionless flush/mint defers instead of pricing itself off it.
    uint16 public constant MAX_ANCHOR_DEVIATION_BPS = 300; // 3%

    struct Split {
        uint16 feeBps;
        uint16 creatorBps;
        uint16 burnBps;
        uint16 holdersBps;
        uint16 autoLpBps;
        uint16 platformBps;
    }

    struct PoolConfig {
        bool registered;
        address creator;
        address holders;
        address autoLp;
        address platformWallet;
        address launch;
        uint16 feeBps;
        uint16 creatorBps;
        uint16 burnBps;
        uint16 holdersBps;
        uint16 autoLpBps;
        uint16 platformBps;
    }

    error NotFactory();
    error NotManager();
    error NotOwner();
    error NotSelf();
    error AlreadyRegistered();
    error NotRegistered();
    error ZeroAddress();
    error BadSplit();
    error BadFeeBps();
    error HoldersRequired();
    error HookNotImplemented();
    error NotAutoLp();
    error Slippage();
    error ZeroOut();

    event PoolRegistered(PoolId indexed id, address indexed creator, address launch, Split split);
    event SplitPaidOrAccrued(
        PoolId indexed id,
        Currency indexed currency,
        uint256 total,
        uint256 creatorAmt,
        uint256 burnAmt,
        uint256 holdersAmt,
        uint256 autoLpAmt,
        uint256 platformAmt
    );
    event Burned(PoolId indexed id, Currency indexed currency, uint256 amount);
    event Withdrawn(address indexed recipient, Currency indexed currency, uint256 amount);
    event FactorySet(address indexed factory);
    event FactoryAllowed(address indexed factory, bool allowed);
    event OwnerTransferred(address indexed previous, address indexed next);
    event AutoLpClaimed(PoolId indexed id, address indexed to, uint256 amount0, uint256 amount1);
    event AutoLpCredited(PoolId indexed id, Currency indexed currency, uint256 amount);

    IPoolManager public immutable poolManager;
    address public owner;
    /// @notice Last factory enabled via setFactory. Informational — auth is `isFactory`.
    address public factory;
    /// @notice USDC Instant + each RWA factory share this hook; one address is not enough.
    mapping(address => bool) public isFactory;

    mapping(PoolId => PoolConfig) public configs;
    mapping(address => mapping(Currency => uint256)) public owed;
    /// @notice Quote-denominated burn slice waiting for `flushQuoteBurn`.
    mapping(PoolId => mapping(Currency => uint256)) public pendingBurn;
    /// @notice Auto-LP slice per pool (not mixed into factory `owed`, which is global per currency).
    mapping(PoolId => mapping(Currency => uint256)) public pendingAutoLp;

    struct PriceAnchor {
        uint160 sqrtPriceX96;
        uint32 timestamp;
    }

    /// @notice Periodic spot-price snapshot per pool. See `ANCHOR_MIN_AGE`.
    mapping(PoolId => PriceAnchor) public priceAnchor;

    struct QuoteBurnCall {
        PoolKey key;
        Currency quote;
        uint256 amount;
        uint256 minOut;
    }

    modifier onlyFactory() {
        if (!isFactory[msg.sender]) revert NotFactory();
        _;
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotManager();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param manager_ Uniswap v4 PoolManager.
    /// @param owner_ Explicit owner. A salted CREATE2 deploy would lock the CREATE2
    ///        factory as owner if this used msg.sender.
    constructor(IPoolManager manager_, address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        Hooks.validateHookPermissions(
            IHooks(address(this)),
            Hooks.Permissions({
                beforeInitialize: false,
                afterInitialize: false,
                beforeAddLiquidity: false,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: false,
                afterSwap: true,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: false,
                afterSwapReturnDelta: true,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            })
        );
        poolManager = manager_;
        owner = owner_;
    }

    function setFactory(address factory_) external onlyOwner {
        _setFactory(factory_, true);
    }

    function setFactoryAllowed(address factory_, bool allowed) external onlyOwner {
        _setFactory(factory_, allowed);
    }

    function _setFactory(address factory_, bool allowed) internal {
        if (factory_ == address(0)) revert ZeroAddress();
        isFactory[factory_] = allowed;
        if (allowed) factory = factory_;
        emit FactoryAllowed(factory_, allowed);
        if (allowed) emit FactorySet(factory_);
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, next);
        owner = next;
    }

    function registerPool(
        PoolKey calldata key,
        address creator,
        address holders,
        address autoLp,
        address platformWallet,
        address launch,
        Split calldata split
    ) external onlyFactory {
        if (creator == address(0) || platformWallet == address(0) || launch == address(0)) revert ZeroAddress();
        if (split.feeBps < MIN_FEE_BPS || split.feeBps > MAX_FEE_BPS) revert BadFeeBps();
        if (split.platformBps < MIN_PLATFORM_BPS) revert BadSplit();
        if (
            uint256(split.creatorBps) + split.burnBps + split.holdersBps + split.autoLpBps + split.platformBps
                != BPS_DENOM
        ) revert BadSplit();
        if (split.holdersBps > 0 && holders == address(0)) revert HoldersRequired();
        PoolId id = key.toId();
        if (configs[id].registered) revert AlreadyRegistered();
        configs[id] = PoolConfig({
            registered: true,
            creator: creator,
            holders: holders,
            autoLp: autoLp,
            platformWallet: platformWallet,
            launch: launch,
            feeBps: split.feeBps,
            creatorBps: split.creatorBps,
            burnBps: split.burnBps,
            holdersBps: split.holdersBps,
            autoLpBps: split.autoLpBps,
            platformBps: split.platformBps
        });
        emit PoolRegistered(id, creator, launch, split);
    }

    function withdraw(Currency currency) external returns (uint256 amount) {
        amount = owed[msg.sender][currency];
        if (amount == 0) return 0;
        owed[msg.sender][currency] = 0;
        currency.transfer(msg.sender, amount);
        emit Withdrawn(msg.sender, currency, amount);
    }

    /// @notice Send accrued launch-token burn to dead. Quote-side pendingBurn is swapped
    ///         to the launch token via `flushQuoteBurn` (cannot swap inside afterSwap).
    function flushBurn(PoolKey calldata key, Currency currency) external returns (uint256 amount) {
        return _flushBurn(key, currency, 0);
    }

    /// @notice Swap quote-side pendingBurn into the launch token and send it to dead.
    ///         Permissionless, not automated. v4 skips `afterSwap` when the hook itself is
    ///         the swapper, so this flush is not re-taxed. `minOut` is launch tokens received.
    function flushQuoteBurn(PoolKey calldata key, uint256 minOut) external returns (uint256 burned) {
        PoolId id = key.toId();
        PoolConfig memory c = configs[id];
        if (!c.registered) revert NotRegistered();
        Currency quote = Currency.unwrap(key.currency0) == c.launch ? key.currency1 : key.currency0;
        return _flushBurn(key, quote, minOut);
    }

    function _flushBurn(PoolKey calldata key, Currency currency, uint256 minOut) internal returns (uint256 amount) {
        PoolId id = key.toId();
        PoolConfig memory c = configs[id];
        if (!c.registered) revert NotRegistered();
        amount = pendingBurn[id][currency];
        if (amount == 0) return 0;

        if (Currency.unwrap(currency) == c.launch) {
            pendingBurn[id][currency] = 0;
            _payOrAccrue(currency, DEAD, amount);
            emit Burned(id, currency, amount);
            return amount;
        }

        // Quote-side: this flush swaps through the pool at whatever price it finds, so a
        // caller-supplied `minOut` alone is not a safe guard — the call is permissionless,
        // and a caller who wants fewer tokens burned just passes 0. What actually needs
        // checking is not the swap's output (that legitimately reflects the pool's own
        // size-dependent slippage, which a fixed floor cannot predict for an arbitrary
        // pendingBurn size) but whether the *starting* price was just set by this same
        // transaction. Require it to match a snapshot old enough that it could not have
        // been: once that holds, the swap's execution price is the pool's honest price for
        // its own size, with nothing left to game by omitting minOut. If the anchor is not
        // ready or the pool has moved off it, defer (nothing lost — pendingBurn is
        // untouched, anyone can retry).
        (uint160 anchorSqrtPriceX96_, bool ready) = _anchor(id);
        if (!ready) return 0;
        (uint160 currentSqrtPriceX96,,,) = poolManager.getSlot0(id);
        if (_deviatesTooMuch(currentSqrtPriceX96, anchorSqrtPriceX96_)) return 0;

        pendingBurn[id][currency] = 0;
        bytes memory result =
            poolManager.unlock(abi.encode(QuoteBurnCall({key: key, quote: currency, amount: amount, minOut: minOut})));
        amount = abi.decode(result, (uint256));
        emit Burned(id, Currency.wrap(c.launch), amount);
    }

    /// @notice Refresh the snapshot once it is stale. A no-op otherwise, so a burst of swaps
    ///         in one block cannot move the anchor more than once.
    function _syncAnchor(PoolId id) internal {
        PriceAnchor storage a = priceAnchor[id];
        if (a.timestamp != 0 && block.timestamp < uint256(a.timestamp) + ANCHOR_MIN_AGE) return;
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(id);
        a.sqrtPriceX96 = sqrtPriceX96;
        a.timestamp = uint32(block.timestamp);
    }

    function _anchor(PoolId id) internal view returns (uint160 sqrtPriceX96, bool ready) {
        PriceAnchor memory a = priceAnchor[id];
        sqrtPriceX96 = a.sqrtPriceX96;
        ready = a.timestamp != 0 && block.timestamp >= uint256(a.timestamp) + ANCHOR_MIN_AGE;
    }

    /// @notice Public so `InstantAutoLp.mintClaimed` can bound its mint price against the
    ///         same anchor this hook uses for burns.
    function anchorSqrtPriceX96(PoolId id) external view returns (uint160 sqrtPriceX96, bool ready) {
        return _anchor(id);
    }

    /// @notice True if `sqrtPriceX96` has moved more than `MAX_ANCHOR_DEVIATION_BPS` from
    ///         the anchor. Same check `InstantAutoLp.mintClaimed` applies before minting.
    function _deviatesTooMuch(uint160 sqrtPriceX96, uint160 anchorSqrtPriceX96_) internal pure returns (bool) {
        uint256 diff = sqrtPriceX96 > anchorSqrtPriceX96_
            ? uint256(sqrtPriceX96) - anchorSqrtPriceX96_
            : uint256(anchorSqrtPriceX96_) - sqrtPriceX96;
        return diff * BPS_DENOM > uint256(anchorSqrtPriceX96_) * MAX_ANCHOR_DEVIATION_BPS;
    }

    /// @notice Pull this pool's auto-LP inventory to the registered auto-LP (the factory).
    function claimAutoLp(PoolKey calldata key) external returns (uint256 amount0, uint256 amount1) {
        PoolId id = key.toId();
        PoolConfig memory c = configs[id];
        if (!c.registered) revert NotRegistered();
        if (msg.sender != c.autoLp) revert NotAutoLp();
        amount0 = pendingAutoLp[id][key.currency0];
        amount1 = pendingAutoLp[id][key.currency1];
        if (amount0 > 0) {
            pendingAutoLp[id][key.currency0] = 0;
            key.currency0.transfer(msg.sender, amount0);
        }
        if (amount1 > 0) {
            pendingAutoLp[id][key.currency1] = 0;
            key.currency1.transfer(msg.sender, amount1);
        }
        emit AutoLpClaimed(id, msg.sender, amount0, amount1);
    }

    /// @notice Restow unused auto-LP tokens after a mint. Caller must already have transferred.
    function creditAutoLp(PoolKey calldata key, Currency currency, uint256 amount) external {
        PoolId id = key.toId();
        PoolConfig memory c = configs[id];
        if (!c.registered) revert NotRegistered();
        if (msg.sender != c.autoLp) revert NotAutoLp();
        if (amount == 0) return;
        pendingAutoLp[id][currency] += amount;
        emit AutoLpCredited(id, currency, amount);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotManager();
        QuoteBurnCall memory call = abi.decode(data, (QuoteBurnCall));
        bool zeroForOne = call.quote == call.key.currency0;
        BalanceDelta d = poolManager.swap(
            call.key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(call.amount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int256 a0 = int256(d.amount0());
        int256 a1 = int256(d.amount1());
        if (a0 < 0) call.key.currency0.settle(poolManager, address(this), uint256(-a0), false);
        if (a1 < 0) call.key.currency1.settle(poolManager, address(this), uint256(-a1), false);
        uint256 amountOut;
        Currency outCur;
        if (a0 > 0) {
            amountOut = uint256(a0);
            outCur = call.key.currency0;
            call.key.currency0.take(poolManager, address(this), amountOut, false);
        }
        if (a1 > 0) {
            amountOut = uint256(a1);
            outCur = call.key.currency1;
            call.key.currency1.take(poolManager, address(this), amountOut, false);
        }
        if (amountOut == 0) revert ZeroOut();
        if (amountOut < call.minOut) revert Slippage();
        _payOrAccrue(outCur, DEAD, amountOut);
        return abi.encode(amountOut);
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        PoolId id = key.toId();
        PoolConfig memory c = configs[id];
        if (!c.registered) revert NotRegistered();
        _syncAnchor(id);

        bool specifiedIsCurrency0 = params.zeroForOne == (params.amountSpecified < 0);
        bool unspecifiedIsCurrency0 = !specifiedIsCurrency0;
        int256 unspecifiedDelta = int256(unspecifiedIsCurrency0 ? delta.amount0() : delta.amount1());
        uint256 unspecifiedAbs = (unspecifiedDelta < 0 ? -unspecifiedDelta : unspecifiedDelta).toUint256();
        if (unspecifiedAbs == 0) return (IHooks.afterSwap.selector, 0);

        uint256 feeAmount = (unspecifiedAbs * c.feeBps) / BPS_DENOM;
        if (feeAmount == 0) return (IHooks.afterSwap.selector, 0);

        Currency feeCurrency = unspecifiedIsCurrency0 ? key.currency0 : key.currency1;
        poolManager.take(feeCurrency, address(this), feeAmount);

        uint256 creatorAmt = (feeAmount * c.creatorBps) / BPS_DENOM;
        uint256 burnAmt = (feeAmount * c.burnBps) / BPS_DENOM;
        uint256 holdersAmt = (feeAmount * c.holdersBps) / BPS_DENOM;
        uint256 autoLpAmt = (feeAmount * c.autoLpBps) / BPS_DENOM;
        uint256 platformAmt = feeAmount - creatorAmt - burnAmt - holdersAmt - autoLpAmt;

        owed[c.creator][feeCurrency] += creatorAmt;
        owed[c.platformWallet][feeCurrency] += platformAmt;
        if (holdersAmt > 0 && c.holders != address(0)) owed[c.holders][feeCurrency] += holdersAmt;
        if (autoLpAmt > 0) {
            pendingAutoLp[id][feeCurrency] += autoLpAmt;
        }
        if (burnAmt > 0) {
            if (Currency.unwrap(feeCurrency) == c.launch) {
                _payOrAccrue(feeCurrency, DEAD, burnAmt);
                emit Burned(id, feeCurrency, burnAmt);
            } else {
                pendingBurn[id][feeCurrency] += burnAmt;
            }
        }

        emit SplitPaidOrAccrued(id, feeCurrency, feeAmount, creatorAmt, burnAmt, holdersAmt, autoLpAmt, platformAmt);
        return (IHooks.afterSwap.selector, feeAmount.toInt256().toInt128());
    }

    function _payOrAccrue(Currency currency, address to, uint256 amount) internal {
        if (amount == 0 || to == address(0)) return;
        try this.unsafeTransfer(currency, to, amount) {}
        catch {
            owed[to][currency] += amount;
        }
    }

    function unsafeTransfer(Currency currency, address to, uint256 amount) external {
        if (msg.sender != address(this)) revert NotSelf();
        currency.transfer(to, amount);
    }

    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        pure
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}

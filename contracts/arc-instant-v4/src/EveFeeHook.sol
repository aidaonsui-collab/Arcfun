// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "v4-core/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title EveFeeHook
/// @notice Shared v4 afterSwap hook for eve.fun Instant (meme, reflect, RWA).
///         One swap fee (0.3–3%), same on buy and sell. 100% of that fee is allocated
///         creator / burn / holders / auto-LP / platform. Platform floor 10%.
///
///         Fee is levied on the unspecified currency (what the swapper receives).
///         Burn: if that currency is the launch token, send to dead in this tx; if it is
///         quote, accrue to pendingBurn for a later permissionless flush (cannot swap
///         inside afterSwap). Auto-LP and holders accrue pull-based like creator.
contract EveFeeHook is IHooks {
    using PoolIdLibrary for PoolKey;
    using SafeCast for uint256;
    using SafeCast for int256;

    uint16 public constant BPS_DENOM = 10_000;
    uint16 public constant MIN_FEE_BPS = 30; // 0.3%
    uint16 public constant MAX_FEE_BPS = 300; // 3%
    uint16 public constant MIN_PLATFORM_BPS = 1_000; // 10%
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

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

    IPoolManager public immutable poolManager;
    address public owner;
    /// @notice Last factory enabled via setFactory. Informational — auth is `isFactory`.
    address public factory;
    /// @notice USDC Instant + each RWA factory share this hook; one address is not enough.
    mapping(address => bool) public isFactory;

    mapping(PoolId => PoolConfig) public configs;
    mapping(address => mapping(Currency => uint256)) public owed;
    /// @notice Quote-denominated burn slice waiting for flush (cannot swap in afterSwap).
    mapping(PoolId => mapping(Currency => uint256)) public pendingBurn;

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

    /// @notice Send accrued launch-token burn to dead. Quote-denominated pendingBurn is
    ///         left for a later flush that can swap (not in afterSwap).
    function flushBurn(PoolKey calldata key, Currency currency) external returns (uint256 amount) {
        PoolId id = key.toId();
        PoolConfig memory c = configs[id];
        if (!c.registered) revert NotRegistered();
        amount = pendingBurn[id][currency];
        if (amount == 0) return 0;
        pendingBurn[id][currency] = 0;
        if (Currency.unwrap(currency) == c.launch) {
            _payOrAccrue(currency, DEAD, amount);
            emit Burned(id, currency, amount);
        } else {
            // Quote side: park on this hook until a swapper flush exists. Keep pull-based
            // so this call never reverts the original collect. Anyone may retry.
            pendingBurn[id][currency] = amount;
        }
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        PoolId id = key.toId();
        PoolConfig memory c = configs[id];
        if (!c.registered) revert NotRegistered();

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
            address lpTo = c.autoLp == address(0) ? address(this) : c.autoLp;
            owed[lpTo][feeCurrency] += autoLpAmt;
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

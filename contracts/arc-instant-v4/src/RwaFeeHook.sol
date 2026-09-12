// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title RwaFeeHook
/// @notice The reason this pad exists on v4 instead of v3: a swap fee split paid out
///         atomically, in the swap itself, with no keeper. v3's CrucibleLock accrues fees in
///         the LP position and needs a cron to call collectFees() — the exact thing that's
///         needed a wall-clock budget fix and a keeper-key setup to keep alive (see
///         contracts/crucible, lib/arc-indexer/run.ts). This hook has no collection step: every
///         swap settles its own split before the transaction returns.
///
///         Permissions used: AFTER_SWAP + AFTER_SWAP_RETURNS_DELTA only. No beforeSwap, no
///         liquidity hooks — this contract's address must be CREATE2-mined so its low bits set
///         exactly those two flags (see HookMiner in test/, and script/ once a real deploy
///         happens).
///
///         Fee is levied on the *unspecified* currency of each swap (whichever side isn't what
///         the swapper pinned amountSpecified to) — i.e. "a cut of whatever you're receiving" on
///         an exact-input swap, the standard v4 fee-hook shape. That means accrued fees can be in
///         either the launch token or the quote (RWA) currency depending on trade mix over time,
///         not quote-only like the v3 model — recipients withdraw whichever currency actually
///         accrued to them.
///
///         Split (creator/crucible/platform) mirrors CrucibleLock's Meme split conceptually, not
///         numerically: there's no "project burn buys back the launch token" leg here (no
///         guaranteed launch-token/EVE route for an arbitrary RWA pair), so that share folds into
///         `crucible` — pending a documented follow-up to route accrued crucible-leg balances
///         into the existing EVE buyback-and-burn (contracts/eve-burn / scripts/cook-crucible.ts)
///         once a swap path from a given RWA quote into USDC exists. Until then this contract
///         only accrues; nothing here burns anything automatically.
contract RwaFeeHook is IHooks {
    using PoolIdLibrary for PoolKey;
    using SafeCast for uint256;
    using SafeCast for int256;

    uint16 public constant BPS_DENOM = 10_000;
    uint24 public constant DEFAULT_FEE_BPS = 100; // 1%, matches the pad's v3 pools

    struct PoolConfig {
        bool registered;
        address creator;
        address platformWallet;
        address crucible;
        uint16 creatorBps;
        uint16 crucibleBps;
        uint16 platformBps;
        uint24 feeBps;
    }

    error NotFactory();
    error NotManager();
    error NotOwner();
    error AlreadyRegistered();
    error NotRegistered();
    error ZeroAddress();
    error BadSplit();
    error BadFeeBps();
    error HookNotImplemented();

    event PoolRegistered(
        PoolId indexed id, address indexed creator, address platformWallet, address crucible, uint24 feeBps
    );
    event SplitPaidOrAccrued(
        PoolId indexed id, Currency indexed currency, uint256 total, uint256 creatorAmt, uint256 crucibleAmt, uint256 platformAmt
    );
    event Withdrawn(address indexed recipient, Currency indexed currency, uint256 amount);
    event FactorySet(address indexed factory);
    event OwnerTransferred(address indexed previous, address indexed next);

    IPoolManager public immutable poolManager;
    address public owner;
    address public factory;

    mapping(PoolId => PoolConfig) public configs;
    /// @notice recipient => currency => amount they can withdraw().
    mapping(address => mapping(Currency => uint256)) public owed;

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
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

    /// @param owner_ Explicit owner, NOT defaulted to msg.sender — this contract must be
    ///        CREATE2-deployed with a mined salt (its address encodes its permission bits), and
    ///        `forge script` broadcasts a salted `new X{salt}()` from an EOA through Foundry's
    ///        canonical CREATE2 factory (forge-std's StdConstants.CREATE2_FACTORY), not the EOA
    ///        directly. `msg.sender` inside this constructor would then be that factory contract
    ///        — an address nobody controls — permanently locking out setFactory/transferOwnership.
    ///        Caught by actually running a deploy script against a live Anvil node rather than
    ///        only unit-testing this contract (tests instantiate it directly, where msg.sender
    ///        really is the test contract, which is why this never showed up there).
    constructor(IPoolManager manager_, address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        // Validates that THIS contract's address (whatever it was CREATE2-deployed to) actually
        // carries the AFTER_SWAP + AFTER_SWAP_RETURNS_DELTA bits and nothing else — deploying to
        // a wrong-bit address silently makes the PoolManager skip calling afterSwap at all,
        // which would mean the fee split never runs and nobody would notice until the sink stays
        // empty. Fail the deployment instead.
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

    // ── admin ──────────────────────────────────────────────────────────────────────────────
    function setFactory(address factory_) external onlyOwner {
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        emit FactorySet(factory_);
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, next);
        owner = next;
    }

    /// @notice Called once by the factory, inside the same unlock() as pool initialize + the
    ///         single-sided liquidity mint — before that mint, so no swap can land on an
    ///         unregistered pool.
    function registerPool(
        PoolKey calldata key,
        address creator,
        address platformWallet,
        address crucible,
        uint16 creatorBps,
        uint16 crucibleBps,
        uint16 platformBps,
        uint24 feeBps
    ) external onlyFactory {
        if (creator == address(0) || platformWallet == address(0) || crucible == address(0)) revert ZeroAddress();
        if (creatorBps + crucibleBps + platformBps != BPS_DENOM) revert BadSplit();
        if (feeBps == 0 || feeBps > 5_000) revert BadFeeBps(); // sanity cap at 50%
        PoolId id = key.toId();
        if (configs[id].registered) revert AlreadyRegistered();
        configs[id] = PoolConfig({
            registered: true,
            creator: creator,
            platformWallet: platformWallet,
            crucible: crucible,
            creatorBps: creatorBps,
            crucibleBps: crucibleBps,
            platformBps: platformBps,
            feeBps: feeBps
        });
        emit PoolRegistered(id, creator, platformWallet, crucible, feeBps);
    }

    /// @notice Pull whatever accrued to you. Pull-based on purpose — see CrucibleLock's
    ///         owed/_payOrAccrue pattern this mirrors: a recipient that reverts on transfer
    ///         (blacklist, paused token) must never be able to jam every future swap.
    function withdraw(Currency currency) external returns (uint256 amount) {
        amount = owed[msg.sender][currency];
        if (amount == 0) return 0;
        owed[msg.sender][currency] = 0;
        currency.transfer(msg.sender, amount);
        emit Withdrawn(msg.sender, currency, amount);
    }

    // ── the only hook that does anything ──────────────────────────────────────────────────
    function afterSwap(
        address, /* sender */
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata /* hookData */
    ) external onlyPoolManager returns (bytes4, int128) {
        PoolId id = key.toId();
        PoolConfig memory c = configs[id];
        if (!c.registered) revert NotRegistered();

        // Standard v4 idiom: XNOR of direction and exact-in/out tells you which side of the
        // trade the swapper pinned. The other side is what this hook takes its cut from.
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
        uint256 platformAmt = (feeAmount * c.platformBps) / BPS_DENOM;
        // Remainder (rounding dust + the crucible leg itself) goes to crucible — same
        // "remainder absorbs dust" convention as CrucibleLock.quoteSplit.
        uint256 crucibleAmt = feeAmount - creatorAmt - platformAmt;

        owed[c.creator][feeCurrency] += creatorAmt;
        owed[c.platformWallet][feeCurrency] += platformAmt;
        owed[c.crucible][feeCurrency] += crucibleAmt;

        emit SplitPaidOrAccrued(id, feeCurrency, feeAmount, creatorAmt, crucibleAmt, platformAmt);

        // Checked downcast: reverts (rather than silently wrapping) in the unreachable-in-practice
        // case where a 50%-capped fee of a swap delta still somehow exceeds int128 — see
        // registerPool's feeBps <= 5_000 cap.
        return (IHooks.afterSwap.selector, feeAmount.toInt256().toInt128());
    }

    // ── every other IHooks function: never invoked (permission bits gate that), but the
    //    interface requires a body. Revert rather than silently no-op, so a PoolManager upgrade
    //    or a misconfigured pool that somehow calls one of these fails loudly. ──────────────
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

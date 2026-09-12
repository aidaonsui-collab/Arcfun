// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {CurrencySettler} from "./libraries/CurrencySettler.sol";
import {RwaFeeHook} from "./RwaFeeHook.sol";

/// @title BasketVault
/// @notice "Earn RWAs automatically, just for holding" — one of these per basket-enabled pool,
///         registered as that pool's `crucible` recipient in RwaFeeHook. Pulls the accrued leg,
///         converts it into a creator-configured basket of assets (stocks/ETFs/other RWAs —
///         anything with a real v4 pool against the pulled currency), and holds the converted
///         balance for holders to be paid out from.
///
///         ONE VAULT PER POOL, DELIBERATELY — not a single shared router address reused across
///         every basket-enabled launch. RwaFeeHook.owed[recipient][currency] is keyed by
///         (recipient address, currency) globally across every pool that hook serves. If the same
///         router address were registered as `crucible` for two different pools that happen to
///         share a quote currency (extremely likely — most RWA launches would share the same
///         RWA quote asset), their accrued fees would land in the exact same owed[] slot with no
///         way to tell whose money is whose. A dedicated contract per pool makes that structurally
///         impossible instead of a bookkeeping problem to get right.
///
///         Payout to individual holders is NOT computed on-chain. Enumerating "every current
///         holder and their exact balance" cheaply on-chain is a real unsolved problem for a
///         plain ERC-20 (no snapshot/checkpoint system here); this mirrors the pattern already
///         proven in production for $EVE holder rewards (lib/arc-eve-holder-rewards.ts): a keeper
///         reads real balances off-chain, computes the pro-rata weights, and submits exact
///         amounts on-chain via `disperse`. This contract's only enforcement is that a submitted
///         batch can never exceed what actually converted for holders — same trust boundary the
///         existing EVE rewards keeper already operates under, not a new one.
contract BasketVault is IUnlockCallback {
    using CurrencyLibrary for Currency;
    using CurrencySettler for Currency;
    using SafeCast for int256;

    enum PayoutMode {
        AllAtOnce, // every convert() splits the full pulled amount across every basket asset by weight
        Rotating // every convert() sends the full pulled amount to just the next asset in line

    }

    struct BasketAsset {
        Currency asset;
        uint16 weightBps; // used in AllAtOnce; stored but ignored in Rotating
        PoolKey poolKey; // the (fromCurrency <-> asset) pool to route the conversion swap through
    }

    error ZeroAddress();
    error NotOwner();
    error NotCreator();
    error EmptyBasket();
    error BadWeights();
    error LengthMismatch();
    error NotSelf();
    error NothingPending();
    error ExceedsPending();
    error PoolMismatch();
    error SlippageExceeded();

    event OwnerTransferred(address indexed previous, address indexed next);
    event BasketConfigured(PayoutMode mode, uint256 assetCount);
    event Pulled(Currency indexed currency, uint256 amount);
    event Converted(Currency indexed fromCurrency, Currency indexed toAsset, uint256 amountIn, uint256 amountOut);
    event Dispersed(Currency indexed asset, uint256 totalPaid, uint256 recipients);

    RwaFeeHook public immutable hook;
    IPoolManager public immutable poolManager;
    /// @notice The launch's creator — the only one allowed to reconfigure the basket. Matches the
    ///         tweet's "fully automatic, no relaunches": changing the payout basket never touches
    ///         the token or its pool.
    address public immutable creator;
    /// @notice Keeper/ops address allowed to submit `disperse` batches. Settable because the
    ///         keeper running the off-chain balance computation is an operational detail, not
    ///         part of what the creator committed to at launch.
    address public owner;

    PayoutMode public mode;
    BasketAsset[] public basket;
    uint256 public rotateIndex;

    /// @notice Pulled from the hook but not yet swapped into the basket, per source currency.
    mapping(Currency => uint256) public pendingConvert;
    /// @notice Converted and waiting for `disperse` to pay it out to holders, per basket asset.
    mapping(Currency => uint256) public pendingDistribution;

    modifier onlyCreator() {
        if (msg.sender != creator) revert NotCreator();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(RwaFeeHook hook_, IPoolManager manager_, address creator_, address owner_) {
        if (creator_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        hook = hook_;
        poolManager = manager_;
        creator = creator_;
        owner = owner_;
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, next);
        owner = next;
    }

    /// @notice AllAtOnce requires weights summing to exactly 10_000; Rotating's weights are
    ///         stored but not enforced to sum to anything (a rotation just walks the list).
    ///         Each entry's poolKey must be the real (currency you intend to `convert` from,
    ///         this asset) v4 pool — mismatches revert at convert() time via PoolMismatch, not
    ///         silently route through the wrong pool.
    function setBasket(
        address[] calldata assets,
        uint16[] calldata weightsBps,
        PoolKey[] calldata poolKeys,
        PayoutMode mode_
    ) external onlyCreator {
        if (assets.length == 0) revert EmptyBasket();
        if (assets.length != weightsBps.length || assets.length != poolKeys.length) revert LengthMismatch();
        delete basket;
        uint256 sum;
        for (uint256 i; i < assets.length; i++) {
            if (assets[i] == address(0)) revert ZeroAddress();
            sum += weightsBps[i];
            basket.push(BasketAsset({asset: Currency.wrap(assets[i]), weightBps: weightsBps[i], poolKey: poolKeys[i]}));
        }
        if (mode_ == PayoutMode.AllAtOnce && sum != 10_000) revert BadWeights();
        mode = mode_;
        rotateIndex = 0;
        emit BasketConfigured(mode_, assets.length);
    }

    function basketLength() external view returns (uint256) {
        return basket.length;
    }

    /// @notice Permissionless: pull whatever accrued to this vault from the hook for `currency`.
    ///         Safe to call for either side RwaFeeHook might tax (the launch token on a sell, the
    ///         quote asset on a buy — see RwaFeeHook's afterSwap) since this vault is the sole
    ///         crucible recipient for its one pool.
    function pull(Currency currency) external returns (uint256 pulled) {
        pulled = hook.withdraw(currency);
        pendingConvert[currency] += pulled;
        emit Pulled(currency, pulled);
    }

    /// @notice Swap `fromCurrency`'s full pending balance into the basket.
    ///         AllAtOnce: `minOuts` must have one entry per basket asset, in order.
    ///         Rotating: `minOuts` must have exactly one entry, for whichever asset is next.
    function convert(Currency fromCurrency, uint256[] calldata minOuts) external returns (uint256 totalIn) {
        uint256 n = basket.length;
        if (n == 0) revert EmptyBasket();
        uint256 amount = pendingConvert[fromCurrency];
        if (amount == 0) revert NothingPending();
        pendingConvert[fromCurrency] = 0;

        if (mode == PayoutMode.AllAtOnce) {
            if (minOuts.length != n) revert LengthMismatch();
            uint256 distributed;
            for (uint256 i; i < n; i++) {
                // Last leg absorbs rounding dust rather than risk leaving wei behind.
                uint256 amtIn = i == n - 1 ? amount - distributed : (amount * basket[i].weightBps) / 10_000;
                distributed += amtIn;
                if (amtIn == 0) continue;
                _swapAndCredit(fromCurrency, basket[i], amtIn, minOuts[i]);
            }
        } else {
            if (minOuts.length != 1) revert LengthMismatch();
            _swapAndCredit(fromCurrency, basket[rotateIndex], amount, minOuts[0]);
            rotateIndex = (rotateIndex + 1) % n;
        }
        totalIn = amount;
    }

    function _swapAndCredit(Currency fromCurrency, BasketAsset memory a, uint256 amountIn, uint256 minOut) internal {
        bytes memory result =
            poolManager.unlock(abi.encode(a.poolKey, fromCurrency, a.asset, amountIn, minOut));
        uint256 amountOut = abi.decode(result, (uint256));
        pendingDistribution[a.asset] += amountOut;
        emit Converted(fromCurrency, a.asset, amountIn, amountOut);
    }

    // ── IUnlockCallback ────────────────────────────────────────────────────────────────────
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotSelf();
        (PoolKey memory key, Currency fromCurrency, Currency toAsset, uint256 amountIn, uint256 minOut) =
            abi.decode(data, (PoolKey, Currency, Currency, uint256, uint256));

        bool fromIsCurrency0 = fromCurrency == key.currency0;
        bool matches_ = fromIsCurrency0 ? toAsset == key.currency1 : toAsset == key.currency0;
        if (!matches_) revert PoolMismatch();

        // casting to 'int256' is safe because amountIn is a real accrued-fee balance — nowhere
        // near uint256's top bit — and V4's exact-input convention is a negative amountSpecified
        SwapParams memory params = SwapParams({
            zeroForOne: fromIsCurrency0,
            amountSpecified: -int256(amountIn),
            sqrtPriceLimitX96: fromIsCurrency0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
        BalanceDelta delta = poolManager.swap(key, params, "");

        int256 fromDelta = int256(fromIsCurrency0 ? delta.amount0() : delta.amount1());
        int256 outDelta = int256(fromIsCurrency0 ? delta.amount1() : delta.amount0());

        fromCurrency.settle(poolManager, address(this), (-fromDelta).toUint256(), false);
        uint256 amountOut = outDelta.toUint256();
        if (amountOut < minOut) revert SlippageExceeded();
        toAsset.take(poolManager, address(this), amountOut, false);

        return abi.encode(amountOut);
    }

    /// @notice Owner-submitted, off-chain-computed pro-rata payout — see the contract-level
    ///         comment for why this can't be permissionless or computed on-chain. The only
    ///         on-chain guarantee is `sum(amounts) <= pendingDistribution[asset]`; correctness of
    ///         the weights themselves is the keeper's responsibility, same as today's EVE rewards.
    function disperse(Currency asset, address[] calldata holders, uint256[] calldata amounts) external onlyOwner {
        if (holders.length != amounts.length) revert LengthMismatch();
        uint256 total;
        for (uint256 i; i < amounts.length; i++) {
            total += amounts[i];
        }
        if (total > pendingDistribution[asset]) revert ExceedsPending();
        pendingDistribution[asset] -= total;
        for (uint256 i; i < holders.length; i++) {
            if (amounts[i] > 0) asset.transfer(holders[i], amounts[i]);
        }
        emit Dispersed(asset, total, holders.length);
    }
}

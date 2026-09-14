// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {CurrencySettler} from "./libraries/CurrencySettler.sol";
import {EveFeeHook} from "./EveFeeHook.sol";
import {IHolderSinkNotify} from "./LaunchToken18Tracked.sol";

/// @title BundleSink
/// @notice "Earn RWAs automatically, just for holding" — the `holders` destination for an
///         RwaInstantV4Factory launch that opts into a bundle. Same job BundleVault (the earlier,
///         now-retired version of this contract) did, rebuilt on top of the accrual mechanism
///         EveFeeHook's HolderSink already proved for plain launch-token/quote reflections: real-
///         time, on-chain, per-share accounting checkpointed via LaunchToken18Tracked's transfer
///         hook, instead of an off-chain keeper computing balances and submitting disperse()
///         batches. Concretely:
///
///         - `pull`/`convert` are unchanged from BundleVault: pull whatever RwaFeeHook-successor
///           EveFeeHook accrued to this sink, swap it into the creator's configured basket via
///           real v4 pools. This half has no HolderSink equivalent — HolderSink only ever pays out
///           in the two currencies it was constructed with (launch token, quote); it has no notion
///           of converting into a creator-chosen list of other assets at all.
///         - Distribution is HolderSink's half, generalized: HolderSink's accPerShare/debt/
///           unclaimed maps are already keyed by an arbitrary Currency, just only ever looped over
///           two hardcoded ones (launch, quote). This contract loops over `trackedAssets` instead
///           — every basket asset the creator has ever configured — so every holder gets a real,
///           permissionless `claim()` per asset, correct at every instant via `onTransfer`
///           checkpointing. There is no owner-gated disperse() left to trust: the only privileged
///           action anywhere in this contract is `setBasket`, gated to the launch's creator.
///
///         ONE SINK PER POOL, same reasoning BundleVault had: EveFeeHook.owed[recipient][currency]
///         is keyed globally by (address, currency) across every pool the hook serves, so reusing
///         one sink address across two pools that share a quote currency would land both pools'
///         fees in the same slot with no way to tell whose money is whose.
///
///         Why RwaInstantV4Factory can allow this specifically where it otherwise bans a holders
///         slice: the compliance concern that ban exists for is a permissioned MMF token (USYC,
///         BUIDL) landing directly in an arbitrary holder's wallet. Holders here never receive the
///         raw quote asset — `convert()` swaps it into whatever the creator's basket holds first,
///         and only the converted asset is ever paid out via `claim()`.
contract BundleSink is IUnlockCallback, IHolderSinkNotify {
    using CurrencyLibrary for Currency;
    using CurrencySettler for Currency;
    using SafeCast for int256;

    uint256 public constant SCALE = 1e18;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    enum PayoutMode {
        AllAtOnce, // every convert() splits the full pulled amount across every basket asset by weight
        Rotating // every convert() sends the full pulled amount to just the next asset in line

    }

    struct BundleAsset {
        Currency asset;
        uint16 weightBps; // used in AllAtOnce; stored but ignored in Rotating
        PoolKey poolKey; // the (fromCurrency <-> asset) pool to route the conversion swap through
    }

    error ZeroAddress();
    error NotCreator();
    error NotToken();
    error NotSelf();
    error EmptyBundle();
    error BadWeights();
    error LengthMismatch();
    error NothingPending();
    error PoolMismatch();
    error SlippageExceeded();

    event BundleConfigured(PayoutMode mode, uint256 assetCount);
    event Pulled(Currency indexed currency, uint256 amount);
    event Converted(Currency indexed fromCurrency, Currency indexed toAsset, uint256 amountIn, uint256 amountOut);
    event Accrued(Currency indexed asset, uint256 amount, uint256 eligible);
    event Claimed(address indexed user, Currency indexed asset, uint256 amount);

    EveFeeHook public immutable hook;
    IPoolManager public immutable poolManager;
    IERC20 public immutable token; // the tracked launch token this sink pays holders of
    address public immutable factory;
    /// @notice The launch's creator — the only one allowed to reconfigure the basket. Changing
    ///         what holders earn never touches the token or its pool ("fully automatic, no
    ///         relaunches").
    address public immutable creator;

    PayoutMode public mode;
    BundleAsset[] public basket;
    uint256 public rotateIndex;

    /// @notice Every distinct asset ever configured into the basket, append-only. `onTransfer`
    ///         checkpoints over this full historical set, not just the live `basket`, so a holder
    ///         who still has an unclaimed balance in an asset the creator has since rotated out
    ///         keeps accruing/settling correctly instead of getting silently frozen out. The real
    ///         tradeoff: checkpoint gas scales with how many distinct assets this sink has *ever*
    ///         held, not with the current basket size — bounded by how often a creator actually
    ///         changes their basket, not unbounded, but not free either.
    Currency[] public trackedAssets;
    mapping(Currency => bool) public isTracked;

    /// @notice Pulled from the hook but not yet swapped into the basket, per source currency.
    mapping(Currency => uint256) public pendingConvert;

    mapping(Currency => uint256) public accPerShare;
    mapping(address => mapping(Currency => uint256)) public debt;
    mapping(address => mapping(Currency => uint256)) public unclaimed;

    modifier onlyCreator() {
        if (msg.sender != creator) revert NotCreator();
        _;
    }

    constructor(EveFeeHook hook_, IPoolManager manager_, IERC20 token_, address creator_, address factory_) {
        if (address(token_) == address(0) || creator_ == address(0) || factory_ == address(0)) revert ZeroAddress();
        hook = hook_;
        poolManager = manager_;
        token = token_;
        creator = creator_;
        factory = factory_;
    }

    // ── basket configuration ──────────────────────────────────────────────────────────────────
    function setBasket(
        address[] calldata assets,
        uint16[] calldata weightsBps,
        PoolKey[] calldata poolKeys,
        PayoutMode mode_
    ) external onlyCreator {
        if (assets.length == 0) revert EmptyBundle();
        if (assets.length != weightsBps.length || assets.length != poolKeys.length) revert LengthMismatch();
        delete basket;
        uint256 sum;
        for (uint256 i; i < assets.length; i++) {
            if (assets[i] == address(0)) revert ZeroAddress();
            sum += weightsBps[i];
            Currency c = Currency.wrap(assets[i]);
            basket.push(BundleAsset({asset: c, weightBps: weightsBps[i], poolKey: poolKeys[i]}));
            if (!isTracked[c]) {
                isTracked[c] = true;
                trackedAssets.push(c);
            }
        }
        if (mode_ == PayoutMode.AllAtOnce && sum != 10_000) revert BadWeights();
        mode = mode_;
        rotateIndex = 0;
        emit BundleConfigured(mode_, assets.length);
    }

    function basketLength() external view returns (uint256) {
        return basket.length;
    }

    function trackedAssetsLength() external view returns (uint256) {
        return trackedAssets.length;
    }

    // ── pull + convert (unchanged from BundleVault) ───────────────────────────────────────────
    /// @notice Permissionless: pull whatever accrued to this sink from the hook for `currency`.
    function pull(Currency currency) external returns (uint256 pulled) {
        pulled = hook.withdraw(currency);
        pendingConvert[currency] += pulled;
        emit Pulled(currency, pulled);
    }

    /// @notice Swap `fromCurrency`'s full pending balance into the basket, then accrue each
    ///         converted amount to every current holder pro-rata (see `_accrue`).
    ///         AllAtOnce: `minOuts` must have one entry per basket asset, in order.
    ///         Rotating: `minOuts` must have exactly one entry, for whichever asset is next.
    function convert(Currency fromCurrency, uint256[] calldata minOuts) external returns (uint256 totalIn) {
        uint256 n = basket.length;
        if (n == 0) revert EmptyBundle();
        uint256 amount = pendingConvert[fromCurrency];
        if (amount == 0) revert NothingPending();
        pendingConvert[fromCurrency] = 0;

        if (mode == PayoutMode.AllAtOnce) {
            if (minOuts.length != n) revert LengthMismatch();
            uint256 distributed;
            for (uint256 i; i < n; i++) {
                uint256 amtIn = i == n - 1 ? amount - distributed : (amount * basket[i].weightBps) / 10_000;
                distributed += amtIn;
                if (amtIn == 0) continue;
                _swapAndAccrue(fromCurrency, basket[i], amtIn, minOuts[i]);
            }
        } else {
            if (minOuts.length != 1) revert LengthMismatch();
            _swapAndAccrue(fromCurrency, basket[rotateIndex], amount, minOuts[0]);
            rotateIndex = (rotateIndex + 1) % n;
        }
        totalIn = amount;
    }

    function _swapAndAccrue(Currency fromCurrency, BundleAsset memory a, uint256 amountIn, uint256 minOut) internal {
        bytes memory result = poolManager.unlock(abi.encode(a.poolKey, fromCurrency, a.asset, amountIn, minOut));
        uint256 amountOut = abi.decode(result, (uint256));
        emit Converted(fromCurrency, a.asset, amountIn, amountOut);
        _accrue(a.asset, amountOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotSelf();
        (PoolKey memory key, Currency fromCurrency, Currency toAsset, uint256 amountIn, uint256 minOut) =
            abi.decode(data, (PoolKey, Currency, Currency, uint256, uint256));

        bool fromIsCurrency0 = fromCurrency == key.currency0;
        bool matches_ = fromIsCurrency0 ? toAsset == key.currency1 : toAsset == key.currency0;
        if (!matches_) revert PoolMismatch();

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

    // ── on-chain, keeperless holder accounting (generalized from HolderSink) ─────────────────
    function _accrue(Currency asset, uint256 amount) internal {
        if (amount == 0) return;
        uint256 elig = eligibleSupply();
        if (elig == 0) {
            emit Accrued(asset, amount, 0);
            return;
        }
        accPerShare[asset] += (amount * SCALE) / elig;
        emit Accrued(asset, amount, elig);
    }

    /// @notice Called by the tracked launch token before every transfer/mint/burn.
    function onTransfer(address from, address to, uint256 amount) external {
        if (msg.sender != address(token)) revert NotToken();
        _checkpoint(from, _bal(from));
        _checkpoint(to, _bal(to));
        uint256 n = trackedAssets.length;
        if (from != address(0) && !_excluded(from)) {
            uint256 next = _bal(from) - amount;
            for (uint256 i; i < n; i++) {
                Currency c = trackedAssets[i];
                debt[from][c] = (next * accPerShare[c]) / SCALE;
            }
        }
        if (to != address(0) && !_excluded(to)) {
            uint256 next = _bal(to) + amount;
            for (uint256 i; i < n; i++) {
                Currency c = trackedAssets[i];
                debt[to][c] = (next * accPerShare[c]) / SCALE;
            }
        }
    }

    /// @notice Claim every tracked asset's pending balance in one call.
    function claim() external {
        _checkpoint(msg.sender, _bal(msg.sender));
        uint256 n = trackedAssets.length;
        for (uint256 i; i < n; i++) {
            Currency c = trackedAssets[i];
            uint256 amount = unclaimed[msg.sender][c];
            if (amount == 0) continue;
            unclaimed[msg.sender][c] = 0;
            c.transfer(msg.sender, amount);
            emit Claimed(msg.sender, c, amount);
        }
    }

    /// @notice Claim a single asset — cheaper than `claim()` when only one is worth the gas.
    function claim(Currency asset) external returns (uint256 amount) {
        _checkpoint(msg.sender, _bal(msg.sender));
        amount = unclaimed[msg.sender][asset];
        if (amount == 0) return 0;
        unclaimed[msg.sender][asset] = 0;
        asset.transfer(msg.sender, amount);
        emit Claimed(msg.sender, asset, amount);
    }

    function preview(address user) external view returns (Currency[] memory assets, uint256[] memory amounts) {
        uint256 n = trackedAssets.length;
        assets = new Currency[](n);
        amounts = new uint256[](n);
        uint256 bal = _bal(user);
        for (uint256 i; i < n; i++) {
            assets[i] = trackedAssets[i];
            amounts[i] = _pending(user, trackedAssets[i], bal);
        }
    }

    function eligibleSupply() public view returns (uint256) {
        uint256 ts = token.totalSupply();
        uint256 ex = _excludedBalance();
        return ts > ex ? ts - ex : 0;
    }

    function _checkpoint(address user, uint256 bal) internal {
        if (user == address(0) || _excluded(user)) return;
        uint256 n = trackedAssets.length;
        for (uint256 i; i < n; i++) {
            Currency c = trackedAssets[i];
            unclaimed[user][c] += _pending(user, c, bal);
            debt[user][c] = (bal * accPerShare[c]) / SCALE;
        }
    }

    function _pending(address user, Currency currency, uint256 bal) internal view returns (uint256) {
        if (user == address(0) || _excluded(user)) return unclaimed[user][currency];
        uint256 accrued = (bal * accPerShare[currency]) / SCALE;
        uint256 d = debt[user][currency];
        uint256 extra = accrued > d ? accrued - d : 0;
        return unclaimed[user][currency] + extra;
    }

    function _bal(address a) internal view returns (uint256) {
        if (a == address(0)) return 0;
        return token.balanceOf(a);
    }

    function _excluded(address a) internal view returns (bool) {
        return a == DEAD || a == factory || a == address(this) || a == address(hook) || a == address(poolManager);
    }

    function _excludedBalance() internal view returns (uint256 n) {
        n += token.balanceOf(DEAD);
        n += token.balanceOf(factory);
        n += token.balanceOf(address(this));
        n += token.balanceOf(address(hook));
        n += token.balanceOf(address(poolManager));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {LiquidityAmounts} from "./libraries/LiquidityAmounts.sol";
import {CurrencySettler} from "./libraries/CurrencySettler.sol";
import {VirtualQuote} from "./libraries/VirtualQuote.sol";
import {InstantAutoLp} from "./libraries/InstantAutoLp.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {LaunchToken18} from "./LaunchToken18.sol";
import {LaunchToken18Tracked} from "./LaunchToken18Tracked.sol";
import {EveFeeHook} from "./EveFeeHook.sol";
import {BundleSink} from "./BundleSink.sol";
import {BundleSinkDeployer} from "./BundleSinkDeployer.sol";

/// @title RwaInstantV4Factory
/// @notice Instant factory quoted against an RWA (USYC, BUIDL, …). Same mint/seed/first-buy
///         shape as EveInstantV4Factory, registered on the shared EveFeeHook.
///
///         The general `holders` slice (an arbitrary caller-supplied address, like
///         EveInstantV4Factory allows) is NOT available here — a permissioned MMF token landing
///         directly in random holders' wallets is a real compliance problem. `createTokenWithBundle`
///         is the one sanctioned exception: it always deploys a fresh `BundleSink` and wires that
///         in as `holders` instead, and holders never receive the raw quote token — BundleSink
///         converts it into the creator's chosen basket first and only pays out the converted
///         asset (see BundleSink's top comment).
///
///         Auto-LP is the same as the USDC factory: per-pool on the hook, `flushAutoLp` mints
///         into the factory-owned position. After 365 days the stamped platform beneficiary
///         can `unlockLiquidity` (creator cannot). Tick range is stored next to `poolOf` (ABI of
///         `poolOf` stays 5 fields).
contract RwaInstantV4Factory is IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using CurrencySettler for Currency;
    using SafeCast for int256;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;
    int24 public constant TICK_SPACING = 200;
    uint16 public constant DEFAULT_FEE_BPS = 100;
    uint16 public constant DEFAULT_CREATOR_BPS = 7_000;
    uint16 public constant DEFAULT_BURN_BPS = 1_000;
    uint16 public constant DEFAULT_HOLDERS_BPS = 0;
    uint16 public constant DEFAULT_AUTO_LP_BPS = 1_000;
    uint16 public constant DEFAULT_PLATFORM_BPS = 1_000;
    uint64 public constant LOCK_DURATION = 365 days;

    error ZeroAddress();
    error NotOwner();
    error TokenIsQuote();
    error AlreadyExists();
    error NotSelf();
    error UnknownAction();
    error TransferFailed();
    error FirstBuyZero();
    error FirstBuyTooLarge();
    error HoldersNotOnRwa();
    error BundleRequiresHoldersSlice();
    error StillLocked();
    error NotBeneficiary();

    struct PoolInfo {
        address token;
        address quote;
        address creator;
        address holders;
        PoolId id;
    }

    struct LpLock {
        uint64 unlockAt;
        address beneficiary;
    }

    struct LaunchCall {
        string name;
        string symbol;
        address quote;
        address creator;
        address payer;
        uint256 vq;
        uint256 firstBuy;
        EveFeeHook.Split split;
        bool useBundle;
    }

    event TokenLaunched(
        address indexed token,
        address indexed quote,
        address indexed creator,
        PoolId id,
        bool tokenIsCurrency0,
        uint16 buyFeeBps,
        uint16 sellFeeBps
    );
    event TokenFirstBuy(address indexed token, address indexed buyer, uint256 quoteIn, uint256 tokensOut);
    event LaunchVirtualQuoteSet(uint256 quote);
    event AutoLpFlushed(PoolId indexed id, uint128 liquidity);
    event LiquidityUnlocked(PoolId indexed id, address indexed to, uint128 liquidity);

    IPoolManager public immutable poolManager;
    EveFeeHook public immutable hook;
    BundleSinkDeployer public immutable sinkDeployer;
    address public owner;
    address public platformWallet;
    uint256 public launchVirtualQuote;

    uint256 private _nonce;
    mapping(address => PoolInfo) public poolOf;
    mapping(address => int24) public tickLowerOf;
    mapping(address => int24) public tickUpperOf;
    mapping(address => LpLock) public lpLock;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        IPoolManager manager_,
        EveFeeHook hook_,
        address platformWallet_,
        BundleSinkDeployer sinkDeployer_
    ) {
        if (platformWallet_ == address(0) || address(sinkDeployer_) == address(0)) revert ZeroAddress();
        poolManager = manager_;
        hook = hook_;
        sinkDeployer = sinkDeployer_;
        owner = msg.sender;
        platformWallet = platformWallet_;
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        owner = next;
    }

    function setPlatformWallet(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        platformWallet = next;
    }

    function setLaunchVirtualQuote(uint256 q) external onlyOwner {
        launchVirtualQuote = q;
        emit LaunchVirtualQuoteSet(q);
    }

    /// @notice Permissionless: pull this pool's auto-LP slice from the hook and mint it
    ///         into the factory-owned position. Leftover (wrong-side at the current tick)
    ///         is restowed on the hook.
    function flushAutoLp(address token) external returns (uint128 liquidityAdded) {
        PoolInfo memory info = poolOf[token];
        if (info.token == address(0)) revert ZeroAddress();
        PoolKey memory key = _poolKey(token, info);
        (uint256 a0, uint256 a1) = hook.claimAutoLp(key);
        if (a0 == 0 && a1 == 0) return 0;
        bytes memory result = poolManager.unlock(
            abi.encode(uint8(2), key, tickLowerOf[token], tickUpperOf[token], a0, a1)
        );
        liquidityAdded = abi.decode(result, (uint128));
        emit AutoLpFlushed(info.id, liquidityAdded);
    }

    /// @notice After 365 days, the stamped platform beneficiary (or factory owner) burns
    ///         the factory-owned position and takes both currencies. Creator cannot.
    function unlockLiquidity(address token) external returns (uint128 liquidityRemoved) {
        PoolInfo memory info = poolOf[token];
        if (info.token == address(0)) revert ZeroAddress();
        LpLock memory lock = lpLock[token];
        if (msg.sender != lock.beneficiary && msg.sender != owner) revert NotBeneficiary();
        if (block.timestamp < lock.unlockAt) revert StillLocked();
        PoolKey memory key = _poolKey(token, info);
        bytes memory result = poolManager.unlock(
            abi.encode(uint8(3), key, tickLowerOf[token], tickUpperOf[token], lock.beneficiary)
        );
        liquidityRemoved = abi.decode(result, (uint128));
        emit LiquidityUnlocked(info.id, lock.beneficiary, liquidityRemoved);
    }

    /// @notice 2 = buyFeeBps + sellFeeBps. Older factories omit this and use one feeBps.
    function feeModel() external pure returns (uint8) {
        return 2;
    }

    function defaultSplit() public pure returns (EveFeeHook.Split memory s) {
        s.buyFeeBps = DEFAULT_FEE_BPS;
        s.sellFeeBps = DEFAULT_FEE_BPS;
        s.creatorBps = DEFAULT_CREATOR_BPS;
        s.burnBps = DEFAULT_BURN_BPS;
        s.holdersBps = DEFAULT_HOLDERS_BPS;
        s.autoLpBps = DEFAULT_AUTO_LP_BPS;
        s.platformBps = DEFAULT_PLATFORM_BPS;
    }

    function createToken(string calldata name, string calldata symbol, address quote, address creator)
        external
        returns (address token, PoolId id)
    {
        (token, id,,) = _create(name, symbol, quote, creator, 0, 0, defaultSplit(), false);
    }

    function createToken(
        string calldata name,
        string calldata symbol,
        address quote,
        address creator,
        uint256 launchVirtualQuote_,
        uint256 firstBuyQuoteAmount
    ) external returns (address token, PoolId id, uint256 tokensOut) {
        (token, id, tokensOut,) =
            _create(name, symbol, quote, creator, launchVirtualQuote_, firstBuyQuoteAmount, defaultSplit(), false);
    }

    function createToken(
        string calldata name,
        string calldata symbol,
        address quote,
        address creator,
        uint256 launchVirtualQuote_,
        uint256 firstBuyQuoteAmount,
        EveFeeHook.Split calldata split
    ) external returns (address token, PoolId id, uint256 tokensOut) {
        (token, id, tokensOut,) =
            _create(name, symbol, quote, creator, launchVirtualQuote_, firstBuyQuoteAmount, split, false);
    }

    /// @notice The one way to get a holders slice on an RWA launch: `split.holdersBps` must be
    ///         > 0, and this always deploys a fresh `BundleSink` (never a caller-supplied address
    ///         — see the contract top comment for why). Configure what it pays out via
    ///         `BundleSink.setBasket` after launch.
    function createTokenWithBundle(
        string calldata name,
        string calldata symbol,
        address quote,
        address creator,
        uint256 launchVirtualQuote_,
        uint256 firstBuyQuoteAmount,
        EveFeeHook.Split calldata split
    ) external returns (address token, PoolId id, uint256 tokensOut, address bundleSink) {
        return _create(name, symbol, quote, creator, launchVirtualQuote_, firstBuyQuoteAmount, split, true);
    }

    function _create(
        string calldata name,
        string calldata symbol,
        address quote,
        address creator,
        uint256 launchVirtualQuote_,
        uint256 firstBuyQuoteAmount,
        EveFeeHook.Split memory split,
        bool useBundle
    ) internal returns (address token, PoolId id, uint256 tokensOut, address bundleSink) {
        if (quote == address(0) || creator == address(0)) revert ZeroAddress();
        if (split.holdersBps != 0 && !useBundle) revert HoldersNotOnRwa();
        if (useBundle && split.holdersBps == 0) revert BundleRequiresHoldersSlice();
        if (firstBuyQuoteAmount > uint256(type(int256).max)) revert FirstBuyTooLarge();
        uint256 vq = launchVirtualQuote_ == 0 ? launchVirtualQuote : launchVirtualQuote_;
        if (firstBuyQuoteAmount > 0) {
            bool ok = IERC20Minimal(quote).transferFrom(msg.sender, address(this), firstBuyQuoteAmount);
            if (!ok) revert TransferFailed();
        }
        LaunchCall memory call = LaunchCall({
            name: name,
            symbol: symbol,
            quote: quote,
            creator: creator,
            payer: msg.sender,
            vq: vq,
            firstBuy: firstBuyQuoteAmount,
            split: split,
            useBundle: useBundle
        });
        bytes memory result = poolManager.unlock(abi.encode(uint8(1), call));
        bytes32 idBytes;
        (token, idBytes, tokensOut, bundleSink) = abi.decode(result, (address, bytes32, uint256, address));
        id = PoolId.wrap(idBytes);
        uint256 leftover = IERC20Minimal(quote).balanceOf(address(this));
        if (leftover > 0) {
            bool sent = IERC20Minimal(quote).transfer(msg.sender, leftover);
            if (!sent) revert TransferFailed();
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotSelf();
        uint8 action = uint8(uint256(bytes32(data[0:32])));
        if (action == 1) {
            (, LaunchCall memory call) = abi.decode(data, (uint8, LaunchCall));
            (address token, PoolId id, uint256 tokensOut, address bundleSink) = _createToken(call);
            return abi.encode(token, PoolId.unwrap(id), tokensOut, bundleSink);
        }
        if (action == 2) {
            (, PoolKey memory key, int24 tickLower, int24 tickUpper, uint256 a0, uint256 a1) =
                abi.decode(data, (uint8, PoolKey, int24, int24, uint256, uint256));
            uint128 liq = InstantAutoLp.mintClaimed(poolManager, hook, key, tickLower, tickUpper, a0, a1);
            return abi.encode(liq);
        }
        if (action == 3) {
            (, PoolKey memory key, int24 tickLower, int24 tickUpper, address recipient) =
                abi.decode(data, (uint8, PoolKey, int24, int24, address));
            uint128 liq = InstantAutoLp.burnPosition(poolManager, key, tickLower, tickUpper, recipient);
            return abi.encode(liq);
        }
        revert UnknownAction();
    }

    function _createToken(LaunchCall memory call)
        internal
        returns (address token, PoolId id, uint256 tokensOut, address bundleSink)
    {
        bytes32 salt = keccak256(
            abi.encode(
                call.name,
                call.symbol,
                call.quote,
                call.creator,
                call.vq,
                call.firstBuy,
                call.split.buyFeeBps,
                call.split.sellFeeBps,
                call.split.creatorBps,
                call.split.burnBps,
                call.split.autoLpBps,
                call.split.platformBps,
                call.useBundle,
                _nonce++,
                block.chainid
            )
        );
        if (call.useBundle) {
            LaunchToken18Tracked t = new LaunchToken18Tracked{salt: salt}(call.name, call.symbol, address(this));
            token = address(t);
        } else {
            LaunchToken18 t = new LaunchToken18{salt: salt}(call.name, call.symbol, address(this));
            token = address(t);
        }
        if (token == call.quote) revert TokenIsQuote();
        if (poolOf[token].token != address(0)) revert AlreadyExists();

        bool tokenIsCurrency0 = token < call.quote;
        Currency currency0 = Currency.wrap(tokenIsCurrency0 ? token : call.quote);
        Currency currency1 = Currency.wrap(tokenIsCurrency0 ? call.quote : token);

        PoolKey memory key = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: 0,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        (int24 tickLower, int24 tickUpper, uint160 startSqrtPriceX96) = _range(tokenIsCurrency0, call.vq);
        poolManager.initialize(key, startSqrtPriceX96);
        id = key.toId();

        address holders = address(0);
        if (call.useBundle) {
            BundleSink sink = sinkDeployer.deploy(hook, poolManager, IERC20(token), call.creator, address(this));
            bundleSink = address(sink);
            holders = bundleSink;
            LaunchToken18Tracked(token).setSink(holders);
        }
        hook.registerPool(key, call.creator, holders, address(this), platformWallet, token, call.split);
        tickLowerOf[token] = tickLower;
        tickUpperOf[token] = tickUpper;
        lpLock[token] = LpLock({unlockAt: uint64(block.timestamp + uint256(LOCK_DURATION)), beneficiary: platformWallet});

        uint160 sqrtA = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(tickUpper);
        uint128 liquidity = tokenIsCurrency0
            ? LiquidityAmounts.getLiquidityForAmount0(sqrtA, sqrtB, TOTAL_SUPPLY)
            : LiquidityAmounts.getLiquidityForAmount1(sqrtA, sqrtB, TOTAL_SUPPLY);

        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(0)
            }),
            ""
        );

        int256 amt0 = int256(delta.amount0());
        int256 amt1 = int256(delta.amount1());
        if (amt0 < 0) currency0.settle(poolManager, address(this), (-amt0).toUint256(), false);
        if (amt1 < 0) currency1.settle(poolManager, address(this), (-amt1).toUint256(), false);

        if (call.firstBuy > 0) {
            tokensOut = _firstBuy(key, currency0, currency1, tokenIsCurrency0, call.payer, call.firstBuy);
            emit TokenFirstBuy(token, call.payer, call.firstBuy, tokensOut);
        }

        poolOf[token] = PoolInfo({token: token, quote: call.quote, creator: call.creator, holders: holders, id: id});
        emit TokenLaunched(
            token, call.quote, call.creator, id, tokenIsCurrency0, call.split.buyFeeBps, call.split.sellFeeBps
        );
    }

    function _range(bool tokenIsCurrency0, uint256 vq)
        internal
        pure
        returns (int24 tickLower, int24 tickUpper, uint160 startSqrt)
    {
        int24 ts = TICK_SPACING;
        tickLower = TickMath.minUsableTick(ts);
        tickUpper = TickMath.maxUsableTick(ts);
        if (vq == 0) {
            int24 startTick = tokenIsCurrency0 ? tickLower : tickUpper;
            return (tickLower, tickUpper, TickMath.getSqrtPriceAtTick(startTick));
        }

        uint160 idealSqrt = VirtualQuote.sqrtPriceX96(tokenIsCurrency0, vq, VirtualQuote.VIRTUAL_TOKEN_INIT);
        int24 idealTick = TickMath.getTickAtSqrtPrice(idealSqrt);
        if (idealTick <= tickLower) idealTick = tickLower + ts;
        if (idealTick >= tickUpper) idealTick = tickUpper - ts;

        if (tokenIsCurrency0) {
            tickLower = _floorToSpacing(idealTick, ts);
            if (tickUpper <= tickLower) tickUpper = tickLower + ts;
            startSqrt = TickMath.getSqrtPriceAtTick(tickLower);
        } else {
            tickUpper = _ceilToSpacing(idealTick, ts);
            if (tickUpper <= tickLower) tickLower = tickUpper - ts;
            startSqrt = TickMath.getSqrtPriceAtTick(tickUpper);
        }
    }

    function _firstBuy(
        PoolKey memory key,
        Currency currency0,
        Currency currency1,
        bool tokenIsCurrency0,
        address buyer,
        uint256 quoteIn
    ) internal returns (uint256 tokensOut) {
        bool zeroForOne = !tokenIsCurrency0;
        BalanceDelta d = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(quoteIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int256 a0 = int256(d.amount0());
        int256 a1 = int256(d.amount1());
        if (a0 < 0) currency0.settle(poolManager, address(this), (-a0).toUint256(), false);
        if (a1 < 0) currency1.settle(poolManager, address(this), (-a1).toUint256(), false);
        if (a0 > 0) {
            tokensOut = a0.toUint256();
            currency0.take(poolManager, buyer, tokensOut, false);
        }
        if (a1 > 0) {
            tokensOut = a1.toUint256();
            currency1.take(poolManager, buyer, tokensOut, false);
        }
        if (tokensOut == 0) revert FirstBuyZero();
    }

    function _floorToSpacing(int24 tick, int24 ts) internal pure returns (int24) {
        int24 compressed = tick / ts;
        if (tick < 0 && tick % ts != 0) compressed--;
        return compressed * ts;
    }

    function _ceilToSpacing(int24 tick, int24 ts) internal pure returns (int24) {
        int24 floored = _floorToSpacing(tick, ts);
        return floored == tick ? tick : floored + ts;
    }

    function _poolKey(address token, PoolInfo memory info) internal view returns (PoolKey memory) {
        bool tokenIsCurrency0 = token < info.quote;
        return PoolKey({
            currency0: Currency.wrap(tokenIsCurrency0 ? token : info.quote),
            currency1: Currency.wrap(tokenIsCurrency0 ? info.quote : token),
            fee: 0,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
    }
}

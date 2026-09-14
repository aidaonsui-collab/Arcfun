// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";
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
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {LaunchToken18} from "./LaunchToken18.sol";
import {EveFeeHook} from "./EveFeeHook.sol";

/// @title EveInstantV4Factory
/// @notice USDC Instant factory for eve.fun meme + reflect launches on Uniswap v4.
///         Same mint/seed/first-buy shape as `RwaInstantV4Factory`, but the fee split is
///         per-create (creator / burn / holders / auto-LP / platform) on the shared
///         `EveFeeHook`. There is no Crucible leg and no $EVE cook on these pools.
///
///         Quote is per-create (typically Arc ERC-20 USDC 6dp) so HandlePay and existing
///         wallet approvals keep working. Native USDC pairing is a later factory.
///
///         Liquidity is factory-owned inside PoolManager; nothing here can withdraw it.
///         Auto-LP fee slice accrues to this factory (donate/flush is a follow-up).
///         Holders slice accrues to the address passed at create (HolderSink later).
contract EveInstantV4Factory is IUnlockCallback {
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

    error ZeroAddress();
    error NotOwner();
    error TokenIsQuote();
    error AlreadyExists();
    error NotSelf();
    error UnknownAction();
    error TransferFailed();
    error FirstBuyZero();
    error FirstBuyTooLarge();

    struct PoolInfo {
        address token;
        address quote;
        address creator;
        address holders;
        PoolId id;
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
        address holders;
    }

    event TokenLaunched(
        address indexed token,
        address indexed quote,
        address indexed creator,
        PoolId id,
        bool tokenIsCurrency0,
        uint16 feeBps
    );
    event TokenFirstBuy(address indexed token, address indexed buyer, uint256 quoteIn, uint256 tokensOut);
    event LaunchVirtualQuoteSet(uint256 quote);

    IPoolManager public immutable poolManager;
    EveFeeHook public immutable hook;
    address public owner;
    address public platformWallet;
    /// @notice Default virtual quote in the quote token's native decimals (5500e6 ≈ $5.5k FDV
    ///         on a 6dp quote, same as Instant V3 USDC). 0 = open at the usable-tick edge.
    uint256 public launchVirtualQuote;

    uint256 private _nonce;
    mapping(address => PoolInfo) public poolOf;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IPoolManager manager_, EveFeeHook hook_, address platformWallet_) {
        if (platformWallet_ == address(0)) revert ZeroAddress();
        poolManager = manager_;
        hook = hook_;
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

    /// @notice Creator preset: 1% pool fee, 70/10/0/10/10 creator/burn/holders/auto-LP/platform.
    function defaultSplit() public pure returns (EveFeeHook.Split memory s) {
        s.feeBps = DEFAULT_FEE_BPS;
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
        (token, id,) = _create(name, symbol, quote, creator, 0, 0, defaultSplit(), address(0));
    }

    function createToken(
        string calldata name,
        string calldata symbol,
        address quote,
        address creator,
        uint256 launchVirtualQuote_,
        uint256 firstBuyQuoteAmount
    ) external returns (address token, PoolId id, uint256 tokensOut) {
        return _create(name, symbol, quote, creator, launchVirtualQuote_, firstBuyQuoteAmount, defaultSplit(), address(0));
    }

    /// @param split Per-pool fee + 100% allocation. Hook enforces 0.3–3% and 10% platform floor.
    /// @param holders Destination for the holders slice. Required iff `split.holdersBps > 0`.
    function createToken(
        string calldata name,
        string calldata symbol,
        address quote,
        address creator,
        uint256 launchVirtualQuote_,
        uint256 firstBuyQuoteAmount,
        EveFeeHook.Split calldata split,
        address holders
    ) external returns (address token, PoolId id, uint256 tokensOut) {
        return _create(name, symbol, quote, creator, launchVirtualQuote_, firstBuyQuoteAmount, split, holders);
    }

    function _create(
        string calldata name,
        string calldata symbol,
        address quote,
        address creator,
        uint256 launchVirtualQuote_,
        uint256 firstBuyQuoteAmount,
        EveFeeHook.Split memory split,
        address holders
    ) internal returns (address token, PoolId id, uint256 tokensOut) {
        if (quote == address(0) || creator == address(0)) revert ZeroAddress();
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
            holders: holders
        });
        bytes memory result = poolManager.unlock(abi.encode(uint8(1), call));
        bytes32 idBytes;
        (token, idBytes, tokensOut) = abi.decode(result, (address, bytes32, uint256));
        id = PoolId.wrap(idBytes);
        uint256 leftover = IERC20Minimal(quote).balanceOf(address(this));
        if (leftover > 0) {
            bool sent = IERC20Minimal(quote).transfer(msg.sender, leftover);
            if (!sent) revert TransferFailed();
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotSelf();
        (uint8 action, LaunchCall memory call) = abi.decode(data, (uint8, LaunchCall));
        if (action != 1) revert UnknownAction();
        (address token, PoolId id, uint256 tokensOut) = _createToken(call);
        return abi.encode(token, PoolId.unwrap(id), tokensOut);
    }

    function _createToken(LaunchCall memory call)
        internal
        returns (address token, PoolId id, uint256 tokensOut)
    {
        bytes32 salt = keccak256(
            abi.encode(
                call.name,
                call.symbol,
                call.quote,
                call.creator,
                call.vq,
                call.firstBuy,
                call.split.feeBps,
                call.split.creatorBps,
                call.split.burnBps,
                call.split.holdersBps,
                call.split.autoLpBps,
                call.split.platformBps,
                call.holders,
                _nonce++,
                block.chainid
            )
        );
        LaunchToken18 t = new LaunchToken18{salt: salt}(call.name, call.symbol, address(this));
        token = address(t);
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

        // Auto-LP slice accrues on the factory until a donate/flush lands. Holders sink is
        // whatever the creator passed (zero iff holdersBps == 0 — hook enforces that).
        hook.registerPool(key, call.creator, call.holders, address(this), platformWallet, token, call.split);

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

        poolOf[token] = PoolInfo({
            token: token,
            quote: call.quote,
            creator: call.creator,
            holders: call.holders,
            id: id
        });
        emit TokenLaunched(token, call.quote, call.creator, id, tokenIsCurrency0, call.split.feeBps);
    }

    /// @dev V3 Instant tick frame: one-sided range from the virtual-quote tick to the far
    ///      usable edge, initialized on the inner tick so the mint stays 100% token.
    function _range(bool tokenIsCurrency0, uint256 vq)
        internal
        pure
        returns (int24 tickLower, int24 tickUpper, uint160 startSqrt)
    {
        int24 ts = TICK_SPACING;
        tickLower = TickMath.minUsableTick(ts);
        tickUpper = TickMath.maxUsableTick(ts);
        if (vq == 0) {
            int24 startTick = tokenIsCurrency0 ? tickLower : tickUpper - ts;
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
}

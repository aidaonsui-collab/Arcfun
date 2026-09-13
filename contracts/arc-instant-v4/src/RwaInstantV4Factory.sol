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
import {RwaFeeHook} from "./RwaFeeHook.sol";

/// @title RwaInstantV4Factory
/// @notice Launch a fixed-1B-supply token into a v4 pool quoted against an RWA asset (USYC,
///         BUIDL, tokenized CRCL — see lib/arc-rwa-assets.ts on the app side), with the entire
///         supply seeded single-sided into a position that is never withdrawn — there is no
///         function anywhere in this contract that can move that liquidity back out, the same
///         "no NFT withdraw, owner cannot rug" guarantee CrucibleLock gives its v3 positions,
///         but structural here rather than a revert-guarded function.
///
///         Starting price: `launchVirtualQuote` raw quote units vs VIRTUAL_TOKEN_INIT, same
///         encoding as Instant V3 (`BondingCurveDexSeed.sqrtPriceX96`). 0 uses the factory
///         default; if that is also 0 the pool still opens at the usable-tick edge (original
///         sketch). Per-create override lets USYC-6dp and an 18dp RWA pass different raw values.
///
///         Optional first-buy: `firstBuyQuoteAmount` is pulled from the caller before unlock
///         and swapped quote→token inside the same unlock as the LP mint, so create + seed +
///         first buy is one transaction. The hook still taxes that swap (1% of unspecified).
contract RwaInstantV4Factory is IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using CurrencySettler for Currency;
    using SafeCast for int256;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether; // 1B, 18dp — matches LaunchToken18
    int24 public constant TICK_SPACING = 200; // wide spacing, matches the pad's 1%-tier v3 pools
    uint24 public constant HOOK_FEE_BPS = 100; // 1%
    uint16 public constant CREATOR_BPS = 5_000; // 50%
    uint16 public constant CRUCIBLE_BPS = 4_000; // 40% — folds v3's separate "project burn" leg in;
    //                                               see RwaFeeHook's top comment for why.
    uint16 public constant PLATFORM_BPS = 1_000; // 10%

    error ZeroAddress();
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
        PoolId id;
    }

    event TokenLaunched(
        address indexed token, address indexed quote, address indexed creator, PoolId id, bool tokenIsCurrency0
    );
    event TokenFirstBuy(address indexed token, address indexed buyer, uint256 quoteIn, uint256 tokensOut);
    event LaunchVirtualQuoteSet(uint256 quote);

    IPoolManager public immutable poolManager;
    RwaFeeHook public immutable hook;
    address public owner;
    address public platformWallet;
    /// @notice Where the hook's "crucible" leg accrues. A plain address for v1 — bridging its
    ///         balance into the real EVE burn sink (contracts/eve-burn) once a swap path from a
    ///         given RWA quote into USDC exists is exactly the follow-up flagged in the hook.
    address public crucible;
    /// @notice Default virtual quote in the quote token's native decimals (5500e6 ≈ $5.5k FDV
    ///         on a 6dp quote, same as Instant V3 USDC). 0 = open at the usable-tick edge.
    uint256 public launchVirtualQuote;

    uint256 private _nonce;
    mapping(address => PoolInfo) public poolOf;

    modifier onlyOwner() {
        if (msg.sender != owner) revert ZeroAddress();
        _;
    }

    constructor(IPoolManager manager_, RwaFeeHook hook_, address platformWallet_, address crucible_) {
        if (platformWallet_ == address(0) || crucible_ == address(0)) revert ZeroAddress();
        poolManager = manager_;
        hook = hook_;
        owner = msg.sender;
        platformWallet = platformWallet_;
        crucible = crucible_;
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        owner = next;
    }

    function setPlatformWallet(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        platformWallet = next;
    }

    function setCrucible(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        crucible = next;
    }

    function setLaunchVirtualQuote(uint256 q) external onlyOwner {
        launchVirtualQuote = q;
        emit LaunchVirtualQuoteSet(q);
    }

    /// @param quote The RWA asset to pair against (e.g. USYC) — an existing ERC-20, not deployed
    ///        here. See lib/arc-rwa-assets.ts for the app-side catalog of which ones are live.
    /// @param creator Receives the CREATOR_BPS leg of every swap fee (pulled via
    ///        hook.withdraw()), and is stamped as the pool's creator for display purposes.
    function createToken(string calldata name, string calldata symbol, address quote, address creator)
        external
        returns (address token, PoolId id)
    {
        (token, id,) = _create(name, symbol, quote, creator, 0, 0);
    }

    /// @param launchVirtualQuote_ Raw quote units for the opening price. 0 = factory default.
    /// @param firstBuyQuoteAmount Raw quote the caller spends on the new pool in this tx. 0 = launch only.
    ///        Caller must `approve` this factory. The hook taxes the first buy like any other swap.
    function createToken(
        string calldata name,
        string calldata symbol,
        address quote,
        address creator,
        uint256 launchVirtualQuote_,
        uint256 firstBuyQuoteAmount
    ) external returns (address token, PoolId id, uint256 tokensOut) {
        return _create(name, symbol, quote, creator, launchVirtualQuote_, firstBuyQuoteAmount);
    }

    function _create(
        string calldata name,
        string calldata symbol,
        address quote,
        address creator,
        uint256 launchVirtualQuote_,
        uint256 firstBuyQuoteAmount
    ) internal returns (address token, PoolId id, uint256 tokensOut) {
        if (quote == address(0) || creator == address(0)) revert ZeroAddress();
        if (firstBuyQuoteAmount > uint256(type(int256).max)) revert FirstBuyTooLarge();
        uint256 vq = launchVirtualQuote_ == 0 ? launchVirtualQuote : launchVirtualQuote_;
        if (firstBuyQuoteAmount > 0) {
            bool ok = IERC20Minimal(quote).transferFrom(msg.sender, address(this), firstBuyQuoteAmount);
            if (!ok) revert TransferFailed();
        }
        bytes memory result = poolManager.unlock(
            abi.encode(uint8(1), name, symbol, quote, creator, msg.sender, vq, firstBuyQuoteAmount)
        );
        bytes32 idBytes;
        (token, idBytes, tokensOut) = abi.decode(result, (address, bytes32, uint256));
        id = PoolId.wrap(idBytes);
        uint256 leftover = IERC20Minimal(quote).balanceOf(address(this));
        if (leftover > 0) {
            bool sent = IERC20Minimal(quote).transfer(msg.sender, leftover);
            if (!sent) revert TransferFailed();
        }
    }

    // ── IUnlockCallback ────────────────────────────────────────────────────────────────────
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotSelf();
        uint8 action = abi.decode(data[:32], (uint8));
        if (action == 1) {
            (
                ,
                string memory name,
                string memory symbol,
                address quote,
                address creator,
                address payer,
                uint256 vq,
                uint256 firstBuy
            ) = abi.decode(data, (uint8, string, string, address, address, address, uint256, uint256));
            (address token, PoolId id, uint256 tokensOut) =
                _createToken(name, symbol, quote, creator, payer, vq, firstBuy);
            return abi.encode(token, PoolId.unwrap(id), tokensOut);
        }
        revert UnknownAction();
    }

    function _createToken(
        string memory name,
        string memory symbol,
        address quote,
        address creator,
        address payer,
        uint256 vq,
        uint256 firstBuy
    ) internal returns (address token, PoolId id, uint256 tokensOut) {
        bytes32 salt = keccak256(abi.encode(name, symbol, quote, creator, vq, firstBuy, _nonce++, block.chainid));
        LaunchToken18 t = new LaunchToken18{salt: salt}(name, symbol, address(this));
        token = address(t);
        if (token == quote) revert TokenIsQuote();
        if (poolOf[token].token != address(0)) revert AlreadyExists();

        bool tokenIsCurrency0 = token < quote;
        Currency currency0 = Currency.wrap(tokenIsCurrency0 ? token : quote);
        Currency currency1 = Currency.wrap(tokenIsCurrency0 ? quote : token);

        PoolKey memory key = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: 0, // no standard LP fee — the hook's hook-fee replaces it entirely, see RwaFeeHook
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        (int24 tickLower, int24 tickUpper, uint160 startSqrtPriceX96) = _range(tokenIsCurrency0, vq);

        poolManager.initialize(key, startSqrtPriceX96);
        id = key.toId();

        hook.registerPool(key, creator, platformWallet, crucible, CREATOR_BPS, CRUCIBLE_BPS, PLATFORM_BPS, HOOK_FEE_BPS);

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

        if (firstBuy > 0) {
            tokensOut = _firstBuy(key, currency0, currency1, tokenIsCurrency0, payer, firstBuy);
            emit TokenFirstBuy(token, payer, firstBuy, tokensOut);
        }

        poolOf[token] = PoolInfo({token: token, quote: quote, creator: creator, id: id});
        emit TokenLaunched(token, quote, creator, id, tokenIsCurrency0);
    }

    /// @dev V3 Instant tick frame: one-sided range from the virtual-quote tick to the far
    ///      usable edge, initialized on the inner tick so the mint stays 100% token.
    ///      vq = 0 keeps the original sketch (open at the usable-tick edge).
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
        bool zeroForOne = !tokenIsCurrency0; // paying quote → receiving token
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

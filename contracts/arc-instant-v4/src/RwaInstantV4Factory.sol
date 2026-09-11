// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {LiquidityAmounts} from "./libraries/LiquidityAmounts.sol";
import {CurrencySettler} from "./libraries/CurrencySettler.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {LaunchToken18} from "./LaunchToken18.sol";
import {RwaFeeHook} from "./RwaFeeHook.sol";

/// @title RwaInstantV4Factory
/// @notice Launch a fixed-1B-supply token into a v4 pool quoted against an RWA asset (USYC,
///         BUIDL, tokenized CRCL — see lib/arc-rwa-assets.ts on the app side), with the entire
///         supply seeded single-sided into a genuinely full-range position ([minUsableTick,
///         maxUsableTick]) that is never withdrawn — there is no function anywhere in this
///         contract that can move that liquidity back out, the same "no NFT withdraw, owner
///         cannot rug" guarantee CrucibleLock gives its v3 positions, but structural here rather
///         than a revert-guarded function: the position is owned by this contract inside
///         PoolManager's internal accounting, and nothing calls modifyLiquidity with a negative
///         delta on it, ever.
///
///         Deliberately simpler than the v3 InstantErc20QuoteFactory in one way: there is no
///         `launchVirtualQuote` initial-valuation bonding math here. Every pool starts at the
///         literal edge of the representable price range (TickMath's min or max usable tick,
///         whichever side keeps the position 100% single-sided) — an effectively-zero starting
///         price with the entire rest of the range open for the market to walk the price up
///         through. That sidesteps needing this contract to reason about the RWA quote's
///         decimals or pick a "fair" launch valuation; real price discovery happens entirely
///         through trading, same spirit as the v3 pad's "full float from block one" but without
///         a chosen starting point. A caller-supplied virtual-quote valuation is a reasonable
///         follow-up, not built here.
///
///         No first-buy-in-the-same-transaction (v3's `createTokenMemeInstantQuote`'s
///         `firstBuyQuoteAmount` param) — creator can swap immediately after in a second tx.
///         Folding that in means minting liquidity and swapping against it inside one unlock,
///         which is a correctness-sensitive addition on top of an already-dense callback; left
///         for a follow-up once this path has real usage.
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

    struct PoolInfo {
        address token;
        address quote;
        address creator;
        PoolId id;
    }

    event TokenLaunched(
        address indexed token, address indexed quote, address indexed creator, PoolId id, bool tokenIsCurrency0
    );

    IPoolManager public immutable poolManager;
    RwaFeeHook public immutable hook;
    address public owner;
    address public platformWallet;
    /// @notice Where the hook's "crucible" leg accrues. A plain address for v1 — bridging its
    ///         balance into the real EVE burn sink (contracts/eve-burn) once a swap path from a
    ///         given RWA quote into USDC exists is exactly the follow-up flagged in the hook.
    address public crucible;

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

    /// @param quote The RWA asset to pair against (e.g. USYC) — an existing ERC-20, not deployed
    ///        here. See lib/arc-rwa-assets.ts for the app-side catalog of which ones are live.
    /// @param creator Receives the CREATOR_BPS leg of every swap fee (pulled via
    ///        hook.withdraw()), and is stamped as the pool's creator for display purposes.
    function createToken(string calldata name, string calldata symbol, address quote, address creator)
        external
        returns (address token, PoolId id)
    {
        if (quote == address(0) || creator == address(0)) revert ZeroAddress();
        bytes memory result = poolManager.unlock(abi.encode(uint8(1), name, symbol, quote, creator, msg.sender));
        bytes32 idBytes;
        (token, idBytes) = abi.decode(result, (address, bytes32));
        id = PoolId.wrap(idBytes);
    }

    // ── IUnlockCallback ────────────────────────────────────────────────────────────────────
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotSelf();
        uint8 action = abi.decode(data[:32], (uint8));
        if (action == 1) {
            (, string memory name, string memory symbol, address quote, address creator,) =
                abi.decode(data, (uint8, string, string, address, address, address));
            (address token, PoolId id) = _createToken(name, symbol, quote, creator);
            return abi.encode(token, PoolId.unwrap(id));
        }
        revert UnknownAction();
    }

    function _createToken(string memory name, string memory symbol, address quote, address creator)
        internal
        returns (address token, PoolId id)
    {
        bytes32 salt = keccak256(abi.encode(name, symbol, quote, creator, _nonce++, block.chainid));
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

        // Single-sided, 100% token: initialize AT the extreme edge of the usable range on the
        // token's side, so the whole rest of the range holds only the token. See the contract
        // top-comment for why there's no caller-chosen starting valuation.
        int24 tickLower = TickMath.minUsableTick(TICK_SPACING);
        int24 tickUpper = TickMath.maxUsableTick(TICK_SPACING);
        int24 startTick = tokenIsCurrency0 ? tickLower : tickUpper - TICK_SPACING;
        uint160 startSqrtPriceX96 = TickMath.getSqrtPriceAtTick(startTick);

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

        // Only the token side should ever be owed here — the pool was just initialized 100%
        // single-sided, so the quote-side delta must be zero. Settle whichever side(s) the
        // manager says we owe; a nonzero quote delta would mean a math mistake above, and
        // settling it for real amount 0 is a cheap no-op, not a silent hazard, if that ever
        // happens because Currency.settle(...,0) is a no-op transfer.
        int256 amt0 = int256(delta.amount0());
        int256 amt1 = int256(delta.amount1());
        if (amt0 < 0) currency0.settle(poolManager, address(this), (-amt0).toUint256(), false);
        if (amt1 < 0) currency1.settle(poolManager, address(this), (-amt1).toUint256(), false);

        poolOf[token] = PoolInfo({token: token, quote: quote, creator: creator, id: id});
        emit TokenLaunched(token, quote, creator, id, tokenIsCurrency0);
    }
}

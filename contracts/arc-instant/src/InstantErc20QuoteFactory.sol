// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LaunchToken18} from "./LaunchToken18.sol";
import {INonfungiblePositionManager, ILpLocker, IWMON} from "./UniV3Interfaces.sol";
import {BondingCurveDexSeed} from "./BondingCurveDexSeed.sol";

/// @notice Main BondingCurveFactory surface used only to read live LP-fee bps at stamp time.
interface IBpsSource {
    function lpMemeCreatorBps() external view returns (uint16);
    function lpMemeStakerBps() external view returns (uint16);
}

/// @notice Minimal Uniswap V3 SwapRouter02 (exact-input single-hop). No deadline field — matches rh4663.
interface ISwapRouterQuote {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/**
 * @title InstantErc20QuoteFactory
 * @notice Meme Instant DEX launches quoted in an arbitrary ERC-20 (not native WETH).
 *         100% supply single-sided UniV3 TOKEN/QUOTE from block one.
 *
 *         First-buy options:
 *           1) Pull QUOTE via transferFrom (`createTokenMemeInstantQuote`)
 *           2) Pay native ETH (`createTokenMemeInstantQuoteWithEth`) — wraps to WETH,
 *              swaps WETH→QUOTE on the liquid venue, then QUOTE→TOKEN on the launch pool.
 *
 *         Creation fee (if any) is paid in native ETH on both paths.
 *
 *         Deploy one factory instance per quote asset (AAPL, GME, CASHCAT, PONS, Arc USDC, …).
 *
 *         Token: LaunchToken18 (plain 18dp ERC-20, 1B supply). Quote remains the configured ERC-20
 *         (e.g. Arc USDC 6dp). Existing 6dp Instant proxies keep their old bytecode.
 */
contract InstantErc20QuoteFactory is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether; // 1B, 18dp
    /// @dev Same virtual-token init as Arc curve (18dp) so FDV math stays consistent.
    uint256 public constant VIRTUAL_TOKEN_INIT = 1_066_666_666_666_666_666_666_666_666;

    /// @notice ERC-20 used as the UniV3 quote (immutable). e.g. AAPL/GME/CASHCAT/PONS.
    IERC20 public immutable QUOTE;
    /// @notice Decimals of QUOTE (for off-chain sizing; on-chain mint uses raw units).
    uint8 public immutable quoteDecimals;
    /// @notice Canonical WETH on this chain (wrap target for ETH first-buy).
    IWMON public immutable WETH;

    address public treasury;
    address public stakingPool;
    address public bpsSource;
    address public positionManager;
    address public lpLocker;
    address public swapRouter;
    /// @notice Launch pool TOKEN/QUOTE fee (default 1%).
    uint24 public poolFee = 10_000;
    int24 public tickSpacing = 200;
    /// @notice Fee tier for WETH/QUOTE acquisition hop (ETH first-buy). e.g. 500 / 3000.
    uint24 public quoteAcquisitionFee = 3_000;
    uint256 public CREATION_FEE;
    /// @notice Virtual quote in QUOTE raw units (quoteDecimals).
    uint256 public launchVirtualQuote;
    /// @dev Kept for ABI parity; Instant quote tokens always deploy with limits off.
    uint16 public maxWalletBps;
    uint64 public antiSnipeBlocks;
    uint256 private _createNonce;

    struct InstantQuotePool {
        address creator;
        address uniPool;
        uint256 positionId;
        uint128 liquidity;
        int24 tickLower;
        int24 tickUpper;
    }

    mapping(address => InstantQuotePool) public pools;
    address[] public allTokens;

    event InstantQuoteTokenCreated(
        address indexed token, address indexed creator, address pool, uint256 positionId
    );
    event InstantQuoteMinted(
        address indexed token, address pool, uint256 positionId, int24 tickLower, int24 tickUpper, uint128 liquidity
    );
    event InstantQuoteFirstBuy(address indexed token, address indexed buyer, uint256 quoteIn, uint256 tokensOut);
    event InstantQuoteFirstBuyEth(
        address indexed token, address indexed buyer, uint256 ethIn, uint256 quoteBought, uint256 tokensOut
    );
    event BpsSourceSet(address indexed source);
    event LaunchVirtualQuoteSet(uint256 quote);
    event UniV3Configured(address nfpm, uint24 fee, int24 tickSpacing, address locker, address router);
    event QuoteAcquisitionFeeSet(uint24 fee);
    event CreationFeeSet(uint256 fee);
    event TreasurySet(address treasury);
    event StakingPoolSet(address staking);
    event LaunchLimitsSet(uint16 maxWalletBps, uint64 antiSnipeBlocks);

    constructor(
        address quote_,
        uint8 quoteDecimals_,
        address weth_,
        address treasury_,
        address stakingPool_,
        address owner_
    ) Ownable(owner_) {
        require(quoteDecimals_ > 0 && quoteDecimals_ <= 18, "decimals");
        require(
            quote_ != address(0) && weth_ != address(0) && treasury_ != address(0) && stakingPool_ != address(0)
                && owner_ != address(0),
            "zero"
        );
        QUOTE = IERC20(quote_);
        quoteDecimals = quoteDecimals_;
        WETH = IWMON(weth_);
        treasury = treasury_;
        stakingPool = stakingPool_;
    }

    receive() external payable {}

    // ─── Admin ────────────────────────────────────────────────────────────────────────────

    function setTreasury(address t) external onlyOwner {
        require(t != address(0));
        treasury = t;
        emit TreasurySet(t);
    }

    function setStakingPool(address s) external onlyOwner {
        require(s != address(0));
        stakingPool = s;
        emit StakingPoolSet(s);
    }

    function setBpsSource(address src) external onlyOwner {
        require(src != address(0));
        bpsSource = src;
        emit BpsSourceSet(src);
    }

    function setLaunchVirtualQuote(uint256 q) external onlyOwner {
        require(q > 0);
        launchVirtualQuote = q;
        emit LaunchVirtualQuoteSet(q);
    }

    function setCreationFee(uint256 f) external onlyOwner {
        CREATION_FEE = f;
        emit CreationFeeSet(f);
    }

    function setUniV3Config(
        address positionManager_,
        uint24 poolFee_,
        int24 tickSpacing_,
        address lpLocker_,
        address swapRouter_
    ) external onlyOwner {
        require(positionManager_ != address(0) && lpLocker_ != address(0) && tickSpacing_ > 0);
        positionManager = positionManager_;
        poolFee = poolFee_;
        tickSpacing = tickSpacing_;
        lpLocker = lpLocker_;
        swapRouter = swapRouter_;
        emit UniV3Configured(positionManager_, poolFee_, tickSpacing_, lpLocker_, swapRouter_);
    }

    /// @notice Fee tier for the WETH/QUOTE hop used by ETH-paid first-buy.
    function setQuoteAcquisitionFee(uint24 fee) external onlyOwner {
        require(fee == 100 || fee == 500 || fee == 3_000 || fee == 10_000, "fee tier");
        quoteAcquisitionFee = fee;
        emit QuoteAcquisitionFeeSet(fee);
    }

    /// @notice No-op retained for ABI parity. Instant ERC-20-quote tokens always deploy plain ERC-20.
    function setLaunchLimits(uint16 bps, uint64 blocks_) external onlyOwner {
        require(bps <= 10_000);
        if (bps != 0 || blocks_ != 0) revert("InstantQuote: anti-snipe disabled");
        maxWalletBps = 0;
        antiSnipeBlocks = 0;
        emit LaunchLimitsSet(0, 0);
    }

    // ─── Creates ──────────────────────────────────────────────────────────────────────────

    /**
     * @notice Creation fee due for `creator`. Platform owner is always free; others pay `CREATION_FEE`.
     */
    function creationFeeDue(address creator) public view returns (uint256) {
        if (creator == owner()) return 0;
        return CREATION_FEE;
    }

    /**
     * @notice Instant launch quoted in QUOTE; optional first-buy paid in QUOTE (approve + pull).
     * @param firstBuyQuoteAmount QUOTE raw units. 0 = launch only.
     * @dev Factory owner (platform wallet) pays no creation fee.
     *      LP creator-fee leg stamps to `msg.sender` (use `createTokenMemeInstantQuoteTo` to route elsewhere).
     */
    function createTokenMemeInstantQuote(string calldata name, string calldata symbol, uint256 firstBuyQuoteAmount)
        external
        payable
        nonReentrant
        returns (address token)
    {
        return _createTokenMemeInstantQuote(name, symbol, firstBuyQuoteAmount, msg.sender);
    }

    /**
     * @notice Same as `createTokenMemeInstantQuote`, but LP creator-fee share is stamped to
     *         `creatorRewardsWallet` (MonLock creator split) instead of the tx sender.
     * @param creatorRewardsWallet Wallet that receives creator LP fees. Zero address → msg.sender.
     * @dev `pools[token].creator` remains the create-tx sender (attribution / ownership of the launch).
     *      Only the locker's creator fee leg uses `creatorRewardsWallet`.
     */
    function createTokenMemeInstantQuoteTo(
        string calldata name,
        string calldata symbol,
        uint256 firstBuyQuoteAmount,
        address creatorRewardsWallet
    ) external payable nonReentrant returns (address token) {
        address rewards = creatorRewardsWallet == address(0) ? msg.sender : creatorRewardsWallet;
        return _createTokenMemeInstantQuote(name, symbol, firstBuyQuoteAmount, rewards);
    }

    function _createTokenMemeInstantQuote(
        string calldata name,
        string calldata symbol,
        uint256 firstBuyQuoteAmount,
        address creatorRewardsWallet
    ) internal returns (address token) {
        require(positionManager != address(0) && lpLocker != address(0) && bpsSource != address(0), "unwired");
        uint256 feeDue = creationFeeDue(msg.sender);
        require(msg.value >= feeDue, "fee");

        if (firstBuyQuoteAmount > 0) {
            QUOTE.safeTransferFrom(msg.sender, address(this), firstBuyQuoteAmount);
        }

        token = _createCore(name, symbol, feeDue, creatorRewardsWallet);

        if (firstBuyQuoteAmount > 0) {
            uint256 out = _buyTokenWithQuote(token, firstBuyQuoteAmount, msg.sender);
            emit InstantQuoteFirstBuy(token, msg.sender, firstBuyQuoteAmount, out);
        }

        uint256 refund = msg.value - feeDue;
        if (refund > 0) _sendValue(msg.sender, refund);
    }

    /**
     * @notice Instant launch quoted in QUOTE; optional first-buy paid in native ETH.
     *         msg.value = feeDue + firstBuyEth. Excess ETH above feeDue is wrapped,
     *         swapped WETH→QUOTE on `quoteAcquisitionFee`, then QUOTE→TOKEN on the launch pool.
     * @dev Factory owner (platform wallet) pays no creation fee.
     */
    function createTokenMemeInstantQuoteWithEth(string calldata name, string calldata symbol)
        external
        payable
        nonReentrant
        returns (address token)
    {
        require(positionManager != address(0) && lpLocker != address(0) && bpsSource != address(0), "unwired");
        uint256 feeDue = creationFeeDue(msg.sender);
        require(msg.value >= feeDue, "fee");

        uint256 firstBuyEthWei = msg.value - feeDue;
        token = _createCore(name, symbol, feeDue, msg.sender);

        if (firstBuyEthWei > 0) {
            require(swapRouter != address(0), "no router");
            (uint256 quoteBought, uint256 tokensOut) = _buyTokenWithEth(token, firstBuyEthWei, msg.sender);
            emit InstantQuoteFirstBuyEth(token, msg.sender, firstBuyEthWei, quoteBought, tokensOut);
            emit InstantQuoteFirstBuy(token, msg.sender, quoteBought, tokensOut);
        }

        // No ETH refund — first-buy consumes (msg.value - feeDue); fee already sent in _createCore.
    }

    /// @param creator the create-tx sender (for CREATE2 predict parity).
    function predictTokenAddress(bytes32 salt, string calldata name, string calldata symbol, address creator)
        external
        view
        returns (address)
    {
        return Create2.computeAddress(salt, keccak256(_initCode(name, symbol, creator)));
    }

    function allTokensLength() external view returns (uint256) {
        return allTokens.length;
    }

    function getPool(address token) external view returns (InstantQuotePool memory) {
        return pools[token];
    }

    // ─── Internals ────────────────────────────────────────────────────────────────────────

    /// @param creatorRewardsWallet Wallet stamped on MonLock creator fee leg (LP fee share).
    ///        `pools[token].creator` is always the create-tx sender (`msg.sender`).
    function _createCore(
        string calldata name,
        string calldata symbol,
        uint256 feeDue,
        address creatorRewardsWallet
    ) internal returns (address token) {
        require(creatorRewardsWallet != address(0), "rewards");
        bytes32 salt = keccak256(abi.encode(msg.sender, name, symbol, _createNonce++, launchVirtualQuote));
        token = Create2.deploy(0, salt, _initCode(name, symbol, msg.sender));
        require(pools[token].creator == address(0), "exists");

        (address pool, uint256 positionId, uint128 liq, int24 tickLower, int24 tickUpper) =
            _mintSingleSided(token, TOTAL_SUPPLY);

        pools[token] = InstantQuotePool({
            creator: msg.sender,
            uniPool: pool,
            positionId: positionId,
            liquidity: liq,
            tickLower: tickLower,
            tickUpper: tickUpper
        });
        allTokens.push(token);

        _stampLock(token, positionId, creatorRewardsWallet);

        if (feeDue > 0) _sendValue(treasury, feeDue);

        emit InstantQuoteTokenCreated(token, msg.sender, pool, positionId);
        emit InstantQuoteMinted(token, pool, positionId, tickLower, tickUpper, liq);
    }

    /// @dev Wrap ETH → WETH, swap WETH→QUOTE (try configured + common fee tiers), then QUOTE→TOKEN.
    function _buyTokenWithEth(address token, uint256 ethIn, address recipient)
        internal
        returns (uint256 quoteBought, uint256 tokensOut)
    {
        address weth = address(WETH);
        address quote = address(QUOTE);
        address router = swapRouter;

        WETH.deposit{value: ethIn}();

        if (weth == quote) {
            quoteBought = ethIn;
        } else {
            quoteBought = _swapExactInBestFee(router, weth, quote, ethIn, address(this));
        }
        require(quoteBought > 0, "no quote out");

        tokensOut = _buyTokenWithQuote(token, quoteBought, recipient);
    }

    /// @dev Try quoteAcquisitionFee first, then 500 / 3000 / 10000 (deduped). Reverts if none route.
    function _swapExactInBestFee(address router, address tokenIn, address tokenOut, uint256 amountIn, address to)
        internal
        returns (uint256 amountOut)
    {
        IERC20(tokenIn).forceApprove(router, amountIn);

        uint24 primary = quoteAcquisitionFee;
        uint24[4] memory fees = [primary, uint24(500), uint24(3_000), uint24(10_000)];

        for (uint256 i = 0; i < fees.length; i++) {
            uint24 fee = fees[i];
            // Skip duplicate tiers already tried
            bool seen;
            for (uint256 j = 0; j < i; j++) {
                if (fees[j] == fee) {
                    seen = true;
                    break;
                }
            }
            if (seen) continue;

            try ISwapRouterQuote(router).exactInputSingle(
                ISwapRouterQuote.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: fee,
                    recipient: to,
                    amountIn: amountIn,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            ) returns (uint256 out) {
                if (out > 0) {
                    IERC20(tokenIn).forceApprove(router, 0);
                    return out;
                }
            } catch {}
        }

        IERC20(tokenIn).forceApprove(router, 0);
        revert("no WETH/quote pool");
    }

    function _buyTokenWithQuote(address token, uint256 quoteIn, address recipient) internal returns (uint256 out) {
        require(swapRouter != address(0), "no router");
        QUOTE.forceApprove(swapRouter, quoteIn);
        out = ISwapRouterQuote(swapRouter).exactInputSingle(
            ISwapRouterQuote.ExactInputSingleParams({
                tokenIn: address(QUOTE),
                tokenOut: token,
                fee: poolFee,
                recipient: recipient,
                amountIn: quoteIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        QUOTE.forceApprove(swapRouter, 0);
    }

    /// @dev Single-sided UniV3 mint: 100% launch token, 0 QUOTE.
    function _mintSingleSided(address token, uint256 tokenAmt)
        internal
        returns (address pool, uint256 tokenId, uint128 liquidity, int24 tickLower, int24 tickUpper)
    {
        address quote = address(QUOTE);
        bool launchIsToken0 = token < quote;
        (address token0, address token1) = launchIsToken0 ? (token, quote) : (quote, token);

        uint160 idealSqrt = BondingCurveDexSeed.sqrtPriceX96(launchIsToken0, launchVirtualQuote, VIRTUAL_TOKEN_INIT);
        int24 idealTick = TickMath.getTickAtSqrtPrice(idealSqrt);
        int24 ts = tickSpacing;

        if (launchIsToken0) {
            tickLower = _floorToSpacing(idealTick, ts);
            tickUpper = TickMath.maxUsableTick(ts);
            if (tickUpper <= tickLower) tickUpper = tickLower + ts;
        } else {
            tickUpper = _ceilToSpacing(idealTick, ts);
            tickLower = TickMath.minUsableTick(ts);
            if (tickUpper <= tickLower) tickLower = tickUpper - ts;
        }

        uint160 initSqrt =
            launchIsToken0 ? TickMath.getSqrtPriceAtTick(tickLower) : TickMath.getSqrtPriceAtTick(tickUpper);

        INonfungiblePositionManager pm = INonfungiblePositionManager(positionManager);
        pool = pm.createAndInitializePoolIfNecessary(token0, token1, poolFee, initSqrt);

        IERC20(token).forceApprove(positionManager, tokenAmt);
        (uint256 amount0Desired, uint256 amount1Desired) =
            launchIsToken0 ? (tokenAmt, uint256(0)) : (uint256(0), tokenAmt);

        uint256 used0;
        uint256 used1;
        (tokenId, liquidity, used0, used1) = pm.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: poolFee,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: 0,
                amount1Min: 0,
                recipient: lpLocker,
                deadline: block.timestamp
            })
        );
        IERC20(token).forceApprove(positionManager, 0);

        if (launchIsToken0) require(used1 == 0, "quote side");
        else require(used0 == 0, "quote side");

        uint256 left = IERC20(token).balanceOf(address(this));
        if (left > 0) IERC20(token).safeTransfer(treasury, left);
    }

    function _stampLock(address token, uint256 positionId, address creator) internal {
        IBpsSource src = IBpsSource(bpsSource);
        uint16 cBps = src.lpMemeCreatorBps();
        uint16 sBps = src.lpMemeStakerBps();
        ILpLocker(lpLocker).lockPositionMeme(
            positionId, token, address(QUOTE), stakingPool, sBps, creator, cBps
        );
    }

    function _initCode(string calldata name, string calldata symbol, address /* creator */)
        internal
        view
        returns (bytes memory)
    {
        // Plain 18dp LaunchToken18 — DYOR-style, no anti-snipe args.
        return abi.encodePacked(type(LaunchToken18).creationCode, abi.encode(name, symbol, address(this)));
    }

    function _floorToSpacing(int24 tick, int24 ts) internal pure returns (int24) {
        int24 compressed = tick / ts;
        if (tick < 0 && tick % ts != 0) compressed--;
        return compressed * ts;
    }

    function _ceilToSpacing(int24 tick, int24 ts) internal pure returns (int24) {
        int24 compressed = tick / ts;
        if (tick > 0 && tick % ts != 0) compressed++;
        return compressed * ts;
    }

    function _sendValue(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) {
            (bool ok2,) = payable(treasury).call{value: amount}("");
            require(ok2);
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InstantErc20QuoteFactory} from "./InstantErc20QuoteFactory.sol";

/**
 * @title InstantErc20QuoteFactoryProxyInit
 * @notice Transparent-proxy implementation for InstantErc20QuoteFactory (TOKEN/QUOTE Instant memes).
 *         Deploy one proxy per quote asset (AAPL, GME, CASHCAT, PONS, …).
 */
contract InstantErc20QuoteFactoryProxyInit is InstantErc20QuoteFactory {
    bool private _initialized;

    constructor(address quote_, uint8 quoteDecimals_, address weth_)
        InstantErc20QuoteFactory(
            quote_, quoteDecimals_, weth_, address(0xdead), address(0xdead), address(0xdead)
        )
    {}

    function initialize(
        address treasury_,
        address stakingPool_,
        address owner_,
        address bpsSource_,
        uint256 launchVirtualQuote_
    ) external {
        require(!_initialized, "initialized");
        require(
            treasury_ != address(0) && stakingPool_ != address(0) && owner_ != address(0) && bpsSource_ != address(0),
            "zero"
        );
        require(launchVirtualQuote_ > 0, "vq");
        _initialized = true;
        treasury = treasury_;
        stakingPool = stakingPool_;
        bpsSource = bpsSource_;
        launchVirtualQuote = launchVirtualQuote_;
        _transferOwnership(owner_);
    }
}

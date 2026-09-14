// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {EveFeeHook} from "./EveFeeHook.sol";
import {BundleSink} from "./BundleSink.sol";

/// @title BundleSinkDeployer
/// @notice Holds BundleSink creation code so RwaInstantV4Factory stays under the 24,576
///         byte EIP-170 cap. One deployer serves every RWA factory on this hook.
contract BundleSinkDeployer {
    function deploy(
        EveFeeHook hook,
        IPoolManager manager,
        IERC20 token,
        address creator,
        address factory
    ) external returns (BundleSink sink) {
        sink = new BundleSink(hook, manager, token, creator, factory);
    }
}

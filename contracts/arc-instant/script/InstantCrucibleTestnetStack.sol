// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {InstantErc20QuoteFactoryProxyInit} from "../src/InstantErc20QuoteFactoryProxyInit.sol";
import {ArcBpsSource} from "../src/ArcBpsSource.sol";
import {InstantTestnetStack} from "./InstantTestnetStack.sol";
import {MockUSDC} from "./testnet/MockUSDC.sol";
import {MockEve} from "./testnet/MockEve.sol";
import {WETH9} from "./testnet/WETH9.sol";
import {DummyNFTDescriptor} from "./testnet/DummyNFTDescriptor.sol";
import {CrucibleLock} from "./vendor-crucible/src/CrucibleLock.sol";
import {Crucible} from "./vendor-crucible/src/Crucible.sol";
import {ReferralRegistry} from "./vendor-crucible/src/ReferralRegistry.sol";
import {InstantLockerAdapter} from "./vendor-crucible/src/InstantLockerAdapter.sol";

/// @notice Throwaway-Uni testnet stack for ArcFun Instant routed through CrucibleLock (via
///         InstantLockerAdapter) instead of MonLock. Sibling to InstantTestnetStack.sol, which
///         this reuses for the Uniswap V3 + mock-token deployment (`_creation`/`deployCode`) —
///         everything else is new: ReferralRegistry, Crucible (the burn sink), CrucibleLock,
///         and InstantLockerAdapter (see ./vendor-crucible/README.md for why these are copies
///         rather than a direct cross-project import).
///
///         Not a Script — no chain-id require — so forge tests can reuse `deploy(...)`. The
///         broadcast script wraps this with `require(block.chainid == 5042002)`.
library InstantCrucibleTestnetStack {
    uint24 internal constant POOL_FEE = 10_000;
    int24 internal constant TICK_SPACING = 200;

    struct Addresses {
        address mockUsdc;
        address mockEve;
        address weth;
        address uniFactory;
        address nftDescriptor;
        address nfpm;
        address swapRouter02;
        address bpsSource;
        address referralRegistry;
        address crucible;
        address crucibleLock;
        address adapter;
        address factoryImpl;
        address factory;
    }

    struct DeployParams {
        address owner;
        address treasury;
        address stakingPool;
        address platformWallet;
        uint256 creationFee;
        uint256 launchVirtualQuote;
        bool wireOwner;
    }

    function defaultParams(address owner) internal pure returns (DeployParams memory p) {
        p.owner = owner;
        p.treasury = owner;
        p.stakingPool = owner;
        p.platformWallet = owner;
        p.creationFee = 0;
        p.launchVirtualQuote = 5_500_000_000; // 5500 USDC (6dp)
        p.wireOwner = true;
    }

    function deploy(address owner) internal returns (Addresses memory) {
        return deploy(defaultParams(owner));
    }

    function deploy(DeployParams memory p) internal returns (Addresses memory s) {
        require(p.owner != address(0), "owner");

        s.mockUsdc = address(new MockUSDC());
        s.mockEve = address(new MockEve());
        s.weth = address(new WETH9());

        // Reuse InstantTestnetStack's bytecode-loading helpers (internal library functions —
        // reusable by any importer, not just InstantTestnetStack.deploy() itself).
        s.uniFactory = InstantTestnetStack.deployCode(InstantTestnetStack._creation("UniswapV3Factory.hex"));
        s.nftDescriptor = address(new DummyNFTDescriptor());
        s.nfpm = InstantTestnetStack.deployCode(
            InstantTestnetStack._creation("NonfungiblePositionManager.hex"),
            abi.encode(s.uniFactory, s.weth, s.nftDescriptor)
        );
        s.swapRouter02 = InstantTestnetStack.deployCode(
            InstantTestnetStack._creation("SwapRouter02.hex"),
            abi.encode(address(0), s.uniFactory, s.nfpm, s.weth)
        );

        // Still required by InstantErc20QuoteFactoryProxyInit.initialize (non-zero check) even
        // though CrucibleLock ignores whatever creator/staker bps it reports — CrucibleLock's
        // Meme split (50/25/10/10/5) is a fixed protocol constant, ArcBpsSource's value is dead
        // config once routed through InstantLockerAdapter. Left at the library default (7000/0)
        // rather than wired to anything, since it does nothing on this path.
        ArcBpsSource bps = new ArcBpsSource(p.owner);
        s.bpsSource = address(bps);

        s.referralRegistry = address(new ReferralRegistry());
        s.crucible = address(new Crucible(s.mockUsdc, s.swapRouter02, s.mockEve, POOL_FEE));

        CrucibleLock lock = new CrucibleLock(
            s.nfpm, s.mockUsdc, s.swapRouter02, s.crucible, s.referralRegistry, p.platformWallet
        );
        s.crucibleLock = address(lock);

        InstantErc20QuoteFactoryProxyInit factoryImpl =
            new InstantErc20QuoteFactoryProxyInit(s.mockUsdc, InstantTestnetStack.USDC_DECIMALS, s.weth);
        s.factoryImpl = address(factoryImpl);
        TransparentUpgradeableProxy factoryProxy = new TransparentUpgradeableProxy(
            address(factoryImpl),
            p.owner,
            abi.encodeCall(
                InstantErc20QuoteFactoryProxyInit.initialize,
                (p.treasury, p.stakingPool, p.owner, s.bpsSource, p.launchVirtualQuote)
            )
        );
        s.factory = address(factoryProxy);

        // Adapter wired with a placeholder instantFactory at construction (the real factory
        // address doesn't exist yet) — deploy(), then setInstantFactory(real factory) below.
        InstantLockerAdapter adapter = new InstantLockerAdapter(s.crucibleLock, s.nfpm, p.owner);
        s.adapter = address(adapter);

        if (p.wireOwner) {
            lock.setFactory(s.adapter);
            adapter.setInstantFactory(s.factory);
            InstantErc20QuoteFactoryProxyInit(payable(s.factory)).setUniV3Config(
                s.nfpm, POOL_FEE, TICK_SPACING, s.adapter, s.swapRouter02
            );
            if (p.creationFee > 0) {
                InstantErc20QuoteFactoryProxyInit(payable(s.factory)).setCreationFee(p.creationFee);
            }
        }
    }
}

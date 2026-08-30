// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ArcNft721} from "./ArcNft721.sol";

interface IInstantGetPool {
    struct Pool {
        address creator;
        address uniPool;
        uint256 positionId;
        uint128 liquidity;
        int24 tickLower;
        int24 tickUpper;
    }

    function getPool(address token) external view returns (Pool memory);
}

interface IReflectionPools {
    function pools(address token)
        external
        view
        returns (
            address creator,
            address rewardToken,
            address feeSink,
            address uniPool,
            uint256 positionId,
            uint128 liquidity,
            int24 tickLower,
            int24 tickUpper
        );
}

/// @title ArcNftCollectionFactory
/// @notice One-tx collection deploy. Same creation-fee / treasury / owner-waiver
///         shape as InstantErc20QuoteFactory. Clones ArcNft721.
///         Optional originToken binds the collection to an Instant/Reflection
///         launch; only that token's creator can set the link.
contract ArcNftCollectionFactory is Initializable, OwnableUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable {
    error FeeTooLow();
    error ZeroAddr();
    error BadImpl();
    error UnknownToken();
    error NotTokenCreator();
    error TokenAlreadyLinked();
    error NotCollection();

    struct CreateParams {
        string name;
        string symbol;
        string unrevealedURI;
        string baseURI;
        bool revealed;
        uint256 maxSupply;
        uint256 maxPerWallet;
        uint256 price;
        uint64 publicMintStart;
        uint64 allowlistMintStart;
        uint64 allowlistMintEnd;
        bytes32 allowlistRoot;
        uint96 royaltyBps;
        address creatorRewardsWallet;
        address originToken;
    }

    uint256 public creationFee;
    address public treasury;
    address public usdc;
    address public implementation;
    address public instantFactory;
    address public reflectionFactory;

    address[] public allCollections;
    mapping(address => bool) public isCollection;
    mapping(address => address) public creatorOf;
    mapping(address => address) public originTokenOf;
    mapping(address => address) public collectionOfToken;
    mapping(address => bool) public hidden;

    event CollectionCreated(
        address indexed collection,
        address indexed creator,
        address indexed creatorPayout,
        address originToken,
        string name,
        string symbol
    );
    event CollectionHidden(address indexed collection, bool hidden);
    event TreasurySet(address treasury);
    event CreationFeeSet(uint256 fee);
    event ImplementationSet(address implementation);

    constructor() {
        _disableInitializers();
    }

    function initialize(
        address owner_,
        address treasury_,
        address usdc_,
        address implementation_,
        uint256 creationFee_,
        address instantFactory_,
        address reflectionFactory_
    ) external initializer {
        if (owner_ == address(0) || treasury_ == address(0) || usdc_ == address(0) || implementation_ == address(0)) {
            revert ZeroAddr();
        }
        if (implementation_.code.length == 0) revert BadImpl();
        __Ownable_init(owner_);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        treasury = treasury_;
        usdc = usdc_;
        implementation = implementation_;
        creationFee = creationFee_;
        instantFactory = instantFactory_;
        reflectionFactory = reflectionFactory_;
    }

    /// @notice Instant/Reflection launch creator. Zero if the token is not on the pad.
    function tokenCreator(address token) public view returns (address) {
        if (token == address(0)) return address(0);
        if (instantFactory != address(0)) {
            try IInstantGetPool(instantFactory).getPool(token) returns (IInstantGetPool.Pool memory p) {
                if (p.creator != address(0) && p.uniPool != address(0)) return p.creator;
            } catch {}
        }
        if (reflectionFactory != address(0)) {
            try IReflectionPools(reflectionFactory).pools(token) returns (
                address creator,
                address,
                address,
                address uniPool,
                uint256,
                uint128,
                int24,
                int24
            ) {
                if (creator != address(0) && uniPool != address(0)) return creator;
            } catch {}
        }
        return address(0);
    }

    /// @notice Instant-compatible: platform owner mints collections free.
    function creationFeeDue(address creator) public view returns (uint256) {
        if (creator == owner()) return 0;
        return creationFee;
    }

    function CREATION_FEE() external view returns (uint256) {
        return creationFee;
    }

    function createCollection(CreateParams calldata p) external payable nonReentrant returns (address collection) {
        uint256 due = creationFeeDue(msg.sender);
        if (msg.value < due) revert FeeTooLow();
        if (due > 0) {
            (bool ok,) = treasury.call{value: due}("");
            require(ok, "fee xfer");
        }
        if (msg.value > due) {
            (bool ok,) = msg.sender.call{value: msg.value - due}("");
            require(ok, "refund");
        }

        address origin = p.originToken;
        if (origin != address(0)) {
            address tokCreator = tokenCreator(origin);
            if (tokCreator == address(0)) revert UnknownToken();
            if (tokCreator != msg.sender) revert NotTokenCreator();
            if (collectionOfToken[origin] != address(0)) revert TokenAlreadyLinked();
        }

        address payout = p.creatorRewardsWallet == address(0) ? msg.sender : p.creatorRewardsWallet;
        collection = Clones.clone(implementation);
        ArcNft721(collection).initialize(
            ArcNft721.Init({
                name: p.name,
                symbol: p.symbol,
                unrevealedURI: p.unrevealedURI,
                baseURI: p.baseURI,
                revealed: p.revealed,
                maxSupply: p.maxSupply,
                maxPerWallet: p.maxPerWallet,
                price: p.price,
                publicMintStart: p.publicMintStart,
                allowlistMintStart: p.allowlistMintStart,
                allowlistMintEnd: p.allowlistMintEnd,
                allowlistRoot: p.allowlistRoot,
                royaltyBps: p.royaltyBps,
                creator: msg.sender,
                creatorPayout: payout,
                treasury: treasury,
                usdc: usdc,
                factory: address(this),
                originToken: origin
            })
        );

        isCollection[collection] = true;
        creatorOf[collection] = msg.sender;
        originTokenOf[collection] = origin;
        if (origin != address(0)) collectionOfToken[origin] = collection;
        allCollections.push(collection);
        emit CollectionCreated(collection, msg.sender, payout, origin, p.name, p.symbol);
    }

    function allCollectionsLength() external view returns (uint256) {
        return allCollections.length;
    }

    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddr();
        treasury = t;
        emit TreasurySet(t);
    }

    function setCreationFee(uint256 fee) external onlyOwner {
        creationFee = fee;
        emit CreationFeeSet(fee);
    }

    /// @dev `Clones.clone` of an address with no code deploys a proxy that
    ///      delegates into nothing: `initialize` returns successfully having
    ///      done nothing, and every collection minted afterwards is a dead
    ///      contract. Cheap to check here, unrecoverable if it lands.
    function setImplementation(address impl) external onlyOwner {
        if (impl == address(0)) revert ZeroAddr();
        if (impl.code.length == 0) revert BadImpl();
        implementation = impl;
        emit ImplementationSet(impl);
    }

    function setInstantFactory(address f) external onlyOwner {
        instantFactory = f;
    }

    function setReflectionFactory(address f) external onlyOwner {
        reflectionFactory = f;
    }

    /// @notice Drop a collection from ArcPort. Does not delete the 721.
    ///         Hiding frees originToken so a later official collection can link.
    function setHidden(address collection, bool hide) external onlyOwner {
        if (!isCollection[collection]) revert NotCollection();
        hidden[collection] = hide;
        address origin = originTokenOf[collection];
        if (origin != address(0)) {
            if (hide) {
                if (collectionOfToken[origin] == collection) collectionOfToken[origin] = address(0);
            } else if (collectionOfToken[origin] == address(0)) {
                collectionOfToken[origin] = collection;
            }
        }
        emit CollectionHidden(collection, hide);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ArcNft721} from "./ArcNft721.sol";

/// @title ArcNftCollectionFactory
/// @notice One-tx collection deploy. Same creation-fee / treasury / owner-waiver
///         shape as InstantErc20QuoteFactory. Clones ArcNft721.
contract ArcNftCollectionFactory is Initializable, OwnableUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable {
    error FeeTooLow();
    error ZeroAddr();
    error BadImpl();

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
    }

    uint256 public creationFee;
    address public treasury;
    address public usdc;
    address public implementation;

    address[] public allCollections;
    mapping(address => bool) public isCollection;
    mapping(address => address) public creatorOf;

    event CollectionCreated(
        address indexed collection,
        address indexed creator,
        address indexed creatorPayout,
        string name,
        string symbol
    );
    event TreasurySet(address treasury);
    event CreationFeeSet(uint256 fee);
    event ImplementationSet(address implementation);

    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, address treasury_, address usdc_, address implementation_, uint256 creationFee_)
        external
        initializer
    {
        if (owner_ == address(0) || treasury_ == address(0) || usdc_ == address(0) || implementation_ == address(0)) {
            revert ZeroAddr();
        }
        __Ownable_init(owner_);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        treasury = treasury_;
        usdc = usdc_;
        implementation = implementation_;
        creationFee = creationFee_;
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
                factory: address(this)
            })
        );

        isCollection[collection] = true;
        creatorOf[collection] = msg.sender;
        allCollections.push(collection);
        emit CollectionCreated(collection, msg.sender, payout, p.name, p.symbol);
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

    function setImplementation(address impl) external onlyOwner {
        if (impl == address(0)) revert ZeroAddr();
        implementation = impl;
        emit ImplementationSet(impl);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}

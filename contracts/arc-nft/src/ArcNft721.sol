// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {ERC2981Upgradeable} from "@openzeppelin/contracts-upgradeable/token/common/ERC2981Upgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title ArcNft721
/// @notice Cloneable ERC-721 + EIP-2981. Fixed-price USDC mint, per-wallet cap,
///         optional merkle allowlist, reveal. Deployed by ArcNftCollectionFactory.
contract ArcNft721 is Initializable, ERC721Upgradeable, ERC2981Upgradeable, OwnableUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    uint16 public constant BPS_DENOM = 10_000;
    uint16 public constant PLATFORM_MINT_BPS = 500; // 5% of mint proceeds
    uint96 public constant MAX_ROYALTY_BPS = 1_000; // 10%

    error SoldOut();
    error WalletCap();
    error NotLive();
    error BadProof();
    error BadN();
    error RoyaltyTooHigh();
    error ZeroAddr();

    struct Init {
        string name;
        string symbol;
        string unrevealedURI;
        string baseURI;
        bool revealed;
        uint256 maxSupply;
        uint256 maxPerWallet;
        uint256 price; // USDC 6dp
        uint64 publicMintStart;
        uint64 allowlistMintStart;
        uint64 allowlistMintEnd;
        bytes32 allowlistRoot;
        uint96 royaltyBps;
        address creator;
        address creatorPayout;
        address treasury;
        address usdc;
        address factory;
    }

    address public factory;
    address public creatorPayout;
    address public treasury;
    IERC20 public usdc;

    uint256 public maxSupply;
    uint256 public maxPerWallet;
    uint256 public price;
    uint256 public totalMinted;

    uint64 public publicMintStart;
    uint64 public allowlistMintStart;
    uint64 public allowlistMintEnd;
    bytes32 public allowlistRoot;

    string public unrevealedURI;
    string public baseTokenURI;
    bool public revealed;

    mapping(address => uint256) public mintedBy;

    event Minted(address indexed to, uint256 firstId, uint256 n, uint256 paid);
    event Revealed(string baseURI);
    event BaseURISet(string baseURI);
    event AllowlistRootSet(bytes32 root);
    event PriceSet(uint256 price);

    constructor() {
        _disableInitializers();
    }

    function initialize(Init calldata c) external initializer {
        if (c.creator == address(0) || c.creatorPayout == address(0) || c.treasury == address(0) || c.usdc == address(0)) {
            revert ZeroAddr();
        }
        if (c.royaltyBps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();
        if (c.maxSupply == 0 || c.maxPerWallet == 0) revert BadN();

        __ERC721_init(c.name, c.symbol);
        __ERC2981_init();
        __Ownable_init(c.creator);
        __ReentrancyGuard_init();

        factory = c.factory;
        creatorPayout = c.creatorPayout;
        treasury = c.treasury;
        usdc = IERC20(c.usdc);

        maxSupply = c.maxSupply;
        maxPerWallet = c.maxPerWallet;
        price = c.price;
        publicMintStart = c.publicMintStart;
        allowlistMintStart = c.allowlistMintStart;
        allowlistMintEnd = c.allowlistMintEnd;
        allowlistRoot = c.allowlistRoot;
        unrevealedURI = c.unrevealedURI;
        baseTokenURI = c.baseURI;
        revealed = c.revealed;

        _setDefaultRoyalty(c.creatorPayout, c.royaltyBps);
    }

    function mint(uint256 n) external nonReentrant {
        if (!_publicLive()) revert NotLive();
        _mintTo(msg.sender, n, false, new bytes32[](0));
    }

    function mintAllowlist(uint256 n, bytes32[] calldata proof) external nonReentrant {
        if (!_allowlistLive()) revert NotLive();
        _mintTo(msg.sender, n, true, proof);
    }

    function _mintTo(address to, uint256 n, bool allowlist, bytes32[] memory proof) internal {
        if (n == 0) revert BadN();
        if (totalMinted + n > maxSupply) revert SoldOut();
        if (mintedBy[to] + n > maxPerWallet) revert WalletCap();
        if (allowlist) {
            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(to))));
            if (!MerkleProof.verify(proof, allowlistRoot, leaf)) revert BadProof();
        }

        uint256 paid = price * n;
        if (paid > 0) {
            usdc.safeTransferFrom(to, address(this), paid);
            uint256 plat = (paid * PLATFORM_MINT_BPS) / BPS_DENOM;
            if (plat > 0) usdc.safeTransfer(treasury, plat);
            usdc.safeTransfer(creatorPayout, paid - plat);
        }

        uint256 firstId = totalMinted + 1;
        mintedBy[to] += n;
        totalMinted += n;
        for (uint256 i; i < n; ++i) {
            _safeMint(to, firstId + i);
        }
        emit Minted(to, firstId, n, paid);
    }

    function _publicLive() internal view returns (bool) {
        return publicMintStart != 0 && block.timestamp >= publicMintStart;
    }

    function _allowlistLive() internal view returns (bool) {
        if (allowlistRoot == bytes32(0)) return false;
        if (allowlistMintStart != 0 && block.timestamp < allowlistMintStart) return false;
        if (allowlistMintEnd != 0 && block.timestamp >= allowlistMintEnd) return false;
        return true;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        if (!revealed) return unrevealedURI;
        return string.concat(baseTokenURI, tokenId.toString());
    }

    function reveal(string calldata newBaseURI) external onlyOwner {
        baseTokenURI = newBaseURI;
        revealed = true;
        emit Revealed(newBaseURI);
    }

    function setBaseURI(string calldata newBaseURI) external onlyOwner {
        baseTokenURI = newBaseURI;
        emit BaseURISet(newBaseURI);
    }

    function setUnrevealedURI(string calldata uri) external onlyOwner {
        unrevealedURI = uri;
    }

    function setAllowlistRoot(bytes32 root) external onlyOwner {
        allowlistRoot = root;
        emit AllowlistRootSet(root);
    }

    function setPrice(uint256 newPrice) external onlyOwner {
        price = newPrice;
        emit PriceSet(newPrice);
    }

    function setRoyalty(address receiver, uint96 bps) external onlyOwner {
        if (receiver == address(0)) revert ZeroAddr();
        if (bps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();
        _setDefaultRoyalty(receiver, bps);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721Upgradeable, ERC2981Upgradeable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}

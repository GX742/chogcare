// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";
import {IBridgeAdapter} from "./interfaces/IBridgeAdapter.sol";

/// @notice Monad-side router. It accepts CHOG, swaps through one allowlisted adapter,
///         adds an optional signed USDC subsidy and hands the exact USDC amount to one bridge adapter.
/// @dev Production ownership should be a timelocked multisig. Adapters must be independently audited.
///      Historical prototype only: this voucher design does NOT enforce the new NFT/day or $10/day policy.
///      It is not connected to the no-connection checkout and must not be deployed as its settlement backend.
contract ChogCareSource is AccessControl, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant SUBSIDY_SIGNER_ROLE = keccak256("SUBSIDY_SIGNER_ROLE");
    bytes32 public constant VOUCHER_TYPEHASH = keccak256(
        "SubsidyVoucher(address donor,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    uint256 public constant MAX_SUBSIDY = 500_000; // $0.50 for a six-decimal USDC token.

    IERC20 public immutable chog;
    IERC20 public immutable usdc;
    ISwapAdapter public swapAdapter;
    IBridgeAdapter public bridgeAdapter;
    uint64 public destinationChainId;
    address public destinationRouter;
    uint256 public donationNonce;

    mapping(address recipient => bool allowed) public allowedRecipients;
    mapping(address donor => mapping(uint256 nonce => bool used)) public usedVoucher;

    struct SubsidyVoucher {
        address donor;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
    }

    struct DonationRequest {
        uint256 chogAmount;
        uint256 minUsdcOut;
        address recipient;
        bytes32 projectId;
        uint256 deadline;
        bytes swapData;
        bytes bridgeData;
    }

    error ZeroAddress();
    error InvalidAmount();
    error InvalidUsdcDecimals();
    error InvalidAdapter();
    error RecipientNotAllowed();
    error DeadlineExpired();
    error SlippageExceeded(uint256 received, uint256 minimum);
    error InvalidVoucher();
    error VoucherAlreadyUsed();
    error SubsidyTooLarge();

    event DonationRequested(
        bytes32 indexed donationId,
        bytes32 indexed bridgeMessageId,
        address indexed donor,
        address recipient,
        bytes32 projectId,
        uint256 chogAmount,
        uint256 swappedUsdc,
        uint256 subsidyUsdc,
        uint256 bridgedUsdc
    );
    event RecipientPermissionSet(address indexed recipient, bool allowed);
    event SwapAdapterSet(address indexed adapter);
    event BridgeRouteSet(address indexed adapter, uint64 destinationChainId, address indexed destinationRouter);

    constructor(
        address admin,
        address chogToken,
        address usdcToken,
        address initialSwapAdapter,
        address initialBridgeAdapter,
        uint64 initialDestinationChainId,
        address initialDestinationRouter
    ) EIP712("ChogCare", "1") {
        if (admin == address(0) || chogToken == address(0) || usdcToken == address(0)) revert ZeroAddress();
        if (IERC20Metadata(usdcToken).decimals() != 6) revert InvalidUsdcDecimals();

        chog = IERC20(chogToken);
        usdc = IERC20(usdcToken);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MANAGER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(SUBSIDY_SIGNER_ROLE, admin);
        _setSwapAdapter(initialSwapAdapter);
        _setBridgeRoute(initialBridgeAdapter, initialDestinationChainId, initialDestinationRouter);
    }

    function donate(
        DonationRequest calldata request,
        SubsidyVoucher calldata voucher,
        bytes calldata voucherSignature
    ) external payable whenNotPaused nonReentrant returns (bytes32 donationId, bytes32 bridgeMessageId) {
        if (request.chogAmount == 0) revert InvalidAmount();
        if (!allowedRecipients[request.recipient]) revert RecipientNotAllowed();
        if (block.timestamp > request.deadline) revert DeadlineExpired();

        chog.safeTransferFrom(msg.sender, address(this), request.chogAmount);

        uint256 usdcBefore = usdc.balanceOf(address(this));
        chog.forceApprove(address(swapAdapter), request.chogAmount);
        swapAdapter.swap(
            address(chog),
            address(usdc),
            request.chogAmount,
            request.minUsdcOut,
            request.deadline,
            request.swapData
        );
        chog.forceApprove(address(swapAdapter), 0);

        uint256 swappedUsdc = usdc.balanceOf(address(this)) - usdcBefore;
        if (swappedUsdc < request.minUsdcOut) revert SlippageExceeded(swappedUsdc, request.minUsdcOut);

        uint256 subsidyUsdc = _consumeVoucher(voucher, voucherSignature);
        uint256 bridgedUsdc = swappedUsdc + subsidyUsdc;
        if (usdc.balanceOf(address(this)) < bridgedUsdc) revert InvalidAmount();

        donationId = keccak256(abi.encode(block.chainid, address(this), msg.sender, donationNonce++));
        bytes memory payload = abi.encode(
            donationId,
            msg.sender,
            request.recipient,
            request.projectId,
            bridgedUsdc
        );

        usdc.forceApprove(address(bridgeAdapter), bridgedUsdc);
        bridgeMessageId = bridgeAdapter.bridge{value: msg.value}(
            address(usdc),
            bridgedUsdc,
            destinationChainId,
            destinationRouter,
            payload,
            request.bridgeData
        );
        usdc.forceApprove(address(bridgeAdapter), 0);

        emit DonationRequested(
            donationId,
            bridgeMessageId,
            msg.sender,
            request.recipient,
            request.projectId,
            request.chogAmount,
            swappedUsdc,
            subsidyUsdc,
            bridgedUsdc
        );
    }

    function _consumeVoucher(
        SubsidyVoucher calldata voucher,
        bytes calldata signature
    ) internal returns (uint256 subsidy) {
        if (voucher.amount == 0 && signature.length == 0) return 0;
        if (voucher.donor != msg.sender || block.timestamp > voucher.deadline) revert InvalidVoucher();
        if (voucher.amount > MAX_SUBSIDY) revert SubsidyTooLarge();
        if (usedVoucher[voucher.donor][voucher.nonce]) revert VoucherAlreadyUsed();

        bytes32 structHash = keccak256(abi.encode(
            VOUCHER_TYPEHASH,
            voucher.donor,
            voucher.amount,
            voucher.nonce,
            voucher.deadline
        ));
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (!hasRole(SUBSIDY_SIGNER_ROLE, signer)) revert InvalidVoucher();

        usedVoucher[voucher.donor][voucher.nonce] = true;
        return voucher.amount;
    }

    function setRecipientAllowed(address recipient, bool allowed) external onlyRole(MANAGER_ROLE) {
        if (recipient == address(0)) revert ZeroAddress();
        allowedRecipients[recipient] = allowed;
        emit RecipientPermissionSet(recipient, allowed);
    }

    function setSwapAdapter(address adapter) external onlyRole(MANAGER_ROLE) {
        _setSwapAdapter(adapter);
    }

    function _setSwapAdapter(address adapter) internal {
        if (adapter.code.length == 0) revert InvalidAdapter();
        swapAdapter = ISwapAdapter(adapter);
        emit SwapAdapterSet(adapter);
    }

    function setBridgeRoute(
        address adapter,
        uint64 chainId,
        address router
    ) external onlyRole(MANAGER_ROLE) {
        _setBridgeRoute(adapter, chainId, router);
    }

    function _setBridgeRoute(address adapter, uint64 chainId, address router) internal {
        if (adapter.code.length == 0 || chainId == 0 || router == address(0)) revert InvalidAdapter();
        bridgeAdapter = IBridgeAdapter(adapter);
        destinationChainId = chainId;
        destinationRouter = router;
        emit BridgeRouteSet(adapter, chainId, router);
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    /// @dev Emergency-only recovery. In production DEFAULT_ADMIN_ROLE must be a timelocked multisig.
    function recoverToken(address token, address recipient, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) whenPaused {
        if (recipient == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(recipient, amount);
    }

    receive() external payable {}
}

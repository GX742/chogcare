// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Ethereum-side receiver. A trusted bridge adapter calls this only after USDC arrives.
/// @dev Historical prototype, not a deployed/verified bridge endpoint. BRIDGE_ROLE can spend its balance;
///      a production adapter must authenticate remote chain/sender/message and enforce exact delivery.
contract ChogCareReceiver is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    IERC20 public immutable usdc;
    mapping(bytes32 donationId => bool processed) public processedDonations;
    mapping(address recipient => bool allowed) public allowedRecipients;

    error ZeroAddress();
    error DonationAlreadyProcessed();
    error RecipientNotAllowed();
    error InvalidAmount();

    event DonationCompleted(
        bytes32 indexed donationId,
        address indexed donor,
        address indexed recipient,
        bytes32 projectId,
        uint256 amount
    );
    event RecipientPermissionSet(address indexed recipient, bool allowed);

    constructor(address admin, address usdcToken) {
        if (admin == address(0) || usdcToken == address(0)) revert ZeroAddress();
        usdc = IERC20(usdcToken);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MANAGER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    function completeDonation(
        bytes32 donationId,
        address donor,
        address recipient,
        bytes32 projectId,
        uint256 amount
    ) external onlyRole(BRIDGE_ROLE) whenNotPaused nonReentrant {
        if (processedDonations[donationId]) revert DonationAlreadyProcessed();
        if (!allowedRecipients[recipient]) revert RecipientNotAllowed();
        if (donor == address(0) || amount == 0) revert InvalidAmount();

        processedDonations[donationId] = true;
        usdc.safeTransfer(recipient, amount);
        emit DonationCompleted(donationId, donor, recipient, projectId, amount);
    }

    function setRecipientAllowed(address recipient, bool allowed) external onlyRole(MANAGER_ROLE) {
        if (recipient == address(0)) revert ZeroAddress();
        allowedRecipients[recipient] = allowed;
        emit RecipientPermissionSet(recipient, allowed);
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    function recoverToken(address token, address recipient, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) whenPaused {
        if (recipient == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(recipient, amount);
    }
}

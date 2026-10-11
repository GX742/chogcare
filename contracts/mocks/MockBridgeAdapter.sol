// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBridgeAdapter} from "../interfaces/IBridgeAdapter.sol";
import {IDonationReceiver} from "../interfaces/IDonationReceiver.sol";

contract MockBridgeAdapter is IBridgeAdapter {
    using SafeERC20 for IERC20;
    uint256 public nonce;

    function bridge(
        address token,
        uint256 amount,
        uint64,
        address destinationRouter,
        bytes calldata payload,
        bytes calldata
    ) external payable returns (bytes32 messageId) {
        IERC20(token).safeTransferFrom(msg.sender, destinationRouter, amount);
        (bytes32 donationId, address donor, address recipient, bytes32 projectId, uint256 payloadAmount) =
            abi.decode(payload, (bytes32, address, address, bytes32, uint256));
        require(payloadAmount == amount, "amount mismatch");
        IDonationReceiver(destinationRouter).completeDonation(donationId, donor, recipient, projectId, amount);
        messageId = keccak256(abi.encode(block.chainid, address(this), nonce++));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IDonationReceiver {
    function completeDonation(
        bytes32 donationId,
        address donor,
        address recipient,
        bytes32 projectId,
        uint256 amount
    ) external;
}

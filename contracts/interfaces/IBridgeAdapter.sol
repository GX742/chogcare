// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IBridgeAdapter {
    function bridge(
        address token,
        uint256 amount,
        uint64 destinationChainId,
        address destinationRouter,
        bytes calldata payload,
        bytes calldata data
    ) external payable returns (bytes32 messageId);
}

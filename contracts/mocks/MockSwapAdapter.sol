// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

contract MockSwapAdapter is ISwapAdapter {
    using SafeERC20 for IERC20;
    uint256 public immutable outputPerWholeInput;
    uint8 public immutable inputDecimals;

    constructor(uint256 rate, uint8 decimals_) {
        outputPerWholeInput = rate;
        inputDecimals = decimals_;
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline,
        bytes calldata
    ) external returns (uint256 amountOut) {
        require(block.timestamp <= deadline, "expired");
        amountOut = amountIn * outputPerWholeInput / (10 ** inputDecimals);
        require(amountOut >= minAmountOut, "slippage");
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
    }
}

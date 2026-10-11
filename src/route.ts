import { parseUnits, type Address } from "viem";

export const CHOG = "0x350035555E10d9AfAF1566AaebfCeD5BA6C27777" as Address;
export const NAD_LENS = "0x7e78A8DE94f21804F7a17F4E8BF9EC2c872187ea" as Address;
export const NAD_DEX_ROUTER = "0x0B79d71AE99528D1dB24A4148b5f4F865cc2b137" as Address;
export const NAD_CURVE_ROUTER = "0x6F6B8F1a20703309951a5127c45B49b1CD981A22" as Address;
export const LIFI_DIAMOND = "0x026F252016A7C47CDEf1F05a3Fc9E20C92a49C37" as Address;
export const MONAD_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Address;
export const ETHEREUM_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
export const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as Address;
export const UNISWAP_QUOTER = "0x661e93cca42afacb172121ef892830ca3b70f08d" as Address;
export const UNISWAP_ROUTER = "0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900" as Address;
export const GAS_RESERVE = parseUnits("1", 18);
export const MIN_CHOG_AMOUNT = parseUnits("300", 18);
export const MIN_BRIDGE_USDC = 200_000n;
export const UNISWAP_FEES = [100, 500, 3000, 10000] as const;
export const GIVETH_PROJECT_SLUG = "creating-the-perfect-villages-in-burundi";
export const GIVETH_PROJECT_RECIPIENT = "0x1de498918d04B8Bf162210103CDd547f73387B2E" as Address;
export const GIVETH_PROJECT_URL = `https://giveth.io/project/${GIVETH_PROJECT_SLUG}`;

export const lensAbi = [{
  type: "function",
  name: "getAmountOut",
  stateMutability: "view",
  inputs: [
    { name: "_token", type: "address" },
    { name: "_amountIn", type: "uint256" },
    { name: "_isBuy", type: "bool" },
  ],
  outputs: [{ name: "router", type: "address" }, { name: "amountOut", type: "uint256" }],
}] as const;

export const sellAbi = [{
  type: "function",
  name: "sell",
  stateMutability: "nonpayable",
  inputs: [{
    name: "params",
    type: "tuple",
    components: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "token", type: "address" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
  }],
  outputs: [{ name: "amountOut", type: "uint256" }],
}] as const;

export const quoterAbi = [{
  type: "function",
  name: "quoteExactInputSingle",
  stateMutability: "nonpayable",
  inputs: [{
    name: "params",
    type: "tuple",
    components: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "fee", type: "uint24" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ],
  }],
  outputs: [
    { name: "amountOut", type: "uint256" },
    { name: "sqrtPriceX96After", type: "uint160" },
    { name: "initializedTicksCrossed", type: "uint32" },
    { name: "gasEstimate", type: "uint256" },
  ],
}] as const;

export const swapRouterAbi = [{
  type: "function",
  name: "exactInputSingle",
  stateMutability: "payable",
  inputs: [{
    name: "params",
    type: "tuple",
    components: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "recipient", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMinimum", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ],
  }],
  outputs: [{ name: "amountOut", type: "uint256" }],
}] as const;

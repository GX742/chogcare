import {
  decodeAbiParameters, encodeAbiParameters, encodeFunctionData, erc20Abi, isAddress, parseAbi, parseUnits,
  type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import {
  CHOG, NAD_LENS, NAD_DEX_ROUTER, NAD_CURVE_ROUTER, LIFI_DIAMOND,
  MONAD_USDC, ETHEREUM_USDC, WMON, UNISWAP_QUOTER, UNISWAP_ROUTER,
  GAS_RESERVE, MIN_CHOG_AMOUNT, MIN_BRIDGE_USDC, UNISWAP_FEES,
  GIVETH_PROJECT_RECIPIENT, lensAbi, quoterAbi, sellAbi, swapRouterAbi,
} from "./route.ts";

export type Call = { to: Address; data: Hex; value: bigint };
export type BridgeQuote = {
  action: {
    fromChainId: number; toChainId: number; fromAmount: string;
    fromAddress: string; toAddress: string;
    fromToken: { address: string }; toToken: { address: string };
  };
  estimate: { toAmountMin: string; approvalAddress: string };
  transactionRequest: { to: Address; data: Hex; value: string; chainId: number };
  tool: string;
};
export type DonationQuote = {
  owner: Address; mode: "chog" | "usdc"; createdAt: number;
  amountIn: bigint; bridgeAmount: bigint; minUsdc: bigint; bridgeTool: string;
  router?: Address; minMon?: bigint; swapMonAmount?: bigint; uniFee?: number;
};
export type Submission = {
  owner: Address; chainId: 143; id?: string; hash?: Hex; bridgeTool: string;
  state: "submitting" | "pending" | "source-confirmed" | "complete" | "failed" | "unknown";
  bridgeAmount: string; createdAt: number;
};

const sameAddress = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
export const storageKey = (owner: string) => `chogcare:submission:v2:143:${owner.toLowerCase()}`;
export const blocksResubmit = (s: Submission | null) => !!s && s.state !== "failed" && s.state !== "complete";
export const quoteIsCurrent = (q: DonationQuote, owner: string, now = Date.now()) =>
  sameAddress(q.owner, owner) && now >= q.createdAt && now - q.createdAt < 120_000;

const bridgeDataAbi = [{ type: "tuple", components: [
  { name: "transactionId", type: "bytes32" }, { name: "bridge", type: "string" },
  { name: "integrator", type: "string" }, { name: "referrer", type: "address" },
  { name: "sendingAssetId", type: "address" }, { name: "receiver", type: "address" },
  { name: "minAmount", type: "uint256" }, { name: "destinationChainId", type: "uint256" },
  { name: "hasSourceSwaps", type: "bool" }, { name: "hasDestinationCall", type: "bool" },
] }] as const;

// HISTORICAL METADATA CHECK ONLY. This does not validate bridge-specific selectors,
// source-swap calldata or refund parameters. Never feed its output to a custody
// signer. The old wallet send entry point is hard-disabled below.
export function validateBridgeQuote(raw: unknown, owner: Address, amount: bigint): BridgeQuote {
  const q = raw as BridgeQuote;
  try {
    if (Number(q.action.fromChainId) !== 143 || Number(q.action.toChainId) !== 1 ||
      BigInt(q.action.fromAmount) !== amount ||
      !sameAddress(q.action.fromAddress, owner) ||
      !sameAddress(q.action.toAddress, GIVETH_PROJECT_RECIPIENT) ||
      !sameAddress(q.action.fromToken.address, MONAD_USDC) ||
      !sameAddress(q.action.toToken.address, ETHEREUM_USDC) ||
      !sameAddress(q.estimate.approvalAddress, LIFI_DIAMOND) ||
      !sameAddress(q.transactionRequest.to, LIFI_DIAMOND) ||
      Number(q.transactionRequest.chainId) !== 143 || BigInt(q.transactionRequest.value) !== 0n ||
      BigInt(q.estimate.toAmountMin) <= 0n || !/^0x[0-9a-f]+$/i.test(q.transactionRequest.data)) throw new Error();
    // LI.FI standard bridge functions carry BridgeData as their first argument.
    // Verify the actual payload, not only the API's display metadata.
    const [data] = decodeAbiParameters(bridgeDataAbi, `0x${q.transactionRequest.data.slice(10)}`);
    if (!sameAddress(data.sendingAssetId, MONAD_USDC) ||
      !sameAddress(data.receiver, GIVETH_PROJECT_RECIPIENT) || data.destinationChainId !== 1n ||
      data.minAmount <= 0n || data.minAmount > amount || data.hasDestinationCall) throw new Error();
    return q;
  } catch {
    throw new Error("Bridge validation failed: amount, addresses or transaction data do not match.");
  }
}

export async function getBridgeQuote(owner: Address, amount: bigint): Promise<BridgeQuote> {
  const params = new URLSearchParams({
    fromChain: "143", toChain: "1", fromToken: MONAD_USDC, toToken: ETHEREUM_USDC,
    fromAmount: amount.toString(), fromAddress: owner, toAddress: GIVETH_PROJECT_RECIPIENT,
    slippage: "0.01", integrator: "chogcare",
  });
  const r = await fetch(`https://li.quest/v1/quote?${params}`, { signal: AbortSignal.timeout(20_000) });
  const raw = await r.json();
  if (!r.ok) throw new Error(raw.code === 1002
    ? "No bridge route is available for this amount. Your funds remain in your wallet."
    : "The quote service is temporarily unavailable. Try again later.");
  return validateBridgeQuote(raw, owner, amount);
}

export async function makeQuote(client: PublicClient, owner: Address, mode: "chog" | "usdc", input: string): Promise<DonationQuote> {
  const decimals = mode === "chog" ? 18 : 6;
  if (!new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(input)) throw new Error("Enter a valid amount.");
  const amountIn = parseUnits(input, decimals);
  if (amountIn <= 0n || (mode === "chog" && amountIn < MIN_CHOG_AMOUNT)) throw new Error("The minimum amount is 300 CHOG.");
  let base: Omit<DonationQuote, "minUsdc" | "bridgeTool"> = {
    owner, mode, amountIn, bridgeAmount: amountIn, createdAt: Date.now(),
  };
  const balance = await client.readContract({ address: mode === "chog" ? CHOG : MONAD_USDC, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
  if (balance < amountIn) throw new Error(`Insufficient ${mode === "chog" ? "CHOG" : "USDC"} in your wallet.`);
  if (mode === "chog") {
    const [router, expectedMon] = await client.readContract({ address: NAD_LENS, abi: lensAbi, functionName: "getAmountOut", args: [CHOG, amountIn, false] });
    if (![NAD_DEX_ROUTER, NAD_CURVE_ROUTER].some(a => sameAddress(a, router))) throw new Error("Unknown Nad.fun router.");
    const minMon = expectedMon * 99n / 100n;
    const swapMonAmount = minMon - GAS_RESERVE;
    if (swapMonAmount <= 0n) throw new Error("The amount is too small for the swap and gas reserve.");
    const pools = await Promise.all(UNISWAP_FEES.map(async fee => {
      try {
        const { result } = await client.simulateContract({ address: UNISWAP_QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: WMON, tokenOut: MONAD_USDC, amountIn: swapMonAmount, fee, sqrtPriceLimitX96: 0n }] });
        return { fee, out: result[0] };
      } catch { return { fee, out: 0n }; }
    }));
    const best = pools.reduce((a, b) => a.out > b.out ? a : b);
    if (best.out === 0n) throw new Error("No liquidity is available for MON → USDC.");
    base = { ...base, router, minMon, swapMonAmount, uniFee: best.fee, bridgeAmount: best.out * 99n / 100n };
  }
  if (base.bridgeAmount < MIN_BRIDGE_USDC) throw new Error("The swap yields less than 0.20 USDC. Increase the amount or wait for another route.");
  const bridge = await getBridgeQuote(owner, base.bridgeAmount);
  return { ...base, minUsdc: BigInt(bridge.estimate.toAmountMin), bridgeTool: bridge.tool };
}

function approve(token: Address, spender: Address, amount: bigint): Call {
  return { to: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }) };
}

export function buildCalls(q: DonationQuote, bridge: BridgeQuote): Call[] {
  validateBridgeQuote(bridge, q.owner, q.bridgeAmount);
  if (BigInt(bridge.estimate.toAmountMin) < q.minUsdc) throw new Error("The recipient would receive less than agreed. Get a new quote.");
  const calls: Call[] = [];
  if (q.mode === "chog") {
    if (q.amountIn < MIN_CHOG_AMOUNT || !q.router || !q.minMon || !q.swapMonAmount || q.uniFee === undefined ||
      ![NAD_DEX_ROUTER, NAD_CURVE_ROUTER].some(a => sameAddress(a, q.router!))) throw new Error("Invalid CHOG route.");
    calls.push(approve(CHOG, q.router, q.amountIn));
    calls.push({ to: q.router, value: 0n, data: encodeFunctionData({ abi: sellAbi, functionName: "sell", args: [{ amountIn: q.amountIn, amountOutMin: q.minMon, token: CHOG, to: q.owner, deadline: BigInt(Math.floor(Date.now() / 1000) + 300) }] }) });
    calls.push({ to: UNISWAP_ROUTER, value: q.swapMonAmount, data: encodeFunctionData({ abi: swapRouterAbi, functionName: "exactInputSingle", args: [{ tokenIn: WMON, tokenOut: MONAD_USDC, fee: q.uniFee, recipient: q.owner, amountIn: q.swapMonAmount, amountOutMinimum: q.bridgeAmount, sqrtPriceLimitX96: 0n }] }) });
    calls.push(approve(CHOG, q.router, 0n));
  }
  calls.push(approve(MONAD_USDC, LIFI_DIAMOND, q.bridgeAmount));
  calls.push({ to: LIFI_DIAMOND, value: 0n, data: bridge.transactionRequest.data });
  calls.push(approve(MONAD_USDC, LIFI_DIAMOND, 0n));
  return calls;
}

export async function requireAtomicWallet(wallet: WalletClient, owner: Address) {
  if (wallet.chain?.id !== 143 || await wallet.getChainId() !== 143) throw new Error("Switch your wallet to Monad.");
  const accounts = await wallet.getAddresses();
  if (!sameAddress(accounts[0], owner)) throw new Error("Your wallet account changed. Get a new quote.");
  try {
    const caps = await wallet.getCapabilities({ account: owner, chainId: 143 });
    if (caps?.atomic?.status === "supported" || caps?.atomic?.status === "ready") return;
  } catch { /* Fail closed: never convert this into sequential transactions. */ }
  throw new Error("Your wallet does not support single-confirmation batches on Monad. A wallet with atomic batch support (EIP-5792) is required.");
}

export async function preflightBatch(client: PublicClient, owner: Address, calls: Call[]) {
  const code = await client.getCode({ address: owner });
  // This deployed MetaMask executor is already selected by the user's smart account.
  // A read-only self-call exercises all steps with real balances and allowances.
  if (code?.toLowerCase() === "0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b") {
    const payload = encodeAbiParameters([{ type: "tuple[]", components: [
      { name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" },
    ] }], [calls.map(call => ({ target: call.to, value: call.value, callData: call.data }))]);
    const data = encodeFunctionData({ abi: parseAbi(["function execute(bytes32 mode, bytes executionCalldata) payable"]), functionName: "execute", args: [`0x01${"00".repeat(31)}`, payload] });
    await client.estimateGas({ account: owner, to: owner, data });
  }
}

export async function sendAtomic(_wallet: WalletClient, _owner: Address, _calls: Call[], _id?: string): Promise<{ id: string }> {
  throw new Error("The legacy wallet route is disabled. Custody settlement requires a separately reviewed transaction policy.");
}

export function errorCode(error: unknown): number | undefined {
  let current = error as { code?: number; cause?: unknown } | undefined;
  for (let i = 0; current && i < 10; i++) {
    if (typeof current.code === "number") return current.code;
    current = current.cause as typeof current;
  }
}

export function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (errorCode(error) === 4001) return "Confirmation was cancelled in your wallet.";
  if (/FAILED_TIMEOUT|Transaction relay error|timed? ?out/i.test(message)) return "Your wallet relay did not confirm the result. Do not resubmit: check the transaction status and your wallet history.";
  if (/insufficient funds/i.test(message)) return "Insufficient funds for the amount and Monad gas.";
  if (/user rejected|denied/i.test(message)) return "Confirmation was cancelled in your wallet.";
  if (/Request Arguments:|Raw Call Arguments:/.test(message)) return "The wallet or network rejected the request. Check the transaction status before retrying.";
  return message.slice(0, 350);
}

export function parseSubmission(text: string | null, owner: Address): Submission | null {
  if (!text) return null;
  const s = JSON.parse(text) as Submission;
  if (!sameAddress(s.owner, owner) || s.chainId !== 143 || !isAddress(s.owner) ||
    !["submitting", "pending", "source-confirmed", "complete", "failed", "unknown"].includes(s.state) ||
    !/^\d+$/.test(s.bridgeAmount) || typeof s.createdAt !== "number") throw new Error("The saved transaction could not be read. Check your wallet history before submitting again.");
  return s;
}

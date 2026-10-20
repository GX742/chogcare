import { relayOrderId } from "./relay-order.mjs";
import { RELAY_SLIPPAGE_TOLERANCE_BPS } from "./relay-quote-policy.mjs";
import { encodeFunctionData, parseAbi, recoverMessageAddress, hexToBytes } from "viem";
import { MONAD_USDC, GIVETH_PROJECT_RECIPIENT } from "../src/route.ts";
import { deliveryNetwork } from "../src/delivery-network.ts";
import { chogBeneficiary } from "../src/chog-beneficiary.ts";

// Pinned independently of quote responses: Relay official /chains and protocol docs.
export const RELAY_DEPOSITORY = "0x4cd00e387622c35bddb9b4c962c136462338bc31";
export const RELAY_SOLVER = "0xf70da97812cb96acdf810712aa562db8dfa3dbef";
const depositAbi = parseAbi(["function depositErc20(address depositor,address token,uint256 amount,bytes32 id)"]);
const same = (a, b) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const uint = x => typeof x === "string" && /^\d{1,78}$/.test(x) && BigInt(x) < 2n ** 256n;
const hash = x => typeof x === "string" && /^0x[0-9a-f]{64}$/i.test(x);
const usdMicros = value => {
  if(typeof value!=="string"||!/^\d{1,12}(\.\d{1,6})?$/.test(value))throw new Error("Invalid quote valuation.");
  const [whole,fraction=""]=value.split(".");return BigInt(whole)*1_000_000n+BigInt(fraction.padEnd(6,"0"));
};

export async function relayJson(path, body) {
  if (!/^\/(quote\/v2|intents\/status\/v3\?requestId=0x[0-9a-f]{64})$/i.test(path)) throw new Error("Unsupported Relay API path.");
  const response = await fetch(`https://api.relay.link${path}`, {
    method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let bytes = 0; const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 262144) throw new Error("Oversized route response.");
    chunks.push(chunk);
  }
  if (!response.ok) throw new Error("Bridge quote unavailable. No funds were sent.");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function validateRelayOrder(quote, payer, amount, minimumOutput, now = Date.now(), destinationChainId = 1, initiativeId = "burundi") {
  const network = deliveryNetwork(destinationChainId);
  const recipient = chogBeneficiary(initiativeId, destinationChainId);
  const sameDestination=(a,b)=>network.kind==="solana"?a===b:same(a,b);
  const p = quote?.protocol?.v2, o = p?.orderData;
  const input = o?.inputs?.[0], output = o?.output, payment = output?.payments?.[0];
  const details=quote?.details, currencyIn=details?.currencyIn, currencyOut=details?.currencyOut;
  if (!p || p.hubType !== "onchain" || o.version !== "v1" || o.solverChainId !== "base" || !same(o.solver, RELAY_SOLVER) ||
      o.inputs?.length !== 1 || input.payment.chainId !== "monad" || !same(input.payment.currency, MONAD_USDC) ||
      !uint(input.payment.amount) || BigInt(input.payment.amount) !== amount || input.payment.weight !== "1" ||
      output?.chainId !== network.relayChain || output.payments?.length !== 1 || output.calls?.length !== 0 || o.fees?.length !== 0 ||
      !sameDestination(payment?.recipient, recipient) || !sameDestination(payment?.currency, network.usdc) ||
      !uint(payment?.minimumAmount) || BigInt(payment.minimumAmount) < minimumOutput || !uint(payment.expectedAmount) ||
      BigInt(payment.minimumAmount) > BigInt(payment.expectedAmount) || (network.kind==="evm" && BigInt(payment.expectedAmount) > amount) ||
      !Number.isSafeInteger(output.deadline) || output.deadline * 1000 < now + 30_000 ||
      !hash(p.orderId) || !hash(quote.requestId) || !same(p.paymentDetails?.depository, RELAY_DEPOSITORY) ||
      p.paymentDetails.chainId !== "monad" || !same(p.paymentDetails.currency, MONAD_USDC) || p.paymentDetails.amount !== String(amount)) throw new Error("Bridge terms failed validation.");
  if (!Array.isArray(input.refunds) || input.refunds.length !== 2 ||
      !input.refunds.some(r => r.chainId === "monad" && same(r.recipient, payer) && same(r.currency, MONAD_USDC)) ||
      !input.refunds.some(r => r.chainId === network.relayChain && sameDestination(r.recipient, recipient) && sameDestination(r.currency, network.usdc))) throw new Error("Unsafe bridge refund destinations.");
  let inputUsd=amount,outputUsd=BigInt(payment.expectedAmount),minimumOutputUsdMicros=BigInt(payment.minimumAmount);
  if(network.kind==="solana"){
    if(details?.recipient!==recipient || currencyIn?.currency?.chainId!==143 || !same(currencyIn?.currency?.address,MONAD_USDC) || currencyIn?.amount!==String(amount) ||
        currencyOut?.currency?.chainId!==destinationChainId || !sameDestination(currencyOut?.currency?.address,network.usdc) || currencyOut?.amount!==payment.expectedAmount || currencyOut?.minimumAmount!==payment.minimumAmount)throw new Error("Quote details do not match the signed order.");
    inputUsd=usdMicros(currencyIn.amountUsd);outputUsd=usdMicros(currencyOut.amountUsd);
    if(inputUsd<amount*95n/100n||inputUsd>amount*105n/100n||outputUsd<=0n)throw new Error("Quote valuation is outside the safety range.");
    minimumOutputUsdMicros=outputUsd*BigInt(payment.minimumAmount)/BigInt(payment.expectedAmount);
  }
  const computed = relayOrderId(o);
  if (!same(computed, p.orderId)) throw new Error("Bridge order hash mismatch.");
  const signer = await recoverMessageAddress({ message: { raw: hexToBytes(computed) }, signature: p.orderSignature });
  if (!same(signer, RELAY_SOLVER)) throw new Error("Bridge order signature mismatch.");
  return {
    requestId: quote.requestId, orderId: computed, amount: String(amount), minOutput: payment.minimumAmount, destinationChainId,
    estimatedSeconds: Number.isFinite(quote.details?.timeEstimate) && quote.details.timeEstimate > 0 && quote.details.timeEstimate <= 3600 ? Math.ceil(quote.details.timeEstimate) : null,
    orderData: structuredClone(o), orderSignature: p.orderSignature,
    expectedOutput: payment.expectedAmount, validUntil: Math.min(now + 60_000, output.deadline * 1000 - 15_000),
    inputUsdMicros:String(inputUsd),expectedOutputUsdMicros:String(outputUsd),minimumOutputUsdMicros:String(minimumOutputUsdMicros),
    // Build calldata ourselves. No provider-supplied executable bytes are forwarded.
    to: RELAY_DEPOSITORY, value: "0",
    data: encodeFunctionData({ abi: depositAbi, functionName: "depositErc20", args: [payer, MONAD_USDC, amount, computed] }),
  };
}

export async function bridgeQuote(payer, amount, minimumOutput = 200_000n, destinationChainId = 1, initiativeId = "burundi") {
  const network = deliveryNetwork(destinationChainId);
  const recipient = chogBeneficiary(initiativeId, destinationChainId);
  const quote = await relayJson("/quote/v2", {
    user: payer, originChainId: 143, destinationChainId, originCurrency: MONAD_USDC,
    destinationCurrency: network.usdc, recipient, refundTo: payer,
    amount: String(amount), tradeType: "EXACT_INPUT", includeProtocolData: true, slippageTolerance: RELAY_SLIPPAGE_TOLERANCE_BPS,
  });
  return validateRelayOrder(quote, payer, amount, minimumOutput, Date.now(), destinationChainId, initiativeId);
}

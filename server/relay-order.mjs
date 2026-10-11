import { hashStruct, isAddress } from "viem";

// Relay v1 wire schema, cross-checked against @relay-protocol/settlement-sdk
// 0.0.144 (MIT, Uneven Labs), dist/order/index.js ORDER_EIP712_TYPES/getOrderId.
// EVM-only: EVM address encoding is its original 20 bytes. We deliberately do
// not ship the SDK's unrelated Solana/Tron parsers and their vulnerable deps.
export const relayOrderTypes = {
  Order: [{ name: "version", type: "string" }, { name: "solverChainId", type: "string" }, { name: "solver", type: "address" }, { name: "salt", type: "uint256" }, { name: "inputs", type: "Input[]" }, { name: "output", type: "Output" }, { name: "fees", type: "Fee[]" }],
  Input: [{ name: "payment", type: "InputPayment" }, { name: "refunds", type: "InputRefund[]" }],
  InputPayment: [{ name: "chainId", type: "string" }, { name: "currency", type: "bytes" }, { name: "amount", type: "uint256" }, { name: "weight", type: "uint256" }],
  InputRefund: [{ name: "chainId", type: "string" }, { name: "recipient", type: "bytes" }, { name: "currency", type: "bytes" }, { name: "minimumAmount", type: "uint256" }, { name: "deadline", type: "uint32" }, { name: "extraData", type: "bytes" }],
  Output: [{ name: "chainId", type: "string" }, { name: "payments", type: "OutputPayment[]" }, { name: "deadline", type: "uint32" }, { name: "calls", type: "bytes[]" }, { name: "extraData", type: "bytes" }],
  OutputPayment: [{ name: "recipient", type: "bytes" }, { name: "currency", type: "bytes" }, { name: "minimumAmount", type: "uint256" }, { name: "expectedAmount", type: "uint256" }],
  Fee: [{ name: "recipientChainId", type: "string" }, { name: "recipient", type: "bytes" }, { name: "currencyChainId", type: "string" }, { name: "currency", type: "bytes" }, { name: "amount", type: "uint256" }],
};

const ALPHABET="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function decodeBase58(value) {
  if(typeof value!=="string"||value.length<32||value.length>44)throw new Error("Invalid Solana protocol address.");
  let n=0n;
  for(const c of value){const i=ALPHABET.indexOf(c);if(i<0)throw new Error("Invalid Solana protocol address.");n=n*58n+BigInt(i);}
  const bytes=[];while(n>0n){bytes.push(Number(n&255n));n>>=8n;}bytes.reverse();
  let zeroes=0;while(zeroes<value.length&&value[zeroes]==="1")zeroes++;
  const decoded=new Uint8Array(zeroes+bytes.length);decoded.set(bytes,zeroes);
  if(decoded.length!==32)throw new Error("Invalid Solana protocol address.");
  return `0x${Buffer.from(decoded).toString("hex")}`;
}
const protocolBytes=(chain,value)=>chain==="solana"?decodeBase58(value):isAddress(value)?value:(()=>{throw new Error("Invalid EVM protocol address.");})();

export function relayOrderId(order) {
  const chains = [order.solverChainId, order.output.chainId, ...order.inputs.flatMap(i => [i.payment.chainId, ...i.refunds.map(r => r.chainId)])];
  if (chains.some(c => !["monad", "ethereum", "optimism", "base", "solana"].includes(c)) || order.fees.length !== 0 || !isAddress(order.solver)) throw new Error("Unsupported protocol order shape.");
  const normalized=structuredClone(order);
  for(const input of normalized.inputs){
    input.payment.currency=protocolBytes(input.payment.chainId,input.payment.currency);
    for(const refund of input.refunds){refund.recipient=protocolBytes(refund.chainId,refund.recipient);refund.currency=protocolBytes(refund.chainId,refund.currency);}
  }
  for(const payment of normalized.output.payments){payment.recipient=protocolBytes(normalized.output.chainId,payment.recipient);payment.currency=protocolBytes(normalized.output.chainId,payment.currency);}
  return hashStruct({ types: relayOrderTypes, primaryType: "Order", data: normalized });
}

// Backward-compatible export used by existing tests and callers.
export const evmRelayOrderId=relayOrderId;

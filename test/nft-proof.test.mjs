import test from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "viem";
import { verifyNftDeposit, isRetryableNftProofError, InvalidNftProofError } from "../server/nft-proof.mjs";
import { PaymentRpcUnavailableError } from "../server/payment-rpc.mjs";

const holder = "0x1111111111111111111111111111111111111111";
const deposit = "0x2222222222222222222222222222222222222222";
const hash = "0x" + "ab".repeat(32);
const blockHash = "0x" + "cd".repeat(32);
const invoice = { kind: "nft-verification", state: "awaiting-payment", id: "invoice-1", holderAddress: holder, depositAddress: deposit, tokenId: "12", createdBlock: 99n, expiresAt: 200_000 };
function client(overrides = {}) {
  return {
    getChainId: async () => 143,
    getTransaction: async () => ({ hash, blockHash, blockNumber: 100n, from: holder, to: deposit, value: parseEther("1"), input: "0x" }),
    getTransactionReceipt: async () => ({ status: "success", transactionHash: hash, blockNumber: 100n, blockHash, from: holder, to: deposit }),
    getBlock: async args => args.blockTag ? { number: 105n } : { number: 100n, hash: blockHash, timestamp: 100n },
    readContract: async () => holder,
    ...overrides,
  };
}
test("NFT proof requires confirmed direct payment plus ownerOf at both snapshots", async () => {
  const proof = await verifyNftDeposit(client(), invoice, hash);
  assert.equal(proof.kind, "confirmed-nft-transfer");
  assert.equal(proof.tokenId, "12");
  assert.equal(proof.collection, "0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763");
  assert.equal(proof.blockNumber, "100");
});
test("rejects preview, wrong network, wrong sender/recipient, wrong amount, calls and old payments", async () => {
  await assert.rejects(verifyNftDeposit(client(), { ...invoice, kind: "preview" }, hash));
  await assert.rejects(verifyNftDeposit(client({ getChainId: async () => 1 }), invoice, hash));
  const tx = await client().getTransaction();
  for (const changed of [{ from: deposit }, { to: holder }, { value: parseEther("0.99") }, { input: "0x1234" }]) {
    await assert.rejects(verifyNftDeposit(client({ getTransaction: async () => ({ ...tx, ...changed }) }), invoice, hash));
  }
  await assert.rejects(verifyNftDeposit(client(), { ...invoice, createdBlock: 100n }, hash));
  await assert.rejects(verifyNftDeposit(client(), { ...invoice, expiresAt: 99_999 }, hash));
});
test("rejects failed, unfinalized, reorganized and no-longer-owned NFT proofs", async () => {
  const receipt = await client().getTransactionReceipt();
  await assert.rejects(verifyNftDeposit(client({ getTransactionReceipt: async () => ({ ...receipt, status: "reverted" }) }), invoice, hash));
  await assert.rejects(verifyNftDeposit(client({ getBlock: async () => ({ number: 99n }) }), invoice, hash));
  await assert.rejects(verifyNftDeposit(client({ getBlock: async () => ({ number: null }) }), invoice, hash));
  await assert.rejects(verifyNftDeposit(client({ getBlock: async args => args.blockTag ? { number: 105n } : { hash: "0x" + "ff".repeat(32), timestamp: 100n } }), invoice, hash));
  await assert.rejects(verifyNftDeposit(client({ readContract: async args => args.blockNumber === 100n ? holder : deposit }), invoice, hash));
});

test("NFT retry classification is explicit, bounded through causes and never retries invalid proofs", async () => {
  const timeout=Object.assign(new Error("network timeout"),{name:"TimeoutError"});
  assert.equal(isRetryableNftProofError(timeout),true);
  const rpcOutage=new PaymentRpcUnavailableError(143);
  assert.equal(isRetryableNftProofError(new Error("wrapped network read",{cause:rpcOutage})),true);
  const invalidDuringOutage=new InvalidNftProofError("invalid proof");invalidDuringOutage.cause=rpcOutage;
  assert.equal(isRetryableNftProofError(invalidDuringOutage),false);
  assert.equal(isRetryableNftProofError(Object.assign(new Error("spoofed error name"),{name:"PaymentRpcUnavailableError"})),false);
  assert.equal(isRetryableNftProofError(new Error("contract call failed",{cause:timeout})),true);
  assert.equal(isRetryableNftProofError(Object.assign(new Error("RPC unavailable"),{code:"ECONNRESET"})),true);
  assert.equal(isRetryableNftProofError(Object.assign(new Error("HTTP limit"),{name:"HttpRequestError",status:429})),true);
  assert.equal(isRetryableNftProofError(Object.assign(new Error("forbidden"),{name:"HttpRequestError",status:403})),false);
  assert.equal(isRetryableNftProofError(new Error("timeout: do not infer retry from untrusted text")),false);
  const invalid=new InvalidNftProofError("wrong amount");invalid.cause=timeout;
  assert.equal(isRetryableNftProofError(invalid),false);
  assert.equal(isRetryableNftProofError(Object.assign(new Error("reverted"),{name:"ContractFunctionRevertedError",cause:timeout})),false);
  const cycle=new Error("cycle");cycle.cause=cycle;
  assert.equal(isRetryableNftProofError(cycle),false);
  const pending=client({getBlock:async args=>args.blockTag?{number:99n}:{number:100n,hash:blockHash,timestamp:100n}});
  await assert.rejects(verifyNftDeposit(pending,invoice,hash),error=>isRetryableNftProofError(error));
});

test("smart-wallet payment requires canonical receipt, successful trace ancestry and NFT ownership",async()=>{
  const relayer="0x3333333333333333333333333333333333333333";
  const tx={...await client().getTransaction(),from:relayer,to:holder,value:0n,input:"0x1234"};
  const transfer={type:"CALL",from:holder,to:deposit,value:"0xde0b6b3a7640000",input:"0x"};
  const root={type:"CALL",from:relayer,to:holder,value:"0x0",input:"0x1234",calls:[transfer]};
  const internal=(trace=root,extra={})=>client({getTransaction:async()=>tx,getTransactionReceipt:async()=>({...await client().getTransactionReceipt(),from:relayer,to:holder}),request:async()=>trace,...extra});
  assert.equal((await verifyNftDeposit(internal(),invoice,hash)).sender,holder);
  for(const trace of [
    {...root,error:"reverted"}, {...root,from:deposit}, {...root,value:"0x1"},
    {...root,calls:[{type:"CALL",error:"reverted",calls:[transfer]}]},
    {...root,calls:[{...transfer,type:"DELEGATECALL"}]},
    {...root,calls:[{...transfer,from:relayer}]},
    {...root,calls:[{...transfer,value:"0x1"}]},
    {...root,calls:[{...transfer,input:"0x1234"}]},
    {...root,calls:[transfer,transfer]},
  ])await assert.rejects(verifyNftDeposit(internal(trace),invoice,hash));
  await assert.rejects(verifyNftDeposit(internal(root,{readContract:async()=>relayer}),invoice,hash));
});

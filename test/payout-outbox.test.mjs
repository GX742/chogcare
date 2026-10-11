import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Wallet, Interface, Transaction } from "ethers";
import { createPayoutOutbox } from "../server/payout-outbox.mjs";
import { createPoolLedger } from "../server/pool-ledger.mjs";
import { PAYMENT_POLICY } from "../server/policy.mjs";
import { ETHEREUM_USDC, GIVETH_PROJECT_RECIPIENT } from "../src/route.ts";
import { createNftProofLedger } from "../server/nft-proof-ledger.mjs";
import { encodeEventTopics, encodeAbiParameters, erc20Abi } from "viem";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const iface = new Interface(["function transfer(address,uint256) returns(bool)"]);
const day = Date.parse("2026-10-08T12:00:00Z");
function fixture(t) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const wallet = Wallet.createRandom();
  const ledger = createPoolLedger(db);
  ledger.creditVerifiedFunding({ chainId: 1, txHash: "0x" + "ab".repeat(32), logIndex: 0, units: 10_000_000 });
  for (const id of ["a", "b"]) ledger.reserve({ invoiceId: id, collection: PAYMENT_POLICY.nftCollection, tokenId: id === "a" ? "1" : "2" }, day);
  const outbox = createPayoutOutbox(db, wallet.address);
  const proofs = createNftProofLedger(db);
  for (const [id, tokenId, prefix] of [["a", "1", "cc"], ["b", "2", "dd"]]) proofs.recordVerifiedProof({
    kind: "confirmed-nft-transfer", invoiceId: id, tokenId, chainId: 143, collection: PAYMENT_POLICY.nftCollection,
    txHash: "0x" + prefix.repeat(32), sender: wallet.address, blockNumber: "100", blockHash: "0x" + "ee".repeat(32),
  }, day);
  const transaction = { type: 2, chainId: 1, nonce: 0, to: ETHEREUM_USDC, value: 0n, gasLimit: 60_000n,
    maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
    data: iface.encodeFunctionData("transfer", [GIVETH_PROJECT_RECIPIENT, 1_000_000n]) };
  return { db, wallet, ledger, outbox, transaction };
}

test("outbox refuses repeat scope when verified sender is not allowlisted",async t=>{
  const {db,wallet,outbox,transaction}=fixture(t);
  db.prepare("UPDATE pool_reservations SET claim_scope='repeat:a' WHERE invoice_id='a'").run();
  db.prepare("UPDATE nft_proofs SET campaign='repeat:a:2026-10-08' WHERE invoice_id='a'").run();
  const signed=await wallet.signTransaction(transaction);
  assert.throws(()=>outbox.persistSignedGrant("a","burundi",signed,day),/allowlisted holder/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pool_outbox").get().n,0);
});

test("even an approved recipient cannot replace the invoice's chosen initiative",async t=>{
  const {db,wallet,outbox,transaction}=fixture(t);
  db.exec("CREATE TABLE nft_invoices(id TEXT PRIMARY KEY,document TEXT NOT NULL)");
  db.prepare("INSERT INTO nft_invoices VALUES(?,?)").run("a",JSON.stringify({initiativeId:"school-supplies"}));
  const raw=await wallet.signTransaction(transaction);
  assert.throws(()=>outbox.persistSignedGrant("a","burundi",raw,day),/does not match/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pool_outbox").get().n,0);
  assert.equal(db.prepare("SELECT state FROM pool_reservations WHERE invoice_id='a'").get().state,"reserved");
});

test("outbox persists before send, retries only identical bytes and refuses replacement after timeout", async t => {
  const { db, wallet, outbox, transaction } = fixture(t);
  const serialized = await wallet.signTransaction(transaction);
  const hash = outbox.persistSignedGrant("a", "burundi", serialized, day);
  assert.equal(outbox.persistSignedGrant("a", "burundi", serialized, day), hash);
  let attempts = 0;
  const rpc = { getChainId: async () => 1, sendRawTransaction: async ({ serializedTransaction }) => {
    assert.equal(serializedTransaction, serialized); attempts++;
    if (attempts === 1) throw new Error("Timeout after upstream accepted transaction");
    return hash;
  } };
  await assert.rejects(outbox.broadcast(rpc, "a"), /unknown/);
  assert.equal(outbox.status("a").state, "unknown");
  const different = await wallet.signTransaction({ ...transaction, nonce: 1 });
  assert.throws(() => outbox.persistSignedGrant("a", "burundi", different, day), /cannot be replaced/);
  const restarted = createPayoutOutbox(db, wallet.address);
  assert.equal(await restarted.broadcast(rpc, "a"), hash);
  assert.equal(restarted.status("a").state, "submitted");
  assert.ok(!JSON.stringify(restarted.status("a")).includes(serialized));
});

test("outbox checks integrity after an awaited chain read, so a concurrently latched hold cannot broadcast", async t => {
  const { wallet, outbox, transaction } = fixture(t);
  const raw=await wallet.signTransaction(transaction);
  const hash=outbox.persistSignedGrant("a","burundi",raw,day);
  let resolveChain,locked=false,checks=0,sent=0;
  const chain=new Promise(resolve=>{resolveChain=resolve;});
  const rpc={getChainId:()=>chain,sendRawTransaction:async()=>{sent++;return hash;}};
  const checkpoint=()=>{checks++;if(locked)throw new Error("Integrity hold latched during RPC");};
  const pending=outbox.broadcast(rpc,"a",checkpoint);
  assert.equal(checks,0,"the last guard must be after the awaited RPC");
  locked=true;resolveChain(1);
  await assert.rejects(pending,/Integrity hold/);
  assert.equal(checks,1);assert.equal(sent,0);
  assert.equal(outbox.status("a").state,"persisted","never label an unsent transaction as unknown");
  await assert.rejects(outbox.broadcast(rpc,"a",checkpoint),/Integrity hold/);
  assert.equal(sent,0);assert.equal(outbox.status("a").hash,hash);
});

test("outbox rejects wrong chain, sender, token, value, data, fee cap and unsupported recipients", async t => {
  const { wallet, outbox, transaction } = fixture(t);
  const foreignWallet = Wallet.createRandom();
  for (const change of [
    { chainId: 143 }, { type: 1 }, { to: foreignWallet.address }, { value: 1n },
    { data: iface.encodeFunctionData("transfer", [foreignWallet.address, 1_000_000n]) },
    { data: iface.encodeFunctionData("transfer", [GIVETH_PROJECT_RECIPIENT, 500_001n]) },
    { data: transaction.data + "00" }, { gasLimit: 150_001n }, { maxFeePerGas: 100_000_000_000n },
  ]) {
    // Unsupported serialization is also an acceptable pre-signing rejection.
    let raw;
    try { raw = await wallet.signTransaction({ ...transaction, ...change }); } catch { continue; }
    assert.throws(() => outbox.persistSignedGrant("a", "burundi", raw, day));
  }
  assert.throws(() => outbox.persistSignedGrant("a", "burundi", Transaction.from(transaction).unsignedSerialized, day));
  assert.throws(() => outbox.persistSignedGrant("a", "gainforest", "0x00", day));
  assert.throws(() => outbox.persistSignedGrant("a", "burundi", "0x00", day));
  const foreignSigned = await foreignWallet.signTransaction(transaction);
  assert.throws(() => outbox.persistSignedGrant("a", "burundi", foreignSigned, day));
});

test("nonce conflict rolls back ledger submission atomically; no unreserved payout is possible", async t => {
  const { db, wallet, outbox, transaction } = fixture(t);
  const signedA = await wallet.signTransaction(transaction);
  outbox.persistSignedGrant("a", "burundi", signedA, day);
  const sameNonceDifferentHash = await wallet.signTransaction({ ...transaction, maxPriorityFeePerGas: 2_000_000_000n });
  assert.throws(() => outbox.persistSignedGrant("b", "burundi", sameNonceDifferentHash, day));
  assert.equal(db.prepare("SELECT state FROM pool_reservations WHERE invoice_id='b'").get().state, "reserved");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pool_payout_days").get().n, 1);
  const nextNonce = await wallet.signTransaction({ ...transaction, nonce: 1 });
  assert.throws(() => outbox.persistSignedGrant("missing", "burundi", nextNonce, day), /payout reservation/);
  outbox.persistSignedGrant("b", "burundi", nextNonce, day);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pool_payout_days").get().n, 2);
  await assert.rejects(outbox.broadcast({ getChainId: async () => 143 }, "a"), /Wrong payout network/);
});

test("reservation without a matching verified NFT/day proof cannot produce a payout", async t => {
  const { db, wallet, outbox, transaction } = fixture(t);
  db.prepare("DELETE FROM nft_proofs WHERE invoice_id='a'").run();
  const signed = await wallet.signTransaction(transaction);
  assert.throws(() => outbox.persistSignedGrant("a", "burundi", signed, day), /verified NFT proof/);
  db.prepare("UPDATE nft_proofs SET campaign='daily:2026-10-07' WHERE invoice_id='b'").run();
  assert.throws(() => outbox.persistSignedGrant("b", "burundi", signed, day), /verified NFT proof/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pool_payout_days").get().n, 0);
});

test("only finalized exact onchain delivery atomically marks both outbox and grant paid", async t => {
  const { db, wallet, outbox, transaction } = fixture(t);
  const signed = await wallet.signTransaction(transaction);
  const hash = outbox.persistSignedGrant("a", "burundi", signed, day);
  const blockHash = "0x" + "ee".repeat(32);
  const receipt = { status: "success", transactionHash: hash, blockNumber: 100n, blockHash, logs: [{
    address: ETHEREUM_USDC, blockHash, blockNumber: 100n, transactionHash: hash, logIndex: 0, removed: false,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: wallet.address, to: GIVETH_PROJECT_RECIPIENT } }),
    data: encodeAbiParameters([{ type: "uint256" }], [1_000_000n]),
  }] };
  let finalized = 99n;
  const rpc = { getChainId: async () => 1, getTransactionReceipt: async () => receipt,
    getBlock: async args => args.blockTag ? { number: finalized } : { number: 100n, hash: blockHash, timestamp: 1000n } };
  await assert.rejects(outbox.confirm(rpc, "a", 0));
  assert.equal(outbox.status("a").state, "persisted");
  assert.equal(db.prepare("SELECT state FROM pool_reservations WHERE invoice_id='a'").get().state, "submitted");
  finalized = 101n;
  assert.equal(await outbox.confirm(rpc, "a", 0), hash);
  assert.equal(await outbox.confirm(rpc, "a", 0), hash);
  assert.equal(outbox.status("a").state, "delivered");
  assert.equal(db.prepare("SELECT state FROM pool_reservations WHERE invoice_id='a'").get().state, "paid");
  assert.equal(await outbox.broadcast({}, "a"), hash); // No network call after delivery.
});

test("signed payout survives a real SQLite close/reopen and cannot become a second payment", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chogcare-outbox-test-"));
  const filename = join(directory, "outbox.sqlite");
  let db = new DatabaseSync(filename);
  try {
    const wallet = Wallet.createRandom();
    let outbox = createPayoutOutbox(db, wallet.address);
    const ledger = createPoolLedger(db);
    ledger.creditVerifiedFunding({ chainId: 1, txHash: "0x" + "aa".repeat(32), logIndex: 0, units: 1_000_000 });
    ledger.reserve({ invoiceId: "disk-test", collection: PAYMENT_POLICY.nftCollection, tokenId: "9" }, day);
    createNftProofLedger(db).recordVerifiedProof({ kind: "confirmed-nft-transfer", invoiceId: "disk-test", chainId: 143, collection: PAYMENT_POLICY.nftCollection, tokenId: "9", sender: wallet.address, txHash: "0x" + "bb".repeat(32), blockNumber: "100", blockHash: "0x" + "cc".repeat(32) }, day);
    const raw = await wallet.signTransaction({ type: 2, chainId: 1, nonce: 5, to: ETHEREUM_USDC, value: 0n, gasLimit: 60_000n, maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, data: iface.encodeFunctionData("transfer", [GIVETH_PROJECT_RECIPIENT, 1_000_000n]) });
    const hash = outbox.persistSignedGrant("disk-test", "burundi", raw, day);
    db.close(); db = new DatabaseSync(filename);
    outbox = createPayoutOutbox(db, wallet.address);
    assert.equal(outbox.status("disk-test").hash, hash);
    assert.equal(outbox.persistSignedGrant("disk-test", "burundi", raw, day + 86_400_000), hash);
    assert.equal(createPoolLedger(db).summary(day).fundedAvailableUnits, 0);
    let sent = 0;
    assert.equal(await outbox.broadcast({ getChainId: async () => 1, sendRawTransaction: async ({ serializedTransaction }) => { sent++; assert.equal(serializedTransaction, raw); return hash; } }, "disk-test"), hash);
    assert.equal(sent, 1);
  } finally {
    db.close();
    // Only these explicitly named test files under our newly created temp dir.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(filename + suffix, { force: true });
    rmdirSync(directory);
  }
});

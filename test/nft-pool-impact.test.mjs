import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Wallet, Transaction } from "ethers";
import { encodeFunctionData, erc20Abi } from "viem";
import { deliveryNetwork } from "../src/delivery-network.ts";
import { chogBeneficiary } from "../src/chog-beneficiary.ts";
import { readNftPoolImpact } from "../server/nft-pool-impact.mjs";

const recipient = chogBeneficiary("burundi",10);
const foreign = "0x2222222222222222222222222222222222222222";
const usdc = deliveryNetwork(10).usdc;

function fixture(t) {
  const db = new DatabaseSync(":memory:"), wallet = Wallet.createRandom();
  t.after(() => { if (db.isOpen) db.close(); });
  db.exec(`CREATE TABLE pool_network(singleton INTEGER PRIMARY KEY,chain_id INTEGER);
    CREATE TABLE nft_pool_meta(singleton INTEGER PRIMARY KEY,treasury TEXT,chain_id INTEGER);
    CREATE TABLE pool_reservations(invoice_id TEXT PRIMARY KEY,units INTEGER,state TEXT,payout_hash TEXT);
    CREATE TABLE pool_outbox(invoice_id TEXT PRIMARY KEY,treasury TEXT,nonce INTEGER,recipient TEXT,signed_tx TEXT,tx_hash TEXT,state TEXT);
    CREATE TABLE nft_invoices(id TEXT PRIMARY KEY,state TEXT,document TEXT);
    CREATE TABLE pool_funding(event_id TEXT,units INTEGER);
    CREATE TABLE pool_contributions(invoice_id TEXT,units TEXT);
    CREATE TABLE nft_proofs(invoice_id TEXT,document TEXT);`);
  db.prepare("INSERT INTO pool_network VALUES(1,10)").run();
  db.prepare("INSERT INTO nft_pool_meta VALUES(1,?,10)").run(wallet.address);
  let sequence = 0;
  async function add({ units = 1_000_000, outboxState = "delivered", reservationState = "paid", invoiceState = "delivered", legacy = false, txChanges = {}, rowChanges = {}, documentChanges = {}, raw } = {}) {
    const nonce = sequence++, id = `fixture-${nonce}`;
    const serialized = raw ?? await wallet.signTransaction({ to: usdc, value: 0n, chainId: 10, type: 2, nonce,
      gasLimit: 60_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 100_000n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, BigInt(units)] }), ...txChanges });
    const transaction = Transaction.from(serialized);
    const hash = rowChanges.hash ?? transaction.hash;
    const document = { id, state: invoiceState, initiativeId: "burundi", destinationHash: hash,
      // Verification MON amounts are irrelevant to the delivered USDC amount.
      paymentUri: legacy ? "verification-only:0.1-MON" : "verification-only:1-MON",
      ...(legacy ? {} : { subsidyUnits: units }), ...documentChanges };
    db.prepare("INSERT INTO pool_outbox VALUES(?,?,?,?,?,?,?)").run(id, rowChanges.treasury ?? wallet.address,
      rowChanges.nonce ?? transaction.nonce, rowChanges.recipient ?? recipient, serialized, hash, outboxState);
    db.prepare("INSERT INTO pool_reservations VALUES(?,?,?,?)").run(id, units, reservationState, rowChanges.payoutHash ?? hash);
    db.prepare("INSERT INTO nft_invoices VALUES(?,?,?)").run(id, invoiceState, JSON.stringify(document));
    return { id, serialized, hash, document };
  }
  return { db, wallet, add, summary: () => readNftPoolImpact(db, wallet.address) };
}

test("NFT pool total includes only final outgoing grants, not funding, reservations, proof payments or unknown sends", async t => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO pool_funding VALUES('fixture-funding',10000000)").run();
  f.db.prepare("INSERT INTO pool_contributions VALUES('fixture-contribution','9000000')").run();
  f.db.prepare("INSERT INTO nft_proofs VALUES('fixture-proof','verification MON is not a donation')").run();
  await f.add({ outboxState: "persisted", reservationState: "submitted", invoiceState: "paying" });
  await f.add({ outboxState: "submitted", reservationState: "submitted", invoiceState: "confirming" });
  await f.add({ outboxState: "unknown", reservationState: "submitted", invoiceState: "manual-review" });
  assert.deepEqual(f.summary(), { donatedUsdc: "0", donations: 0 });
  await f.add();
  assert.deepEqual(f.summary(), { donatedUsdc: "1000000", donations: 1 });
});

test("historical signed USDC6 units remain exact and the public result contains only anonymous aggregates", async t => {
  const f = fixture(t);
  await f.add({ units: 100_001, legacy: true });
  await f.add({ units: 500_000, legacy: true });
  await f.add({ units: 1_000_000 });
  const result = f.summary();
  assert.deepEqual(result, { donatedUsdc: "1600001", donations: 3 });
  assert.deepEqual(Object.keys(result).sort(), ["donatedUsdc", "donations"]);
  assert.doesNotMatch(JSON.stringify(result), /0x|fixture-|invoice|address|signed|hash/i);
});

test("final outbox/reservation markers survive the invoice-save crash gap and reads make no database changes", async t => {
  const f = fixture(t);
  await f.add({ invoiceState: "confirming" });
  const before = f.db.prepare("SELECT total_changes() AS n").get().n;
  f.db.exec("PRAGMA query_only=ON");
  assert.deepEqual(f.summary(), { donatedUsdc: "1000000", donations: 1 });
  assert.deepEqual(f.summary(), { donatedUsdc: "1000000", donations: 1 });
  assert.equal(f.db.prepare("SELECT total_changes() AS n").get().n, before);
});

test("unknown/closed sources are unavailable while a known empty source is zero", t => {
  const f = fixture(t);
  assert.deepEqual(f.summary(), { donatedUsdc: "0", donations: 0 });
  assert.equal(readNftPoolImpact(f.db, foreign), null);
  f.db.prepare("UPDATE pool_network SET chain_id=1").run();
  assert.equal(f.summary(), null);
  f.db.close();
  assert.equal(f.summary(), null);
  const missing = new DatabaseSync(":memory:");
  try { assert.equal(readNftPoolImpact(missing, f.wallet.address), null); } finally { missing.close(); }
});

for (const [outboxState, reservationState] of [["delivered", "submitted"], ["submitted", "paid"], ["unknown", "paid"]]) {
  test(`torn final markers ${outboxState}/${reservationState} never produce a partial total`, async t => {
    const f = fixture(t); await f.add({ outboxState, reservationState });
    assert.equal(f.summary(), null);
  });
}

for (const table of ["pool_outbox", "pool_reservations", "nft_invoices"]) {
  test(`a final record missing ${table} is unavailable, not an invented zero`, async t => {
    const f = fixture(t); await f.add(); f.db.exec(`DELETE FROM ${table}`);
    assert.equal(f.summary(), null);
  });
}

for (const invalid of [0, -1, 0.5, 1_000_000_000_001, "not-units"]) {
  test(`invalid historical grant units ${invalid} cannot enter the total`, async t => {
    const f = fixture(t); await f.add();
    f.db.prepare("UPDATE pool_reservations SET units=?").run(invalid);
    assert.equal(f.summary(), null);
  });
}

for (const [label, options] of [
  ["foreign asset", { txChanges: { to: foreign } }],
  ["foreign chain", { txChanges: { chainId: 1 } }],
  ["native value", { txChanges: { value: 1n } }],
  ["wrong signed amount", { txChanges: { data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, 500_000n] }) } }],
  ["wrong signed recipient", { txChanges: { data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [foreign, 1_000_000n] }) } }],
  ["treasury mismatch", { rowChanges: { treasury: foreign } }],
  ["nonce mismatch", { rowChanges: { nonce: 90 } }],
  ["recipient mismatch", { rowChanges: { recipient: foreign } }],
  ["hash mismatch", { rowChanges: { hash: "0x" + "ab".repeat(32) } }],
  ["reservation hash mismatch", { rowChanges: { payoutHash: "0x" + "ab".repeat(32) } }],
  ["invoice amount mismatch", { documentChanges: { subsidyUnits: 500_000 } }],
  ["invoice destination mismatch", { documentChanges: { destinationHash: "0x" + "ab".repeat(32) } }],
  ["unsupported invoice cause", { documentChanges: { initiativeId: "unapproved-cause" } }],
  ["changed invoice cause", { documentChanges: { initiativeId: "school-supplies" } }],
]) {
  test(`${label} fails closed instead of overstating pool impact`, async t => {
    const f = fixture(t); await f.add(options); assert.equal(f.summary(), null);
  });
}

test("a case-variant duplicated transaction is never counted twice", async t => {
  const f = fixture(t), first = await f.add();
  await f.add({ raw: first.serialized, rowChanges: { hash: "0x" + first.hash.slice(2).toUpperCase() } });
  assert.equal(f.summary(), null);
});

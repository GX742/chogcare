import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createPoolLedger } from "../server/pool-ledger.mjs";
import { PAYMENT_POLICY } from "../server/policy.mjs";
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const collection = PAYMENT_POLICY.nftCollection;
const day = Date.parse("2026-10-08T12:00:00Z");
const funding = { chainId: 1, txHash: "0x" + "ab".repeat(32), logIndex: 0, units: 20_000_000 };
const grant = i => ({ invoiceId: `invoice-${i}`, collection, tokenId: String(i) });
test("daily cap is $10 including pending grants; the 21st simultaneous invoice cannot reserve", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const ledger = createPoolLedger(db);
    assert.equal(ledger.summary(day).availableClaims, 0);
    assert.throws(() => ledger.reserve(grant(1), day), /funding/);
    ledger.creditVerifiedFunding(funding);
    ledger.creditVerifiedFunding(funding); // duplicate receipt is not another deposit
    assert.equal(ledger.summary(day).fundedAvailableUnits, 20_000_000);
    const attempts = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => Promise.resolve().then(() => ledger.reserve(grant(i), day))));
    assert.equal(attempts.filter(item => item.status === "fulfilled").length, 20);
    assert.equal(ledger.summary(day).reservedTodayUnits, 10_000_000);
    assert.equal(ledger.summary(day).availableClaims, 0);
    // Another owner/leading zero representation cannot obtain a second grant for NFT 1.
    assert.throws(() => ledger.reserve({ ...grant(1), invoiceId: "new-owner", tokenId: "01" }, day));
    assert.equal(ledger.reserve(grant(1), day + 86_400_000).day, "2026-10-08");
    assert.equal(ledger.summary(day + 86_400_000).availableClaims, 20);
    ledger.reserve({ ...grant(1), invoiceId: "tomorrow" }, day + 86_400_000);
    assert.equal(ledger.summary(day + 86_400_000).availableClaims, 19);
  } finally { db.close(); }
});
test("midnight resets the cap, not funding, and does not release uncertain payouts", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const ledger = createPoolLedger(db);
    ledger.creditVerifiedFunding({ ...funding, units: 500_000 });
    ledger.reserve(grant(1), day);
    const hash = "0x" + "cd".repeat(32);
    ledger.recordSubmission("invoice-1", hash);
    ledger.recordSubmission("invoice-1", hash);
    assert.equal(ledger.summary(day + 86_400_000).availableClaims, 0);
    assert.throws(() => ledger.recordSubmission("invoice-1", "0x" + "ef".repeat(32)), /unresolved/);
    assert.throws(() => ledger.markPaid("invoice-1", "0x" + "ef".repeat(32)), /match/);
    ledger.markPaid("invoice-1", hash);
    ledger.markPaid("invoice-1", hash);
    assert.equal(ledger.summary(day).fundedAvailableUnits, 0);
    assert.throws(() => ledger.creditVerifiedFunding({ ...funding, units: 1_000_000 }), /conflict/);
  } finally { db.close(); }
});

test("independent concurrent workers cannot exceed the shared SQLite daily cap", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chogcare-pool-test-"));
  const filename = join(directory, "pool.sqlite");
  const db = new DatabaseSync(filename);
  const ledger = createPoolLedger(db);
  ledger.creditVerifiedFunding(funding);
  const workers = [];
  try {
    const attempts = Array.from({ length: 3 }, (_, workerIndex) => new Promise((resolve, reject) => {
      const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        const { DatabaseSync } = require('node:sqlite');
        (async () => {
          const { createPoolLedger } = await import(workerData.moduleUrl);
          const db = new DatabaseSync(workerData.filename);
          const ledger = createPoolLedger(db);
          let success = 0;
          try {
            for (let i = 0; i < 15; i++) {
              const tokenId = String(workerData.workerIndex * 100 + i);
              try { ledger.reserve({ invoiceId: 'worker-' + tokenId, tokenId, collection: workerData.collection }, workerData.day); success++; }
              catch (error) { if (!error.message.includes('daily pool limit')) throw error; }
            }
            parentPort.postMessage(success);
          } finally { db.close(); }
        })().catch(error => { throw error; });
      `, { eval: true, workerData: { filename, workerIndex, collection, day, moduleUrl: new URL("../server/pool-ledger.mjs", import.meta.url).href } });
      workers.push(worker);
      worker.once("message", resolve); worker.once("error", reject);
    }));
    const counts = await Promise.all(attempts);
    assert.equal(counts.reduce((sum, value) => sum + value, 0), 20);
    assert.equal(ledger.summary(day).reservedTodayUnits, 10_000_000);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    db.close();
    // Only files created by this test inside its fresh temporary directory.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(filename + suffix, { force: true });
    rmdirSync(directory);
  }
});

test("a delayed payout backlog cannot bypass today's $10 submission cap", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const ledger = createPoolLedger(db);
    ledger.creditVerifiedFunding(funding);
    for (let i = 0; i < 30; i++) ledger.reserve(grant(i), day + (i >= 20 ? 86_400_000 : 0));
    for (let i = 0; i < 20; i++) ledger.recordSubmission(`invoice-${i}`, "0x" + BigInt(i + 1).toString(16).padStart(64, "0"), day + 86_400_000);
    assert.throws(() => ledger.recordSubmission("invoice-20", "0x" + "aa".repeat(32), day + 86_400_000), /submission limit/);
    ledger.recordSubmission("invoice-20", "0x" + "aa".repeat(32), day + 2 * 86_400_000);
  } finally { db.close(); }
});

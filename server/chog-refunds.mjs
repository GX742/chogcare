import { Transaction } from "ethers";
import { erc20Abi, formatUnits, keccak256 } from "viem";
import { CHOG } from "../src/route.ts";
import { atomic } from "./sqlite-transaction.mjs";
import { finalizedReceipt, AwaitingFinalityError, NonCanonicalReceiptError } from "./chain-receipts.mjs";
import { prepareMonadTransaction } from "./monad-preflight.mjs";
import { observeSourceSubmission } from "./source-submission.mjs";
import { assertSourceNonceAvailable } from "./source-journal.mjs";
import { verifyWrongAmountDeposit, buildWrongAmountRefundCall, validateWrongAmountRefundRaw, verifyWrongAmountRefundReceipt, WrongAmountRefundEligibilityError } from "./chog-wrong-amount.mjs";

const NATIVE_CAP = 50_000_000_000_000_000n, DAILY_NATIVE_CAP = 1_000_000_000_000_000_000n;
const MAX_FEE = 500_000_000_000n, MAX_GAS = 150_000n;
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const validId = value => typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
const serialize = value => JSON.stringify(value);
const unused = ["depositHash", "depositProof", "receivedUnits", "receivedAmount", "receivedDonationAmount", "receivedPoolContributionAmount", "sale", "swap", "monToSwap", "usdcToBridge", "poolContributionUsdc", "bridge", "bridgeHash", "destinationHash", "observedDestinationHash", "deliveredUsdc", "observedUsdc", "processingStartedAt", "bridgeStartedAt", "destinationIncludedAt", "refund", "refundProof"];
class RefundBindingError extends Error { constructor() { super("Refund eligibility changed; operator review is required."); this.name = "RefundBindingError"; } }
const fail = () => { throw new RefundBindingError(); };

// This module is reachable only from the serialized local source worker. A
// browser can neither select a refund recipient nor enqueue or replace a send.
export function createChogRefunds({ db, source, root, vault, journal, checkpoint, now = Date.now }) {
  if (root.neuter().extendedKey !== vault.xpub || !validId(vault.keyId)) fail();
  db.exec(`CREATE TABLE IF NOT EXISTS chog_refunds (
    invoice_id TEXT PRIMARY KEY, deposit_hash TEXT NOT NULL, log_index INTEGER NOT NULL,
    proof TEXT NOT NULL, operator TEXT NOT NULL, invoice_snapshot TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('processing','confirming','completed','blocked')),
    gas_value TEXT, receipt TEXT, created_at INTEGER NOT NULL,
    UNIQUE(deposit_hash,log_index)
  );
  CREATE TRIGGER IF NOT EXISTS chog_refunds_immutable BEFORE UPDATE ON chog_refunds
  WHEN NEW.invoice_id IS NOT OLD.invoice_id OR NEW.deposit_hash IS NOT OLD.deposit_hash OR NEW.log_index IS NOT OLD.log_index
    OR NEW.proof IS NOT OLD.proof OR NEW.operator IS NOT OLD.operator OR NEW.invoice_snapshot IS NOT OLD.invoice_snapshot OR NEW.created_at IS NOT OLD.created_at
    OR (OLD.gas_value IS NOT NULL AND NEW.gas_value IS NOT OLD.gas_value)
    OR (OLD.receipt IS NOT NULL AND NEW.receipt IS NOT OLD.receipt)
    OR (OLD.status IN ('completed','blocked') AND NEW.status IS NOT OLD.status)
  BEGIN SELECT RAISE(ABORT,'Refund replacement prohibited.'); END;
  CREATE TRIGGER IF NOT EXISTS chog_refunds_no_delete BEFORE DELETE ON chog_refunds
  BEGIN SELECT RAISE(ABORT,'Refund deletion prohibited.'); END;`);
  const checkpointErrors = new WeakSet();
  const durable = () => { try { checkpoint(); } catch (error) { if (error && typeof error === "object") checkpointErrors.add(error); throw error; } };
  const get = id => validId(id) ? db.prepare("SELECT * FROM chog_refunds WHERE invoice_id=?").get(id) : null;
  const tableExists = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const proofOf = row => {
    try { const proof = JSON.parse(row.proof); if (proof.invoiceId !== row.invoice_id || !same(proof.txHash, row.deposit_hash) || proof.logIndex !== row.log_index || !same(row.operator, root.address)) fail(); return proof; }
    catch { fail(); }
  };
  const manualBinding = (id, proof) => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'manual_chog_refunds*'").all();
    for (const { name } of tables) {
      if (name.match(/^manual_chog_refunds(?:_[a-z0-9_]+)?$/)?.[0] !== name) fail();
      const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map(column => column.name);
      if (!["invoice_id", "deposit_hash", "log_index"].every(column => columns.includes(column))) fail();
      if (db.prepare(`SELECT 1 FROM "${name}" WHERE invoice_id=? OR (lower(deposit_hash)=? AND log_index=?) LIMIT 1`).get(id, proof?.txHash?.toLowerCase() ?? "", proof?.logIndex ?? -1)) fail();
    }
  };
  const binding = (invoice, row, proof) => {
    if (!invoice || !validId(invoice.id) || invoice.state !== "manual-review" || unused.some(key => invoice[key] != null)) fail();
    const stored = db.prepare("SELECT state,document FROM chog_invoices WHERE id=?").get(invoice.id);
    if (!stored || stored.state !== "manual-review" || stored.document !== serialize(invoice) || row && stored.document !== row.invoice_snapshot) fail();
    const branch = db.prepare("SELECT * FROM custody_branch WHERE singleton=1").get();
    const allocation = db.prepare("SELECT * FROM deposit_addresses WHERE invoice_id=?").get(invoice.id);
    if (!Number.isSafeInteger(invoice.index) || invoice.index < 0 || invoice.index >= 2 ** 31 ||
      !branch || branch.key_id !== vault.keyId || !Number.isSafeInteger(branch.next_index) || branch.next_index <= invoice.index ||
      !allocation || allocation.derivation_index !== invoice.index || allocation.key_id !== vault.keyId || !same(allocation.address, invoice.depositAddress) ||
      !same(root.deriveChild(invoice.index).address, invoice.depositAddress)) fail();
    if (proof && (!same(proof.depositAddress, invoice.depositAddress) || proof.invoiceId !== invoice.id || proof.quotedUnits !== invoice.units)) fail();
    const sends = db.prepare("SELECT phase FROM source_sends WHERE invoice_id=?").all(invoice.id);
    if (sends.some(send => !row || !["refund-gas", "refund-chog"].includes(send.phase))) fail();
    for (const table of ["pool_contributions", "delivered_events"]) if (tableExists(table) && db.prepare(`SELECT 1 FROM ${table} WHERE invoice_id=? LIMIT 1`).get(invoice.id)) fail();
    manualBinding(invoice.id, proof);
    return stored.document;
  };
  const knownAmountHold = invoice => typeof invoice?.message === "string" && (
    invoice.message === "Deposit amount or time differs from the invoice. Do not pay again." ||
    /^Received \d+(?:\.\d{1,18})? CHOG\. (?:This invoice requires|The processing limit is) \d+(?:\.\d{1,18})? CHOG\. Processing is on hold; do not pay again\.$/.exec(invoice.message)?.[0] === invoice.message);
  const canStart = invoice => { try { if (get(invoice?.id) || !knownAmountHold(invoice)) return false; binding(invoice); return true; } catch { return false; } };
  const publicStatus = id => {
    const row = get(id); if (!row) return null;
    const proof = proofOf(row), raw = journal.get(id, "refund-chog");
    return { kind: "chog-amount-mismatch", status: row.status, amount: formatUnits(BigInt(proof.amountUnits), 18), txHash: raw?.hash ?? null };
  };
  const setStatus = (id, status, receipt = null) => {
    const old = get(id);
    if (!old || old.status === status && (!receipt || old.receipt === serialize(receipt))) return;
    durable();
    atomic(db, () => db.prepare("UPDATE chog_refunds SET status=?,receipt=coalesce(receipt,?) WHERE invoice_id=?").run(status, receipt ? serialize(receipt) : null, id));
    durable();
  };
  const checkedGas = (raw, proof, row) => {
    let tx; try { tx = Transaction.from(raw.raw); } catch { fail(); }
    if (!tx.isSigned() || tx.type !== 2 || tx.chainId !== 143n || !same(tx.from, row.operator) || !same(tx.to, proof.depositAddress) || tx.data !== "0x" ||
      tx.accessList?.length || tx.gasLimit < 21_000n || tx.gasLimit > MAX_GAS || tx.maxFeePerGas <= 0n || tx.maxFeePerGas > MAX_FEE ||
      tx.maxPriorityFeePerGas < 0n || tx.maxPriorityFeePerGas > tx.maxFeePerGas || tx.value <= 0n || row.gas_value !== String(tx.value) ||
      tx.value + tx.gasLimit * tx.maxFeePerGas > NATIVE_CAP || !same(tx.hash, raw.hash) || !same(keccak256(raw.raw), raw.hash) || raw.nonce !== tx.nonce || !same(raw.sender, tx.from)) fail();
    return tx;
  };
  const checkedRefund = (raw, proof) => {
    const checked = validateWrongAmountRefundRaw(raw.raw, proof);
    if (!same(checked.hash, raw.hash) || checked.nonce !== raw.nonce || !same(checked.sender, raw.sender)) fail();
    return checked;
  };
  const untouchedTokens = async (invoice, row, proof) => {
    const [latest, finalized, nonce, pending] = await Promise.all([
      source.readContract({ address: CHOG, abi: erc20Abi, functionName: "balanceOf", args: [proof.depositAddress], blockTag: "latest" }),
      source.readContract({ address: CHOG, abi: erc20Abi, functionName: "balanceOf", args: [proof.depositAddress], blockTag: "finalized" }),
      source.getTransactionCount({ address: proof.depositAddress, blockTag: "latest" }),
      source.getTransactionCount({ address: proof.depositAddress, blockTag: "pending" }),
    ]);
    binding(invoice, row, proof);
    if (latest !== BigInt(proof.amountUnits) || finalized !== latest || nonce !== 0 || pending !== 0) fail();
  };
  const fundingBudget = (value, fees) => {
    if (fees.gasLimit > MAX_GAS || value <= 0n || value + fees.gasLimit * fees.maxFeePerGas > NATIVE_CAP) fail();
    const day = new Date(now()).toISOString().slice(0, 10);
    if (db.prepare("SELECT count(*) AS n FROM source_sends WHERE phase IN ('gas','pool-gas','refund-gas') AND day=?").get(day).n >= 20) throw new Error("Daily gas funding is temporarily unavailable.");
    let spent = 0n;
    for (const previous of db.prepare("SELECT raw FROM source_sends WHERE phase='refund-gas' AND day=?").all(day)) {
      const tx = Transaction.from(previous.raw); spent += tx.value + tx.gasLimit * tx.maxFeePerGas;
    }
    if (spent + value + fees.gasLimit * fees.maxFeePerGas > DAILY_NATIVE_CAP) throw new Error("Refund gas budget is temporarily unavailable.");
  };
  const persist = (invoice, row, proof, phase, raw, signer, nonce) => {
    binding(invoice, row, proof); durable();
    const saved = atomic(db, () => { binding(invoice, row, proof); return journal.persist(invoice.id, phase, signer, nonce, raw, now()); });
    durable(); return saved;
  };
  const rejectFinalRevert = async (receipt, raw) => {
    if (receipt.status === "success") return;
    if (receipt.status !== "reverted" || !same(receipt.transactionHash, raw.hash) || typeof receipt.blockNumber !== "bigint") fail();
    const [chain, block, final] = await Promise.all([source.getChainId(), source.getBlock({ blockNumber: receipt.blockNumber }), source.getBlock({ blockTag: "finalized" })]);
    if (chain !== 143) fail();
    if (block.number !== receipt.blockNumber || !same(block.hash, receipt.blockHash)) throw new NonCanonicalReceiptError();
    if (typeof final.number !== "bigint" || receipt.blockNumber > final.number) throw new AwaitingFinalityError();
    fail();
  };
  const observe = async (invoice, row, proof, raw) => {
    const authorize = () => {
      binding(invoice, row, proof);
      try { assertSourceNonceAvailable(db, raw.sender, raw.nonce, raw.hash); } catch { fail(); }
      durable();
    };
    authorize();
    return observeSourceSubmission(source, raw, { checkpoint: authorize, waitMs: 0 });
  };
  const finishRefund = async (invoice, row, proof, raw) => {
    checkedRefund(raw, proof);
    const receipt = await observe(invoice, row, proof, raw);
    if (!receipt) return;
    await rejectFinalRevert(receipt, raw);
    binding(invoice, row, proof);
    setStatus(invoice.id, "confirming");
    const verified = await verifyWrongAmountRefundReceipt(source, proof, raw.raw, receipt);
    binding(invoice, row, proof);
    setStatus(invoice.id, "completed", verified);
  };
  let busy = false;
  const run = async (invoice, startNew) => {
    if (busy) return publicStatus(invoice?.id); busy = true;
    let row = get(invoice?.id);
    try {
      if (!row) {
        if (!startNew || !canStart(invoice)) return null;
        const proof = await verifyWrongAmountDeposit(source, invoice);
        const snapshot = binding(invoice, null, proof);
        durable();
        atomic(db, () => { binding(invoice, null, proof); db.prepare("INSERT INTO chog_refunds(invoice_id,deposit_hash,log_index,proof,operator,invoice_snapshot,status,created_at) VALUES(?,?,?,?,?,?,'processing',?)").run(invoice.id, proof.txHash.toLowerCase(), proof.logIndex, serialize(proof), root.address.toLowerCase(), snapshot, now()); });
        durable(); row = get(invoice.id);
      }
      if (["blocked", "completed"].includes(row.status)) return publicStatus(invoice.id);
      binding(invoice, row, proofOf(row));
      const proof = await verifyWrongAmountDeposit(source, invoice, proofOf(row));
      binding(invoice, row, proof);
      let refund = journal.get(invoice.id, "refund-chog");
      if (refund) { await finishRefund(invoice, row, proof, refund); return publicStatus(invoice.id); }
      await untouchedTokens(invoice, row, proof);
      let gas = journal.get(invoice.id, "refund-gas");
      const call = buildWrongAmountRefundCall(proof), wallet = root.deriveChild(invoice.index);
      if (!gas) {
        const [price, balance] = await Promise.all([source.getGasPrice(), source.getBalance({ address: wallet.address })]);
        binding(invoice, row, proof);
        if (typeof price !== "bigint" || price <= 0n || typeof balance !== "bigint" || balance < 0n) fail();
        // Some RPCs refuse to simulate an unfunded sender. Fund only this small
        // maximum refund budget, then require the real simulation before signing
        // CHOG. An estimate failure never authorizes a larger grant or a retry.
        const gasLimit = MAX_GAS, maxFeePerGas = price * 2n;
        if (maxFeePerGas > MAX_FEE || gasLimit * maxFeePerGas > NATIVE_CAP) throw new Error("Refund gas estimate is temporarily unavailable.");
        const needed = gasLimit * maxFeePerGas > balance ? gasLimit * maxFeePerGas - balance : 0n;
        if (needed > 0n) {
          const value = row.gas_value === null ? needed : BigInt(row.gas_value);
          if (value < needed) return publicStatus(invoice.id); // Never issue a second or replacement grant.
          const fundingCall = { to: wallet.address, value, data: "0x" }, fees = await prepareMonadTransaction(source, root.address, fundingCall);
          if (!fees) return publicStatus(invoice.id);
          binding(invoice, row, proof); fundingBudget(value, fees);
          if (row.gas_value === null) {
            durable(); atomic(db, () => { binding(invoice, row, proof); db.prepare("UPDATE chog_refunds SET gas_value=? WHERE invoice_id=? AND gas_value IS NULL").run(String(value), invoice.id); }); durable(); row = get(invoice.id);
          }
          await untouchedTokens(invoice, row, proof);
          if (await source.getBalance({ address: wallet.address }) !== balance) return publicStatus(invoice.id);
          binding(invoice, row, proof); assertSourceNonceAvailable(db, root.address, fees.nonce); durable();
          const raw = await root.signTransaction({ ...fundingCall, ...fees, chainId: 143, type: 2 });
          await untouchedTokens(invoice, row, proof);
          if (await source.getBalance({ address: wallet.address }) !== balance) return publicStatus(invoice.id);
          binding(invoice, row, proof); fundingBudget(value, fees); checkedGas({ raw, hash: keccak256(raw), nonce: fees.nonce, sender: root.address }, proof, row);
          gas = persist(invoice, row, proof, "refund-gas", raw, root.address, fees.nonce);
        }
      }
      if (gas) {
        checkedGas(gas, proof, row);
        const receipt = await observe(invoice, row, proof, gas);
        if (!receipt) return publicStatus(invoice.id);
        await rejectFinalRevert(receipt, gas);
        await finalizedReceipt(source, 143, gas.hash, receipt);
        binding(invoice, row, proof);
      }
      await untouchedTokens(invoice, row, proof);
      const fees = await prepareMonadTransaction(source, wallet.address, call);
      if (!fees) return publicStatus(invoice.id);
      if (fees.nonce !== 0 || fees.gasLimit > MAX_GAS || fees.gasLimit * fees.maxFeePerGas > NATIVE_CAP) fail();
      binding(invoice, row, proof); assertSourceNonceAvailable(db, wallet.address, fees.nonce); durable();
      const raw = await wallet.signTransaction({ ...call, ...fees, type: 2, chainId: 143 });
      await untouchedTokens(invoice, row, proof);
      binding(invoice, row, proof); validateWrongAmountRefundRaw(raw, proof);
      refund = persist(invoice, row, proof, "refund-chog", raw, wallet.address, fees.nonce);
      await finishRefund(invoice, row, proof, refund);
    } catch (error) {
      if (error && (checkpointErrors.has(error) || error.name === "PaymentIntegrityError")) throw error;
      if (row && (error instanceof RefundBindingError || error instanceof WrongAmountRefundEligibilityError)) setStatus(invoice.id, "blocked");
      // Transport/finality failures retain the immutable job/outbox for the next
      // tick. No raw error text or private proof is projected to the browser.
    } finally { busy = false; }
    return publicStatus(invoice?.id);
  };
  return { has: id => !!get(id), canStart, publicStatus, start: invoice => run(invoice, true), resume: invoice => run(invoice, false) };
}

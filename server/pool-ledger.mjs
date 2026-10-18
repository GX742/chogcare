import { DAILY_POOL_UNITS, SUBSIDY_UNITS, PAYMENT_POLICY } from "./policy.mjs";
import { isAddress, zeroAddress } from "viem";
import { atomic as transaction } from "./sqlite-transaction.mjs";
import { migratePoolRepeatScope } from "./pool-repeat-migration.mjs";
import { migratePoolGrantPolicy } from "./pool-grant-migration.mjs";
import { canRepeatNftGrant, nftGrantScope } from "./nft-repeat-policy.mjs";

const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const dayKey = now => {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid reservation time.");
  return new Date(now).toISOString().slice(0, 10);
};

// Internal accounting. Not an admin HTTP API and not proof of onchain funding.
// The future worker must validate funding receipts before passing them here.
export function createPoolLedger(db, chainId = 1) {
  if (![1, 10].includes(chainId)) throw new Error("Unsupported pool network.");
  const poolChainId = chainId;
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS pool_network (singleton INTEGER PRIMARY KEY CHECK(singleton=1), chain_id INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS pool_funding (
      event_id TEXT PRIMARY KEY,
      units INTEGER NOT NULL CHECK(units > 0)
    );
    CREATE TABLE IF NOT EXISTS pool_reservations (
      invoice_id TEXT PRIMARY KEY,
      collection TEXT NOT NULL,
      token_id TEXT NOT NULL,
      day TEXT NOT NULL,
      units INTEGER NOT NULL CHECK(units IN (500000,1000000)),
      state TEXT NOT NULL CHECK(state IN ('reserved', 'submitted', 'paid')),
      payout_hash TEXT UNIQUE,
      claim_scope TEXT NOT NULL DEFAULT 'daily',
      holder_address TEXT,
      UNIQUE(collection, token_id, day, claim_scope)
    );
    CREATE TABLE IF NOT EXISTS pool_payout_days (
      invoice_id TEXT PRIMARY KEY REFERENCES pool_reservations(invoice_id),
      day TEXT NOT NULL,
      units INTEGER NOT NULL CHECK(units IN (500000,1000000))
    );`);
  migratePoolRepeatScope(db);
  migratePoolGrantPolicy(db);
  transaction(db, () => {
    const bound = db.prepare("SELECT chain_id FROM pool_network WHERE singleton=1").get();
    if (bound && bound.chain_id !== chainId) throw new Error("Pool network cannot be changed in place.");
    if (!bound) {
      if (chainId !== 1 && db.prepare("SELECT COUNT(*) AS n FROM pool_reservations").get().n) throw new Error("Legacy pool requires reconciliation before migration.");
      if (db.prepare("SELECT COUNT(*) AS n FROM pool_funding WHERE event_id NOT LIKE ?").get(`${chainId}:%`).n) throw new Error("Funding belongs to another network.");
      db.prepare("INSERT INTO pool_network VALUES (1, ?)").run(chainId);
    }
  });
  const atomic = callback => transaction(db, callback);
  const balance = () => {
    const funded = db.prepare("SELECT COALESCE(SUM(units),0) AS units FROM pool_funding").get().units;
    const allocated = db.prepare("SELECT COALESCE(SUM(units),0) AS units FROM pool_reservations").get().units;
    return funded - allocated;
  };
  return {
    // A verified Ethereum USDC treasury funding event is credited once, not once per restart.
    creditVerifiedFunding({ chainId, txHash, logIndex, units }) {
      if (chainId !== poolChainId || !hashPattern.test(txHash) || !Number.isSafeInteger(logIndex) || logIndex < 0 || !Number.isSafeInteger(units) || units <= 0 || units > 1_000_000_000_000) throw new Error("Invalid verified USDC funding event.");
      const event = `${chainId}:${txHash.toLowerCase()}:${logIndex}`;
      return atomic(() => {
        const old = db.prepare("SELECT units FROM pool_funding WHERE event_id=?").get(event);
        if (old && old.units !== units) throw new Error("Funding event amount conflict.");
        if (!old) db.prepare("INSERT INTO pool_funding VALUES (?, ?)").run(event, units);
        return balance();
      });
    },
    reserve({ invoiceId, collection, tokenId, holderAddress }, now = Date.now()) {
      const day = dayKey(now);
      if (typeof invoiceId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(invoiceId)) throw new Error("Invalid invoice ID.");
      if (!isAddress(collection) || collection.toLowerCase() === zeroAddress || collection.toLowerCase() !== PAYMENT_POLICY.nftCollection) throw new Error("Unsupported collection.");
      if (!/^\d{1,78}$/.test(tokenId) || BigInt(tokenId) >= 2n ** 256n) throw new Error("Invalid NFT token ID.");
      const normalized = String(BigInt(tokenId));
      if(holderAddress!==undefined&&(!isAddress(holderAddress)||holderAddress.toLowerCase()===zeroAddress))throw new Error("Invalid NFT holder.");
      const holder=holderAddress?.toLowerCase()??null;
      const repeat = canRepeatNftGrant(holder);
      const scope = nftGrantScope(holder,invoiceId);
      return atomic(() => {
        const old = db.prepare("SELECT * FROM pool_reservations WHERE invoice_id=?").get(invoiceId);
        if (old) {
          if (old.collection !== collection.toLowerCase() || old.token_id !== normalized || holder&&old.holder_address&&old.holder_address!==holder) throw new Error("Invoice reservation conflict.");
          return old; // Retry, including after midnight, never reserves another grant.
        }
        const used = db.prepare("SELECT COALESCE(SUM(units),0) AS units,COUNT(*) AS claims FROM pool_reservations WHERE day=?").get(day);
        if (used.units + SUBSIDY_UNITS > DAILY_POOL_UNITS || used.claims>=PAYMENT_POLICY.maxDailyClaims) throw new Error("The $3 daily pool limit has been reached.");
        if (balance() < SUBSIDY_UNITS) throw new Error("Pool funding is insufficient. Do not request a verification payment.");
        if(!repeat&&holder&&db.prepare("SELECT 1 FROM pool_reservations WHERE holder_address=? AND day=?").get(holder,day))throw new Error("This wallet already has a daily grant.");
        // Collection + canonical token ID + UTC day stays used after a transfer,
        // including exceptional reservations, for every non-allowlisted holder.
        if(!repeat&&db.prepare("SELECT 1 FROM pool_reservations WHERE collection=? AND token_id=? AND day=?").get(collection.toLowerCase(),normalized,day))throw new Error("This NFT already has a daily grant.");
        db.prepare("INSERT INTO pool_reservations (invoice_id,collection,token_id,day,units,state,payout_hash,claim_scope,holder_address) VALUES (?, ?, ?, ?, ?, 'reserved', NULL, ?, ?)").run(invoiceId, collection.toLowerCase(), normalized, day, SUBSIDY_UNITS,scope,holder);
        return db.prepare("SELECT * FROM pool_reservations WHERE invoice_id=?").get(invoiceId);
      });
    },
    recordSubmission(invoiceId, signedTransactionHash, now = Date.now()) {
      const submissionDay = dayKey(now);
      if (!hashPattern.test(signedTransactionHash)) throw new Error("Invalid payout hash.");
      return atomic(() => {
        const row = db.prepare("SELECT * FROM pool_reservations WHERE invoice_id=?").get(invoiceId);
        if (!row) throw new Error("Missing pool reservation.");
        if (row.payout_hash && row.payout_hash !== signedTransactionHash.toLowerCase()) throw new Error("An unresolved payout cannot be replaced.");
        if (row.payout_hash) return;
        // A delayed backlog must not bypass today's send budget. This limits send
        // authorizations; chain inclusion can still fall on a later UTC day.
        const used = db.prepare("SELECT COALESCE(SUM(units),0) AS units,COUNT(*) AS claims FROM pool_payout_days WHERE day=?").get(submissionDay);
        if (used.units + row.units > DAILY_POOL_UNITS || used.claims>=PAYMENT_POLICY.maxDailyClaims) throw new Error("The $3 daily payout submission limit has been reached.");
        db.prepare("INSERT INTO pool_payout_days VALUES (?, ?, ?)").run(invoiceId, submissionDay, row.units);
        db.prepare("UPDATE pool_reservations SET state='submitted', payout_hash=? WHERE invoice_id=?").run(signedTransactionHash.toLowerCase(), invoiceId);
      });
    },
    markPaid(invoiceId, verifiedPayoutHash) {
      // Caller must verify exact Ethereum USDC transfer to the allowlisted beneficiary.
      if (!hashPattern.test(verifiedPayoutHash)) throw new Error("Invalid verified payout hash.");
      const result = db.prepare("UPDATE pool_reservations SET state='paid' WHERE invoice_id=? AND state IN ('submitted','paid') AND payout_hash=?").run(invoiceId, verifiedPayoutHash.toLowerCase());
      if (!result.changes) throw new Error("Payout does not match the reserved submission.");
    },
    summary(now = Date.now()) {
      const day = dayKey(now);
      const used = db.prepare("SELECT COALESCE(SUM(units),0) AS units,COUNT(*) AS claims FROM pool_reservations WHERE day=?").get(day);
      const available = balance();
      return { dailyLimitUnits: DAILY_POOL_UNITS, reservedTodayUnits: used.units, fundedAvailableUnits: available, availableClaims: Math.max(0, Math.min(PAYMENT_POLICY.maxDailyClaims-used.claims,Math.floor(Math.min(DAILY_POOL_UNITS-used.units,available)/SUBSIDY_UNITS))) };
    },
  };
}

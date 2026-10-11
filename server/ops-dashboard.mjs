import { DatabaseSync } from "node:sqlite";
import { formatUnits, parseUnits } from "viem";
import { verifiedLeaderboardDonation } from "./donor-leaderboard.mjs";
import { PAYMENT_POLICY } from "./policy.mjs";

const boundedCount = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
const amountPattern = /^(?:0|[1-9]\d{0,30})(?:\.\d{1,18})?$/;

// No HTTP path, custody key or writable financial connection is accepted here.
export function openReadOnlyImpactSource(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try { db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000"); } catch (error) { db.close(); throw error; }
  let closed = false;
  return {
    summary() {
      if (closed) throw new Error("Impact source is closed.");
      let amount = 0n, donations = 0;
      db.exec("BEGIN");
      try {
        for (const row of db.prepare("SELECT i.id,i.document FROM delivered_events e JOIN chog_invoices i ON i.id=e.invoice_id WHERE i.state='delivered'").iterate()) {
          const document = JSON.parse(row.document), verified = verifiedLeaderboardDonation(document, row.id);
          if (!verified || verified.state !== "delivered") throw new Error("Finalized impact record failed verification.");
          amount += parseUnits(verified.amount, 18); donations++;
        }
        db.exec("COMMIT"); return { chogDonated: formatUnits(amount, 18), donations };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}

export function createReadOnlyDashboard({ status = () => null, impact = () => null, clock = Date.now } = {}) {
  let impactCache = null, impactCheckedAt = -Infinity;
  return {
    snapshot() {
      const checkedAt = clock();
      let current = null; try { current = status(); } catch { /* Unavailable is not healthy. */ }
      const locked = current?.integrityLocked === true;
      const offline = !current || current.paymentMode === "offline";
      const paymentState = offline ? "offline" : current.paymentsEnabled === true && current.integrityLocked === false ? "ready" : "paused";
      const nftState = offline ? "offline" : current.nftPaymentsEnabled === true && current.integrityLocked === false ? "ready" : "paused";
      let totals = null;
      if (!offline && current.integrityLocked === false) {
        if (checkedAt - impactCheckedAt >= 5000 || checkedAt < impactCheckedAt) {
          impactCache = null; impactCheckedAt = checkedAt;
          try {
            const value = impact();
            if (value && typeof value.chogDonated === "string" && value.chogDonated.match(amountPattern)?.[0] === value.chogDonated && Number.isSafeInteger(value.donations) && value.donations >= 0 && value.donations <= 1_000_000) impactCache = { chogDonated: value.chogDonated, donations: value.donations };
          } catch { /* Never substitute a fabricated zero for unreadable state. */ }
        }
        totals = impactCache ? { ...impactCache } : null;
      } else { impactCache = null; impactCheckedAt = -Infinity; }
      return {
        checkedAt,
        payments: {
          state: paymentState, nftState,
          availableClaims: locked || offline ? null : boundedCount(current?.availableClaims, PAYMENT_POLICY.maxDailyClaims),
          maxDailyClaims: PAYMENT_POLICY.maxDailyClaims, subsidyUsdc: PAYMENT_POLICY.subsidyUsdc,
          dailyPoolLimitUsdc: PAYMENT_POLICY.dailyPoolLimitUsdc,
          ...(typeof current?.integrityLocked === "boolean" ? { integrityLocked: current.integrityLocked } : {}),
        },
        impact: totals, station: { state: "unknown" }, broadcast: { state: "unknown" },
      };
    },
  };
}

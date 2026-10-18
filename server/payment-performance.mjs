const STAGES = new Set([
  "chog-tick", "chog-tracking", "nft-tick", "source-preflight", "source-confirmation",
  "nft-discovery", "nft-proof", "nft-funding", "nft-payout",
]);
const WINDOW = 128;

// Bounded, RAM-only diagnostics. No invoice/address/hash, RPC payload, caught
// error, secret or signed bytes can enter a snapshot. Not a public HTTP API.
export function createPaymentPerformance(clock = () => performance.now()) {
  const stages = new Map();
  return {
    async measure(stage, action) {
      if (!STAGES.has(stage)) throw new Error("Unknown payment performance stage.");
      let row = stages.get(stage);
      if (!row) { row = { count: 0, failed: 0, inFlight: 0, samples: [] }; stages.set(stage, row); }
      row.inFlight++;
      const started = clock();
      try { return await action(); }
      catch (error) { row.failed++; throw error; }
      finally {
        row.inFlight--; row.count++;
        const duration = clock() - started;
        if (Number.isFinite(duration) && duration >= 0) {
          row.samples.push(Math.round(duration * 100) / 100);
          if (row.samples.length > WINDOW) row.samples.shift();
        }
      }
    },
    snapshot() {
      return Object.fromEntries([...stages].map(([stage, row]) => {
        const sorted = [...row.samples].sort((a, b) => a - b);
        const percentile = p => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
        return [stage, { count: row.count, failed: row.failed, inFlight: row.inFlight, sampleCount: sorted.length,
          lastMs: row.samples.at(-1) ?? null, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted.at(-1) ?? null }];
      }));
    },
  };
}

// In-process test chain only. No live RPC, custody wallet or deployment credentials.
export default {
  networks: { hardhatMainnet: { type: "edr-simulated", chainType: "l1" } },
};

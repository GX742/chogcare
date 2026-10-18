// Read-only preparation. Callers must validate their pinned calldata BEFORE this
// function and again before signing. Nothing here signs or broadcasts a payment.
export async function prepareMonadTransaction(client, account, call) {
  const [latest, pending, price, estimated, balance] = await Promise.all([
    client.getTransactionCount({ address: account, blockTag: "latest" }),
    client.getTransactionCount({ address: account, blockTag: "pending" }),
    client.getGasPrice(),
    client.estimateGas({ account, ...call }),
    client.getBalance({ address: account }),
  ]);
  if (!Number.isSafeInteger(latest) || latest < 0 || !Number.isSafeInteger(pending) || pending < 0) throw new Error("Invalid source nonce.");
  if (latest !== pending) return null; // Never replace an outstanding submission.
  if (typeof price !== "bigint" || price <= 0n || price * 2n > 500_000_000_000n) throw new Error("Source gas price exceeds local policy.");
  if (typeof estimated !== "bigint" || estimated < 21_000n) throw new Error("Invalid source gas estimate.");
  // Monad charges the gas LIMIT. A simulated plain 21k transfer needs no 25%
  // padding. Contract/delegated calls retain the existing conservative margin.
  const gasLimit = call.data === "0x" && estimated === 21_000n ? estimated : (estimated * 125n + 99n) / 100n;
  if (gasLimit > 1_500_000n) throw new Error("Gas estimate exceeds local pilot limit.");
  const maxFeePerGas = price * 2n;
  if (typeof call.value !== "bigint" || call.value < 0n || typeof balance !== "bigint" || balance < call.value + gasLimit * maxFeePerGas) throw new Error("Operator gas funds are insufficient.");
  return { nonce: latest, gasLimit, maxFeePerGas, maxPriorityFeePerGas: price / 10n };
}

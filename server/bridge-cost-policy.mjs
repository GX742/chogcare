// Applies to NEW invoices only. This bounds bridge loss in USDC, not the
// CHOG market price, sale slippage, network gas or recipient conversion fees.
export function minimumBridgeDelivery(inputUnits) {
  if (typeof inputUnits !== "bigint" || inputUnits <= 0n) throw new Error("Invalid bridge input.");
  const floor = (inputUnits * 9600n + 9999n) / 10000n;
  return floor > 200_000n ? floor : 200_000n;
}
export function assertBridgeDelivery(quote, requiredUnits) {
  if (typeof requiredUnits !== "bigint" || requiredUnits <= 0n ||
      typeof quote?.minOutput !== "string" || !/^\d{1,78}$/.test(quote.minOutput) ||
      BigInt(quote.minOutput) < requiredUnits) {
    throw Object.assign(new Error("Bridge cost exceeds the donation limit. No payment QR was issued."), {code:"BRIDGE_COST_LIMIT"});
  }
}
export function assertCrossAssetBridgeDelivery(quote, requiredUsdMicros) {
  if (typeof requiredUsdMicros !== "bigint" || requiredUsdMicros <= 0n ||
      typeof quote?.minimumOutputUsdMicros !== "string" || !/^\d{1,78}$/.test(quote.minimumOutputUsdMicros) ||
      BigInt(quote.minimumOutputUsdMicros) < requiredUsdMicros) {
    throw Object.assign(new Error("Bridge cost exceeds the donation limit. No payment QR was issued."), {code:"BRIDGE_COST_LIMIT"});
  }
}

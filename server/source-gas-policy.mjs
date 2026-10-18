import {Transaction} from "ethers";

export const LEGACY_SOURCE_GAS_GRANT=5_000_000_000_000_000_000n;
export const SOURCE_GAS_GRANT=1_500_000_000_000_000_000n;
export const OPERATOR_READY_BALANCE=1_750_000_000_000_000_000n;
export const SOURCE_MAX_FEE=500_000_000_000n;
// Total child limits: 2,600,000 gas * 500 gwei = 1.30 MON. The
// 1.50 MON grant covers that entire worst case, not just today's estimate.
export const SOURCE_PHASE_GAS_LIMITS=Object.freeze({
  gas:250_000n,"approve-chog":250_000n,sell:750_000n,swap:600_000n,
  "pool-contribution":200_000n,"approve-usdc":200_000n,bridge:600_000n,
});
export function sourceGasGrant(invoice){
  if(invoice?.sourceGasPlanVersion===undefined&&invoice?.gasGrantUnits===undefined)return LEGACY_SOURCE_GAS_GRANT;
  if(invoice?.sourceGasPlanVersion!==2||invoice.gasGrantUnits!==String(SOURCE_GAS_GRANT))throw new Error("Unknown source gas plan. Preserve the invoice.");
  return SOURCE_GAS_GRANT;
}
export function validateSourceGas(phase,call,invoice){
  sourceGasGrant(invoice);
  if(invoice.sourceGasPlanVersion!==2||call.gasLimit===undefined)return;
  const cap=SOURCE_PHASE_GAS_LIMITS[phase];
  if(!cap||typeof call.gasLimit!=="bigint"||call.gasLimit<21_000n||call.gasLimit>cap||typeof call.maxFeePerGas!=="bigint"||call.maxFeePerGas<=0n||call.maxFeePerGas>SOURCE_MAX_FEE)throw new Error("Source gas estimate exceeds the funded invoice budget.");
}
export function sourceGasCharge(row,receipt){
  const tx=Transaction.from(row.raw),price=receipt.effectiveGasPrice;
  if(typeof price!=="bigint"||price<=0n||price>tx.maxFeePerGas)throw new Error("Source gas charge could not be verified.");
  // Monad charges gas LIMIT. gasUsed may describe executed work instead.
  return tx.gasLimit*price;
}

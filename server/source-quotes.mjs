import { CHOG, NAD_LENS, NAD_DEX_ROUTER, NAD_CURVE_ROUTER, WMON, MONAD_USDC, UNISWAP_QUOTER, UNISWAP_FEES, lensAbi, quoterAbi } from "../src/route.ts";
const same = (a,b) => a.toLowerCase() === b.toLowerCase();
export async function saleQuote(client, amount) {
  // A donor can designate up to 1,000,000 CHOG for the cause. New invoices add
  // the disclosed 10% NFT-pool contribution on top; legacy 300 CHOG invoices
  // remain quotable and recoverable.
  if (amount < 300n * 10n**18n || amount > 1_100_000n * 10n**18n) throw new Error("Local pilot accepts up to 1,100,000 CHOG total per payment.");
  const [router, out] = await client.readContract({ address: NAD_LENS, abi: lensAbi, functionName: "getAmountOut", args: [CHOG, amount, false] });
  if (![NAD_DEX_ROUTER, NAD_CURVE_ROUTER].some(a=>same(a,router)) || out <= 0n) throw new Error("Unsupported CHOG liquidity route.");
  return { router, minMon: String(out * 99n / 100n) };
}
export async function usdcQuote(client, amount) {
  if (amount <= 0n) throw new Error("No MON sale proceeds.");
  const options = await Promise.all(UNISWAP_FEES.map(async fee => {
    try {
      const { result } = await client.simulateContract({ address: UNISWAP_QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: WMON, tokenOut: MONAD_USDC, amountIn: amount, fee, sqrtPriceLimitX96: 0n }] });
      return { fee, amount: result[0] };
    } catch { return { fee, amount: 0n }; }
  }));
  const best = options.reduce((a,b)=>a.amount>b.amount?a:b);
  if (best.amount <= 0n) throw new Error("MON/USDC liquidity unavailable.");
  return { fee: best.fee, minUsdc: String(best.amount * 99n / 100n) };
}

import { createPublicClient, http, parseUnits, formatUnits } from "viem";
import { monad, optimism } from "viem/chains";
import { NEW_DONATION_CHAIN_ID } from "../src/delivery-network.ts";
import { saleQuote, usdcQuote } from "../server/source-quotes.mjs";
import { bridgeQuote } from "../server/relay-route.mjs";
import { minimumBridgeDelivery, assertBridgeDelivery } from "../server/bridge-cost-policy.mjs";
const source=createPublicClient({chain:monad,transport:http("https://rpc.monad.xyz",{timeout:15000,retryCount:0})});
const destination=createPublicClient({chain:optimism,transport:http("https://mainnet.optimism.io",{timeout:15000,retryCount:0})});
try {
  if(await source.getChainId()!==143||await destination.getChainId()!==NEW_DONATION_CHAIN_ID)throw new Error("RPC network mismatch.");
  const sale=await saleQuote(source,parseUnits("300",18)),swap=await usdcQuote(source,BigInt(sale.minMon));
  const required=minimumBridgeDelivery(BigInt(swap.minUsdc));
  const bridge=await bridgeQuote("0x1111111111111111111111111111111111111111",BigInt(swap.minUsdc),required,NEW_DONATION_CHAIN_ID);
  assertBridgeDelivery(bridge,required);
  console.log(JSON.stringify({readOnly:true,destinationChainId:NEW_DONATION_CHAIN_ID,bridgeEstimatedSeconds:bridge.estimatedSeconds,amountChog:"300",saleMinimumMon:formatUnits(BigInt(sale.minMon),18),swapMinimumUsdc:formatUnits(BigInt(swap.minUsdc),6),bridgeMinimumUsdc:formatUnits(BigInt(bridge.minOutput),6),solverSignatureVerified:true,quoteExpiresAt:new Date(bridge.validUntil).toISOString()},null,2));
  console.log("Quote check only: no key loaded, no address issued, no transaction signed or sent.");
}catch {console.error("Read-only route check failed. Do not issue payment addresses until liquidity/RPC/bridge checks succeed.");process.exitCode=1;}

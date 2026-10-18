// Read-only provider check. Does not open custody, issue invoices or send funds.
import { createPublicClient, erc20Abi, parseAbi } from "viem";
import { monad, optimism } from "viem/chains";
import { paymentRpcTransport, PAYMENT_RPC_URLS } from "../server/payment-rpc.mjs";
import { PAYMENT_POLICY } from "../server/policy.mjs";
import { NFT_POOL_TREASURY } from "../src/chog-beneficiary.ts";
import { deliveryNetwork } from "../src/delivery-network.ts";

const results = await Promise.all([monad, optimism].flatMap(chain => PAYMENT_RPC_URLS[chain.id].map(async url => {
  const started = Date.now();
  const rpc = createPublicClient({ chain, transport: paymentRpcTransport({ chainId: chain.id, urls: [url] }) });
  try {
    if (await rpc.getChainId() !== chain.id) throw new Error();
    const finalized = await rpc.getBlock({ blockTag: "finalized" });
    if (typeof finalized.number !== "bigint" || !finalized.hash) throw new Error();
    await rpc.getBalance({ address: NFT_POOL_TREASURY });
    if (chain.id === 10) {
      const address = deliveryNetwork(10).usdc;
      const decimals = await rpc.readContract({ address, abi: erc20Abi, functionName: "decimals" });
      if (decimals !== 6) throw new Error();
      await rpc.readContract({ address, abi: erc20Abi, functionName: "balanceOf", args: [NFT_POOL_TREASURY] });
      await rpc.getContractEvents({ address, abi: erc20Abi, eventName: "Transfer", args: { to: NFT_POOL_TREASURY }, fromBlock: finalized.number - 49n, toBlock: finalized.number });
    } else {
      const is721 = await rpc.readContract({ address: PAYMENT_POLICY.nftCollection, abi: parseAbi(["function supportsInterface(bytes4) view returns(bool)"]), functionName: "supportsInterface", args: ["0x80ac58cd"] });
      if (is721 !== true) throw new Error();
    }
    return { chainId: chain.id, provider: new URL(url).host, readChecksPassed: true, elapsedMs: Date.now() - started };
  } catch {
    return { chainId: chain.id, provider: new URL(url).host, readChecksPassed: false, elapsedMs: Date.now() - started };
  }
})));
console.log(JSON.stringify({ readOnly: true, results }, null, 2));
if ([143, 10].some(chainId => !results.some(x => x.chainId === chainId && x.readChecksPassed))) process.exitCode = 1;

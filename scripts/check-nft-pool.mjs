import { createPublicClient, http, erc20Abi, parseAbi } from "viem";
import { monad, optimism } from "viem/chains";
import { PAYMENT_POLICY } from "../server/policy.mjs";
import { NFT_POOL_FUNDERS } from "../server/nft-pool-config.mjs";
import { deliveryNetwork } from "../src/delivery-network.ts";
const source=createPublicClient({chain:monad,transport:http("https://rpc.monad.xyz",{timeout:15000,retryCount:0})});
const destination=createPublicClient({chain:optimism,transport:http("https://mainnet.optimism.io",{timeout:15000,retryCount:0})});
try {
  const [sourceChain,poolChain,is721,decimals]=await Promise.all([
    source.getChainId(),destination.getChainId(),
    source.readContract({address:PAYMENT_POLICY.nftCollection,abi:parseAbi(["function supportsInterface(bytes4) view returns(bool)"]),functionName:"supportsInterface",args:["0x80ac58cd"]}),
    destination.readContract({address:deliveryNetwork(10).usdc,abi:erc20Abi,functionName:"decimals"}),
  ]);
  if(sourceChain!==143||poolChain!==10||!is721||decimals!==6)throw new Error();
  console.log(JSON.stringify({readOnly:true,sourceChain,poolChain,erc721Verified:is721,nativeUsdc:deliveryNetwork(10).usdc,approvedFunders:NFT_POOL_FUNDERS},null,2));
  console.log("No keys accessed, addresses issued, transactions signed or funds moved.");
}catch{console.error("NFT pool network/contract checks failed. Do not enable NFT invoices.");process.exitCode=1;}

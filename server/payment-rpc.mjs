import { BaseError, createPublicClient, createTransport, http } from "viem";

// Fixed server-side destinations only. No endpoint comes from a donor or HTTP.
// Sources: docs.monad.xyz/developer-essentials/network-information and
// optimism.publicnode.com, docs.tenderly.co/node-rpc/overview and
// drpc.org/docs/optimism-api. Public gateway capabilities are checked read-only.
// Every endpoint is checked against the pinned chain.
export const PAYMENT_RPC_URLS = Object.freeze({
  143: Object.freeze(["https://rpc.monad.xyz", "https://rpc-mainnet.monadinfra.com", "https://rpc2.monad.xyz"]),
  10: Object.freeze(["https://optimism-rpc.publicnode.com", "https://optimism.gateway.tenderly.co", "https://optimism.drpc.org"]),
});
const READ_METHODS = new Set([
  "eth_chainId", "eth_blockNumber", "eth_getBalance", "eth_getCode", "eth_getStorageAt",
  "eth_getTransactionCount", "eth_getTransactionByHash", "eth_getTransactionReceipt",
  "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getLogs", "eth_call", "eth_estimateGas",
  "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_getProof",
  "debug_traceTransaction", "debug_traceBlockByNumber", "trace_transaction", "trace_block",
]);
const FAST_READS=new Set(["eth_chainId","eth_getBlockByNumber","eth_getBlockByHash","eth_getTransactionReceipt","eth_getBalance","eth_call"]);

export class PaymentRpcUnavailableError extends BaseError {
  constructor(chainId) {
    // Never attach a caught RPC error: it may contain signed bytes or addresses.
    super(`Payment network ${chainId} is temporarily unavailable; automatic recovery is active.`, { name: "PaymentRpcUnavailableError" });
  }
}

function failureKind(error, method) {
  for (let current = error, depth = 0; current && depth < 8; current = current.cause, depth++) {
    const message = `${current.details ?? ""} ${current.message ?? ""}`;
    // Public providers can encode limits as JSON-RPC errors with HTTP 200.
    // Only recognize the observed limit signatures, never general invalid params.
    if (current.code === 15 && /public endpoint rate limit/i.test(message)) return "network";
    // PublicNode returns INVALID_PARAMS for a valid historical receipt/block
    // request when its free tier has no archive access. Only this exact access
    // restriction is retryable; genuine invalid parameters and reverts stay fatal.
    if (current.code === -32602 && READ_METHODS.has(method) && /archive requests require a personal token/i.test(message)) return "unsupported";
    if (method === "eth_getLogs" && [35, -32614, -32602].includes(current.code) && /eth_getLogs is limited to (?:a \d+ range|\d+ - \d+ blocks range)|block range too large|ranges over \d+ blocks are not supported on free plan/i.test(message)) return "unsupported";
    if ([-32601, -32004, 4200].includes(current.code)) return "unsupported";
    if ([-32005, -32002, -32603].includes(current.code)) return "network";
    if ([401, 403, 408, 429].includes(current.status) || current.status >= 500) return "network";
    if (["TimeoutError", "HttpRequestError", "WebSocketRequestError", "ResponseBodyTooLargeError"].includes(current.name)) return "network";
    if (current instanceof PaymentRpcUnavailableError) return "network";
  }
  return "terminal"; // Reverts, invalid parameters and rejected transactions are not retried.
}

export function paymentRpcTransport({ chainId, urls = PAYMENT_RPC_URLS[chainId], timeout = 6000,hedgeMs=350 }, dependencies = {}) {
  if (!Number.isSafeInteger(chainId) || !Array.isArray(urls) || !urls.length || urls.length > 4 || !Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid payment RPC configuration.");
  if(!Number.isFinite(hedgeMs)||hedgeMs<0||hedgeMs>1000)throw new Error("Invalid RPC read hedge.");
  for (const value of urls) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("HTTPS payment RPC required.");
  }
  const now = dependencies.now ?? Date.now;
  const makeHttp = dependencies.http ?? http;
  return options => {
    const endpoints = [...new Set(urls)].map(url => ({
      rpc: makeHttp(url, { timeout, retryCount: 0, fetchOptions: { redirect: "error" } })({ ...options, retryCount: 0, timeout }).request,
      logRange: url === "https://optimism.drpc.org" ? 50n : ["https://rpc.monad.xyz", "https://rpc-mainnet.monadinfra.com"].includes(url) ? 100n : null,
      blockedUntil: 0, failures: 0, verifiedUntil: 0, verifying: null, methods: new Map(),
    }));
    // Archive/log restrictions are method-specific. A successful historical
    // fallback must not move every balance/heartbeat read onto that provider.
    const preferred = new Map();
    const pending = new Map();
    const call = async (endpoint, args) => {
      // Respect public Monad/dRPC getLogs limits. Preserve the exact
      // filter and read disjoint subranges; never return a partial response.
      const filter = args.method === "eth_getLogs" && endpoint.logRange ? args.params?.[0] : null;
      const isNumber = x => typeof x === "string" && /^0x[\da-f]+$/i.test(x);
      if (!filter || filter.blockHash || !isNumber(filter.fromBlock) || !isNumber(filter.toBlock)) return endpoint.rpc(args);
      const from = BigInt(filter.fromBlock), to = BigInt(filter.toBlock);
      if (to < from || to - from < endpoint.logRange) return endpoint.rpc(args);
      // Processor scans are <= 2000 blocks. Never create an unbounded RPC fanout.
      if (to - from >= 2000n) throw Object.assign(new Error("Provider scan range exceeded."), { code: -32601 });
      const logs = [];
      const deadline = now() + 15_000;
      for (let start = from; start <= to; start += endpoint.logRange) {
        if (now() >= deadline) throw new PaymentRpcUnavailableError(chainId);
        const end = start + endpoint.logRange - 1n < to ? start + endpoint.logRange - 1n : to;
        const part = await endpoint.rpc({ ...args, params: [{ ...filter, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` }] });
        if (!Array.isArray(part)) throw new PaymentRpcUnavailableError(chainId);
        logs.push(...part);
      }
      return logs;
    };
    const block = endpoint => {
      endpoint.failures = Math.min(endpoint.failures + 1, 4);
      endpoint.blockedUntil = now() + Math.min(10_000 * 2 ** (endpoint.failures - 1), 60_000);
      endpoint.verifiedUntil = 0;
    };
    const verify = endpoint => {
      if (endpoint.verifiedUntil > now()) return Promise.resolve();
      if (!endpoint.verifying) endpoint.verifying = (async () => {
        const actual = await endpoint.rpc({ method: "eth_chainId" });
        if (typeof actual !== "string" || !/^0x[\da-f]+$/i.test(actual) || BigInt(actual) !== BigInt(chainId)) throw new PaymentRpcUnavailableError(chainId);
        endpoint.verifiedUntil = now() + 30_000;
      })().finally(() => { endpoint.verifying = null; });
      return endpoint.verifying;
    };
    const run = async args => {
      const readable = READ_METHODS.has(args.method);
      if (!readable && args.method !== "eth_sendRawTransaction") throw new Error("Unsupported payment RPC method.");
      const filter=args.method==="eth_getLogs"?args.params?.[0]:null;
      const ranged=filter&&/^0x[\da-f]+$/i.test(filter.fromBlock??"")&&/^0x[\da-f]+$/i.test(filter.toBlock??"")?BigInt(filter.toBlock)-BigInt(filter.fromBlock)+1n:null;
      const cost=endpoint=>ranged&&endpoint.logRange?Number((ranged+endpoint.logRange-1n)/endpoint.logRange):1;
      const order = endpoints.map((endpoint, index) => ({ endpoint, index }))
        .filter(({ endpoint }) => endpoint.blockedUntil <= now() && (endpoint.methods.get(args.method) ?? 0) <= now())
        .sort((a, b) => cost(a.endpoint)-cost(b.endpoint)||Number(b.index === (preferred.get(args.method) ?? 0)) - Number(a.index === (preferred.get(args.method) ?? 0)));
      const attempt=async({endpoint,index})=>{
        // Failure here is definitely BEFORE submission, so another endpoint is safe.
        try { if (args.method !== "eth_chainId") await verify(endpoint); }
        catch { block(endpoint);throw {terminal:false,error:new PaymentRpcUnavailableError(chainId)}; }
        try {
          const result = await call(endpoint, args);
          if (args.method === "eth_chainId") {
            if (typeof result !== "string" || !/^0x[\da-f]+$/i.test(result) || BigInt(result) !== BigInt(chainId))throw new PaymentRpcUnavailableError(chainId);
            endpoint.verifiedUntil = now() + 30_000;
          }
          endpoint.failures = 0; endpoint.blockedUntil = 0;
          return {result,index};
        } catch (error) {
          const kind = failureKind(error, args.method);
          if (kind === "network") block(endpoint);
          // An ambiguous send is handled ONLY by the persisted transaction journal.
          // Never fan it out, re-sign, replace its nonce, or synthesize success here.
          if (kind === "unsupported") endpoint.methods.set(args.method, now() + 5 * 60_000);
          throw {terminal:!readable||kind==="terminal",error};
        }
      };
      if(hedgeMs>0&&FAST_READS.has(args.method)&&order.length>1){
        // Quotes and readiness must not wait through multiple full RPC timeouts
        // while a healthy backup is available. Race only these read-only methods;
        // estimates, nonce reads, logs and sends stay serialized.
        const winner=await new Promise((resolve,reject)=>{
          let next=0,active=0,done=false,timer;
          const finish=(fn,value)=>{if(done)return;done=true;clearTimeout(timer);fn(value);};
          const launch=()=>{
            clearTimeout(timer);if(done||next>=order.length)return;
            active++;const candidate=order[next++];
            void attempt(candidate).then(value=>finish(resolve,value),failure=>{
              active--;if(done)return;
              if(failure.terminal)return finish(reject,failure.error);
              if(next<order.length)launch();else if(!active)finish(reject,new PaymentRpcUnavailableError(chainId));
            });
            if(next<order.length)timer=setTimeout(launch,hedgeMs);
          };
          launch();
        });
        preferred.set(args.method,winner.index);return winner.result;
      }
      for(const candidate of order){
        try{const value=await attempt(candidate);preferred.set(args.method,value.index);return value.result;}
        catch(failure){if(failure.terminal)throw failure.error;}
      }
      throw new PaymentRpcUnavailableError(chainId);
    };
    return createTransport({
      key: "payment-rpc", name: "Pinned payment RPC with failover", type: "payment-rpc", retryCount: 0, timeout,
      request(args) {
        if (!READ_METHODS.has(args.method)) return run(args);
        // Coalesce concurrent identical reads, never cache balances or receipts.
        const key = JSON.stringify(args);
        if (pending.has(key)) return pending.get(key);
        const request = run(args).finally(() => pending.delete(key));
        pending.set(key, request);
        return request;
      },
    });
  };
}

// CHOG and NFT share provider cooldowns instead of hammering the same failed RPC.
const clients = new Map();
export function paymentRpcClient(chain, primaryUrl) {
  const defaults = PAYMENT_RPC_URLS[chain.id];
  if (!defaults) throw new Error("Payment RPC chain is not configured.");
  const urls = primaryUrl ? [...new Set([primaryUrl, ...defaults])] : defaults;
  const key = `${chain.id}:${urls.join("|")}`;
  if (!clients.has(key)) clients.set(key, createPublicClient({ chain, transport: paymentRpcTransport({ chainId: chain.id, urls }) }));
  return clients.get(key);
}

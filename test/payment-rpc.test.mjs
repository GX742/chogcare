import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { paymentRpcTransport, PaymentRpcUnavailableError, paymentRpcClient } from "../server/payment-rpc.mjs";
import { optimism, monad } from "viem/chains";
import { http } from "viem";

const urls = ["https://first.invalid", "https://second.invalid"];
const networkError = (status = 403) => Object.assign(new Error("private payload must not enter diagnostics"), { name: "HttpRequestError", status });
function fixture(handlers, options = {}) {
  const calls = []; let clock = 100_000;
  const {transport:transportOptions={},...dependencies}=options;
  const transport = paymentRpcTransport({ chainId: 10, urls: urls.slice(0, handlers.length),...transportOptions }, {
    now: () => clock,
    http: (url, config) => () => ({ request: async args => {
      assert.equal(config.retryCount, 0); assert.equal(config.timeout, 6000);
      calls.push({ index: urls.indexOf(url), method: args.method, params: args.params });
      return handlers[urls.indexOf(url)](args);
    } }), ...dependencies,
  })({ chain: optimism });
  return { request: transport.request, calls, advance: ms => { clock += ms; } };
}
const healthy = ({ method }) => method === "eth_chainId" ? "0xa" : "0x123";
const balance = { method: "eth_getBalance", params: ["0x1111111111111111111111111111111111111111", "latest"] };

for (const status of [403, 429, 502, 503]) test(`RPC HTTP ${status} switches to a verified backup and stays there`, async () => {
  const f = fixture([args => { if (args.method === "eth_chainId") return "0xa"; throw networkError(status); }, healthy]);
  assert.equal(await f.request(balance), "0x123");
  assert.equal(await f.request(balance), "0x123");
  assert.equal(f.calls.filter(x => x.index === 0 && x.method === balance.method).length, 1);
  assert.ok(f.calls.some(x => x.index === 1 && x.method === "eth_chainId"));
});

test("all RPCs down gates requests; cooldown recovery needs no restart or stale success", async () => {
  let down = true;
  const handler = args => { if (down) throw networkError(); return healthy(args); };
  const f = fixture([handler, handler]);
  await assert.rejects(f.request(balance), PaymentRpcUnavailableError);
  const count = f.calls.length;
  await assert.rejects(f.request(balance), PaymentRpcUnavailableError);
  assert.equal(f.calls.length, count, "do not hammer quarantined providers");
  down = false; f.advance(10_001);
  assert.equal(await f.request(balance), "0x123");
});

test("wrong-chain endpoint is excluded before any account read or submission", async () => {
  const f = fixture([() => "0x1", healthy]);
  assert.equal(await f.request(balance), "0x123");
  assert.deepEqual(f.calls.filter(x => x.index === 0).map(x => x.method), ["eth_chainId"]);
  const wrong = fixture([() => "0x1", () => "0x8f"]);
  await assert.rejects(wrong.request({ method: "eth_chainId" }), PaymentRpcUnavailableError);
  await assert.rejects(wrong.request({ method: "eth_sendRawTransaction", params: ["0xabc"] }), PaymentRpcUnavailableError);
  assert.ok(wrong.calls.every(x => x.method === "eth_chainId"));
});

test("unsupported tracing fails over per method without disabling balance reads", async () => {
  const f = fixture([args => { if (args.method.startsWith("debug_")) throw Object.assign(new Error("unsupported"), { code: -32601 }); return healthy(args); }, healthy]);
  assert.equal(await f.request({ method: "debug_traceTransaction", params: ["0x123"] }), "0x123");
  assert.equal(await f.request(balance), "0x123");
});

test("contract reverts and invalid params remain errors, not retryable success", async () => {
  for (const code of [3, -32602, -32000]) {
    const f = fixture([args => { if (args.method === "eth_chainId") return "0xa"; throw Object.assign(new Error("execution reverted"), { code }); }, healthy]);
    await assert.rejects(f.request({ method: "eth_call", params: [] }));
    assert.ok(f.calls.every(x => x.index === 0));
  }
});

test("public JSON-RPC rate limits switch reads to a backup, but never resend a signed transaction", async () => {
  const limited=args=>{if(args.method==="eth_chainId")return "0xa";throw Object.assign(new Error("You reached Public endpoint rate limit, please upgrade to paid plan"),{code:15});};
  const f=fixture([limited,healthy]);
  assert.equal(await f.request(balance),"0x123");
  assert.equal(await f.request(balance),"0x123");
  assert.equal(f.calls.filter(x=>x.index===0&&x.method===balance.method).length,1);
  const sending=fixture([limited,healthy]);
  await assert.rejects(sending.request({method:"eth_sendRawTransaction",params:["0x1234"]}));
  assert.equal(sending.calls.filter(x=>x.method==="eth_sendRawTransaction").length,1);
  assert.ok(sending.calls.every(x=>x.index===0));
});

test("recognized log-range limits fail over only for log reads", async () => {
  for(const [code,message] of [[-32614,"eth_getLogs is limited to a 100 range"],[-32602,"block range too large"],[35,"ranges over 10000 blocks are not supported on free plan"],[-32602,"eth_getLogs is limited to 0 - 50 blocks range"]]){
    const limited=args=>{if(args.method==="eth_chainId")return "0xa";throw Object.assign(new Error(message),{code});};
    const f=fixture([limited,healthy]);
    assert.equal(await f.request({method:"eth_getLogs",params:[{fromBlock:"0x1",toBlock:"0x7d0"}]}),"0x123");
    const other=fixture([limited,healthy]);
    await assert.rejects(other.request({method:"eth_call",params:[]}));
    assert.ok(other.calls.every(x=>x.index===0));
    const sending=fixture([limited,healthy]);
    await assert.rejects(sending.request({method:"eth_sendRawTransaction",params:["0x1234"]}));
    assert.equal(sending.calls.filter(x=>x.method==="eth_sendRawTransaction").length,1);
    assert.ok(sending.calls.every(x=>x.index===0));
  }
});

test("archive access restrictions use a backup without retrying invalid parameters or broadcasts", async () => {
  const restricted=args=>{if(args.method==="eth_chainId")return "0xa";throw Object.assign(new Error("Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode"),{code:-32602});};
  for(const method of ["eth_getTransactionReceipt","eth_getBlockByNumber","eth_getBalance","eth_call"]){
    const f=fixture([restricted,healthy]);
    assert.equal(await f.request({method,params:[]}),"0x123");
    assert.equal(await f.request({method,params:[]}),"0x123");
    assert.equal(f.calls.filter(x=>x.index===0&&x.method===method).length,1);
  }
  const sending=fixture([restricted,healthy]);
  await assert.rejects(sending.request({method:"eth_sendRawTransaction",params:["0x1234"]}));
  assert.equal(sending.calls.filter(x=>x.method==="eth_sendRawTransaction").length,1);
  assert.ok(sending.calls.every(x=>x.index===0));
});

test("historical log fallback does not redirect healthy balance heartbeats to the backup",async()=>{
  const f=fixture([args=>{
    if(args.method==="eth_getLogs")throw Object.assign(new Error("Archive requests require a personal token"),{code:-32602});
    return healthy(args);
  },healthy]);
  const logs={method:"eth_getLogs",params:[{fromBlock:"0x1",toBlock:"0x32"}]};
  await f.request(logs);await f.request(balance);await f.request(logs);await f.request(balance);
  assert.deepEqual(f.calls.filter(x=>x.method==="eth_getLogs").map(x=>x.index),[0,1,1]);
  assert.deepEqual(f.calls.filter(x=>x.method==="eth_getBalance").map(x=>x.index),[0,0]);
});

for(const url of ["https://rpc.monad.xyz","https://rpc-mainnet.monadinfra.com"])test(`Monad 2000-block invoice scans respect the 100-block limit at ${new URL(url).hostname}`, async () => {
  const calls=[];
  const rpc=paymentRpcTransport({chainId:143,urls:[url]},{http:()=>()=>({request:async args=>{
    if(args.method==="eth_chainId")return "0x8f";
    const filter=args.params[0];calls.push(filter);
    assert.ok(BigInt(filter.toBlock)-BigInt(filter.fromBlock)<100n);
    return [{block:filter.fromBlock}];
  }})})({chain:monad});
  const filter={address:"0x1111111111111111111111111111111111111111",topics:["0x123",null,"0x456"],fromBlock:"0x65",toBlock:"0x834"};
  const logs=await rpc.request({method:"eth_getLogs",params:[filter]});
  assert.equal(calls.length,20);assert.equal(logs.length,20);
  assert.equal(calls[0].fromBlock,filter.fromBlock);assert.equal(calls.at(-1).toBlock,filter.toBlock);
  for(const [i,page] of calls.entries()){
    assert.equal(page.address,filter.address);assert.deepEqual(page.topics,filter.topics);
    if(i)assert.equal(BigInt(page.fromBlock),BigInt(calls[i-1].toBlock)+1n);
  }
});

test("failed Monad scan pages are discarded before a complete backup rescan", async () => {
  const original={address:"0x1111111111111111111111111111111111111111",topics:["0x123"],fromBlock:"0x65",toBlock:"0x834"};
  let pages=0,backups=0;
  const rpc=paymentRpcTransport({chainId:143,urls:["https://rpc.monad.xyz","https://rpc-mainnet.monadinfra.com"]},{http:url=>()=>({request:async args=>{
    if(args.method==="eth_chainId")return "0x8f";
    if(url==="https://rpc.monad.xyz"){
      if(++pages===2)throw networkError(429);
      return [{block:"partial-primary-result"}];
    }
    backups++;assert.equal(args.params[0].address,original.address);assert.deepEqual(args.params[0].topics,original.topics);
    return [{block:args.params[0].fromBlock}];
  }})})({chain:monad});
  const logs=await rpc.request({method:"eth_getLogs",params:[original]});
  assert.equal(logs.length,20);assert.equal(logs[0].block,original.fromBlock);
  assert.ok(logs.every(x=>x.block!=="partial-primary-result"));
  assert.equal(pages,2);assert.equal(backups,20);
});

test("a full-range Monad provider avoids twenty serial queries without skipping history",async()=>{
  const filter={address:"0x1111111111111111111111111111111111111111",topics:["0x123"],fromBlock:"0x65",toBlock:"0x834"},calls=[];
  const rpc=paymentRpcTransport({chainId:143},{http:url=>()=>({request:async args=>{
    calls.push({url,args});if(args.method==="eth_chainId")return "0x8f";
    assert.deepEqual(args.params,[filter]);return [{block:"all-results"}];
  }})})({chain:monad});
  assert.deepEqual(await rpc.request({method:"eth_getLogs",params:[filter]}),[{block:"all-results"}]);
  assert.equal(calls.length,2);assert.ok(calls.every(x=>x.url==="https://rpc2.monad.xyz"));
});

test("an unavailable full-range provider falls back to every limited-provider page",async()=>{
  let singleCalls=0;const pages=[];
  const rpc=paymentRpcTransport({chainId:143},{http:url=>()=>({request:async args=>{
    if(args.method==="eth_chainId")return "0x8f";
    if(url==="https://rpc2.monad.xyz"){singleCalls++;throw networkError(429);}
    assert.equal(url,"https://rpc.monad.xyz");pages.push(args.params[0]);return [];
  }})})({chain:monad});
  const filter={fromBlock:"0x1",toBlock:"0x7d0",topics:["0x123"]};
  assert.deepEqual(await rpc.request({method:"eth_getLogs",params:[filter]}),[]);
  assert.equal(singleCalls,1);assert.equal(pages.length,20);
  assert.equal(pages[0].fromBlock,filter.fromBlock);assert.equal(pages.at(-1).toBlock,filter.toBlock);
  for(let i=1;i<pages.length;i++)assert.equal(BigInt(pages[i].fromBlock),BigInt(pages[i-1].toBlock)+1n);
});

test("a slow receipt read uses a verified backup before the original timeout",async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const f=fixture([async args=>{if(args.method==="eth_chainId")return "0xa";await gate;return "late-primary";},healthy],{transport:{hedgeMs:10}});
  const receipt={method:"eth_getTransactionReceipt",params:["0x123"]};
  try{
    assert.equal(await f.request(receipt),"0x123");
    assert.deepEqual(f.calls.filter(x=>x.method===receipt.method).map(x=>x.index),[0,1]);
  }finally{release();}
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(await f.request({...receipt,params:["0x456"]}),"0x123");
  assert.equal(f.calls.filter(x=>x.index===0&&x.method===receipt.method).length,1,"a late primary must not replace the fast preferred provider");
});

for (const method of ["eth_getBalance", "eth_call"]) test(`a stalled ${method} uses a verified backup for checkout quotes and readiness`, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture([async args => { if (args.method === "eth_chainId") return "0xa"; await gate; return "late-primary"; }, healthy], { transport: { hedgeMs: 10 } });
  try {
    assert.equal(await f.request({ method, params: [] }), "0x123");
    assert.deepEqual(f.calls.filter(x => x.method === method).map(x => x.index), [0, 1]);
    assert.ok(f.calls.some(x => x.index === 1 && x.method === "eth_chainId"));
  } finally { release(); }
});

test("a late failed hedged read is handled without disturbing the successful read",async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const f=fixture([async args=>{if(args.method==="eth_chainId")return "0xa";await gate;throw networkError();},healthy],{transport:{hedgeMs:10}});
  try{assert.equal(await f.request({method:"eth_getBlockByNumber",params:["finalized",false]}),"0x123");}
  finally{release();}
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(await f.request(balance),"0x123");
});

test("fast-read invalid parameters remain terminal and do not launch a backup",async()=>{
  const f=fixture([args=>{if(args.method==="eth_chainId")return "0xa";throw Object.assign(new Error("invalid parameters"),{code:-32602});},healthy],{transport:{hedgeMs:10}});
  await assert.rejects(f.request({method:"eth_getTransactionReceipt",params:[]}),/invalid parameters/);
  assert.ok(f.calls.every(x=>x.index===0));
});

test("slow signed submissions are not hedged or duplicated",async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const f=fixture([async args=>{if(args.method==="eth_chainId")return "0xa";await gate;return "0x123";},healthy],{transport:{hedgeMs:10}});
  const request=f.request({method:"eth_sendRawTransaction",params:["0x1234"]});
  await new Promise(resolve=>setTimeout(resolve,35));
  try{assert.equal(f.calls.filter(x=>x.method==="eth_sendRawTransaction").length,1);assert.ok(f.calls.every(x=>x.index===0));}
  finally{release();}
  assert.equal(await request,"0x123");
});

test("ambiguous signed submission is never automatically sent to another RPC", async () => {
  const raw = "0x1234";
  const f = fixture([args => { if (args.method === "eth_chainId") return "0xa"; throw networkError(504); }, healthy]);
  await assert.rejects(f.request({ method: "eth_sendRawTransaction", params: [raw] }));
  assert.equal(f.calls.filter(x => x.method === "eth_sendRawTransaction").length, 1);
  assert.ok(f.calls.every(x => x.index === 0));
  // Only the caller's persisted-journal retry can subsequently resubmit identical bytes.
  assert.equal(await f.request({ method: "eth_sendRawTransaction", params: [raw] }), "0x123");
  assert.deepEqual(f.calls.filter(x => x.method === "eth_sendRawTransaction").map(x => x.params), [[raw], [raw]]);
});

test("read-only chain failure can select a backup before the sole submission", async () => {
  const f = fixture([() => { throw networkError(); }, healthy]);
  assert.equal(await f.request({ method: "eth_sendRawTransaction", params: ["0x1234"] }), "0x123");
  assert.deepEqual(f.calls.filter(x => x.method === "eth_sendRawTransaction").map(x => x.index), [1]);
});

test("identical concurrent reads coalesce, but later reads always refresh", async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const f = fixture([async args => { if (args.method === "eth_chainId") return "0xa"; await waiting; return "0x123"; }]);
  const reads = Array.from({ length: 10 }, () => f.request(balance));
  release(); await Promise.all(reads);
  assert.equal(f.calls.filter(x => x.method === balance.method).length, 1);
  await f.request(balance);
  assert.equal(f.calls.filter(x => x.method === balance.method).length, 2);
});

test("no arbitrary signing methods or non-HTTPS endpoints", async () => {
  for (const url of ["http://localhost", "file:///x", "https://user:pass@example.com"]) assert.throws(() => paymentRpcTransport({ chainId: 10, urls: [url] }));
  const f = fixture([healthy]);
  await assert.rejects(f.request({ method: "eth_sendTransaction", params: [] }), /Unsupported/);
  await assert.rejects(f.request({ method: "personal_sign", params: [] }), /Unsupported/);
  assert.equal(f.calls.length, 0);
  assert.equal(paymentRpcClient(optimism), paymentRpcClient(optimism, "https://optimism-rpc.publicnode.com"));
});

test("limited backup scans complete disjoint ranges with the original filter", async () => {
  const calls=[];
  const rpc=paymentRpcTransport({chainId:10,urls:["https://optimism.drpc.org"]},{http:()=>()=>({request:async args=>{
    if(args.method==="eth_chainId")return "0xa";
    calls.push(args);return [{block:args.params[0].fromBlock}];
  }})})({chain:optimism});
  const filter={address:"0x1111111111111111111111111111111111111111",topics:["0x123",null,"0x456"],fromBlock:"0x64",toBlock:"0xc8"};
  const logs=await rpc.request({method:"eth_getLogs",params:[filter]});
  assert.deepEqual(calls.map(x=>[x.params[0].fromBlock,x.params[0].toBlock]),[["0x64","0x95"],["0x96","0xc7"],["0xc8","0xc8"]]);
  for(const x of calls){assert.equal(x.params[0].address,filter.address);assert.deepEqual(x.params[0].topics,filter.topics);}
  assert.equal(logs.length,3);assert.equal(filter.fromBlock,"0x64");
});

test("a failed scan page never returns partial funding events or skips a range", async () => {
  let pages=0;
  const rpc=paymentRpcTransport({chainId:10,urls:["https://optimism.drpc.org"]},{http:()=>()=>({request:async args=>{
    if(args.method==="eth_chainId")return "0xa";
    if(++pages===2)throw networkError();return [{block:args.params[0].fromBlock}];
  }})})({chain:optimism});
  await assert.rejects(rpc.request({method:"eth_getLogs",params:[{fromBlock:"0x1",toBlock:"0x65"}]}),PaymentRpcUnavailableError);
  assert.equal(pages,2);
});

test("paged backup scans are bounded in both range and total elapsed time", async () => {
  let clock=100_000,pages=0;
  const rpc=paymentRpcTransport({chainId:10,urls:["https://optimism.drpc.org"]},{now:()=>clock,http:()=>()=>({request:async args=>{
    if(args.method==="eth_chainId")return "0xa";
    pages++;clock+=5001;return [];
  }})})({chain:optimism});
  await assert.rejects(rpc.request({method:"eth_getLogs",params:[{fromBlock:"0x1",toBlock:"0x7d0"}]}),PaymentRpcUnavailableError);
  assert.equal(pages,3);
  clock+=60_000;
  await assert.rejects(rpc.request({method:"eth_getLogs",params:[{fromBlock:"0x1",toBlock:"0x7d1"}]}),PaymentRpcUnavailableError);
  assert.equal(pages,3,"an oversized scan must not create RPC calls");
});

test("real HTTP transport handles HTML 403 and a bounded timeout before fallback", {timeout:10_000}, async t => {
  let failure = "403";
  const requests=[];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    requests.push({path:req.url,method:input.method});
    if (req.url === "/bad") {
      if (failure === "timeout") return;
      res.writeHead(403, { "Content-Type": "text/html" }); res.end("Forbidden"); return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result: healthy(input) }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  // Only the intentionally hung endpoint needs a tiny timeout. A healthy local
  // backup must not fail merely because parallel crypto/build tests busy the CPU.
  const fakeHttp = (url,options) => http(`http://127.0.0.1:${server.address().port}/${url === urls[0] ? "bad" : "good"}`, { ...options,retryCount:0,timeout:url === urls[0] ? options.timeout : 2_000 });
  for (failure of ["403", "timeout"]) {
    requests.length=0;
    const rpc = paymentRpcTransport({ chainId: 10, urls, timeout: 50 }, { http: fakeHttp })({ chain: optimism });
    assert.equal(await rpc.request(balance), "0x123");
    assert.ok(requests.some(value=>value.path==="/bad"),"the unavailable primary must actually be attempted");
    assert.ok(requests.some(value=>value.path==="/good"&&value.method==="eth_chainId"),"the fallback must be checked for the pinned chain");
    assert.ok(requests.some(value=>value.path==="/good"&&value.method===balance.method),"the balance must come from the verified fallback");
  }
});

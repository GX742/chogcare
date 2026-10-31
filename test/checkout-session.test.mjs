import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { assertUnpaidCheckout } from "../src/checkout-session.ts";
import { activeInvoiceKeys, beginCreation, BridgeCostLimitError, checkoutSelection, closeSavedInvoice, createPaymentRequest, pendingCreation, recoveryBundle, rememberInvoice, rememberMode, savedInvoice, savedCheckoutModes, validInvoiceId } from "../src/checkout-session.ts";

const chogId = "a".repeat(64), nftId = "b".repeat(64);
test("cancel guard refuses processing, wrong identity and any detected funds", () => {
  const invoice = { id: chogId, state: "awaiting-payment", depositHash: null };
  assert.doesNotThrow(() => assertUnpaidCheckout(chogId, invoice));
  for (const state of ["processing", "bridging", "verifying", "verified", "paying", "confirming", "delivered", "manual-review", "expired"]) assert.throws(() => assertUnpaidCheckout(chogId, { ...invoice, state }));
  assert.throws(() => assertUnpaidCheckout(nftId, invoice));
  for (const key of ["depositHash", "bridgeHash", "destinationHash", "observedDestinationHash"]) assert.throws(() => assertUnpaidCheckout(chogId, { ...invoice, [key]: "0x" + "1".repeat(64) }));
});
function memory() { const map = new Map(); return { getItem:key=>map.get(key)??null, setItem:(key,value)=>map.set(key,value), removeItem:key=>map.delete(key) }; }
const chog = { mode:"chog", amount:"300", holderAddress:"", initiativeId:"burundi" };
const nft = { mode:"nft", amount:"1", holderAddress:"0x"+"1".repeat(40), tokenId:"12", initiativeId:"burundi" };

for(const initiativeId of ["school-supplies","solar-foundation","vida-verde"])test(`NFT ${initiativeId} recovery never relabels an outstanding grant`,()=>{
  const store=memory();beginCreation({...nft,initiativeId},store);
  assert.equal(pendingCreation("nft",store).input.initiativeId,initiativeId);
  rememberInvoice("nft",nftId,store,initiativeId);
  assert.equal(checkoutSelection("burundi","nft",store).initiativeId,initiativeId);
  assert.equal(checkoutSelection("burundi","chog",store).mode,"chog");
  assert.equal(savedInvoice("nft",store),nftId);
  assert.throws(()=>rememberInvoice("nft",nftId,store,"burundi"));
});

test("Animal Ethics recovery retains its cause instead of falling back to Burundi",()=>{
  const store=memory();
  beginCreation({...chog,initiativeId:"animal-ethics"},store);
  assert.equal(checkoutSelection("burundi","chog",store).initiativeId,"animal-ethics");
  rememberInvoice("chog",chogId,store,"animal-ethics");
  assert.equal(checkoutSelection("burundi","chog",store).initiativeId,"animal-ethics");
  assert.throws(()=>rememberInvoice("chog",chogId,store,"burundi"));
  closeSavedInvoice("chog",store);
  assert.equal(checkoutSelection("burundi","chog",store).initiativeId,"burundi");
});

test("archived completed or explicitly closed invoices unlock methods without losing recovery", () => {
  for (const mode of ["chog", "nft"]) {
    const store = memory(), id = mode === "chog" ? chogId : nftId;
    rememberInvoice(mode, id, store);
    closeSavedInvoice(mode, store);
    closeSavedInvoice(mode, store);
    for (const wanted of ["chog", "nft"]) assert.deepEqual(checkoutSelection("herd", wanted, store), { mode: wanted, initiativeId: "herd", outstanding: false });
    assert.deepEqual(JSON.parse(recoveryBundle(store)).history, [{ mode, id }]);
  }
});

test("automatic NFT-only restore pins its cause while explicit CHOG navigation stays independent", () => {
  const store = memory(); store.setItem(activeInvoiceKeys.nft,nftId);
  assert.deepEqual(checkoutSelection("herd",undefined,store),{mode:"nft",initiativeId:"burundi",outstanding:true});
  assert.deepEqual(checkoutSelection("school-supplies","chog",store),{mode:"chog",initiativeId:"school-supplies",outstanding:true});
  assert.equal(savedInvoice("nft",store),nftId);
});
test("both invoice IDs survive mode switching, pinning, reset and recovery export", () => {
  const store=memory(); rememberInvoice("chog",chogId,store); rememberInvoice("nft",nftId,store);
  rememberMode("nft",store);
  assert.equal(checkoutSelection("herd",undefined,store).mode,"nft");
  assert.equal(checkoutSelection("herd","chog",store).mode,"chog");
  assert.throws(()=>rememberInvoice("nft","c".repeat(64),store),/already saved/);
  assert.equal(savedInvoice("nft",store),nftId);
  closeSavedInvoice("chog",store);
  assert.equal(savedInvoice("nft",store),nftId);
  const recovery=JSON.parse(recoveryBundle(store));
  assert.equal(recovery.nft,nftId); assert.deepEqual(recovery.history,[{mode:"chog",id:chogId}]);
  assert.equal(checkoutSelection("herd","chog",store).mode,"chog");
});
test("ambiguous creation retries keep exactly the same key and payload across reloads", async () => {
  const store=memory(), first=beginCreation(chog,store);
  await assert.rejects(()=>createPaymentRequest(first,new AbortController().signal,async()=>{throw new Error("response lost");}),/request is saved/);
  const restored=pendingCreation("chog",store);
  assert.deepEqual(restored,first);
  assert.deepEqual(beginCreation(chog,store),first);
  assert.throws(()=>beginCreation({...chog,amount:"500"},store),/not been resolved/);
  assert.equal(checkoutSelection("heaven","nft",store).mode,"nft");
  assert.equal(checkoutSelection("heaven","chog",store).initiativeId,"burundi");
  let sent;
  await createPaymentRequest(restored,new AbortController().signal,async(url,init)=>{sent={url,...init}; return new Response(JSON.stringify({id:chogId}),{status:201});});
  assert.equal(sent.headers["Idempotency-Key"],first.key);
  assert.deepEqual(JSON.parse(sent.body),chog);
  rememberInvoice("chog",chogId,store);
  assert.equal(pendingCreation("chog",store),null);
  assert.equal(savedInvoice("chog",store),chogId);
});
test("storage write failure prevents new creation; failed completion does not lose pending key", () => {
  const store=memory(); const broken={...store,setItem(){throw new Error("full");}};
  assert.throws(()=>beginCreation(chog,broken),/full/);
  assert.equal(pendingCreation("chog",store),null);
  const pending=beginCreation(nft,store);
  assert.throws(()=>rememberInvoice("nft",nftId,broken),/full/);
  assert.deepEqual(pendingCreation("nft",store),pending);
});
test("only an explicit safe pre-creation rejection unlocks request editing", async () => {
  const store=memory(), pending=beginCreation(chog,store);
  const fail=(body,status)=>async()=>new Response(JSON.stringify(body),{status});
  for(const [body,status,message] of [[{code:"REQUEST_PENDING"},409,/still being checked/],[{code:"SESSION_REQUIRED"},403,/session could not be restored/],[{error:"offline"},503,/not resolved/]]) {
    await assert.rejects(()=>createPaymentRequest(pending,new AbortController().signal,fail(body,status),store),message);
    assert.deepEqual(pendingCreation("chog",store),pending);
  }
  await assert.rejects(()=>createPaymentRequest(pending,new AbortController().signal,fail({creationNotStarted:true},400),store),/No payment was created/);
  assert.equal(pendingCreation("chog",store),null);
  assert.notEqual(beginCreation({...chog,amount:"500"},store).key,pending.key);
});

test("an expired worker session renews once and recovers the identical saved request", async () => {
  const store = memory(), pending = beginCreation(chog, store), calls = [];
  const result = await createPaymentRequest(pending, new AbortController().signal, async (url, init) => {
    calls.push({ url, ...init });
    if (calls.length === 1) return Response.json({ code: "SESSION_REQUIRED" }, { status: 403 });
    if (url === "/api/payments/config") return Response.json({});
    return Response.json({ id: chogId }, { status: 201 });
  }, store);
  assert.equal(result.id, chogId);
  assert.deepEqual(calls.map(x => x.url), ["/api/payments/invoices", "/api/payments/config", "/api/payments/invoices"]);
  assert.equal(calls[0].headers["Idempotency-Key"], pending.key);
  assert.deepEqual(calls[2], calls[0]);
  assert.equal(calls[1].credentials, "same-origin");
  assert.equal(calls[1].cache, "no-store");
  assert.deepEqual(pendingCreation("chog", store), pending);
});

test("failed session renewal or a second session rejection retains recovery and never loops", async () => {
  for (const failure of ["offline", "rejected", "session-still-invalid"]) {
    const store = memory(), pending = beginCreation(chog, store); let calls = 0;
    await assert.rejects(createPaymentRequest(pending, new AbortController().signal, async url => {
      calls++;
      if (url === "/api/payments/config") {
        if (failure === "offline") throw new Error("private transport error");
        return Response.json({}, { status: failure === "rejected" ? 503 : 200 });
      }
      return Response.json({ code: "SESSION_REQUIRED" }, { status: 403 });
    }, store), /saved|not resolved/);
    assert.equal(calls, failure === "session-still-invalid" ? 3 : 2);
    assert.deepEqual(pendingCreation("chog", store), pending);
  }
});

const settleCreation = () => new Promise(resolve => setImmediate(resolve));

test("an explicitly pending request waits five seconds and recovers with byte-identical POSTs", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = memory(), pending = beginCreation(chog, store), original = structuredClone(pending), calls = [];
  const controller = new AbortController();
  const result = createPaymentRequest(pending, controller.signal, async (url, init) => {
    calls.push({ url, ...init });
    return calls.length === 1
      ? Response.json({ code: "REQUEST_PENDING", retryAfterSeconds: 5 }, { status: 409, headers: { "Retry-After": "5" } })
      : Response.json({ id: chogId }, { status: 201 });
  }, store);
  await settleCreation();
  assert.equal(calls.length, 1);
  // Mutating a caller's object while waiting cannot alter a durable retry.
  pending.key = "changed-after-send"; pending.input.amount = "999";
  t.mock.timers.tick(4999); await settleCreation();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  assert.equal((await result).id, chogId);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(calls[1].headers["Idempotency-Key"], original.key);
  assert.equal(calls[1].body, JSON.stringify(original.input));
  assert.equal(calls[1].credentials, "same-origin");
  assert.equal(calls[1].signal, controller.signal);
  assert.deepEqual(pendingCreation("chog", store), original);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("short pending and rate limits share a maximum of two additional POSTs", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = memory(), pending = beginCreation(chog, store), calls = [], controller = new AbortController();
  const result = assert.rejects(createPaymentRequest(pending, controller.signal, async (url, init) => {
    calls.push({ url, ...init });
    return calls.length === 2
      ? Response.json({ code: "RATE_LIMITED" }, { status: 429, headers: { "Retry-After": "1" } })
      : Response.json({ code: "REQUEST_PENDING", retryAfterSeconds: 5 }, { status: 409 });
  }, store), /still being checked/);
  await settleCreation();
  t.mock.timers.tick(5000); await settleCreation();
  assert.equal(calls.length, 2);
  t.mock.timers.tick(999); await settleCreation();
  assert.equal(calls.length, 2);
  t.mock.timers.tick(1); await result;
  t.mock.timers.tick(60_000); await settleCreation();
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.body === calls[0].body && call.headers["Idempotency-Key"] === pending.key));
  assert.deepEqual(pendingCreation("chog", store), pending);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("invalid, missing, conflicting or long retry instructions never trigger an automatic POST", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const variants = [
    {}, { header: "0" }, { header: "-1" }, { header: "6" }, { header: "1.5" },
    { header: "Infinity" }, { header: "Wed, 21 Oct 2026 07:28:00 GMT" },
    { body: "5" }, { body: 0 }, { body: -1 }, { body: 6 }, { body: 1.5 },
    { header: "5", body: 1 }, { header: "1", body: 60 }, { header: "bad", body: 1 },
  ];
  for (const status of [409, 429]) for (const variant of variants) {
    const store = memory(), pending = beginCreation(chog, store); let calls = 0;
    const code = status === 409 ? "REQUEST_PENDING" : "RATE_LIMITED";
    await assert.rejects(createPaymentRequest(pending, new AbortController().signal, async () => {
      calls++;
      return Response.json({ code, ...(variant.body === undefined ? {} : { retryAfterSeconds: variant.body }) }, {
        status, ...(variant.header === undefined ? {} : { headers: { "Retry-After": variant.header } }),
      });
    }, store), /saved request/);
    t.mock.timers.tick(60_000);
    assert.equal(calls, 1);
    assert.deepEqual(pendingCreation("chog", store), pending);
  }
});

test("session recovery happens once and shares the three-POST budget with transient retries", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const sequence of [
    ["SESSION_REQUIRED", "REQUEST_PENDING", "SESSION_REQUIRED"],
    ["REQUEST_PENDING", "SESSION_REQUIRED", "SESSION_REQUIRED"],
    ["REQUEST_PENDING", "SESSION_REQUIRED", "RATE_LIMITED"],
  ]) {
    const store = memory(), pending = beginCreation(chog, store), calls = []; let posts = 0;
    const result = assert.rejects(createPaymentRequest(pending, new AbortController().signal, async (url, init) => {
      calls.push({ url, ...init });
      if (url === "/api/payments/config") return Response.json({});
      posts++;
      const code = sequence[posts - 1];
      return Response.json({ code, retryAfterSeconds: 1 }, { status: code === "REQUEST_PENDING" ? 409 : code === "RATE_LIMITED" ? 429 : 403 });
    }, store), sequence[2] === "RATE_LIMITED" ? /Too many payment requests/ : /session could not be restored/);
    await settleCreation();
    t.mock.timers.tick(1000); await result;
    t.mock.timers.tick(60_000); await settleCreation();
    assert.equal(posts, 3);
    assert.equal(calls.filter(call => call.url === "/api/payments/config").length, 1);
    const attempts = calls.filter(call => call.method === "POST");
    assert.ok(attempts.every(call => call.body === attempts[0].body && call.headers["Idempotency-Key"] === pending.key));
    assert.deepEqual(pendingCreation("chog", store), pending);
  }
});

test("an aborted session renewal cannot replay even when its transport ignores cancellation", async () => {
  const store = memory(), pending = beginCreation(chog, store), controller = new AbortController();
  let releaseConfig, posts = 0, configReads = 0;
  const configResponse = new Promise(resolve => { releaseConfig = resolve; });
  const result = assert.rejects(createPaymentRequest(pending, controller.signal, async url => {
    if (url === "/api/payments/config") { configReads++; return configResponse; }
    posts++;
    return Response.json({ code: "SESSION_REQUIRED" }, { status: 403 });
  }, store), /request is saved/);
  await settleCreation();
  controller.abort();
  releaseConfig(Response.json({}));
  await result;
  assert.equal(configReads, 1);
  assert.equal(posts, 1);
  assert.deepEqual(pendingCreation("chog", store), pending);
});

test("aborting during a retry wait clears the timer and preserves the original request", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = memory(), pending = beginCreation(chog, store), controller = new AbortController(); let posts = 0;
  const result = assert.rejects(createPaymentRequest(pending, controller.signal, async () => {
    posts++;
    return Response.json({ code: "RATE_LIMITED", retryAfterSeconds: 5 }, { status: 429 });
  }, store), error => {
    assert.match(error.message, /request is saved/);
    assert.doesNotMatch(error.message, /PRIVATE_ABORT_DETAIL/);
    return true;
  });
  await settleCreation();
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort(new Error("PRIVATE_ABORT_DETAIL"));
  await result;
  t.mock.timers.tick(60_000); await settleCreation();
  assert.equal(posts, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.deepEqual(pendingCreation("chog", store), pending);
});

test("an aborted overall signal cannot send before startup or after a wait finishes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const beforeStart of [true, false]) {
    const store = memory(), pending = beginCreation(chog, store), controller = new AbortController(); let posts = 0;
    if (beforeStart) controller.abort();
    const result = assert.rejects(createPaymentRequest(pending, controller.signal, async () => {
      posts++;
      return Response.json({ code: "REQUEST_PENDING", retryAfterSeconds: 1 }, { status: 409 });
    }, store), /request is saved/);
    if (!beforeStart) {
      await settleCreation();
      t.mock.timers.tick(1000);
      controller.abort();
    }
    await result;
    assert.equal(posts, beforeStart ? 0 : 1);
    assert.deepEqual(pendingCreation("chog", store), pending);
  }
});

test("terminal errors, malformed responses and gateway failures retain recovery without auto-retry or raw errors", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const variants = [
    [409, "IDEMPOTENCY_CONFLICT", /conflicts with an existing payment/],
    [503, "INTEGRITY_HOLD", /recovery check/],
    [403, "ORIGIN_REJECTED", /Payment access was rejected/],
    [409, "UNKNOWN_PRIVATE_CODE", /not resolved/],
    [429, "UNKNOWN_PRIVATE_CODE", /not resolved/],
    [500, "REQUEST_PENDING", /still being checked/],
    [502, null, /gateway is temporarily unavailable/],
    [504, null, /gateway is temporarily unavailable/],
    [503, null, /not resolved/],
  ];
  for (const [status, code, message] of variants) {
    const store = memory(), pending = beginCreation(chog, store); let posts = 0;
    await assert.rejects(createPaymentRequest(pending, new AbortController().signal, async () => {
      posts++;
      return code === null ? new Response("PRIVATE_PROXY_DETAIL", { status, headers: { "Retry-After": "1" } })
        : Response.json({ code, error: "PRIVATE_WORKER_DETAIL", retryAfterSeconds: 1 }, { status });
    }, store), error => {
      assert.match(error.message, message);
      assert.doesNotMatch(error.message, /PRIVATE_/);
      return true;
    });
    t.mock.timers.tick(60_000);
    assert.equal(posts, 1);
    assert.deepEqual(pendingCreation("chog", store), pending);
  }
});

test("only existing explicit pre-creation proof unlocks edits, including bridge and NFT rejections", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [code, input, message] of [
    ["BRIDGE_COST_LIMIT", chog, /Bridge fees are too high/],
    ["NFT_NOT_OWNED", nft, /not held by your wallet/],
    ["NFT_DAILY_LIMIT", nft, /already has today's donation/],
    ["REQUEST_PENDING", chog, /No payment was created/],
    ["RATE_LIMITED", chog, /No payment was created/],
  ]) {
    const store = memory(), pending = beginCreation(input, store); let posts = 0;
    await assert.rejects(createPaymentRequest(pending, new AbortController().signal, async () => {
      posts++;
      return Response.json({ code, creationNotStarted: true, retryAfterSeconds: 1 }, { status: code === "RATE_LIMITED" ? 429 : code === "REQUEST_PENDING" ? 409 : 422 });
    }, store), message);
    t.mock.timers.tick(60_000);
    assert.equal(posts, 1);
    assert.equal(pendingCreation(input.mode, store), null);
  }
});

test("bridge amount suggestions are authorized only by explicit proof that creation did not start", async () => {
  for (const creationNotStarted of [undefined, false, "true", true]) {
    const store = memory(), pending = beginCreation(chog, store);
    await assert.rejects(createPaymentRequest(pending, new AbortController().signal, async () =>
      Response.json({ code: "BRIDGE_COST_LIMIT", creationNotStarted }, { status: 422 }), store), problem => {
      assert.equal(problem instanceof BridgeCostLimitError, creationNotStarted === true);
      assert.equal(problem.code, creationNotStarted === true ? "BRIDGE_COST_LIMIT" : undefined);
      return true;
    });
    if (creationNotStarted === true) {
      assert.equal(pendingCreation("chog", store), null);
      const reviewed = beginCreation({ ...chog, amount: "500" }, store);
      assert.notEqual(reviewed.key, pending.key, "a donor-reviewed larger amount uses a new request");
      assert.equal(reviewed.input.amount, "500");
    } else {
      assert.deepEqual(pendingCreation("chog", store), pending);
      assert.throws(() => beginCreation({ ...chog, amount: "500" }, store), /Retry it unchanged/);
    }
  }
  const store = memory(), pending = beginCreation(nft, store);
  await assert.rejects(createPaymentRequest(pending, new AbortController().signal, async () =>
    Response.json({ code: "BRIDGE_COST_LIMIT", creationNotStarted: true }, { status: 422 }), store), problem => {
    assert.equal(problem instanceof BridgeCostLimitError, false, "NFT checkout cannot offer a CHOG amount suggestion");
    assert.equal(problem.code, undefined);
    return true;
  });
});
test("invalid saved references are not silently erased or substituted", () => {
  const store=memory(); store.setItem(activeInvoiceKeys.nft,"../../config");
  assert.equal(checkoutSelection("herd","chog",store).initiativeId,"herd");
  assert.throws(()=>closeSavedInvoice("nft",store),/Invalid saved invoice/);
  assert.equal(store.getItem(activeInvoiceKeys.nft),"../../config");
  for(const value of ["../config",nftId+"?query",null,123])assert.equal(validInvoiceId(value),false);
});

test("independent methods retain different pinned causes and pending idempotency keys across tab changes", () => {
  const store = memory();
  const request = beginCreation({ ...nft, initiativeId: "solar-foundation" }, store);
  rememberInvoice("chog", chogId, store, "animal-ethics");
  const before = recoveryBundle(store);
  assert.deepEqual(checkoutSelection("school-supplies", "nft", store), { mode: "nft", initiativeId: "solar-foundation", outstanding: true });
  assert.deepEqual(checkoutSelection("solar-foundation", "chog", store), { mode: "chog", initiativeId: "animal-ethics", outstanding: true });
  assert.deepEqual(savedCheckoutModes(store), { chog: true, nft: true });
  assert.equal(recoveryBundle(store), before);
  assert.deepEqual(pendingCreation("nft", store), request);
});

test("choosing an empty CHOG tab survives reload and NFT completion without relabeling or deleting a receipt", () => {
  const store = memory();
  rememberInvoice("nft", nftId, store, "solar-foundation");
  rememberMode("chog", store);
  assert.equal(checkoutSelection("school-supplies", undefined, store).mode, "chog");
  closeSavedInvoice("nft", store);
  assert.deepEqual(checkoutSelection("school-supplies", "chog", store), { mode: "chog", initiativeId: "school-supplies", outstanding: false });
  assert.deepEqual(JSON.parse(recoveryBundle(store)).history, [{ mode: "nft", id: nftId }]);
});

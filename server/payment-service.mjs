import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPreviewInvoice } from "../src/checkout.ts";
import { openInvoiceStore } from "./invoice-store.mjs";
import { INITIATIVE_IDS, PAYMENT_POLICY, SUBSIDY_UNITS } from "./policy.mjs";
import { publicDepositNode } from "./custody-vault.mjs";
import { createHash } from "node:crypto";
import { createHttpAdmission } from "./http-admission.mjs";
import { supportsChog, supportsNft, acceptsNewChog } from "../src/chog-beneficiary.ts";
import { parseUnits } from "viem";
import { buildDonorLeaderboard } from "./donor-leaderboard.mjs";
import { createReadOnlyDashboard } from "./ops-dashboard.mjs";
import { validateSupportInput } from "./support-store.mjs";
import { validateEstimateInput } from "./ops-quotes.mjs";

export function createPaymentService(store, allowedOrigin = "http://127.0.0.1:4173", custodyConfigured = false, processor = null, options = {}) {
  const admission = createHttpAdmission(allowedOrigin);
  const dashboard = options.dashboard ?? createReadOnlyDashboard({ status: () => processor?.publicStatus?.() ?? null });
  const opsBuckets = new Map(), opsClock = options.clock ?? Date.now;
  function opsAdmission(req, kind, session) {
    const now = opsClock();
    for (const [key, bucket] of opsBuckets) if (bucket.reset <= now) opsBuckets.delete(key);
    const peer = req.socket.remoteAddress || "unknown";
    const limits = kind === "support"
      ? [["support:global", 30, 60_000], [`support:peer:${peer}`, 30, 60_000], [`support:session:${session ?? peer}`, 3, 600_000]]
      : [["quote:global", 12, 60_000], [`quote:peer:${peer}`, 12, 60_000], [`quote:session:${session ?? peer}`, 6, 60_000]];
    for (const [key, maximum, window] of limits) {
      let bucket = opsBuckets.get(key);
      if (!bucket) {
        if (opsBuckets.size >= 2000) return 60;
        bucket = { count: 0, reset: now + window }; opsBuckets.set(key, bucket);
      }
      if (++bucket.count > maximum) return Math.max(1, Math.ceil((bucket.reset - now) / 1000));
    }
    return 0;
  }
  let preparing = 0;
  const preparingModes = new Set();
  const server = createServer({ maxHeaderSize: 8192, connectionsCheckingInterval: 1000 }, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    const respond = (status, body) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    const profileIntegrityHeld = () => processor?.publicStatus?.()?.integrityLocked === true;
    const profileIntegrityHold = () => respond(503, { code: "INTEGRITY_HOLD", error: "Payments and donor profiles are paused for a storage integrity check. Keep this invoice; do not pay again." });
    const replyWithProfile = async (status, profile) => {
      if (profileIntegrityHeld()) return profileIntegrityHold();
      try {
        // Publishing is a durable write, even though it never moves money. A
        // failed checkpoint must not be reported as a successful publication.
        await processor?.checkpoint?.();
        if (profileIntegrityHeld()) return profileIntegrityHold();
      } catch { return profileIntegrityHold(); }
      return respond(status, { profile });
    };
    const creationDefinitelyNotStarted = () => {
      const key = req.headers["idempotency-key"];
      // A rejection of THIS retry is not proof that an earlier request failed.
      // A recorded request must never be unlocked by validation/readiness errors.
      try { return typeof key !== "string" || !store.requests.find(key.toLowerCase()); }
      catch { return false; }
    };
    const rejectBeforeCreation = (status, error, code) => respond(status, { error, ...(code ? { code } : {}), ...(creationDefinitelyNotStarted() ? { creationNotStarted: true } : {}) });
      const readJson = async (limit=4096) => {
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] || "") || req.headers["content-encoding"]) throw Object.assign(new Error("Use uncompressed UTF-8 JSON."),{status:415});
        if (Number(req.headers["content-length"] || 0) > limit) throw Object.assign(new Error("Request is too large."),{status:413});
        const chunks=[];let bytes=0;
        const deadline=setTimeout(()=>{respond(408,{error:"Request body timed out."});req.destroy();},5000);deadline.unref();
        try{for await(const chunk of req){bytes+=chunk.length;if(bytes>limit)throw Object.assign(new Error("Request is too large."),{status:413});chunks.push(chunk);}}finally{clearTimeout(deadline);}
        try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw Object.assign(new Error("Invalid JSON."),{status:400});}
      };
    try {
      const localPort = req.socket.localPort;
      const allowedHosts = new Set([new URL(allowedOrigin).host, `127.0.0.1:${localPort}`]);
      if (!allowedHosts.has(req.headers.host)) return respond(403, { error: "Host not allowed." });
      if (req.headers.origin && req.headers.origin !== allowedOrigin) return respond(403, { error: "Origin not allowed." });
      if (req.headers["sec-fetch-site"] === "cross-site") return respond(403, { error: "Cross-site requests are not allowed." });
      if (req.method === "POST" && req.headers.origin !== allowedOrigin) return respond(403, { error: "An exact application Origin is required." });
      if (!req.url?.startsWith("/") || req.url.startsWith("//")) return respond(400, { error: "Invalid request target." });
      const url = new URL(req.url || "/", allowedOrigin);
      const session = admission.session(req, res);
      const supportRequest = req.method === "POST" && url.pathname === "/api/payments/support";
      const estimateRequest = req.method === "GET" && url.pathname === "/api/payments/bridge-estimate";
      // Support/quote abuse must not consume the invoice-creation budget.
      const wait = supportRequest || estimateRequest ? opsAdmission(req, supportRequest ? "support" : "quote", session) : admission.admit(req, req.method === "POST" ? "create" : "read", session);
      if (wait) { res.setHeader("Retry-After", wait); return respond(429, { code: "RATE_LIMITED", error: "Too many requests. Retry this same request shortly.", retryAfterSeconds: wait }); }
      if (supportRequest) {
        if (!options.supportStore) return respond(503, { error: "Support is temporarily unavailable. Please try again later." });
        if (!session) return respond(403, { error: "Open the application before contacting support." });
        let input;
        try { input = validateSupportInput(await readJson(4096)); }
        catch (error) { return respond(error.status ?? 400, { error: [400, 413, 415].includes(error.status) ? error.message : "Invalid support request." }); }
        if (req.aborted || res.writableEnded || res.destroyed) return;
        try {
          // Dedicated support storage never changes a financial checkpoint.
          const submitted = options.supportStore.submit({ requestId: input.requestId, subject: input.subject, message: input.message, ...(input.contact !== null ? { contact: input.contact } : {}), ...(input.invoiceId !== null ? { invoiceId: input.invoiceId } : {}) });
          return respond(submitted.created ? 201 : 200, { ticket: { reference: submitted.ticket.reference, createdAt: submitted.ticket.createdAt } });
        } catch (error) {
          return respond(error.status === 409 ? 409 : 503, { error: error.status === 409 ? "This support request cannot be changed. Use a new request ID." : "Support is temporarily unavailable. Please try again later." });
        }
      }
      if (req.method === "GET" && url.pathname === "/api/payments/dashboard") {
        if (url.search) return respond(400, { error: "Dashboard parameters are not supported." });
        if (!session) admission.session(req, res, true);
        return respond(200, dashboard.snapshot());
      }
      if (estimateRequest) {
        if (!options.quoteService) return respond(503, { error: "Bridge estimate is temporarily unavailable. No payment was created." });
        let input;
        try {
          if ([...url.searchParams.keys()].length !== 2 || url.searchParams.getAll("amount").length !== 1 || url.searchParams.getAll("initiativeId").length !== 1) throw new Error();
          input = validateEstimateInput({ amount: url.searchParams.get("amount"), initiativeId: url.searchParams.get("initiativeId") });
        } catch { return respond(400, { error: "Choose a supported donation amount and initiative." }); }
        try { return respond(200, await options.quoteService.quote(input)); }
        catch { return respond(503, { error: "Bridge estimate is temporarily unavailable. No payment was created." }); }
      }
      if (req.method === "GET" && url.pathname === "/api/payments/config") {
        if (!session) admission.session(req, res, true);
        const pool = store.poolSummary();
        const status = options.operationsOnly ? { paymentMode: "offline", paymentsEnabled: false, nftPaymentsEnabled: false, integrityLocked: false } : processor?.publicStatus();
        return respond(200, {
          ...PAYMENT_POLICY,
          securityVersion: "2026-10-09-hardened-v1",
          poolFunded: pool.fundedAvailableUnits >= SUBSIDY_UNITS,
          availableClaims: pool.availableClaims,
          reservedTodayUsdc: (pool.reservedTodayUnits / 1_000_000).toFixed(2),
          custodyConfigured: options.operationsOnly ? false : custodyConfigured,
          ...status,
          readiness: { custody: options.operationsOnly ? "not-configured" : processor ? "unlocked-local-pilot" : custodyConfigured ? "locked" : "not-configured", processing: options.operationsOnly ? "not-connected" : processor ? "connected" : "not-connected", pool: (status?.poolFunded ?? pool.availableClaims > 0) ? "funded" : "not-funded" },
        });
      }
      if (options.operationsOnly) return respond(503, { code: "PAYMENTS_OFFLINE", error: "The payment worker is offline. Keep your original invoice; do not pay again." });
      if (req.method === "GET" && url.pathname === "/api/payments/chog-rate") {
        if (!processor?.publicChogRate) return respond(503,{error:"CHOG quote is temporarily unavailable."});
        try { return respond(200,await processor.publicChogRate()); }
        catch { return respond(503,{error:"CHOG quote is temporarily unavailable."}); }
      }
      if (req.method === "GET" && url.pathname === "/api/payments/leaderboard") {
        if (profileIntegrityHeld()) return profileIntegrityHold();
        const entries=buildDonorLeaderboard(store.leaderboardRecords(),processor?.leaderboardDonation? id=>processor.leaderboardDonation(id):null);
        return respond(200,{entries});
      }
      const cancelMatch=url.pathname.match(/^\/api\/payments\/invoices\/([a-f0-9]{64})\/cancel$/);
      if(req.method==="POST"&&cancelMatch){
        if(profileIntegrityHeld())return profileIntegrityHold();
        if(!session)return respond(403,{error:"Open payment configuration before retrying cancellation."});
        const body=await readJson(64);
        if(!body||Array.isArray(body)||Object.keys(body).length!==1||body.mode!=="chog")return respond(400,{error:"Only an explicitly cancelled unpaid CHOG checkout is supported."});
        if(!processor?.cancelUnpaidChog)return respond(503,{error:"Cancellation is unavailable. Keep your original payment reference."});
        try{
          const result=processor.cancelUnpaidChog(cancelMatch[1]);
          await processor.checkpoint?.();
          if(profileIntegrityHeld())return profileIntegrityHold();
          return respond(200,result);
        }catch{return respond(409,{error:"Payment may be processing or its storage check is incomplete. Keep your invoice and retry; do not pay again."});}
      }
      const profileMatch=url.pathname.match(/^\/api\/payments\/invoices\/([a-f0-9]{64})\/profile$/);
      if(req.method==="GET"&&profileMatch){
        if (profileIntegrityHeld()) return profileIntegrityHold();
        if(!processor?.profileNfts)return respond(503,{error:"Donor profiles are temporarily unavailable."});
        const existing=store.findDonorProfile(profileMatch[1]);
        if(existing)return respond(200,{published:true,profile:existing,nfts:[]});
        try{const context=await processor.profileNfts(profileMatch[1]);if(profileIntegrityHeld())return profileIntegrityHold();return respond(200,{published:false,profile:null,nfts:context.nfts});}
        catch{if(profileIntegrityHeld())return profileIntegrityHold();return respond(409,{error:"Your profile unlocks after the donation is verified on the destination network."});}
      }
      if(req.method==="POST"&&url.pathname==="/api/payments/leaderboard"){
        if (profileIntegrityHeld()) return profileIntegrityHold();
        if(!processor?.profileNfts)return respond(503,{error:"Donor profiles are temporarily unavailable."});
        let input;try{input=await readJson(1024);}catch(error){return respond(error.status??400,{error:error.message});}
        if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(key=>!["invoiceId","nickname","avatarTokenId"].includes(key))||typeof input.invoiceId!=="string"||!/^[a-f0-9]{64}$/.test(input.invoiceId)||typeof input.nickname!=="string"||(input.avatarTokenId!==null&&typeof input.avatarTokenId!=="string"))return respond(400,{error:"Invalid leaderboard profile."});
        const nickname=input.nickname.normalize("NFKC").trim().replace(/\s+/g," ");
        if([...nickname].length<2||[...nickname].length>24||!/^[-_.\p{L}\p{N} ]+$/u.test(nickname))return respond(400,{error:"Use 2 to 24 letters, numbers, spaces, dots, dashes or underscores."});
        if (profileIntegrityHeld()) return profileIntegrityHold();
        const current=store.findDonorProfile(input.invoiceId);if(current)return await replyWithProfile(200,current);
        try{
          const context=await processor.profileNfts(input.invoiceId);
          if (profileIntegrityHeld()) return profileIntegrityHold();
          const avatar=input.avatarTokenId===null?null:context.nfts.find(item=>item.tokenId===input.avatarTokenId);
          if(input.avatarTokenId!==null&&!avatar)return respond(400,{error:"Choose an NFT verified in the donating wallet."});
          const profile=store.publishDonorProfile({invoiceId:input.invoiceId,nickname,initiativeId:context.initiativeId,amount:context.amount,amountUnits:parseUnits(context.amount,18).toString(),avatarTokenId:avatar?.tokenId??null,avatarName:avatar?.name??null,avatarImage:avatar?.image??null,publishedAt:Date.now()});
          return await replyWithProfile(201,profile);
        }catch(error){if(profileIntegrityHeld())return profileIntegrityHold();const recovered=store.findDonorProfile(input.invoiceId);if(recovered)return await replyWithProfile(200,recovered);return respond(409,{error:"Profile can be published only after a verified CHOG donation reaches the destination network."});}
      }
      if (req.method === "GET" && /^\/api\/payments\/invoices\/[a-f0-9]{64}$/.test(url.pathname)) {
        if (processor?.publicStatus().integrityLocked) return respond(503, { code: "INTEGRITY_HOLD", error: "Payments are paused for a storage integrity check. Keep this invoice; do not pay again." });
        const invoice=processor?.get(url.pathname.split("/").at(-1));
        return invoice ? respond(200,invoice) : respond(404,{error:"Invoice not found or worker is offline. Do not pay again."});
      }
      if (req.method === "POST" && url.pathname === "/api/payments/invoices" && !processor) {
        // No environment flag can accidentally activate unimplemented custody/settlement.
        return respond(503, { code: "PAYMENTS_NOT_READY", error: "The payment worker is offline. Keep any existing invoice; do not pay again.", ...(creationDefinitelyNotStarted() ? { creationNotStarted: true } : {}), custodyConfigured, dailyPoolLimitUsdc: PAYMENT_POLICY.dailyPoolLimitUsdc });
      }
      if (req.method === "POST" && ["/api/payments/previews", "/api/payments/invoices"].includes(url.pathname)) {
        // Previews use the same integrity-protected companion store. A hold
        // prohibits these writes too, not only the allocation of payable QR codes.
        if (profileIntegrityHeld()) return profileIntegrityHold();
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] || "") || req.headers["content-encoding"]) return rejectBeforeCreation(415, "Use uncompressed UTF-8 JSON.");
        if (Number(req.headers["content-length"] || 0) > 4096) return rejectBeforeCreation(413, "Request is too large.");
        const chunks = [];
        let bytes = 0;
        // Inactivity timeouts alone do not stop a client sending one byte at a
        // time. Enforce a wall-clock body deadline before any worker action.
        const bodyDeadline = setTimeout(() => { rejectBeforeCreation(408, "Request body timed out."); req.destroy(); }, 5000);
        bodyDeadline.unref();
        try {
          for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > 4096) { rejectBeforeCreation(413, "Request is too large."); req.resume(); return; }
            chunks.push(chunk);
          }
        } finally { clearTimeout(bodyDeadline); }
        if (req.aborted || res.writableEnded || res.destroyed) return;
        let input;
        try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { return rejectBeforeCreation(400, "Invalid JSON."); }
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["mode", "amount", "holderAddress", "initiativeId", "tokenId"].includes(key)) || !INITIATIVE_IDS.has(input.initiativeId) ||
          !["chog", "nft"].includes(input.mode) || typeof input.amount !== "string" || typeof input.holderAddress !== "string") {
          return rejectBeforeCreation(400, "Invalid payment request.");
        }
        if ("tokenId" in input && (input.mode !== "nft" || typeof input.tokenId !== "string" || !/^\d{1,78}$/.test(input.tokenId) || BigInt(input.tokenId) >= 2n ** 256n)) return rejectBeforeCreation(400,"Invalid NFT token ID.");
        let invoice;
        try { invoice = createPreviewInvoice(input.mode, input.amount, input.holderAddress, input.initiativeId); }
        catch { return rejectBeforeCreation(400, "Check the amount and NFT holder address. Minimum donation: 300 CHOG; NFT verification: exactly 1 MON."); }
        if(url.pathname==="/api/payments/invoices") {
          if (!session) return respond(403, { error: "Reload payment configuration before retrying the same request.", code: "SESSION_REQUIRED" });
          const rawKey = req.headers["idempotency-key"];
          if (typeof rawKey !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(rawKey)) return rejectBeforeCreation(400, "A random request key is required.", "IDEMPOTENCY_KEY_REQUIRED");
          if (input.mode === "nft" ? !supportsNft(input.initiativeId) || input.amount !== "1" : !supportsChog(input.initiativeId)) return rejectBeforeCreation(400, "Unsupported live payment request.");
          const canRetryUnissued = id => input.mode === "nft" ? processor.canRetryUnissuedNft?.(id) : processor.canRetryUnissuedChog?.(id);
          const key = rawKey.toLowerCase();
          const digest = createHash("sha256").update(JSON.stringify([input.mode, input.amount, input.holderAddress, input.initiativeId, input.tokenId ?? null])).digest("hex");
          const existing = store.requests.find(key);
          if (existing && existing.digest !== digest) return respond(409, { code: "IDEMPOTENCY_CONFLICT", error: "This request key belongs to another payment. Keep the original request unchanged." });
          const pending = () => { res.setHeader("Retry-After", "5"); return respond(409, { code: "REQUEST_PENDING", error: "The original request is still being checked. Retry the same request; do not create another payment. Contact the operator if this persists.", retryAfterSeconds: 5 }); };
          const integrityHold = () => respond(503, { code: "INTEGRITY_HOLD", error: "Payments are paused for a storage integrity check. Keep the original request; do not pay again." });
          const replyWithInvoice = async (id, result) => {
            if (processor.publicStatus().integrityLocked) return integrityHold();
            try {
              store.requests.complete(key, id);
              await processor.checkpoint?.();
              if (processor.publicStatus().integrityLocked) return integrityHold();
            } catch { return integrityHold(); }
            return respond(201, result);
          };
          if (existing) {
            if (processor.publicStatus().integrityLocked) return integrityHold();
            const recovered = processor.get(existing.invoice_id);
            if (recovered) return await replyWithInvoice(existing.invoice_id, recovered);
            if (!canRetryUnissued(existing.invoice_id)) return pending();
          }
          const status = processor.publicStatus();
          if(input.mode==="chog"&&!acceptsNewChog(input.initiativeId)) return rejectBeforeCreation(503,"Recipient verification is pending. No new payment was started.","RECIPIENT_REVIEW");
          if (input.mode === "nft" ? !status.nftPaymentsEnabled : !status.paymentsEnabled) return rejectBeforeCreation(503, "This payment route is temporarily unavailable. No new payment was started.", "PAYMENTS_NOT_READY");
          if (preparing >= 4 || preparingModes.has(input.mode)) { res.setHeader("Retry-After", "5"); return respond(429, { code: "RATE_LIMITED", error: "The service is preparing other payments. Retry the same request.", retryAfterSeconds: 5 }); }
          let entry;
          preparing++;
          preparingModes.add(input.mode);
          try {
            // Reject fresh ineligible requests before spending an immutable
            // journal key. This check cannot allocate or reserve anything. The
            // worker repeats eligibility after the intent is checkpointed;
            // preflight never authorizes an address or a transfer.
            if (input.mode === "nft" && !existing) {
              if (typeof processor.preflightNft !== "function") return rejectBeforeCreation(503, "NFT eligibility checks are temporarily unavailable. No payment was started.", "NFT_ELIGIBILITY_UNAVAILABLE");
              try { await processor.preflightNft(input); }
              catch (error) {
                if (profileIntegrityHeld()) return integrityHold();
                if (["NFT_NOT_OWNED", "NFT_DAILY_LIMIT"].includes(error?.code)) return rejectBeforeCreation(422, "NFT eligibility check failed before any payment address was allocated.", error.code);
                return rejectBeforeCreation(503, "NFT eligibility checks are temporarily unavailable. No payment was started.", "NFT_ELIGIBILITY_UNAVAILABLE");
              }
              if (req.aborted || res.writableEnded || res.destroyed) return;
              const checked = processor.publicStatus();
              if (checked.integrityLocked) return integrityHold();
              if (!checked.nftPaymentsEnabled) return rejectBeforeCreation(503, "This payment route is temporarily unavailable. No new payment was started.", "PAYMENTS_NOT_READY");
            }
            entry = store.requests.claim(key, digest);
            if (entry.digest !== digest) return respond(409, { code: "IDEMPOTENCY_CONFLICT", error: "This request key belongs to another payment." });
            if (!entry.fresh && !canRetryUnissued(entry.invoice_id)) return pending();
            // Count the in-flight request before checkpoint I/O so concurrent
            // connections cannot all slip through the preparation admission cap.
            // A journal write is checkpointed BEFORE custody work starts.
            try { await processor.checkpoint?.(); if (processor.publicStatus().integrityLocked) return integrityHold(); }
            catch { return integrityHold(); }
            const issued = await processor.issue(input, entry.invoice_id);
            if (!issued || issued.id !== entry.invoice_id) throw new Error("Worker request binding mismatch.");
            return await replyWithInvoice(entry.invoice_id, issued);
          } catch (error) {
            if (!entry) throw error;
            // A worker may have committed before throwing or losing its reply.
            // Recover the original ID, never retry issuance with another ID.
            const recovered = processor.get(entry.invoice_id);
            if (recovered) return await replyWithInvoice(entry.invoice_id, recovered);
            if (input.mode === "chog" && processor.canRetryUnissuedChog?.(entry.invoice_id) && error?.code === "BRIDGE_COST_LIMIT") {
              return respond(422,{code:"BRIDGE_COST_LIMIT",creationNotStarted:true,error:"This amount is too small for the current bridge cost limit. Increase the amount or try later. No payment address was created."});
            }
            if (input.mode === "nft" && processor.canRetryUnissuedNft?.(entry.invoice_id) && ["NFT_NOT_OWNED","NFT_DAILY_LIMIT"].includes(error?.code)) {
              return respond(422,{code:error.code,creationNotStarted:true,error:"NFT eligibility check failed before any payment address was allocated."});
            }
            return pending();
          } finally { preparing--; preparingModes.delete(input.mode); }
        }
        if (profileIntegrityHeld()) return profileIntegrityHold();
        store.savePreview(invoice);
        await processor?.checkpoint?.();
        return respond(201, invoice);
      }
      return respond(404, { error: "Not found." });
    } catch {
      // Do not expose RPC credentials, request data, SQL paths or stack traces.
      if (!res.headersSent) respond(500, { code: "SERVICE_UNAVAILABLE", error: "Payment service unavailable. Keep your original request and invoice; do not pay again." });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.maxHeadersCount = 32;
  server.maxConnections = 100;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.setTimeout(30_000, socket => socket.destroy());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const filename = resolve("work/payments/preview.sqlite");
  mkdirSync(dirname(filename), { recursive: true });
  const store = openInvoiceStore(filename);
  let custodyConfigured = false;
  try {
    publicDepositNode(JSON.parse(readFileSync(resolve("work/payments/custody/vault.json"), "utf8")));
    custodyConfigured = true;
  } catch { /* Missing or invalid backups keep live payment issuance closed. */ }
  const service = createPaymentService(store, "http://127.0.0.1:4173", custodyConfigured);
  service.listen(4174, "127.0.0.1", () => console.log("ChogCare payment service: http://127.0.0.1:4174 (preview only; real payments disabled)"));
  const stop = () => service.close(() => { store.close(); process.exit(0); });
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}

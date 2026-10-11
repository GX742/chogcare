import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPreviewInvoice } from "../src/checkout.ts";
import { openInvoiceStore } from "./invoice-store.mjs";
import { INITIATIVE_IDS, PAYMENT_POLICY } from "./policy.mjs";
import { publicDepositNode } from "./custody-vault.mjs";
import { createHash } from "node:crypto";
import { createHttpAdmission } from "./http-admission.mjs";
import { supportsChog, supportsNft, acceptsNewChog } from "../src/chog-beneficiary.ts";
import { parseUnits } from "viem";

export function createPaymentService(store, allowedOrigin = "http://127.0.0.1:4173", custodyConfigured = false, processor = null) {
  const admission = createHttpAdmission(allowedOrigin);
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
      const wait = admission.admit(req, req.method === "POST" ? "create" : "read", session);
      if (wait) { res.setHeader("Retry-After", wait); return respond(429, { code: "RATE_LIMITED", error: "Too many requests. Retry this same request shortly.", retryAfterSeconds: wait }); }
      if (req.method === "GET" && url.pathname === "/api/payments/config") {
        if (!session) admission.session(req, res, true);
        const pool = store.poolSummary();
        const status = processor?.publicStatus();
        return respond(200, {
          ...PAYMENT_POLICY,
          securityVersion: "2026-10-09-hardened-v1",
          poolFunded: pool.fundedAvailableUnits >= 500_000,
          availableClaims: pool.availableClaims,
          reservedTodayUsdc: (pool.reservedTodayUnits / 1_000_000).toFixed(2),
          custodyConfigured,
          ...status,
          readiness: { custody: processor ? "unlocked-local-pilot" : custodyConfigured ? "locked" : "not-configured", processing: processor ? "connected" : "not-connected", pool: (status?.poolFunded ?? pool.availableClaims > 0) ? "funded" : "not-funded" },
        });
      }
      if (req.method === "GET" && url.pathname === "/api/payments/chog-rate") {
        if (!processor?.publicChogRate) return respond(503,{error:"CHOG quote is temporarily unavailable."});
        try { return respond(200,await processor.publicChogRate()); }
        catch { return respond(503,{error:"CHOG quote is temporarily unavailable."}); }
      }
      if (req.method === "GET" && url.pathname === "/api/payments/leaderboard") {
        return respond(200,{entries:store.leaderboard(20)});
      }
      const profileMatch=url.pathname.match(/^\/api\/payments\/invoices\/([a-f0-9]{64})\/profile$/);
      if(req.method==="GET"&&profileMatch){
        if(!processor?.profileNfts)return respond(503,{error:"Donor profiles are temporarily unavailable."});
        const existing=store.findDonorProfile(profileMatch[1]);
        if(existing)return respond(200,{published:true,profile:existing,nfts:[]});
        try{const context=await processor.profileNfts(profileMatch[1]);return respond(200,{published:false,profile:null,nfts:context.nfts});}
        catch{return respond(409,{error:"Your profile unlocks after the donation reaches final confirmation."});}
      }
      if(req.method==="POST"&&url.pathname==="/api/payments/leaderboard"){
        if(!processor?.profileNfts)return respond(503,{error:"Donor profiles are temporarily unavailable."});
        let input;try{input=await readJson(1024);}catch(error){return respond(error.status??400,{error:error.message});}
        if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(key=>!["invoiceId","nickname","avatarTokenId"].includes(key))||typeof input.invoiceId!=="string"||!/^[a-f0-9]{64}$/.test(input.invoiceId)||typeof input.nickname!=="string"||(input.avatarTokenId!==null&&typeof input.avatarTokenId!=="string"))return respond(400,{error:"Invalid leaderboard profile."});
        const nickname=input.nickname.normalize("NFKC").trim().replace(/\s+/g," ");
        if([...nickname].length<2||[...nickname].length>24||!/^[-_.\p{L}\p{N} ]+$/u.test(nickname))return respond(400,{error:"Use 2 to 24 letters, numbers, spaces, dots, dashes or underscores."});
        const current=store.findDonorProfile(input.invoiceId);if(current)return respond(200,{profile:current});
        try{
          const context=await processor.profileNfts(input.invoiceId);
          if(context.state!=="delivered")return respond(409,{error:"Your profile is ready. Publishing unlocks after final confirmation."});
          const avatar=input.avatarTokenId===null?null:context.nfts.find(item=>item.tokenId===input.avatarTokenId);
          if(input.avatarTokenId!==null&&!avatar)return respond(400,{error:"Choose an NFT verified in the donating wallet."});
          const profile=store.publishDonorProfile({invoiceId:input.invoiceId,nickname,initiativeId:context.initiativeId,amount:context.amount,amountUnits:parseUnits(context.amount,18).toString(),avatarTokenId:avatar?.tokenId??null,avatarName:avatar?.name??null,avatarImage:avatar?.image??null,publishedAt:Date.now()});
          await processor.checkpoint?.();return respond(201,{profile});
        }catch(error){const recovered=store.findDonorProfile(input.invoiceId);if(recovered)return respond(200,{profile:recovered});return respond(409,{error:"Profile can be published only after a finalized CHOG donation."});}
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
          const entry = store.requests.claim(key, digest);
          if (entry.digest !== digest) return respond(409, { code: "IDEMPOTENCY_CONFLICT", error: "This request key belongs to another payment." });
          if (!entry.fresh && !canRetryUnissued(entry.invoice_id)) return pending();
          preparing++;
          preparingModes.add(input.mode);
          try {
            // Count the in-flight request before checkpoint I/O so concurrent
            // connections cannot all slip through the preparation admission cap.
            // A journal write is checkpointed BEFORE custody work starts.
            try { await processor.checkpoint?.(); if (processor.publicStatus().integrityLocked) return integrityHold(); }
            catch { return integrityHold(); }
            const issued = await processor.issue(input, entry.invoice_id);
            if (!issued || issued.id !== entry.invoice_id) throw new Error("Worker request binding mismatch.");
            return await replyWithInvoice(entry.invoice_id, issued);
          } catch (error) {
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

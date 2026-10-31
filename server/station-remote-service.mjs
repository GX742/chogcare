import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { stationDonation } from "./station-events.mjs";

export const STATION_REMOTE_PREFIX = "/api/station/v1";
export const validStationToken = token => typeof token === "string" && token.length === 64 && /^[a-f0-9]{64}$/.test(token);
export const validStationEventId = id => typeof id === "string" && id.length === 24 && /^[a-f0-9]{24}$/.test(id);
export function sanitizedStationEvent(value) {
  if (!value || Array.isArray(value) || Object.keys(value).some(key => !["v", "type", "id", "nick", "amount", "cause"].includes(key)) || value.v !== 1 || value.type !== "donation" || !validStationEventId(value.id)) throw Error("Invalid station event.");
  const result = stationDonation(value);
  if (result.nick !== value.nick || result.amount !== value.amount || result.cause !== value.cause) throw Error("Invalid station event.");
  return result;
}

// No signer, writable financial connection, invoice lookup or arbitrary proxy
// belongs in this service. Its only mutation is its separate gratitude outbox.
export function createStationRemoteService({ events, token, healthy, clock = Date.now }) {
  if (!validStationToken(token) || typeof healthy !== "function" || typeof events?.sync !== "function" || typeof events?.acknowledge !== "function") throw Error("Invalid station service configuration.");
  const expected = Buffer.from(`Bearer ${token}`);
  let windowStart = 0, requests = 0;
  const server = createServer(async (req, res) => {
    const reply = (status, value) => { if (res.destroyed) return; res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(value)); };
    try {
      const port = server.address()?.port;
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) || req.headers.host !== `127.0.0.1:${port}` || req.headers.origin) return reply(403, { error: "Station access denied." });
      const authorization = req.headers.authorization;
      const supplied = typeof authorization === "string" && authorization.length <= 80 ? Buffer.from(authorization) : Buffer.alloc(0);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401, { error: "Station authentication required." });
      const at = clock(); if (at < windowStart || at - windowStart >= 1000) { windowStart = at; requests = 0; }
      if (++requests > 20) return reply(429, { error: "Station request limit." });
      const next = req.url === `${STATION_REMOTE_PREFIX}/next`, ack = req.url === `${STATION_REMOTE_PREFIX}/ack`;
      if (!next && !ack) return reply(404, { error: "Station route unavailable." });
      if (req.method !== (next ? "GET" : "POST")) return reply(405, { error: "Station method unavailable." });
      const pendingId = req.headers["x-chogcare-station-pending"];
      if (pendingId !== undefined && (!next || !validStationEventId(pendingId))) return reply(400, { error: "Invalid station pending identity." });
      let body;
      if (ack) {
        if (req.headers["content-type"] !== "application/json" || req.headers["content-encoding"] || (req.headers["content-length"] && (!/^\d+$/.test(req.headers["content-length"]) || Number(req.headers["content-length"]) > 256))) return reply(400, { error: "Invalid station acknowledgement." });
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 256) return reply(413, { error: "Station acknowledgement too large." }); chunks.push(chunk); }
        try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { return reply(400, { error: "Invalid station acknowledgement." }); }
        if (!body || Array.isArray(body) || Object.keys(body).sort().join(",") !== "id,status" || !validStationEventId(body.id) || body.status !== "done") return reply(400, { error: "Invalid station acknowledgement." });
      }
      const connected = await healthy() === true;
      events.sync(connected, at);
      if (!connected) return reply(503, { version: 1, healthy: false, event: null });
      if (next) { const event = events.next(at, pendingId ?? null); return reply(200, { version: 1, healthy: true, event: event ? sanitizedStationEvent(event) : null }); }
      if (!events.acknowledge(body.id, at)) return reply(409, { code: "STATION_EVENT_NOT_ELIGIBLE", error: "Station event is not eligible." });
      return reply(200, { version: 1, acknowledged: true });
    } catch { return reply(503, { error: "Station feed unavailable." }); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 20;
  return server;
}

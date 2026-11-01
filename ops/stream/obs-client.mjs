import { createHash, randomUUID } from "node:crypto";

// OBS WebSocket 5.x requires these exact SHA-256/base64 challenge operations;
// this is wire authentication, not password storage or a configurable KDF.
// https://github.com/obsproject/obs-websocket/blob/5.6.3/docs/generated/protocol.md#creating-an-authentication-string
const digest = value => createHash("sha256").update(value).digest("base64");

// Use only OBS's authenticated local API. Never log RPC response comments:
// services can include a stream key or destination in diagnostic messages.
export function connectLocalObs({ port = 4455, password, timeoutMs = 8000, WebSocketImpl = WebSocket, onRecoveryEvent } = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 ||
      typeof password !== "string" || password.length < 8 || password.length > 1024 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000 || onRecoveryEvent !== undefined && typeof onRecoveryEvent !== "function") throw new Error("Invalid local OBS connection settings.");
  return new Promise((resolve, reject) => {
    let identified = false, settled = false, hello = false, sequence = 0, disconnected = false;
    const pending = new Map();
    const changing = new Set();
    const socket = new WebSocketImpl(`ws://127.0.0.1:${port}`, "obswebsocket.json");
    const fail = () => {
      const wasIdentified = identified; identified = false;
      clearTimeout(handshakeTimer);
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Local OBS connection closed.")); }
      pending.clear();
      if (wasIdentified && !disconnected && onRecoveryEvent) { disconnected = true; try { onRecoveryEvent({ type: "ConnectionClosed" }); } catch { /* Close still completes. */ } }
      if (!settled) { settled = true; reject(new Error("Authenticated local OBS API is unavailable.")); }
      try { socket.close(); } catch { /* Already closed. */ }
    };
    const handshakeTimer = setTimeout(fail, timeoutMs);
    socket.addEventListener("error", fail);
    socket.addEventListener("close", fail);
    socket.addEventListener("message", event => {
      if (typeof event.data !== "string" || Buffer.byteLength(event.data) > 256 * 1024) { fail(); return; }
      let message;
      try { message = JSON.parse(event.data); } catch { fail(); return; }
      if (!message || typeof message !== "object" || Array.isArray(message) || !Number.isInteger(message.op) ||
          !message.d || typeof message.d !== "object" || Array.isArray(message.d)) { fail(); return; }
      if (message.op === 0 && !hello && !identified) {
        hello = true;
        const auth = message.d?.authentication;
        if (message.d?.rpcVersion < 1 || !auth || ![auth.salt, auth.challenge].every(value => typeof value === "string" && value.length >= 16 && value.length <= 256)) { fail(); return; }
        const authentication = digest(digest(password + auth.salt) + auth.challenge);
        // Opt-in only: Config (2) and Outputs (64), never names/settings/media.
        socket.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, eventSubscriptions: onRecoveryEvent ? 66 : 0, authentication } }));
      } else if (message.op === 2 && hello && !identified && message.d?.negotiatedRpcVersion === 1) {
        identified = true; settled = true; clearTimeout(handshakeTimer);
        resolve({
          request(requestType, requestData = {}) {
            if (!identified || changing.size || socket.readyState !== 1 || typeof requestType !== "string" || requestType.match(/^[A-Z][A-Za-z0-9]{1,63}$/)?.[0] !== requestType || pending.size >= 8) return Promise.reject(new Error("Invalid or unavailable local OBS request."));
            const requestId = `${++sequence}-${randomUUID()}`;
            return new Promise((yes, no) => {
              const timer = setTimeout(() => { pending.delete(requestId); no(new Error("Local OBS request timed out.")); }, timeoutMs);
              pending.set(requestId, { resolve: yes, reject: no, timer, requestType });
              try { socket.send(JSON.stringify({ op: 6, d: { requestId, requestType, requestData } })); }
              catch { clearTimeout(timer); pending.delete(requestId); no(new Error("Local OBS request failed.")); }
            });
          },
          close() { fail(); },
        });
      } else if (message.op === 7 && identified) {
        const response = message.d, entry = pending.get(response?.requestId);
        if (!entry) return;
        clearTimeout(entry.timer); pending.delete(response.requestId);
        if (response.requestType !== entry.requestType || response.requestStatus?.result !== true) {
          entry.reject(new Error(`Local OBS request rejected (${Number.isInteger(response.requestStatus?.code) ? response.requestStatus.code : 0}).`));
        } else entry.resolve(response.responseData ?? {});
      } else if (message.op === 5 && identified && onRecoveryEvent) {
        const type = message.d.eventType, data = message.d.eventData;
        let projected;
        if (type === "StreamStateChanged") {
          const states = ["STARTING", "STARTED", "STOPPING", "STOPPED", "RECONNECTING", "RECONNECTED", "PAUSED", "RESUMED"].map(value => `OBS_WEBSOCKET_OUTPUT_${value}`);
          if (!data || typeof data.outputActive !== "boolean" || !states.includes(data.outputState)) { fail(); return; }
          projected = { type, outputActive: data.outputActive, outputState: data.outputState };
        } else if (["CurrentProfileChanging", "CurrentProfileChanged", "CurrentSceneCollectionChanging", "CurrentSceneCollectionChanged"].includes(type)) {
          const key = type.startsWith("CurrentProfile") ? "profile" : "collection";
          const name = data?.[key === "profile" ? "profileName" : "sceneCollectionName"];
          if (typeof name !== "string" || !name.length || name.length > 1024) { fail(); return; }
          if (type.endsWith("Changing")) {
            changing.add(key);
            // OBS documents RPC during collection switching as undefined.
            for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Local OBS configuration is changing.")); }
            pending.clear();
          } else changing.delete(key);
          projected = { type }; // Names and arbitrary event data stay private.
        }
        if (projected) { try { onRecoveryEvent(projected); } catch { fail(); } }
      } else if (message.op !== 5) fail();
    });
  });
}

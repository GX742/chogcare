import { startPaymentWorker } from "../scripts/start-payments.mjs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const validPassword = value => typeof value === "string" && value.length >= 16 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const knownCodes = new Set(["ready", "stopped", "integrity-locked", "busy", "startup-failed", "chog-network", "nft-network"]);

// This module is never an HTTP service. Its only credential channel is the
// inherited IPC pipe created by the trusted, local Electron main process.
export async function runPrivatePaymentWorker(channel = process, start = startPaymentWorker) {
  if (typeof channel.send !== "function" || !channel.connected) throw new Error("Private desktop IPC is required.");
  let stop, stopping = false, secretRequested = false, secretReceived = false, pendingSecret, timer;
  const send = value => { if (channel.connected) channel.send(value, () => {}); };
  const rejectSecret = () => {
    clearTimeout(timer);
    pendingSecret?.reject(Object.assign(new Error("Startup cancelled."), { code: "ADMIN_CANCELLED" })); pendingSecret = null;
  };
  const shutdown = async () => {
    if (stopping) return;
    stopping = true; rejectSecret();
    try { await stop?.(); send({ type: "stopped" }); }
    catch { send({ type: "event", code: "shutdown-failed", level: "error" }); channel.exitCode = 1; }
    finally { channel.removeListener("message", onMessage); channel.removeListener("disconnect", onDisconnect); if (channel.connected) channel.disconnect(); }
  };
  const onDisconnect = () => { void shutdown(); };
  const onMessage = message => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    if (message.type === "stop" && Object.keys(message).length === 1) { void shutdown(); return; }
    if (message.type !== "secret" || Object.keys(message).length !== 2 || !secretRequested || secretReceived || !pendingSecret || stopping) return;
    secretReceived = true;
    if (!validPassword(message.password)) { message.password = ""; rejectSecret(); return; }
    let password = message.password; message.password = "";
    clearTimeout(timer); const pending = pendingSecret; pendingSecret = null;
    pending.resolve(password); password = "";
  };
  channel.on("message", onMessage); channel.once("disconnect", onDisconnect);
  try {
    const worker = await start({
      registerStop(value) { stop = value; },
      passwordProvider() {
        if (stopping || secretRequested) return Promise.reject(Object.assign(new Error("Startup cancelled."), { code: "ADMIN_CANCELLED" }));
        secretRequested = true;
        const request = new Promise((resolveSecret, reject) => { pendingSecret = { resolve: resolveSecret, reject }; });
        timer = setTimeout(rejectSecret, 30_000);
        send({ type: "secret-request" });
        return request;
      },
      onEvent(event) { if (knownCodes.has(event?.code)) send({ type: "event", code: event.code, level: ["info", "warning", "error"].includes(event.level) ? event.level : "info" }); },
    });
    if (stopping || !worker) { await shutdown(); return; }
    send({ type: "ready" });
  } catch {
    rejectSecret();
    send({ type: "event", code: "startup-failed", level: "error" });
    channel.exitCode = 1;
    await shutdown();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPrivatePaymentWorker().catch(() => { console.error("Private payment startup failed. No credentials were printed."); process.exitCode = 1; });
}

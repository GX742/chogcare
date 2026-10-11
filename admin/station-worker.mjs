import { runStationBridge, parseStationArgs } from "../scripts/station-bridge.mjs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export async function runPrivateStationWorker(channel = process, run = runStationBridge) {
  if (typeof channel.send !== "function" || !channel.connected) throw new Error("Private desktop IPC is required.");
  const args = channel.argv.slice(2);
  const options = parseStationArgs(args);
  if (options.demo || options.simulate) throw new Error("The desktop bridge uses only the selected USB COM port.");
  let bridge, requestedStop = false, shutdownPromise, finishStartup;
  const startupDone = new Promise(ok => { finishStartup = ok; });
  const send = value => { if (channel.connected) channel.send(value, () => {}); };
  const shutdown = () => shutdownPromise ??= (async () => {
    requestedStop = true;
    await startupDone;
    try { await bridge?.close(); send({ type: "stopped" }); }
    catch { send({ type: "event", code: "shutdown-failed", level: "error" }); channel.exitCode = 1; }
    finally { channel.removeListener("message", onMessage); channel.removeListener("disconnect", onDisconnect); if (channel.connected) channel.disconnect(); }
  })();
  const onDisconnect = () => { void shutdown(); };
  const onMessage = message => { if (message?.type === "stop" && Object.keys(message).length === 1) void shutdown(); };
  channel.on("message", onMessage); channel.once("disconnect", onDisconnect);
  try {
    bridge = await run(args);
    if (bridge.finished) void bridge.finished.then(() => shutdown());
    if (!requestedStop) send({ type: "ready" });
  } catch { send({ type: "event", code: "station-failed", level: "error" }); channel.exitCode = 1; }
  finally { finishStartup(); }
  if (requestedStop || !bridge) await shutdown();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPrivateStationWorker().catch(() => { console.error("Private station startup failed. Payments were not changed."); process.exitCode = 1; });
}

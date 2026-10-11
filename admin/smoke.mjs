// Build QA only. No controller, live database, worker, passwords or admin action.
import { app, BrowserWindow, ipcMain, protocol, net, session } from "electron";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFile, mkdir } from "node:fs/promises";
import { ADMIN_URL, assetPath, trustedSender } from "./security.mjs";
const here = fileURLToPath(new URL("./", import.meta.url));
console.log("Build QA: Electron main loaded.");
protocol.registerSchemesAsPrivileged([{ scheme: "chogcare-admin", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.enableSandbox();
void app.whenReady().then(async () => {
console.log("Build QA: Electron ready.");
let window;
try {
  // Verify the packaged Electron Node can parse the workspace's TS imports.
  await import("../server/ops-quotes.mjs");
  console.log("Build QA: workspace imports verified.");
  const root = join(here, "renderer-dist");
  session.fromPartition("chogcare-admin").protocol.handle("chogcare-admin", async request => {
    try { return net.fetch(pathToFileURL(await assetPath(root, request.url)).href); }
    catch { return new Response("Not found", { status: 404 }); }
  });
  const snapshot = { checkedAt: Date.now(), workspacePath: "Build QA — no live workspace", stationPort: "", services: ["payments", "broadcast", "station", "gateway"].map(id => ({ id, state: "unknown", managed: false, detail: "Build QA. No real service was queried." })), payments: null, support: { open: 0, total: 0 }, events: [] };
  for (const [channel, data] of [["admin:snapshot", snapshot], ["admin:settings", { workspacePath: snapshot.workspacePath, stationPort: "", owncastPasswordSet: false }], ["admin:action", snapshot], ["admin:support:list", []]]) ipcMain.handle(channel, event => trustedSender(event, window) ? { ok: true, data } : { ok: false, error: "Invalid sender" });
  window = new BrowserWindow({ width: 1280, height: 850, show: false, backgroundColor: "#140d26", webPreferences: { preload: join(here, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, partition: "chogcare-admin", backgroundThrottling: false } });
  const errors = [];
  window.webContents.on("console-message", (_event, details) => { if (details.level >= 2) errors.push(String(details.message).slice(0, 250)); });
  await window.loadURL(ADMIN_URL);
  console.log("Build QA: renderer loaded.");
  await new Promise(ok => setTimeout(ok, 900));
  const result = await window.webContents.executeJavaScript("({title:document.title,heading:document.querySelector('h1')?.innerText,hasBridge:document.body.innerText.includes('Bridge estimate'),hasSupport:document.body.innerText.includes('Support inbox'),hasPreview:document.body.innerText.includes('Design preview only'),overflow:document.documentElement.scrollWidth>innerWidth,images:[...document.images].map(i=>({loaded:i.complete&&i.naturalWidth>0,alt:i.alt})),ipc:typeof window.chogcareAdmin?.snapshot==='function'})");
  const output = join(here, "..", "work", "admin-qa"); await mkdir(output, { recursive: true });
  await writeFile(join(output, "desktop.png"), (await window.webContents.capturePage()).toPNG());
  await writeFile(join(output, "smoke.json"), JSON.stringify({ node: process.versions.node, electron: process.versions.electron, ...result, errors }, null, 2));
  if (!result.ipc || result.hasPreview || result.overflow || !result.hasBridge || !result.hasSupport || errors.length || result.images.some(item => !item.loaded)) throw Error("Desktop renderer smoke failed.");
  console.log(JSON.stringify({ verified: true, node: process.versions.node, electron: process.versions.electron, ...result, errors }));
  window.destroy(); app.exit(0);
} catch (error) { console.error("Build QA failed:", error.message); window?.destroy(); app.exit(1); }
});

import { app, BrowserWindow, Menu, Tray, nativeImage, protocol, net, ipcMain, dialog, shell, session } from "electron";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createAdminController } from "./controller.mjs";
import { ADMIN_URL, assetPath, trustedSender, safeExternalTarget } from "./security.mjs";

const here = fileURLToPath(new URL("./", import.meta.url));
protocol.registerSchemesAsPrivileged([{ scheme: "chogcare-admin", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.enableSandbox();
app.setName("ChogCare Admin");
// A source-only build check: never enabled by flags in an installed release.
const buildQa = !app.isPackaged && app.commandLine.hasSwitch("chogcare-build-qa");
let window, controller, tray, quitting = false, closing = false;
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { window?.show(); window?.focus(); });

async function workspace() {
  const configPath = join(app.getPath("userData"), "workspace.json");
  let selected;
  try { const data = JSON.parse(await readFile(configPath, "utf8")); if (typeof data.workspacePath === "string") selected = data.workspacePath; } catch {}
  const candidates = [selected, resolve(here, ".."), "C:\\Users\\User\\Documents\\Codex\\2026-10-07\\ghb"].filter(Boolean);
  for (const candidate of candidates) {
    if (!/^[A-Za-z]:[\\/]/.test(candidate) || /^[\\/]{2}/.test(candidate) || resolve(candidate).startsWith("\\\\")) continue;
    try { const pkg = JSON.parse(await readFile(join(candidate, "package.json"), "utf8")); if (pkg.name === "chogcare") return candidate; } catch {}
  }
  const choice = await dialog.showOpenDialog({ title: "Select the ChogCare project folder", properties: ["openDirectory"], buttonLabel: "Use ChogCare folder" });
  if (choice.canceled || !choice.filePaths[0]) throw Error("No project selected.");
  if (!/^[A-Za-z]:[\\/]/.test(choice.filePaths[0]) || /^[\\/]{2}/.test(choice.filePaths[0]) || resolve(choice.filePaths[0]).startsWith("\\\\")) throw Error("Select a local project folder.");
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(configPath, JSON.stringify({ workspacePath: choice.filePaths[0] }), { mode: 0o600 });
  return choice.filePaths[0];
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, input) => {
    if (!trustedSender(event, window)) return { ok: false, error: "Local application access required." };
    try { return { ok: true, data: await callback(input) }; }
    catch { return { ok: false, error: "The action could not be completed. Check the activity panel and service status." }; }
  });
}

async function requestQuit() {
  if (closing) return;
  closing = true;
  const answer = await dialog.showMessageBox(window, { type: "question", title: "Quit ChogCare Admin?", message: "App-managed payments, USB bridge and offline support will stop safely.", detail: "Owncast, nginx and OBS keep running until you stop them explicitly. Existing external workers are untouched. To keep app-managed payments and support running, leave ChogCare Admin in the system tray.", buttons: ["Keep running", "Stop local workers and quit"], defaultId: 0, cancelId: 0 });
  if (answer.response !== 1) { closing = false; return; }
  try { await controller?.close(); quitting = true; tray?.destroy(); app.quit(); }
  catch { closing = false; await dialog.showMessageBox(window, { type: "warning", message: "A service has not finished stopping.", detail: "The app will remain open. No process was forcibly terminated.", buttons: ["OK"] }); }
}

void app.whenReady().then(async () => {
let startupPhase = "workspace";
try {
  const localWorkspace = await workspace(); startupPhase = "controller";
  controller = await createAdminController({ workspacePath: localWorkspace });
  startupPhase = "renderer";
  const rendererRoot = join(here, "renderer-dist");
  session.fromPartition("chogcare-admin").protocol.handle("chogcare-admin", async request => {
    try { return net.fetch(pathToFileURL(await assetPath(rendererRoot, request.url)).href); }
    catch { return new Response("Not found", { status: 404 }); }
  });
  window = new BrowserWindow({ width: 1360, height: 900, minWidth: 1000, minHeight: 720, backgroundColor: "#140d26", title: "ChogCare Admin", show: false,
    icon: join(here, "assets", "coin.png"),
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: !app.isPackaged, spellcheck: false, partition: "chogcare-admin", backgroundThrottling: !buildQa },
  });
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("chogcare-admin://app/") && !details.url.startsWith("data:image/") }));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  window.on("close", event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  window.once("ready-to-show", () => { if (!buildQa) window.show(); });
  Menu.setApplicationMenu(null);
  handle("admin:snapshot", () => controller.snapshot());
  handle("admin:settings", () => controller.settings());
  handle("admin:action", input => controller.action(input));
  handle("admin:quote", input => controller.quote(input));
  handle("admin:support:list", input => controller.listSupport(input));
  handle("admin:support:update", input => controller.updateSupport(input));
  handle("admin:open", async target => { await shell.openExternal(safeExternalTarget(target)); return true; });
  const image = nativeImage.createFromPath(join(here, "assets", "coin.png")).resize({ width: 24, height: 24 });
  tray = new Tray(image); tray.setToolTip("ChogCare Admin — local services");
  tray.setContextMenu(Menu.buildFromTemplate([{ label: "Open ChogCare Admin", click: () => { window.show(); window.focus(); } }, { type: "separator" }, { label: "Quit safely", click: () => void requestQuit() }]));
  tray.on("double-click", () => { window.show(); window.focus(); });
  await window.loadURL(ADMIN_URL);
  if (buildQa) {
    await new Promise(done => setTimeout(done, 1200));
    const result = await window.webContents.executeJavaScript("({title:document.title,heading:document.querySelector('h1')?.innerText,ipc:typeof window.chogcareAdmin?.snapshot==='function',hasPreview:document.body.innerText.includes('Design preview only'),imagesLoaded:[...document.images].every(i=>i.complete&&i.naturalWidth>0),overflow:document.documentElement.scrollWidth>innerWidth})");
    if (!result.ipc || result.hasPreview || !result.imagesLoaded || result.overflow) throw Error("Native startup check failed.");
    const output = join(controller.settings().workspacePath, "work", "admin-qa");
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "native-startup.png"), (await window.webContents.capturePage()).toPNG());
    await writeFile(join(output, "native-startup.json"), JSON.stringify({ verified: true, ...result }, null, 2));
    await controller.close(); quitting = true; tray.destroy(); window.destroy();
    console.log("Verified real application startup; no financial worker was started."); app.exit(0);
  }
} catch {
  if (buildQa) { try { await controller?.close(); } catch {} quitting = true; window?.destroy(); console.error(`Native startup check failed at ${startupPhase}. No password was read or payment started.`); app.exit(1); return; }
  await dialog.showMessageBox({ type: "error", title: "ChogCare Admin", message: "ChogCare Admin could not open the local project.", detail: "Use the ChogCare project folder with its installed Node.js runtime and dependencies. No payment service was stopped or changed.", buttons: ["OK"] });
  try { await controller?.close(); } catch {}
  quitting = true; app.quit();
}
});
app.on("before-quit", event => { if (!quitting) { event.preventDefault(); void requestQuit(); } });
app.on("window-all-closed", () => { /* Keep managed services alive in the tray. */ });

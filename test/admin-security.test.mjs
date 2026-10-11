import test from "node:test";
import assert from "node:assert/strict";
import { resolve, join, relative, basename } from "node:path";
import { mkdir, mkdtemp, writeFile, rm, symlink, realpath, readFile } from "node:fs/promises";
import { assetPath, trustedSender, safeExternalTarget, ADMIN_URL } from "../admin/security.mjs";
async function assetFixture(t) {
  const testRoot = resolve("work"); await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, "admin-asset-test-")), root = join(directory, "built");
  t.after(async () => {
    const child = relative(testRoot, resolve(directory));
    assert.ok(child && !child.startsWith("..") && !child.includes("/") && !child.includes("\\") && basename(directory).startsWith("admin-asset-test-"));
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(join(root, "assets"), { recursive: true }); await mkdir(join(root, "admin"));
  await writeFile(join(root, "assets/main.js"), "// test asset"); await writeFile(join(root, "admin/index.html"), "<html></html>");
  return { root, directory };
}
test("admin resource boundary serves only existing built assets and the exact entry page", async t => {
  const { root } = await assetFixture(t);
  assert.equal(await assetPath(root,"chogcare-admin://app/assets/main.js"),await realpath(join(root,"assets/main.js")));
  assert.equal(await assetPath(root,"chogcare-admin://app/admin/index.html"),await realpath(join(root,"admin/index.html")));
  for (const target of ["https://app/assets/main.js","chogcare-admin://evil/assets/main.js","chogcare-admin://app/work/vault.json","chogcare-admin://app/%2e%2e%5cprivate.png","chogcare-admin://app/%2f%2e%2e%2fkey.png","chogcare-admin://app/assets/main.js?q=1","chogcare-admin://user:pass@app/assets/main.js","chogcare-admin://app/assets/main.js#x","chogcare-admin://app/assets/.hidden.js","chogcare-admin://app/admin/other.html","chogcare-admin://app/assets/other.html","chogcare-admin://app/scripts/main.js","chogcare-admin://app/assets/missing.js"]) await assert.rejects(assetPath(root,target));
});

test("admin resource boundary rejects a junction or symlink escaping its build directory", async t => {
  const { root, directory } = await assetFixture(t), outside = join(directory, "outside");
  await mkdir(outside); await writeFile(join(outside, "private.js"), "// secret test fixture only");
  try { await symlink(outside, join(root, "assets/escape"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error.code === "EPERM") { t.skip("This Windows test account cannot create a junction/symlink."); return; } throw error; }
  await assert.rejects(assetPath(root,"chogcare-admin://app/assets/escape/private.js"));
});
test("admin IPC requires its exact trusted main frame", () => {
  const frame={url:ADMIN_URL},webContents={mainFrame:frame},window={webContents,isDestroyed:()=>false};
  assert.equal(trustedSender({sender:webContents,senderFrame:frame},window),true);
  assert.equal(trustedSender({sender:{},senderFrame:frame},window),false);
  assert.equal(trustedSender({sender:webContents,senderFrame:{url:ADMIN_URL}},window),false);
  frame.url="https://chogcare.vercel.app";
  assert.equal(trustedSender({sender:webContents,senderFrame:frame},window),false);
});
test("external links are fixed destinations, never ticket or renderer supplied URLs",()=>{
  assert.equal(safeExternalTarget("dashboard"),"https://chogcare.vercel.app/dashboard");
  for(const value of ["https://evil.test","file:///C:/Windows/System32/cmd.exe","mailto:user@example.com","website?x=1",null,{},"Dashboard"])assert.throws(()=>safeExternalTarget(value));
});

test("admin native bootstrap runs after readiness without an ESM top-level readiness await", async () => {
  const source = await readFile(new URL("../admin/main.mjs", import.meta.url), "utf8");
  assert.ok(source.includes("void app.whenReady().then(async () => {"));
  assert.ok(!/await\s+app\.whenReady\(/.test(source));
  assert.ok(source.indexOf("protocol.registerSchemesAsPrivileged") < source.indexOf("app.whenReady()"));
  const handle = source.indexOf('session.fromPartition("chogcare-admin").protocol.handle("chogcare-admin"');
  assert.ok(handle > source.indexOf("app.whenReady()"));
  assert.ok(handle < source.indexOf("new BrowserWindow("));
  assert.ok(source.includes('partition: "chogcare-admin"'));
  assert.ok(source.includes("pathToFileURL(await assetPath(rendererRoot, request.url))"));
  assert.ok(!/^\s*(?:await\s+)?protocol\.handle\(/m.test(source));
  assert.ok(source.indexOf("await window.loadURL(ADMIN_URL)") > handle);
});

test("admin package hardens ASAR and inspector flags without breaking its native Node worker IPC", async () => {
  const pkg = JSON.parse(await readFile(new URL("../admin/package.json", import.meta.url), "utf8"));
  const controller = await readFile(new URL("../admin/controller.mjs", import.meta.url), "utf8");
  const schema = JSON.parse(await readFile(new URL("../node_modules/app-builder-lib/scheme.json", import.meta.url), "utf8"));
  assert.equal(pkg.build.asar, true); assert.notEqual(pkg.build.disableAsarIntegrity, true);
  const fuses = pkg.build.electronFuses;
  for (const [name, value] of Object.entries(fuses)) {
    assert.equal(schema.definitions.FuseOptionsV1.properties[name]?.type, "boolean");
    assert.equal(typeof value, "boolean");
  }
  assert.equal(fuses.enableCookieEncryption, true);
  assert.equal(fuses.enableNodeOptionsEnvironmentVariable, false);
  assert.equal(fuses.enableNodeCliInspectArguments, false);
  assert.equal(fuses.enableEmbeddedAsarIntegrityValidation, true);
  assert.equal(fuses.onlyLoadAppFromAsar, true);
  // Electron 44.7 refuses child_process.fork before honoring execPath when
  // RunAsNode is disabled. Change this fuse only with the worker transport.
  assert.equal(fuses.runAsNode, true);
  assert.ok(controller.includes("execPath: nodePath"));
  assert.ok(controller.includes("execArgv: []"));
  assert.ok(controller.includes('stdio: ["ignore", "pipe", "pipe", "ipc"]'));
  assert.ok(controller.includes("env: safeWorkerEnvironment(workspace, nodePath)"));
});

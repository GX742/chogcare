import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/admin/AdminApp.tsx", import.meta.url), "utf8");
const controller = readFileSync(new URL("../admin/controller.mjs", import.meta.url), "utf8");

test("screen test is explicit, device-confirmed and disabled for disconnected/external/busy stations",()=>{
  assert.match(source,/className="admin-button admin-outline admin-test-button"/);
  assert.match(source,/disabled=\{!api \|\| !service.managed \|\| !running \|\| Boolean\(busy\) \|\| snapshot\?\.stationTest === "running"\}/);
  assert.match(source,/act\(\{ type: "station.test" \}, "station.test"\)/);
  assert.match(source,/TEST - NO PAYMENT/);assert.match(source,/role="status" aria-live="polite"/);
  assert.match(source,/confirmed by the device/);assert.match(source,/No transaction, history or leaderboard entry/);
});

test("Connect and Save share the exact controller COM port constraint", () => {
  const expression = source.match(/const validPort = (\/[^\n]+?\/)\.test\(port\);/)?.[1];
  const serverExpression = controller.match(/const COM = (\/[^\n]+?\/);/)?.[1];
  assert.equal(expression, "/^COM[1-9]\\d{0,2}$/");
  assert.equal(expression, serverExpression);
  assert.ok(source.includes('disabled={!api || running || !validPort || Boolean(busy)} onClick={() => void act({ type: "station.start", port }, "station.start")}'));
  assert.ok(source.includes('disabled={!api || !validPort || Boolean(busy)} onClick={() => void act({ type: "settings.save", stationPort: port }, "settings.save")}'));
});

test("COM1 through COM999 are accepted, zero, padding and four digits are rejected", () => {
  const expression = source.match(/const validPort = \/([^\n]+?)\/\.test\(port\);/)?.[1];
  assert.ok(expression);
  const validator = new RegExp(expression);
  for (const port of ["COM1", "COM3", "COM9", "COM10", "COM99", "COM100", "COM999"]) assert.equal(validator.test(port), true, port);
  for (const port of ["COM0", "COM00", "COM01", "COM1000", "com3", " COM3", "COM3 ", "COM", "3"]) assert.equal(validator.test(port), false, port);
});

test("password input matches custody 16–256 and Owncast 1–256 character limits", () => {
  assert.match(source, /const passwordMinimum = confirmation\?\.type === "broadcast\.configure" \? 1 : 16;/);
  const passwordInput = source.match(/<input type="password"[\s\S]+?\/>/)?.[0];
  assert.ok(passwordInput);
  assert.match(passwordInput, /maxLength=\{256\}/);
  assert.match(passwordInput, /minLength=\{passwordMinimum\}/);
  assert.match(passwordInput, /autoComplete="off"/);
  assert.doesNotMatch(passwordInput, /maxLength=\{1024\}/);
  assert.match(source, /confirmation\?\.password && password\.length < passwordMinimum/);
});

test("password length is checked again before IPC and credentials are cleared", () => {
  const action = source.slice(source.indexOf("async function confirmAction()"), source.indexOf("async function getEstimate()"));
  const validation = action.indexOf("password.length < passwordMinimum || password.length > 256");
  assert.ok(validation >= 0 && validation < action.indexOf("let credential = password"));
  assert.match(action, /let credential = password; setPassword\(""\)/);
  assert.match(action, /finally \{ credential = ""; setBusy\(""\); \}/);
});

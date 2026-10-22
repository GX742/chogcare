import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(resolve(process.env.USERPROFILE, ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/package.json"));
const { chromium, webkit, devices } = require("playwright");
const root = resolve("dist"), output = resolve("work/leaderboard-design-qa");
await mkdir(output, { recursive: true });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) throw Error("API must be mocked");
    const path = resolve(root, "." + (url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)));
    if (!path.startsWith(root + sep)) throw Error("Invalid path");
    res.setHeader("Content-Type", types[extname(path)] ?? "application/octet-stream"); res.end(await readFile(path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(ok => server.listen(0, "127.0.0.1", ok));
const origin = process.env.QA_SITE_ORIGIN ?? `http://127.0.0.1:${server.address().port}`;
const engine = process.env.QA_BROWSER === "webkit" ? "webkit" : "chrome";
const browser = await (engine === "webkit" ? webkit.launch({ headless: true }) : chromium.launch({ channel: "chrome", headless: true }));
const results = [];
try {
  for (const width of engine === "webkit" ? [390, 320] : [1440, 768, 390, 320]) {
    const context = await browser.newContext({ ...(width < 768 ? devices["iPhone 13"] : {}), viewport: { width, height: 900 }, reducedMotion: "reduce" });
    const page = await context.newPage(); let scenario = "normal", writes = 0;
    await page.route("**/api/**", async route => {
      if (route.request().method() !== "GET") { writes++; return route.abort(); }
      const path = new URL(route.request().url()).pathname;
      if ((scenario === "offline" && (path.endsWith("dashboard") || path.endsWith("leaderboard"))) || (scenario === "no-quote" && path.endsWith("chog-rate"))) return route.fulfill({ status: 503, body: "{}" });
      const amount = scenario === "large" ? "9007199254740993" : scenario === "zero" ? "0" : "3600";
      const body = path.endsWith("dashboard") ? { impact: { chogDonated: amount, donations: scenario === "zero" ? 0 : 12 } } :
        path.endsWith("chog-rate") ? { referenceChog: "300", estimatedUsdMicros: "487917", quotedAt: Date.now() } :
        path.endsWith("leaderboard") ? { entries: scenario === "zero" ? [] : [{ rank: 1, nickname: "gx", initiativeId: "school-supplies", amount: "1500", status: "delivered", avatarImage: null }], pool: scenario === "pool-unavailable" ? null : { donatedUsdc: scenario === "zero" ? "0" : scenario === "large" ? "9007199254740993000001" : "2500000", donations: scenario === "zero" ? 0 : 4 } } : {};
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    for (scenario of ["normal", "zero", "offline", "no-quote", "large", "pool-unavailable"]) {
      await page.goto(`${origin}/?boardqa=${scenario}#leaderboard`, { waitUntil: "domcontentloaded" });
      await page.locator(".leaderboard-impact[aria-busy=false]").waitFor(); await page.evaluate(() => document.fonts.ready);
      const total = await page.locator(".leaderboard-impact-amount strong").innerText();
      assert.equal(total, scenario === "offline" ? "—" : scenario === "zero" ? "0" : scenario === "large" ? "9,007,199,254,740,993" : "3,600");
      const sub = await page.locator(".leaderboard-impact-usd").innerText();
      if (scenario === "normal") assert.equal(sub, "(≈ $5.86 USD)");
      if (scenario === "offline") assert.match(sub, /unavailable/);
      if (scenario === "no-quote") assert.equal(sub, "(USD estimate unavailable)");
      assert.equal(await page.locator("#leaderboard").count(), 1);
      assert.equal(await page.locator(".leaderboard-pool").count(), 1);
      assert.equal(await page.locator(".leaderboard-board ol .leaderboard-pool").count(), 0, "pool must not receive a donor rank");
      assert.equal(await page.locator(".leaderboard-pool-total strong").innerText(), ["offline", "pool-unavailable"].includes(scenario) ? "—" : scenario === "zero" ? "0.00" : scenario === "large" ? "9,007,199,254,740,993.000001" : "2.50");
      if (["offline", "pool-unavailable"].includes(scenario)) assert.match(await page.locator(".leaderboard-pool-total small").innerText(), /unavailable/);
      const bounds = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, after: document.querySelector("#leaderboard").getBoundingClientRect().top >= document.querySelector("#causes").getBoundingClientRect().bottom, innerOverflow: [...document.querySelectorAll(".leaderboard-impact,.leaderboard-ranking")].some(el => el.scrollWidth > el.clientWidth + 1) }));
      assert.deepEqual(bounds, { overflow: false, after: true, innerOverflow: false }, `${width}: ${scenario}`);
      if (scenario === "normal") {
        const compact = await page.evaluate(() => {
          const board = document.querySelector("#leaderboard").getBoundingClientRect();
          const digits = document.querySelector(".leaderboard-impact-amount strong").getBoundingClientRect();
          const usd = document.querySelector(".leaderboard-impact-usd").getBoundingClientRect();
          const initiatives = document.querySelector(".care-lower-world").getBoundingClientRect();
          return { height: board.height, centerError: Math.abs(digits.left + digits.width / 2 - (board.left + board.width / 2)), usdError: Math.abs(digits.left + digits.width / 2 - (usd.left + usd.width / 2)), widthError: Math.abs(board.width - initiatives.width) };
        });
        assert.ok(compact.centerError < 2, "digits must be centered independently of the ticker");
        assert.ok(compact.usdError < 2, "USD and CHOG digits share the same center");
        assert.ok(compact.widthError < 2, "board matches the initiative panel width");
        // Budget includes one ranked donor and the separate pool row, whose
        // exact USDC total stacks below its identity on narrow screens.
        assert.ok(compact.height < 600, `${width}: compact board is too tall (${compact.height})`);
      }
      if (scenario === "normal" || scenario === "large") await page.locator("#leaderboard").screenshot({ path: resolve(output, `${engine}-${width}-${scenario}.png`), style: ".site-header,.skip-link { visibility:hidden!important; }" });
      results.push({ width, scenario });
    }
    assert.equal(writes, 0); await context.close();
  }
  console.log(JSON.stringify({ verified: true, engine, results, paymentWrites: 0 }));
} finally { await browser.close(); await new Promise(ok => server.close(ok)); }

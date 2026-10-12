import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { stripTypeScriptTypes } from "node:module";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const source = stripTypeScriptTypes(read("../src/HeartField.tsx")
  .replace(/^import .*;\r?\n/, "")
  .replace("export default function HeartField", "function HeartField")
  .replace(/return <canvas[^;]+;/, "return null;"));

// Exercise the real background effect without a GPU or network. In particular,
// simulate visual-viewport changes independently from the stable canvas bounds.
function field({ compact = true, reduced = false } = {}) {
  let paints = 0, scheduled = 0, bitmapWrites = 0;
  const events = new Map(), queries = new Map(), effects = [];
  const context = new Proxy({}, { get: (_, key) => {
    if (key === "clearRect") return () => paints++;
    if (key === "createLinearGradient") return () => ({ addColorStop() {} });
    return () => {};
  }});
  let bitmapWidth = 0, bitmapHeight = 0;
  const bounds = { width: 390, height: 844 };
  const canvas = {
    getContext: () => context,
    getBoundingClientRect: () => bounds,
    get width() { return bitmapWidth; },
    set width(value) { bitmapWidth = value; bitmapWrites++; },
    get height() { return bitmapHeight; },
    set height(value) { bitmapHeight = value; bitmapWrites++; },
  };
  const listen = prefix => ({
    addEventListener(name, callback) { events.set(prefix + name, callback); },
    removeEventListener(name) { events.delete(prefix + name); },
  });
  const document = {
    hidden: false,
    documentElement: { clientWidth: 390, ...listen("root:") },
    querySelector: () => ({ getBoundingClientRect: () => ({ bottom: 180 }) }),
    createElement: () => ({ getContext: () => context }),
    ...listen("document:"),
  };
  const window = {
    innerHeight: 844, devicePixelRatio: 3,
    matchMedia(query) {
      const media = { matches: query.includes("max-width") ? compact : reduced, ...listen(query + ":") };
      queries.set(query, media);
      return media;
    },
    ...listen("window:"),
  };
  runInNewContext(source + "\nHeartField({ paused: false });", {
    window, document, Path2D: class {},
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => ++scheduled, cancelAnimationFrame() {},
    useRef: value => ({ current: value === null ? canvas : value }),
    useEffect: callback => effects.push(callback),
  });
  const cleanup = effects[0]();
  return {
    window, document, canvas, bounds, events, queries, cleanup,
    stats: () => ({ paints, scheduled, bitmapWrites }),
    fire: event => events.get(event)?.(),
  };
}

test("mobile heart artwork is static, density-capped and fixed during scrolling", () => {
  const view = field();
  assert.equal(view.stats().scheduled, 0);
  assert.equal(view.canvas.width, 585);
  assert.equal(view.canvas.height, 1266);
  const before = view.stats();
  view.fire("window:scroll");
  assert.deepEqual(view.stats(), before);
  view.cleanup();
  assert.equal(view.events.size, 0, "all listeners are removed on unmount");
});

test("address-bar and keyboard height changes do not rebuild the mobile field", () => {
  const view = field();
  const before = view.stats();
  for (const height of [780, 500, 844]) {
    view.window.innerHeight = height;
    view.fire("window:resize");
    assert.deepEqual(view.stats(), before);
  }
  view.document.documentElement.clientWidth = 430;
  view.bounds.width = 430;
  view.fire("window:resize");
  assert.equal(view.canvas.width, 645, "rotation/width changes still redraw");
  assert.ok(view.stats().bitmapWrites > before.bitmapWrites);
  assert.equal(view.stats().scheduled, 0);
  view.cleanup();
});

test("desktop animation remains available and reduced motion stays respected", () => {
  const desktop = field({ compact: false });
  assert.equal(desktop.stats().scheduled, 1);
  assert.equal(desktop.canvas.width, 780);
  desktop.cleanup();
  const reduced = field({ compact: false, reduced: true });
  assert.equal(reduced.stats().scheduled, 0);
  reduced.cleanup();
});

test("phone UI retains stable viewport background, readable inputs and bounded tabs", () => {
  assert.match(read("../src/styles.css"), /height: 100lvh/);
  const mobile = read("../src/station-redesign.css");
  assert.match(mobile, /nav \.lp-nav-donate \{ grid-column: 1 \/ -1/);
  assert.match(mobile, /checkout-address-input \{ font-size: 16px/);
  assert.match(mobile, /lp-payment-tabs \{[^}]*minmax\(0, 1fr\)/);
  assert.match(read("../src/support-dialog.css"), /overscroll-behavior:contain/);
});

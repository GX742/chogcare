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
  const events = new Map(), queries = new Map(), effects = [], frames = [];
  const observed = [];
  const glyphPositions = [];
  let notifyLayout = () => {};
  const context = new Proxy({}, { get: (_, key) => {
    if (key === "clearRect") return () => paints++;
    if (key === "createLinearGradient") return () => ({ addColorStop() {} });
    if (key === "drawImage") return (_image, x, y) => glyphPositions.push([x, y]);
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
    ResizeObserver: class { constructor(callback) { notifyLayout = callback; } observe(target) { observed.push(target); } disconnect() {} },
    requestAnimationFrame: callback => { frames.push(callback); return ++scheduled; }, cancelAnimationFrame() {},
    useRef: value => ({ current: value === null ? canvas : value }),
    useEffect: callback => effects.push(callback),
  });
  const cleanup = effects[0]();
  return {
    window, document, canvas, bounds, events, queries, cleanup,
    stats: () => ({ paints, scheduled, bitmapWrites }),
    fire: event => events.get(event)?.(),
    tick: time => frames.shift()?.(time),
    notifyLayout: () => notifyLayout(), observed, glyphPositions,
  };
}

test("mobile heart colors animate at retina density while artwork stays fixed on scroll", () => {
  const view = field();
  assert.equal(view.stats().scheduled, 1);
  assert.equal(view.canvas.width, 780);
  assert.equal(view.canvas.height, 1688);
  const before = view.stats();
  view.fire("window:scroll");
  assert.deepEqual(view.stats(), before);
  view.tick(1);
  view.tick(51);
  assert.ok(view.stats().paints > before.paints, "colors continue flowing without scrolling");
  view.cleanup();
  assert.equal(view.events.size, 0, "all listeners are removed on unmount");
});

test("late CSS canvas growth redraws the entire bitmap without a window resize event", () => {
  const view = field();
  assert.ok(view.observed.includes(view.canvas), "the actual canvas box is observed");
  view.bounds.height = 1004;
  view.notifyLayout();
  assert.equal(view.canvas.height, 2008, "drawing covers the extended retina canvas");
  const after = view.stats();
  view.notifyLayout();
  assert.deepEqual(view.stats(), after, "intrinsic bitmap writes cannot create a resize loop");
  view.cleanup();
});

test("iPhone unsafe regions receive a root-level heart pattern, not a plain color", () => {
  assert.match(read("../index.html"), /viewport-fit=cover/);
  assert.match(read("../src/station-redesign.css"), /html:has\(\.landing-page\), body:has\(\.landing-page\) \{ background: #0e0a19; \}/);
  const tile = read("../public/chog-heart-tile.svg");
  assert.match(tile, /viewBox="0 0 104 100"/);
  assert.match(tile, /linearGradient/);
  assert.doesNotMatch(tile, /<script|onload=|href="https?:/);
  assert.match(read("../src/ops-dashboard.css"), /padding-top:env\(safe-area-inset-top\)/);
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
  assert.equal(view.canvas.width, 860, "rotation/width changes still redraw");
  assert.ok(view.stats().bitmapWrites > before.bitmapWrites);
  assert.equal(view.stats().scheduled, 2);
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
  const reducedMobile = field({ compact: true, reduced: true });
  assert.equal(reducedMobile.stats().scheduled, 0);
  reducedMobile.cleanup();
});

test("phone UI retains stable viewport background, readable inputs and bounded tabs", () => {
  assert.match(read("../src/styles.css"), /height: calc\(100lvh \+ 160px\)/);
  const mobile = read("../src/station-redesign.css");
  assert.match(mobile, /care-header-inner nav \{ display: none/);
  assert.match(mobile, /checkout-address-input \{ font-size: 16px/);
  assert.match(mobile, /lp-payment-tabs \{[^}]*minmax\(0, 1fr\)/);
  assert.match(read("../src/support-dialog.css"), /overscroll-behavior:contain/);
});

test("iPhone root has no always-visible hearts and mobile checkout puts stream first",()=>{
  const mobile=read("../src/station-redesign.css"),sunset=read("../src/sunset-redesign.css");
  assert.match(mobile,/html:has\(\.landing-page\), body:has\(\.landing-page\) \{ background: #0e0a19; \}/);
  assert.doesNotMatch(mobile,/html:has\(\.landing-page\)[^}]*chog-heart-tile/);
  assert.match(sunset,/care-heart-scene \{[^}]*opacity: 0/);
  assert.match(sunset,/care-station-grid \{ grid-template-areas: "stream" "checkout"; \}/);
  assert.doesNotMatch(sunset,/grid-template-areas: "checkout" "stream"/);
});

test("mobile header is fixed, opaque, safe-area padded and shows the creator avatar", () => {
  const mobile = read("../src/station-redesign.css");
  assert.match(mobile, /site-header \{ position: fixed; inset: 0 0 auto/);
  assert.match(mobile, /overscroll-behavior-y: none/);
  assert.match(mobile, /padding-top: calc\(76px \+ env\(safe-area-inset-top\)\)/);
  assert.match(mobile, /creator > img \{ display: block/);
  assert.match(mobile, /heart-field \{ clip-path: inset\(calc\(76px/);
  assert.match(read("../src/App.tsx"), /<img\b[^>]*src="\/gx-avatar\.png"[^>]*alt="GX avatar"[^>]*>/);
});

test("phone heart glyphs have real horizontal and vertical gutters, including the fallback tile", () => {
  const view = field();
  const [x, y] = view.glyphPositions[0];
  assert.equal(view.glyphPositions[1][0] - x, 26);
  const nextRow = view.glyphPositions.find(position => position[1] !== y);
  assert.ok(nextRow);
  assert.equal(nextRow[1] - y, 25);
  assert.ok(26 > 23.65 && 25 > 22.15, "pitch exceeds the outlined glyph dimensions");
  const tile = read("../public/chog-heart-tile.svg");
  const cells = Array.from(tile.matchAll(/<use href="#heart" x="([\d.]+)" y="([\d.]+)"/g), match => [Number(match[1]), Number(match[2])]);
  assert.equal(cells.length, 16);
  assert.equal(cells[1][0] - cells[0][0], 26);
  assert.equal(cells[4][1] - cells[0][1], 25);
  view.cleanup();
});

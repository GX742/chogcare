import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

const source = stripTypeScriptTypes(readFileSync(new URL('../src/landing-transition.ts', import.meta.url), 'utf8'))
  .replace('import gsap from "gsap";', '').replaceAll('export ', '');
function harness({ native = true, reduced = false } = {}) {
  const classes = new Set(), timers = new Map(), steps = [];
  let callback, resolveNative, complete, reverted = 0, removed = 0, skipped = 0;
  const element = { setAttribute() {}, remove() { removed++; } };
  const document = {
    documentElement: { classList: { add: value => classes.add(value), remove: value => classes.delete(value) } },
    createElement: () => element, body: { appendChild() {} },
    ...(native ? { startViewTransition(update) {
      callback = update;
      return { ready: Promise.resolve(), finished: new Promise(resolve => { resolveNative = resolve; }), skipTransition() { skipped++; } };
    } } : {}),
  };
  const gsap = {
    context(run) { run(); return { revert() { reverted++; } }; },
    timeline(options) {
      complete = options.onComplete;
      const timeline = { to(_target, vars) { steps.push(vars); return timeline; }, call(run) { steps.push(run); return timeline; } };
      return timeline;
    },
  };
  const transition = runInNewContext(source + '\ntransitionLanding;', {
    document, window: { matchMedia: () => ({ matches: reduced }) }, gsap,
    setTimeout(run) { timers.set(1, run); return 1; }, clearTimeout(id) { timers.delete(id); },
  });
  return { transition, classes, steps, timers, apply: () => callback(), finish: () => resolveNative(), complete: () => complete(),
    stats: () => ({ reverted, removed, skipped }) };
}

test('native navigation paints the destination in its update, keeps transition active, and cleans up after completion', async () => {
  const h = harness(); let updates = 0;
  const transition = h.transition(() => updates++);
  assert.equal(updates, 0);
  assert.ok(h.classes.has('care-navigation-transition'));
  h.apply(); assert.equal(updates, 1);
  assert.ok(h.classes.has('care-navigation-transition'));
  h.finish(); await transition.finished;
  assert.equal(h.classes.size, 0);
});

test('cancelled navigation cannot mutate the route or leak a viewport transition', async () => {
  const h = harness(); let updates = 0;
  const transition = h.transition(() => updates++);
  transition.cancel(); h.apply(); await transition.finished;
  assert.equal(updates, 0); assert.equal(h.classes.size, 0); assert.equal(h.stats().skipped, 1);
});

test('reduced motion updates once without snapshots or animations and clears its task', async () => {
  const h = harness({ reduced: true }); let updates = 0;
  const transition = h.transition(() => updates++);
  assert.equal(h.classes.size, 0); assert.equal(h.steps.length, 0);
  h.timers.get(1)(); await transition.finished;
  assert.equal(updates, 1); assert.equal(h.timers.size, 0);
});

test('compatibility animation covers route mutation before revealing it and releases its scoped veil', async () => {
  const h = harness({ native: false }); let updates = 0;
  const transition = h.transition(() => updates++);
  assert.equal(h.steps[0].opacity, 1); assert.equal(h.steps[2].opacity, 0); assert.equal(updates, 0);
  h.steps[1](); assert.equal(updates, 1);
  h.complete(); await transition.finished;
  assert.deepEqual(h.stats(), { reverted: 1, removed: 1, skipped: 0 });
  transition.cancel(); assert.equal(h.stats().removed, 1);
});

test('compatibility cancellation stops mutation and cleans its animation', async () => {
  const h = harness({ native: false }); let updates = 0;
  const transition = h.transition(() => updates++);
  transition.cancel(); h.steps[1](); await transition.finished;
  assert.equal(updates, 0); assert.equal(h.stats().reverted, 1); assert.equal(h.stats().removed, 1);
});

test('return positioning catches up only its own scrubbed scene and retains an opaque outgoing snapshot', () => {
  const scene = readFileSync(new URL('../src/SunsetScene.tsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/sunset-redesign.css', import.meta.url), 'utf8');
  assert.match(app, /transitionLanding\(\(\) => flushSync/);
  assert.match(app, /dispatchEvent\(new Event\(landingPositioned\)\)/);
  assert.match(scene, /trigger\.getTween\(\)\?\.progress\(1\)/);
  assert.match(scene, /sceneTween\?\.progress\(trigger\.progress\)/);
  assert.match(scene, /removeEventListener\(landingPositioned, alignWithViewport\)/);
  assert.match(css, /view-transition-old\(root\) \{ animation: none; opacity: 1/);
});

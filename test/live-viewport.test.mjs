import test from "node:test";
import assert from "node:assert/strict";
import { createLiveViewportPresence } from "../src/live-viewport.ts";

function fixture() {
  let visible = false, next = 0, reads = 0;
  const frames = new Map(), changes = [];
  const presence = createLiveViewportPresence({
    read() { reads++; return visible; },
    onChange(value) { changes.push(value); },
    schedule(callback) { const id = ++next; frames.set(id, callback); return id; },
    cancel(id) { frames.delete(id); },
  });
  return {
    presence, changes,
    setVisible(value) { visible = value; },
    flush() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); },
    get pending() { return frames.size; },
    get reads() { return reads; },
  };
}

test("batched exit and re-entry notifications reconcile current geometry once", () => {
  const view = fixture();
  view.setVisible(true); view.presence.invalidate(); view.flush();
  assert.deepEqual(view.changes, [true]);
  view.setVisible(false); view.presence.invalidate();
  view.setVisible(true); view.presence.invalidate();
  assert.equal(view.pending, 1);
  view.flush();
  assert.deepEqual(view.changes, [true], "A queued exit must not suspend the currently visible player");
  assert.equal(view.reads, 2);
});

test("a stale intersecting notification cannot latch presence before geometry catches up", () => {
  const view = fixture();
  // The old observer record says visible, but its callback only invalidates.
  view.presence.invalidate(); view.flush();
  assert.deepEqual(view.changes, []);
  // A later captured scroll/resize sees current geometry without requiring
  // another observer threshold crossing or media event to resume playback.
  view.setVisible(true); view.presence.invalidate(); view.flush();
  assert.deepEqual(view.changes, [true]);
  view.setVisible(false); view.presence.invalidate(); view.flush();
  assert.deepEqual(view.changes, [true, false]);
});

test("unchanged visible scroll/resize notifications do not repeatedly resume or reset recovery", () => {
  const view = fixture();
  view.setVisible(true); view.presence.invalidate(); view.flush();
  for (let frame = 0; frame < 20; frame++) {
    for (let event = 0; event < 10; event++) view.presence.invalidate();
    assert.equal(view.pending, 1);
    view.flush();
  }
  assert.deepEqual(view.changes, [true]);
  assert.equal(view.reads, 21);
});

test("hidden/offline suspension is immediate and visible recovery requires a new geometry check", () => {
  const view = fixture();
  view.setVisible(true); view.presence.invalidate(); view.flush();
  view.presence.invalidate(); view.presence.suspend();
  assert.equal(view.pending, 0);
  assert.deepEqual(view.changes, [true, false]);
  view.presence.suspend();
  assert.deepEqual(view.changes, [true, false]);
  view.presence.invalidate(); view.flush();
  assert.deepEqual(view.changes, [true, false, true]);
});

test("an initially hidden player resumes when it first becomes visible", () => {
  const view = fixture();
  view.presence.invalidate(); view.flush();
  view.presence.suspend();
  view.setVisible(true); view.presence.invalidate(); view.flush();
  assert.deepEqual(view.changes, [true]);
});

test("dispose cancels pending frame work and ignores later notifications", () => {
  const view = fixture();
  view.setVisible(true); view.presence.invalidate(); view.presence.dispose();
  assert.equal(view.pending, 0);
  view.presence.invalidate(); view.presence.suspend(); view.flush();
  assert.equal(view.reads, 0);
  assert.deepEqual(view.changes, []);
});

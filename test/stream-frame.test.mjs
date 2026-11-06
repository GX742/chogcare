import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { twitchChannel, twitchChannelUrl } from "../src/twitch-channel.ts";

const read = file => readFileSync(new URL(file, import.meta.url), "utf8");
const app = read("../src/App.tsx");
const css = read("../src/sunset-redesign.css");

test("Twitch player stays inline on both pages and fits narrow screens", () => {
  assert.equal(twitchChannel, "chogcare");
  assert.equal(twitchChannelUrl, "https://www.twitch.tv/chogcare");
  assert.equal((app.match(/<BroadcastPanel headingId=/g) ?? []).length, 2);
  assert.match(app, /const twitchPlayerWidth = 400;/);
  assert.match(app, /width=\{twitchPlayerWidth\}/);
  assert.match(app, /setPlayerScale\(Math.min\(1, frame.getBoundingClientRect\(\).width \/ twitchPlayerWidth\)\)/);
  assert.match(app, /const parent = encodeURIComponent\(window\.location\.hostname\)/);
  assert.match(app, /\?channel=\$\{twitchChannel\}&parent=\$\{parent\}&muted=true&autoplay=true/);
  assert.match(app, /allowFullScreen/);
  assert.doesNotMatch(app, /Watch on Twitch|care-twitch-fallback|playerFits/);
});

test("the portrait iframe fits its frame without an extra chat or link row", () => {
  assert.match(css, /\.care-stream \{[^}]*aspect-ratio: 9 \/ 16;/);
  assert.match(css, /\.care-twitch-player \{[^}]*aspect-ratio: 9 \/ 16;[^}]*transform-origin: top left;/);
  assert.doesNotMatch(app, /care-broadcast-actions|care-twitch-chat|chatOpen/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { twitchChannel, twitchChannelUrl } from "../src/twitch-channel.ts";

const read = file => readFileSync(new URL(file, import.meta.url), "utf8");
const app = read("../src/App.tsx");
const css = read("../src/sunset-redesign.css");

test("Twitch player works on either page and links out below Twitch's minimum width", () => {
  assert.equal(twitchChannel, "chogcare");
  assert.equal(twitchChannelUrl, "https://www.twitch.tv/chogcare");
  assert.equal((app.match(/<BroadcastPanel headingId=/g) ?? []).length, 2);
  assert.match(app, /const twitchPlayerMinWidth = 400;/);
  assert.match(app, /width >= twitchPlayerMinWidth/);
  assert.match(app, /const parent = encodeURIComponent\(window\.location\.hostname\)/);
  assert.match(app, /\?channel=\$\{twitchChannel\}&parent=\$\{parent\}&muted=true&autoplay=true/);
  assert.match(app, /allowFullScreen/);
  assert.match(app, /href=\{twitchChannelUrl\}[^>]*>\s*<Broadcast[^>]*\/> Watch on Twitch/);
  assert.match(css, /\.care-twitch-player \{ aspect-ratio: 16 \/ 9; min-height: 300px; \}/);
});

test("chat is collapsed by default and only loads the channel chat when opened", () => {
  assert.match(app, /const \[chatOpen, setChatOpen\] = useState\(false\)/);
  assert.match(app, /aria-expanded=\{chatOpen\} aria-controls=\{chatId\}/);
  assert.match(app, /\{chatOpen && <iframe\s+className="care-twitch-chat"/);
  assert.match(app, /https:\/\/www\.twitch\.tv\/embed\/\$\{twitchChannel\}\/chat\?parent=\$\{parent\}&darkpopout/);
});

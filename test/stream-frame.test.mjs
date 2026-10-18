import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("broadcast rim overlays the image without shrinking its aspect-ratio viewport",async()=>{
  const css=await readFile(new URL("../src/sunset-redesign.css",import.meta.url),"utf8");
  assert.match(css,/\.sunset-page \.lp-broadcast-frame \{ border: 0;/);
  assert.match(css,/lp-broadcast-frame::after \{[^}]*padding: 1px;[^}]*mask-composite: exclude;[^}]*pointer-events: none/);
  assert.match(css,/lp-broadcast-interior \{ inset: 0; border-radius: 0; background: transparent;[^}]*clip-path: none/);
  assert.doesNotMatch(css,/lp-broadcast-interior \{[^}]*clip-path: inset/);
});

test("portrait edge bleed is minimal and does not crop landscape fallback",async()=>{
  const css=await readFile(new URL("../src/sunset-redesign.css",import.meta.url),"utf8");
  const app=await readFile(new URL("../src/App.tsx",import.meta.url),"utf8");
  assert.match(app,/data-camera-fit=\{portraitAspect \? "portrait" : "fallback"\}/);
  assert.match(css,/\[data-camera-fit=portrait\] video\.lp-broadcast-player \{ inset: -1px; width: calc\(100% \+ 2px\); height: calc\(100% \+ 2px\); object-fit: cover/);
  assert.match(css,/video\.lp-broadcast-player \{ object-fit: contain; object-position: center/);
});

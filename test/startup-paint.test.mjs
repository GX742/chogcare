import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("landing startup has no lazy-route splash and its CSS arrives with the entry",async()=>{
  const main=await readFile(new URL("../src/main.tsx",import.meta.url),"utf8");
  const html=await readFile(new URL("../index.html",import.meta.url),"utf8");
  const base=await readFile(new URL("../src/bootstrap.css",import.meta.url),"utf8");
  assert.match(main,/import App from "\.\/App"/);
  assert.doesNotMatch(main,/Loading ChogCare|React\.lazy\(\(\) => import\("\.\/App"\)\)/);
  assert.ok(html.indexOf('href="/src/bootstrap.css"')<html.indexOf('src="/src/main.tsx"'));
  assert.match(html,/rel="preload" as="image" href="\/chogcare-care-background.png" fetchpriority="high"/);
  assert.match(base,/background-color: #0e0a19/);
  assert.doesNotMatch(html,/<style|<script(?![^>]*src=)/);
});

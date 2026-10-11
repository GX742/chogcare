import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("site donation route and document language use English copy", () => {
  const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(read("../index.html"), /<html\s+lang="en"/);
  for (const path of ["../src/App.tsx", "../src/DonationThanks.tsx"]) {
    const source = read(path);
    assert.match(source, /<span(?: className="care-charity-word")?>Charity<\/span>/);
    assert.doesNotMatch(source, /Благотворительность|lang="ru"/);
  }
});

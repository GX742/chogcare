import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("site donation route and document language use English copy", () => {
  const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(read("../index.html"), /<html\s+lang="en"/);
  for (const path of ["../src/App.tsx", "../src/DonationThanks.tsx"]) {
    const source = read(path);
    if (path.endsWith("App.tsx")) {
      const giving = read("../src/GivingExplainer.tsx");
      assert.match(giving, /<h3 id="token-mechanic-title">Give with \$CHOG<\/h3>/);
      assert.match(giving, /<h3 id="nft-mechanic-title">Give as an NFT holder<\/h3>/);
      assert.doesNotMatch(giving, /Благотворительность|lang="ru"/);
      assert.match(source, /<span>CHARITY<\/span>/);
    } else {
      assert.match(source, /<span(?: className="care-charity-word")?>Charity<\/span>/);
    }
    assert.doesNotMatch(source, /Благотворительность|lang="ru"/);
  }
});

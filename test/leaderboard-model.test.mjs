import test from "node:test";
import assert from "node:assert/strict";
import { formatChogAmount, isPositiveChogAmount, parseLeaderboardEntries, safeLeaderboardAvatarImage } from "../src/leaderboard-model.ts";

const cid = "bafybeihau2egcccbdxymeckmmbrqytbfor5gkt3en6d5fsbueymdbq7g6e";
const image = `https://gateway.pinata.cloud/ipfs/${cid}/1462.webp`;
const row = overrides => ({ rank: 1, nickname: "Big Chog", initiativeId: "solar-foundation", amount: "300", avatarImage: image, avatarName: "CHOG #1462", status: "delivered", ...overrides });

test("positive aggregate amounts allow 78 whole digits and retain 18 decimals", () => {
  for (const value of ["300", "10000000", "900719925474099312345678", "9".repeat(78), `${"9".repeat(78)}.${"9".repeat(18)}`, "0.000000000000000001", "000300.0100"]) {
    assert.equal(isPositiveChogAmount(value), true, value);
  }
});

test("amount validation rejects zero, non-decimals, excess precision and trailing newlines", () => {
  for (const value of [undefined, null, 300, NaN, Infinity, {}, [], "", "0", "000.000", "-1", "+1", "1e3", "0xff", ".1", "1.", "1,000", " 1", "1 ", "1\n", "1\r", "1\r\n", "1.2\n", "1.0\u2028", "9".repeat(79), `1.${"9".repeat(19)}`]) {
    assert.equal(isPositiveChogAmount(value), false, String(value));
  }
});

test("amount formatting groups whole digits without floating-point conversion", () => {
  assert.equal(formatChogAmount("10000000"), "10,000,000");
  assert.equal(formatChogAmount("900719925474099312345678"), "900,719,925,474,099,312,345,678");
  assert.equal(formatChogAmount("123456789012345678901234567890123456789012345678901234567890123456789012345678"), "123,456,789,012,345,678,901,234,567,890,123,456,789,012,345,678,901,234,567,890,123,456,789,012,345,678");
  assert.equal(formatChogAmount("000300.0100"), "300.01");
});

test("fraction formatting never rounds totals upward or hides omitted nonzero digits", () => {
  assert.equal(formatChogAmount("999.99999"), "999.9999…");
  assert.equal(formatChogAmount("300.123400000000000000"), "300.1234");
  assert.equal(formatChogAmount("1.000000000000000000"), "1");
  assert.equal(formatChogAmount("1.2345"), "1.2345");
  assert.equal(formatChogAmount("1.2300"), "1.23");
  assert.equal(formatChogAmount("0.000000000000000001"), "0.0000…");
  assert.equal(formatChogAmount("9007199254740993.999999999999999999"), "9,007,199,254,740,993.9999…");
  assert.throws(() => formatChogAmount("0"), TypeError);
  assert.throws(() => formatChogAmount("1e30"), TypeError);
});

test("avatar images remain restricted to the allowed HTTPS IPFS gateway", () => {
  assert.equal(safeLeaderboardAvatarImage(image), image);
  const nested = `https://gateway.pinata.cloud/ipfs/${cid}/collection/1462.png`;
  assert.equal(safeLeaderboardAvatarImage(nested), nested);
  for (const value of [undefined, null, {}, "/local.png", "javascript:alert(1)", image.replace("https:", "http:"), image.replace("gateway.pinata.cloud", "evil.example"), image.replace("gateway.pinata.cloud", "gateway.pinata.cloud.evil.example"), image.replace("https://", "https://user:password@"), `${image}?secret=1`, `${image}#secret`, `${image}\n`, `https://gateway.pinata.cloud/ipfs/${cid}/../secret.png`, `https://gateway.pinata.cloud/ipfs/${cid}/./1462.png`, `https://gateway.pinata.cloud/ipfs/${cid}/%2e%2e/secret.png`]) {
    assert.equal(safeLeaderboardAvatarImage(value), null, String(value));
  }
});

test("public entry parsing keeps large exact totals and picks no private fields", () => {
  const amount = "10000000.000000000000000001";
  const source = row({ amount, wallet: "0xprivate", invoiceId: "private", avatarTokenId: "1462", publishedAt: 123 });
  const entries = parseLeaderboardEntries({ entries: [source] });
  assert.deepEqual(entries, [row({ amount })]);
  assert.doesNotMatch(JSON.stringify(entries), /wallet|invoice|publishedAt|avatarTokenId|0xprivate/);
  assert.equal(source.wallet, "0xprivate", "Parsing must not mutate the response");
});

test("entry parsing rejects malformed rows and safely falls back for untrusted avatars", () => {
  const invalid = [null, [], row({ rank: 0 }), row({ rank: -1 }), row({ rank: 1.5 }), row({ rank: Number.MAX_SAFE_INTEGER + 1 }), row({ nickname: 123 }), row({ amount: 300 }), row({ amount: "0" }), row({ amount: "9".repeat(79) }), row({ initiativeId: "toString" }), row({ initiativeId: "__proto__" }), row({ initiativeId: "unknown" }), row({ status: "processing" })];
  assert.deepEqual(parseLeaderboardEntries({ entries: invalid }), []);
  assert.deepEqual(parseLeaderboardEntries({ entries: [row({ avatarImage: "https://evil.example/avatar.png", avatarName: {} })] }), [row({ avatarImage: null, avatarName: null })]);
  for (const value of [undefined, null, [], {}, { entries: "not an array" }]) assert.deepEqual(parseLeaderboardEntries(value), []);
});

test("entry parsing preserves supported initiatives, statuses, order and the 20-row cap", () => {
  const initiatives = ["burundi", "school-supplies", "solar-foundation", "vida-verde", "animal-ethics"];
  const rows = Array.from({ length: 25 }, (_, index) => row({ rank: index + 1, initiativeId: initiatives[index % initiatives.length], status: index % 2 ? "confirming" : "delivered" }));
  assert.deepEqual(parseLeaderboardEntries({ entries: rows }), rows.slice(0, 20));
});

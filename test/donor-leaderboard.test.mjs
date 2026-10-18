import test from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "viem";
import { buildDonorLeaderboard, verifiedLeaderboardDonation } from "../server/donor-leaderboard.mjs";

const id = number => number.toString(16).padStart(64, "0");
const address = number => `0x${number.toString(16).padStart(40, "0")}`;
const txHash = `0x${"a".repeat(64)}`;
const profile = (number, options = {}) => ({ invoiceId: id(number), nickname: "GX", amount: "300", initiativeId: "school-supplies", publishedAt: number, avatarTokenId: "1130", avatarName: "CHOG #1130", avatarImage: null, ...options });
const donation = (sender = address(1), options = {}) => ({ sender, state: "delivered", amount: "300", initiativeId: "school-supplies", ...options });
const invoice = (options = {}) => ({ id: id(1), state: "delivered", amount: "330", donationAmount: "300", units: parseUnits("330", 18).toString(), initiativeId: "school-supplies", depositHash: txHash,
  depositProof: { kind: "confirmed-chog-transfer", invoiceId: id(1), chainId: 143, sender: address(1), txHash, amountUnits: parseUnits("330", 18).toString() }, ...options });

test("one donating wallet gets one row with 300 + 300 = 600 CHOG", () => {
  const result = buildDonorLeaderboard([profile(1), profile(2)], () => donation());
  assert.deepEqual(result.map(entry => [entry.rank, entry.nickname, entry.amount]), [[1, "GX", "600"]]);
  assert.doesNotMatch(JSON.stringify(result), /invoice|sender|wallet|0x/i);
  assert.deepEqual(Object.keys(result[0]), ["rank", "nickname", "initiativeId", "amount", "avatarTokenId", "avatarName", "avatarImage", "publishedAt", "status"]);
});

test("verified source proof binds donor identity and original donation excluding the pool addition", () => {
  const valid = invoice();
  assert.deepEqual(verifiedLeaderboardDonation(valid, id(1)), donation());
  assert.equal(verifiedLeaderboardDonation({ ...valid, state: "confirming" }, id(1)).state, "confirming");
  for (const state of ["awaiting-payment", "processing", "bridging", "expired", "manual-review"]) assert.equal(verifiedLeaderboardDonation({ ...valid, state }, id(1)), null);
  assert.equal(verifiedLeaderboardDonation(valid, id(2)), null);
  assert.equal(verifiedLeaderboardDonation({ ...valid, depositProof: null }, id(1)), null);
  for (const patch of [{ kind: "unverified" }, { invoiceId: id(2) }, { chainId: 10 }, { sender: address(0) }, { sender: "GX" }, { sender: address(1)+"\n" }, { txHash: `0x${"b".repeat(64)}` }, { amountUnits: "330" }]) {
    assert.equal(verifiedLeaderboardDonation({ ...valid, depositProof: { ...valid.depositProof, ...patch } }, id(1)), null);
  }
  for (const amount of ["0", "331", "NaN", "300\n", "300.0000000000000000001"]) assert.equal(verifiedLeaderboardDonation({ ...valid, donationAmount: amount }, id(1)), null);
  const legacy = { ...valid }; delete legacy.donationAmount;
  assert.equal(verifiedLeaderboardDonation(legacy, id(1)).amount, "330");
  delete legacy.initiativeId;
  assert.equal(verifiedLeaderboardDonation(legacy, id(1)).initiativeId, "burundi");
});

test("proof-backed excess keeps the original selected donation on the public board without changing receipt verification", () => {
  const receivedUnits=parseUnits("333",18).toString();
  const overpaid=invoice({contributionPercent:10,receivedUnits});
  overpaid.depositProof={...overpaid.depositProof,amountUnits:receivedUnits,logIndex:0,blockNumber:"100",blockHash:`0x${"b".repeat(64)}`};
  const verified=verifiedLeaderboardDonation(overpaid,id(1));
  assert.deepEqual(verified,donation(address(1),{amount:"300"}));
  const leaderboard=buildDonorLeaderboard([profile(1),profile(1)],()=>verified);
  assert.deepEqual(leaderboard.map(row=>[row.rank,row.amount]),[[1,"300"]]);
  assert.equal(verifiedLeaderboardDonation({...overpaid,receivedUnits:parseUnits("334",18).toString()},id(1)),null);
  assert.equal(verifiedLeaderboardDonation({...overpaid,depositProof:{...overpaid.depositProof,blockHash:"0x"}},id(1)),null);
  assert.equal(verifiedLeaderboardDonation({...overpaid,depositProof:{...overpaid.depositProof,sender:address(0)}},id(1)),null);
  assert.equal(verifiedLeaderboardDonation({...overpaid,donationAmount:"331"},id(1)),null,"the selected base cannot exceed the immutable quoted total even if the actual transfer covers it");
  assert.equal(verifiedLeaderboardDonation({...overpaid,receivedUnits:parseUnits("329",18).toString(),depositProof:{...overpaid.depositProof,amountUnits:parseUnits("329",18).toString()}},id(1)),null);
  const overCap=parseUnits("1100000.000000000000000001",18).toString();
  assert.equal(verifiedLeaderboardDonation({...overpaid,receivedUnits:overCap,depositProof:{...overpaid.depositProof,amountUnits:overCap}},id(1)),null);
});

test("legacy overpaid invoices without a separate base field retain their original selected amount", () => {
  const receivedUnits=parseUnits("333",18).toString(),legacy=invoice({amount:"300",units:parseUnits("300",18).toString(),contributionPercent:0,receivedUnits});
  delete legacy.donationAmount;
  legacy.depositProof={...legacy.depositProof,amountUnits:receivedUnits,logIndex:0,blockNumber:"100",blockHash:`0x${"b".repeat(64)}`};
  assert.equal(verifiedLeaderboardDonation(legacy,id(1)).amount,"300");
  assert.equal(legacy.receivedUnits,receivedUnits);
  assert.equal(legacy.depositProof.amountUnits,receivedUnits);
});

test("1500 previous + selected 300 overpaid as 333 ranks as 1800, with duplicates and reorgs handled once", () => {
  const receivedUnits=parseUnits("333",18).toString(),overpaid=invoice({contributionPercent:10,receivedUnits,state:"confirming"});
  overpaid.depositProof={...overpaid.depositProof,amountUnits:receivedUnits,logIndex:0,blockNumber:"100",blockHash:`0x${"b".repeat(64)}`};
  const earlier=invoice({id:id(2),amount:"1650",donationAmount:"1500",units:parseUnits("1650",18).toString()});
  earlier.depositProof={...earlier.depositProof,invoiceId:id(2),amountUnits:earlier.units};
  const before=structuredClone([overpaid,earlier]);
  const profiles=[profile(1,{amount:"333"}),profile(1),profile(2)];
  const read=invoiceId=>verifiedLeaderboardDonation(invoiceId===id(1)?overpaid:earlier,invoiceId);
  let rows=buildDonorLeaderboard(profiles,read);
  assert.deepEqual(rows.map(row=>[row.amount,row.status]),[["1800","confirming"]]);
  assert.deepEqual([overpaid,earlier],before,"public projection must not mutate financial records");
  overpaid.state="bridging";
  rows=buildDonorLeaderboard(profiles,read);
  assert.deepEqual(rows.map(row=>[row.amount,row.status]),[["1500","delivered"]]);
  overpaid.state="delivered";
  rows=buildDonorLeaderboard(profiles,read);
  assert.deepEqual(rows.map(row=>[row.amount,row.status]),[["1800","delivered"]]);
});

test("same wallet ignores address casing and uses its latest verified public name and avatar", () => {
  const sender = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const profiles = [profile(2, { nickname: "New GX", avatarTokenId: "77", avatarName: "CHOG #77", avatarImage: "https://gateway.pinata.cloud/ipfs/example/77.webp" }), profile(1)];
  const result = buildDonorLeaderboard(profiles, invoiceId => donation(invoiceId === id(1) ? sender : `0x${sender.slice(2).toUpperCase()}`, { initiativeId: invoiceId === id(1) ? "school-supplies" : "solar-foundation" }));
  assert.equal(result.length, 1);
  assert.deepEqual([result[0].nickname, result[0].avatarTokenId, result[0].amount, result[0].initiativeId], ["New GX", "77", "600", "solar-foundation"]);
});

test("same nickname or NFT from different wallets never merges different donors", () => {
  const result = buildDonorLeaderboard([profile(1), profile(2)], invoiceId => donation(invoiceId === id(1) ? address(1) : address(2)));
  assert.deepEqual(result.map(entry => entry.amount), ["300", "300"]);
});

test("sum exact 18-decimal CHOG units before ranking, without the old top-40 invoice cutoff", () => {
  const profiles = Array.from({ length: 61 }, (_, index) => profile(index + 1));
  const result = buildDonorLeaderboard(profiles, invoiceId => donation(invoiceId <= id(60) ? address(1) : address(2), { amount: invoiceId <= id(60) ? "300.000000000000000001" : "17000" }));
  assert.deepEqual(result.map(entry => entry.amount), ["18000.00000000000000006", "17000"]);
  const large = buildDonorLeaderboard(profiles, () => donation(address(1), { amount: "1000000" }));
  assert.equal(large[0].amount, "61000000");
  assert.equal(buildDonorLeaderboard([profile(1), profile(2)], invoiceId => donation(address(1), { amount: invoiceId === id(1) ? "0.1" : "0.2" }))[0].amount, "0.3");
});

test("only eligible donations count, duplicate invoice IDs cannot count twice, and reorgs remove their contribution", () => {
  let secondState = "confirming";
  const profiles = [profile(1, { amount: "9999999" }), profile(2), profile(2), profile(3, { nickname: "Unverified replacement", publishedAt: 999 })];
  const read = invoiceId => invoiceId === id(3) ? null : donation(address(1), { state: invoiceId === id(1) ? "delivered" : secondState });
  let result = buildDonorLeaderboard(profiles, read);
  assert.equal(result[0].amount, "600", "Use authoritative source amount, not the stored profile amount");
  assert.equal(result[0].nickname, "GX");
  assert.equal(result[0].status, "confirming");
  secondState = "bridging";
  result = buildDonorLeaderboard(profiles, read);
  assert.deepEqual([result[0].amount, result[0].status], ["300", "delivered"]);
  secondState = "delivered";
  assert.equal(buildDonorLeaderboard(profiles, read)[0].status, "delivered");
  assert.deepEqual(buildDonorLeaderboard(profiles, null), []);
});

test("public top-20 is applied to aggregated donors and equal totals have deterministic ranks", () => {
  const profiles = Array.from({ length: 45 }, (_, index) => profile(index + 1, { publishedAt: 10 }));
  const read = invoiceId => donation(address(Number.parseInt(invoiceId, 16)), { amount: "300.000000000000000001" });
  const first = buildDonorLeaderboard(profiles, read);
  assert.equal(first.length, 20);
  assert.deepEqual(first, buildDonorLeaderboard([...profiles].reverse(), read));
});

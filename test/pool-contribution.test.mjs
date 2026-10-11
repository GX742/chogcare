import test from "node:test";
import assert from "node:assert/strict";
import { contributionForDonationUnits, splitSettlementUnits } from "../src/pool-contribution.ts";

test("10% is added on top and never deducted from the selected cause amount",()=>{
  assert.deepEqual(contributionForDonationUnits(300n),{donationUnits:300n,contributionUnits:30n,totalUnits:330n});
  assert.deepEqual(contributionForDonationUnits(301n),{donationUnits:301n,contributionUnits:31n,totalUnits:332n});
  assert.throws(()=>contributionForDonationUnits(0n));
});

test("post-swap allocation preserves every unit and gives indivisible dust to the pool",()=>{
  const split=splitSettlementUnits(1_000_000n);
  assert.equal(split.causeUnits,909_090n);
  assert.equal(split.poolUnits,90_910n);
  assert.equal(split.causeUnits+split.poolUnits,1_000_000n);
  assert.throws(()=>splitSettlementUnits(1n));
});

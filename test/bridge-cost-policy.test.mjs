import test from "node:test";
import assert from "node:assert/strict";
import { CHOG_DONATION_MAX_BRIDGE_LOSS_BPS, minimumBridgeDelivery, assertBridgeDelivery, assertCrossAssetBridgeDelivery } from "../server/bridge-cost-policy.mjs";
import { recipientCandidates } from "../server/recipient-candidates.mjs";
test("bridge ceiling preserves at least 96% of quoted USDC input",()=>{
  assert.equal(minimumBridgeDelivery(500000n),480000n);
  assert.equal(minimumBridgeDelivery(500001n),480001n);
  assert.equal(minimumBridgeDelivery(500000n,CHOG_DONATION_MAX_BRIDGE_LOSS_BPS),470000n);
  assert.equal(minimumBridgeDelivery(100000n),200000n);
  assert.throws(()=>minimumBridgeDelivery(0n));
  assert.throws(()=>minimumBridgeDelivery(500000));
  assert.throws(()=>minimumBridgeDelivery(500000n,1001n));
});
test("reject costly and malformed bridge outputs",()=>{
  for(const minOutput of ["477087","283994","-1","NaN","480000.0",undefined])assert.throws(()=>assertBridgeDelivery({minOutput},480000n));
  assert.doesNotThrow(()=>assertBridgeDelivery({minOutput:"480000"},480000n));
});
test("tighter signed quotes can fit small donations without raising the six-percent loss ceiling",()=>{
  const required=minimumBridgeDelivery(397429n,CHOG_DONATION_MAX_BRIDGE_LOSS_BPS);
  assert.equal(required,373584n);
  assert.throws(()=>assertBridgeDelivery({minOutput:"373255",expectedOutput:"377025"},required),{code:"BRIDGE_COST_LIMIT"},
    "an attractive expected payout cannot replace the signed worst-case minimum");
  assert.doesNotThrow(()=>assertBridgeDelivery({minOutput:"376082"},required));
  assert.doesNotThrow(()=>assertCrossAssetBridgeDelivery({minimumOutputUsdMicros:"374516"},required));
  assert.doesNotThrow(()=>assertBridgeDelivery({minOutput:String(required)},required));
  assert.throws(()=>assertBridgeDelivery({minOutput:String(required-1n)},required),{code:"BRIDGE_COST_LIMIT"});
});
test("cross-asset ceiling compares conservative USD value rather than unrelated token units",()=>{
  assert.doesNotThrow(()=>assertCrossAssetBridgeDelivery({minimumOutputUsdMicros:"4800000"},4_800_000n));
  for(const minimumOutputUsdMicros of ["4799999","-1","NaN",undefined])assert.throws(()=>assertCrossAssetBridgeDelivery({minimumOutputUsdMicros},4_800_000n));
});
test("research is immutable and never enables a payment route",()=>{
  assert.equal(recipientCandidates.length,6);
  for(const candidate of recipientCandidates){
    assert.match(candidate.source,/^https:\/\//);
    assert.ok(candidate.blocker);
    assert.notEqual(candidate.paymentsEnabled,true);
    assert.ok(Object.isFrozen(candidate.routes));
  }
  const animal=recipientCandidates.find(p=>p.id==="animal-ethics");
  assert.equal(animal.routes[0].recipient,"J7XmJiC44bFTbTzoAF69qhWPZq6LUkvf8wPk2UV4zXXL");
  assert.equal(animal.routes[0].asset,"SOL");
  assert.equal(animal.routes[0].chainId,792703809);
  assert.equal(animal.routes[1].recipient,"0x6201B6D58fa7EAA7e99552085Bea2CAc25FdeA0c");
  assert.equal(recipientCandidates.find(p=>p.id==="givewell").routes[0].asset,"SOL");
});

test("GiveWell fund selection does not enable an unconfirmed bridge",()=>{
  const givewell=recipientCandidates.find(p=>p.id==="givewell");
  assert.equal(givewell.fundDesignation,"Unrestricted Fund");
  assert.equal(givewell.allowsOperatingExpenses,true);
  assert.notEqual(givewell.paymentsEnabled,true);
  assert.match(givewell.blocker,/bridge compatibility.*unconfirmed/);
  assert.equal(givewell.routes[0].recipient,"4Z2DBVoQCJZ42cCTDMNvYDUqRjA1C3vV7B155Mc6jGah");
});

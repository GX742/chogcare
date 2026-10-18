import test from "node:test";
import assert from "node:assert/strict";
import { holderAvailability, paymentAvailabilityNotice, paymentServicePolicy, requiredPaymentSecurityVersion } from "../src/payment-service-policy.ts";

test("old or integrity-locked payment service cannot issue new frontend QR instructions", () => {
  for(const config of [{},{securityVersion:"old",integrityLocked:false},{securityVersion:requiredPaymentSecurityVersion},{securityVersion:requiredPaymentSecurityVersion,integrityLocked:true},{securityVersion:requiredPaymentSecurityVersion,integrityLocked:"false"}]) {
    assert.equal(paymentServicePolicy(config).allowed,false);
    assert.ok(paymentServicePolicy(config).notice);
  }
  assert.deepEqual(paymentServicePolicy({securityVersion:requiredPaymentSecurityVersion,integrityLocked:false}),{allowed:true,notice:""});
});
test("unknown pool availability is not represented as zero funded claims", () => {
  const current={securityVersion:requiredPaymentSecurityVersion,integrityLocked:false};
  for(const config of [{availableClaims:20},{...current,integrityLocked:true,availableClaims:20},{...current},{...current,availableClaims:"20"},{...current,availableClaims:-1},{...current,availableClaims:21}])assert.equal(holderAvailability(config),null);
  assert.equal(holderAvailability({...current,availableClaims:0}),0);
  assert.equal(holderAvailability({...current,availableClaims:3}),3);
});

test("readiness reasons are fixed, mode-specific copy and never payment authorization", () => {
  const config={paymentsEnabled:false,nftPaymentsEnabled:true,chogReadiness:"network-unavailable",nftReadiness:"ready"};
  assert.match(paymentAvailabilityNotice(config,"chog"),/recovering automatically/);
  assert.equal(paymentAvailabilityNotice(config,"nft"),"");
  assert.equal(paymentAvailabilityNotice({...config,paymentsEnabled:true},"chog"),"");
  assert.equal(paymentAvailabilityNotice({chogReadiness:"secret raw RPC response"},"chog"),"");
  assert.equal(paymentServicePolicy(config).allowed,false);
  for(const reason of ["gas-needed","funding-needed","daily-limit","queue-full"]){
    const notice=paymentAvailabilityNotice({nftReadiness:reason},"nft");
    assert.ok(notice.length>0);assert.doesNotMatch(notice,/enter.*password|new wallet/i);
  }
});

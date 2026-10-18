import test from "node:test";
import assert from "node:assert/strict";
import { formatDonationAmount } from "../src/donation-amount.ts";

test("CHOG presentation rounds half-up to two decimals while preserving exact accounting strings",()=>{
  for(const [exactAmount,display,rounded] of [
    ["302.727272727272727272","302.73",true],
    ["1.004999999999999999","1",true],
    ["1.005","1.01",true],
    ["9.995","10",true],
    ["999.995","1,000",true],
    ["99999999.999999999999999999","100,000,000",true],
    ["1000000.123456789123456789","1,000,000.12",true],
    ["300.000000000000000001","300",true],
    ["300.000000000000000000","300",false],
    ["300.10","300.1",false],
    ["300.12","300.12",false],
    ["300","300",false],
  ])assert.deepEqual(formatDonationAmount(exactAmount),{exactAmount,display,rounded});
});

test("NFT USD presentation keeps two decimal places without binary rounding or dropping the original value",()=>{
  for(const [exactAmount,display,rounded] of [["1","1.00",false],["1.00","1.00",false],["0.50","0.50",false],["1.005","1.01",true],["99999999.995","100,000,000.00",true]])
    assert.deepEqual(formatDonationAmount(exactAmount,"nft"),{exactAmount,display,rounded});
});

test("positive dust stays visibly positive rather than masquerading as zero",()=>{
  for(const mode of ["chog","nft"]){
    for(const exactAmount of ["0.000000000000000001","0.004999999999999999"])assert.deepEqual(formatDonationAmount(exactAmount,mode),{exactAmount,display:"<0.01",rounded:true});
    assert.equal(formatDonationAmount("0.005",mode).display,"0.01");
  }
});

test("amount presentation rejects coercion, invalid precision and control characters",()=>{
  for(const value of [undefined,null,300,{},"","0","0.000000000000000000","-1","1e6","1,000","300\n","300\u2028","300.","100000000","300.1234567891234567890","Infinity","<script>"])
    assert.throws(()=>formatDonationAmount(value),String(value));
  assert.throws(()=>formatDonationAmount("300","anything"));
});

import test from "node:test";
import assert from "node:assert/strict";
import { donationShare } from "../src/donation-share.ts";
const input={state:"delivered",mode:"chog",amount:"1234.5678",initiativeId:"burundi"};
test("share uses confirmed CHOG amount, exact initiative and safe encoded URL",()=>{
  const share=donationShare(input,"https://chogcare.example/?invoice=secret#station");
  assert.match(share.text,/1,234\.5678 \$CHOG/);assert.match(share.text,/Perfect Villages in Burundi/);
  const url=new URL(share.href);assert.equal(url.origin,"https://twitter.com");assert.equal(url.searchParams.get("text"),share.text);
  assert.equal(url.searchParams.get("url"),"https://chogcare.example/");assert.doesNotMatch(share.href,/secret|station|0x/);
});
test("NFT share attributes the $0.50 donation to the pool, not the holder's payment",()=>{
  const share=donationShare({...input,mode:"nft",amount:"0.50"});
  assert.match(share.text,/\$0.50 from the ChogCare pool/);assert.doesNotMatch(share.text,/I donated|1 MON/);
});

test("new NFT share uses the invoice's $1 amount while confirming without claiming finality",()=>{
  const share=donationShare({...input,mode:"nft",state:"confirming",amount:"1.00"});
  assert.match(share.text,/\$1.00 from the ChogCare pool/);
  assert.match(share.text,/Donation received/);
  assert.doesNotMatch(share.text,/Donation delivered|1 MON/);
});
test("share is available after receipt observation; failed or unfinished states remain private",()=>{
  assert.match(donationShare({...input,state:"confirming"}).text,/final confirmation in progress/);
  for(const state of ["processing","paying","expired","manual-review"])assert.equal(donationShare({...input,state}),null);
  assert.equal(donationShare({...input,initiativeId:"unknown"}),null);
  for(const configured of ["http://127.0.0.1:4173","https://127.0.0.1","https://localhost","javascript:alert(1)","https://user:secret@example.com"])assert.equal(donationShare(input,configured).site,"https://chogcare.vercel.app/");
});

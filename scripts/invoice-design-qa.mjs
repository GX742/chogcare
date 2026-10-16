import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { getAddress, parseUnits } from "viem";
import { CHOG } from "../src/route.ts";
import { chogBeneficiary } from "../src/chog-beneficiary.ts";

const require=createRequire(resolve(process.env.USERPROFILE,".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/package.json"));
const {chromium,webkit,devices}=require("playwright");
const root=resolve("dist"),out=resolve("work/invoice-design-qa");await mkdir(out,{recursive:true});
const types={".html":"text/html",".js":"text/javascript",".css":"text/css",".png":"image/png",".jpg":"image/jpeg",".svg":"image/svg+xml",".woff2":"font/woff2"};
const server=createServer(async(req,res)=>{
  try{
    const path=new URL(req.url,"http://localhost").pathname;
    if(path.startsWith("/api/")){res.writeHead(503);res.end();return;}
    const file=resolve(root,"."+(path==="/"?"/index.html":decodeURIComponent(path)));
    if(!file.startsWith(root+sep))throw Error("Invalid path");
    res.setHeader("Content-Type",types[extname(file)]??"application/octet-stream");res.end(await readFile(file));
  }catch{res.writeHead(404);res.end();}
});
await new Promise(ok=>server.listen(0,"127.0.0.1",ok));
const origin=`http://127.0.0.1:${server.address().port}`,engine=process.env.QA_BROWSER==="webkit"?"webkit":"chrome";
const siteOrigin=process.env.QA_SITE_ORIGIN??origin,activityOnly=process.env.QA_ACTIVITY_ONLY==="1";
if(![origin,"https://chogcare.xyz"].includes(siteOrigin))throw Error("Unapproved origin");
const browser=await(engine==="webkit"?webkit.launch({headless:true}):chromium.launch({channel:"chrome",headless:true}));
const widths=process.env.QA_WIDTHS?.split(",").map(Number)??[1440,1024,768,390,320];
assert.ok(widths.every(width=>[1440,1024,768,430,390,320].includes(width)));
const config={securityVersion:"2026-10-09-hardened-v1",integrityLocked:false,chainId:143,paymentMode:"local-pilot",paymentsEnabled:true,nftPaymentsEnabled:true,supportedModes:["chog","nft"],supportedInitiatives:["school-supplies","vida-verde","solar-foundation","animal-ethics"],nftSupportedInitiatives:["school-supplies","vida-verde","solar-foundation"],poolChainId:10,poolHealthy:true,poolGasReady:true,availableClaims:2,maxDailyClaims:3,subsidyUsdc:"1.00",destinationChainId:10};
const address="0x1111111111111111111111111111111111111111",hash="0x"+"c".repeat(64),results=[];
function fixture(mode,amount="330"){
  const shared={kind:"payment",id:(mode==="chog"?"a":"b").repeat(64),mode,state:"awaiting-payment",chainId:143,destinationChainId:10,initiativeId:"school-supplies",recipient:chogBeneficiary("school-supplies",10),depositAddress:address,expiresAt:Date.now()+600000,depositHash:null,destinationHash:null,observedDestinationHash:null,message:null};
  return mode==="chog"?{...shared,asset:"CHOG",amount,donationAmount:amount==="330"?"300":"1000000",poolContributionAmount:amount==="330"?"30":"100000",contributionPercent:10,poolContributionState:"pending",minUsdc:"200000",minimumUsd:"200000",destinationAsset:"USDC",destinationDecimals:6,bridgeHash:null,paymentUri:`ethereum:${CHOG}@143/transfer?address=${getAddress(address)}&uint256=${parseUnits(amount,18)}`}:{...shared,asset:"MON",amount:"1",subsidyUsdc:"1.00",tokenId:"7",holderAddress:"0x2222222222222222222222222222222222222222",claimDay:"2026-10-16",paymentUri:`ethereum:${address}@143?value=1000000000000000000`};
}
try{
  for(const width of widths)for(const mode of activityOnly?["chog"]:["chog","nft"]){
    const context=await browser.newContext({...width<768?{...devices["iPhone 13"],viewport:{width,height:844}}:{viewport:{width,height:1000}},reducedMotion:"reduce"});
    const page=await context.newPage();page.setDefaultTimeout(15000);
    let current=fixture(mode),offline=false,posts=0;
    await page.route("**/api/**",async route=>{
      if(route.request().method()!=="GET"){posts++;return route.abort();}
      const path=new URL(route.request().url()).pathname;
      if(offline&&path.includes("/invoices/"))return route.fulfill({status:503,body:"{}"});
      const data=path.endsWith("/config")?config:path.endsWith("/chog-rate")?{referenceChog:"300",estimatedUsdMicros:"1500000"}:path.includes("/invoices/")?current:{donations:[],total:0};
      return route.fulfill({contentType:"application/json",body:JSON.stringify(data)});
    });
    await page.addInitScript(({mode,id})=>{
      sessionStorage.setItem(mode==="chog"?"chogcare:active-invoice:v1":"chogcare:active-nft-invoice:v1",id);
      sessionStorage.setItem(`chogcare:invoice-cause:${mode}:v1`,"school-supplies");sessionStorage.setItem("chogcare:checkout-mode:v1",mode);
      window.__copies=[];window.__copyFail=false;
      Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async value=>{if(window.__copyFail)throw Error("denied");window.__copies.push(value);}}});
    },{mode,id:current.id});
    const load=async()=>{await page.goto(siteOrigin,{waitUntil:"domcontentloaded"});await page.locator(".checkout-qr img").waitFor();await page.evaluate(()=>document.fonts.ready);};
    await load();
    const capture=name=>page.locator(".care-checkout-column").screenshot({path:resolve(out,`${engine}-${width}-${mode}-${name}.png`),style:".site-header,.skip-link { visibility:hidden!important; }"});
    if(activityOnly){
      for(const state of ["processing","bridging","delayed","offline","million","confirming"]){
        const started=Date.now()-23_000;
        current={...fixture("chog",state==="million"?"1100000":"330"),state:state==="confirming"?"confirming":state==="processing"?"processing":"bridging",depositHash:hash,bridgeHash:state==="processing"?null:hash,processingStartedAt:started,bridgeStartedAt:started,bridgeEstimatedSeconds:30};
        if(state==="delayed")current.message="Processing paused while the network or route is checked. Do not pay again.";
        if(state==="confirming")Object.assign(current,{observedDestinationHash:hash,observedUsdc:"450000",destinationIncludedAt:Date.now()});
        offline=false;await page.goto(siteOrigin,{waitUntil:"domcontentloaded"});
        await page.locator(state==="confirming"?".checkout-thanks":".payment-activity-refined").waitFor();
        await page.evaluate(()=>document.fonts.ready);
        await page.locator(state==="confirming"?".checkout-thanks-art":".invoice-processing-art").evaluate(img=>img.decode());
        if(state==="offline"){offline=true;await page.getByRole("heading",{name:"Reconnecting to your donation",exact:true}).waitFor();}
        await capture(state);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${width} ${state}: viewport overflow`);
        assert.equal(await page.locator(".checkout-qr").count(),0,"a paid invoice cannot show a payable QR");
        if(state!=="confirming"){
          assert.equal(await page.locator(".checkout-thanks").count(),0,"processing cannot pretend to be delivered");
          assert.equal(await page.locator(".checkout-progress [aria-current=step]").count(),1);
          await page.getByRole("heading",{name:"Total received",exact:true}).waitFor();
          const bounds=await page.locator(".invoice-payment-main").evaluate(el=>({scroll:el.scrollWidth,width:el.clientWidth,loaded:el.querySelector("img").naturalWidth>0}));
          assert.ok(bounds.loaded);assert.ok(bounds.scroll<=bounds.width+1,`${width} ${state}: amount overflow`);
          if(state==="million")assert.ok(await page.locator(".invoice-payment-amount strong").evaluate(el=>el.getBoundingClientRect().height<parseFloat(getComputedStyle(el).fontSize)*1.5),"million amount must stay on one line");
          await page.getByText("Transfer receipts",{exact:true}).click();assert.ok(await page.getByRole("link",{name:"View $CHOG deposit"}).isVisible());
        }else {
          await page.getByText("Donation received · finalizing",{exact:true}).waitFor();
          await page.getByText("Thank you, CHOG friend.",{exact:true}).waitFor();
          const surface=await page.locator(".checkout-thanks-art").evaluate(img=>({
            logo:img.getAttribute("src"),radius:parseFloat(getComputedStyle(img).borderRadius),
            wrapper:getComputedStyle(img.closest(".lp-payment")).backgroundImage,
            inner:getComputedStyle(img.closest(".checkout")).backgroundColor,
          }));
          assert.equal(surface.logo,"/chogcare-care-logo.png");assert.ok(surface.radius>=12);
          assert.match(surface.wrapper,/radial-gradient/);assert.equal(surface.inner,"rgba(0, 0, 0, 0)");
          await page.getByRole("link",{name:"Watch yourself on the livestream"}).click();
          assert.equal(await page.locator("#care-livestream").count(),1);
          assert.equal(await page.locator(".checkout-thanks").count(),1,"stream navigation preserves receipt");
        }
        results.push({width,mode,state,paymentPosts:posts});
      }
      assert.equal(posts,0);await context.close();continue;
    }
    await capture("qr");
    const layout=await page.evaluate(()=>{
      const box=selector=>document.querySelector(selector).getBoundingClientRect();
      const detail=document.querySelector(".checkout-payment-details"),amount=document.querySelector(".invoice-payment-amount strong");
      return{overflow:document.documentElement.scrollWidth>innerWidth,amountFont:parseFloat(getComputedStyle(amount).fontSize),innerBorder:getComputedStyle(detail).borderWidth,qrWidth:box(".checkout-qr").width,statusGap:box(".checkout-status").y-(box(".checkout-cancel").y+box(".checkout-cancel").height)};
    });
    assert.equal(layout.overflow,false);assert.equal(layout.innerBorder,"0px");assert.ok(layout.amountFont>=48);assert.ok(layout.qrWidth>=176);
    assert.ok(layout.statusGap>=24,`status spacing ${layout.statusGap}`);
    const addressButton=page.getByRole("button",{name:mode==="chog"?"Copy payment address":"Copy verification address",exact:true});
    await addressButton.click();await addressButton.click();
    assert.equal(await addressButton.innerText(),"Copied");assert.equal(await addressButton.isEnabled(),true);
    assert.deepEqual(await page.evaluate(()=>window.__copies),[address,address]);
    await page.waitForTimeout(1750);assert.equal(await addressButton.innerText(),"Copy");
    await page.getByRole("button",{name:"Copy amount",exact:true}).click();
    assert.equal(await page.evaluate(()=>window.__copies.at(-1)),current.amount);
    await page.evaluate(()=>{window.__copyFail=true;});await addressButton.click();await page.getByText("Copy is unavailable. Select the displayed value manually.").waitFor();
    await page.evaluate(()=>{window.__copyFail=false;});
    if([390,1440].includes(width)){
      await page.getByRole("button",{name:"Change initiative",exact:true}).click();
      const confirm=page.getByRole("button",{name:"I haven’t paid · change initiative",exact:true});await confirm.waitFor();
      await page.locator(".checkout-change").screenshot({path:resolve(out,`${engine}-${width}-${mode}-change.png`),style:".site-header,.skip-link { visibility:hidden!important; }"});
      current={...current,state:mode==="chog"?"processing":"verifying",depositHash:hash};
      await confirm.click();await page.getByText("This payment may be processing. Keep it open; do not pay again.",{exact:true}).waitFor();
      assert.equal(await page.evaluate(mode=>sessionStorage.getItem(mode==="chog"?"chogcare:active-invoice:v1":"chogcare:active-nft-invoice:v1"),mode),current.id);
      current=fixture(mode);offline=true;await confirm.click();await page.getByText("Could not check this payment. Keep your checkout and try again.",{exact:true}).waitFor();
      offline=false;await confirm.click();await page.waitForFunction(()=>document.querySelector("#station").hidden);
      const saved=await page.evaluate(mode=>({active:sessionStorage.getItem(mode==="chog"?"chogcare:active-invoice:v1":"chogcare:active-nft-invoice:v1"),history:JSON.parse(sessionStorage.getItem("chogcare:invoice-history:v1"))}),mode);
      assert.equal(saved.active,null);assert.ok(saved.history.some(x=>x.id===current.id&&x.mode===mode));
      await page.locator(".care-cause-button").nth(1).click();await page.locator(mode==="chog"?"#live-amount":"#nft-holder").waitFor();
      assert.equal(await page.locator(".checkout-qr").count(),0,"old QR must not follow into a new initiative");
    }
    if(mode==="chog"){
      current=fixture(mode,"1100000");await load();await capture("million");
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.getByRole("button",{name:"Copy amount",exact:true}).click();assert.equal(await page.evaluate(()=>window.__copies.at(-1)),"1100000");
    }
    current={...current,expiresAt:Date.now()-1000};
    await page.goto(origin,{waitUntil:"domcontentloaded"});
    await page.getByText("Payment window closed · do not pay",{exact:true}).waitFor();
    assert.equal(await page.locator(".checkout-qr").count(),0,"expired QR is never displayed");
    assert.equal(posts,0);results.push({width,mode,...layout,paymentPosts:posts});await context.close();
  }
  await writeFile(resolve(out,`${engine}-results.json`),JSON.stringify(results,null,2));console.log(JSON.stringify({verified:true,engine,results}));
}finally{await browser.close();await new Promise(ok=>server.close(ok));}

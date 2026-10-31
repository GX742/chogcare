import {createServer} from "node:http";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {resolve,extname,sep} from "node:path";
import {createRequire} from "node:module";
import assert from "node:assert/strict";
import {getAddress,parseUnits} from "viem";
import {CHOG} from "../src/route.ts";
import {chogBeneficiary} from "../src/chog-beneficiary.ts";
import {validatePayableInvoice} from "../src/payable-invoice.ts";

const require=createRequire(resolve(process.env.USERPROFILE,".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/package.json"));
const {chromium,webkit,devices}=require("playwright");
const root=resolve("dist"),out=resolve("work/checkout-design-qa");
await mkdir(out,{recursive:true});
const baseline=process.env.QA_CHECKOUT_BASELINE==="1",engine=process.env.QA_BROWSER==="webkit"?"webkit":"chrome";
const types={".html":"text/html",".js":"text/javascript",".css":"text/css",".png":"image/png",".jpg":"image/jpeg",".svg":"image/svg+xml",".woff2":"font/woff2"};
const server=createServer(async(req,res)=>{
  try{
    const path=new URL(req.url,"http://localhost").pathname;
    if(path.startsWith("/api/")){res.writeHead(503,{"Content-Type":"application/json"});res.end('{"error":"Isolated design QA"}');return;}
    const file=resolve(root,"."+(path==="/"?"/index.html":decodeURIComponent(path)));
    if(!file.startsWith(root+sep))throw Error("Invalid path");
    const content=await readFile(file);res.setHeader("Content-Type",types[extname(file)]??"application/octet-stream");res.end(content);
  }catch{res.writeHead(404);res.end();}
});
await new Promise(ok=>server.listen(0,"127.0.0.1",ok));
const origin=`http://127.0.0.1:${server.address().port}`;
const siteOrigin=process.env.QA_SITE_ORIGIN??origin;
if(![origin,"https://chogcare.xyz"].includes(siteOrigin))throw Error("Unapproved origin");
const config={securityVersion:"2026-10-09-hardened-v1",integrityLocked:false,chainId:143,paymentMode:"local-pilot",paymentsEnabled:true,nftPaymentsEnabled:true,supportedModes:["chog","nft"],supportedInitiatives:["school-supplies","vida-verde","solar-foundation","animal-ethics"],nftSupportedInitiatives:["school-supplies","vida-verde","solar-foundation"],poolChainId:10,poolHealthy:true,poolGasReady:true,availableClaims:2,maxDailyClaims:3,subsidyUsdc:"1.00",destinationChainId:10};
const browser=await (engine==="webkit"?webkit.launch({headless:true}):chromium.launch({channel:"chrome",headless:true}));
const results=[];
const widths=process.env.QA_WIDTHS?.split(",").map(Number)??(baseline?[1440,390]:[1440,1024,768,430,390,320]);
assert.ok(widths.every(width=>[1440,1024,768,430,390,320].includes(width)));
try{
  for(const width of widths){
    const context=await browser.newContext({...width<768?{...devices["iPhone 13"],viewport:{width,height:844}}:{viewport:{width,height:1000}},reducedMotion:engine==="webkit"?"reduce":"no-preference"});
    const page=await context.newPage();page.setDefaultTimeout(15000);let offline=false,posts=0,availability={};
    await page.route("**/api/payments/**",async route=>{
      if(route.request().method()!=="GET"){posts++;return route.abort();}
      const path=new URL(route.request().url()).pathname;
      if(offline&&path.endsWith("/config"))return route.fulfill({status:503,contentType:"application/json",body:'{"error":"QA offline state"}'});
      const data=path.endsWith("/config")?{...config,...availability}:path.endsWith("/chog-rate")?{referenceChog:"300",estimatedUsdMicros:"1500000"}:{donations:[],total:0};
      return route.fulfill({contentType:"application/json",body:JSON.stringify(data)});
    });
    await page.goto(siteOrigin,{waitUntil:"domcontentloaded"});
    await page.evaluate(()=>document.fonts.ready);
    await page.locator(".care-cause-button").first().evaluate(el=>el.scrollIntoView({block:"center",behavior:"instant"}));
    await page.locator(".care-cause-button").first().click();
    await page.waitForFunction(()=>!document.querySelector("#panel-chog .checkout-submit")?.disabled);
    await page.waitForTimeout(400);
    const prefix=`${baseline?"before":"after"}-${engine}-${width}`;
    const capture=path=>page.locator(".care-checkout-column").screenshot({path,style:".site-header, .skip-link { visibility: hidden !important; }"});
    await capture(resolve(out,prefix+"-chog.png"));
    const initial=await page.evaluate(()=>{
      const tabs=[...document.querySelectorAll(".lp-payment-tabs button")].map(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}));
      const input=document.querySelector("#live-amount"),split=document.querySelector(".checkout-contribution");
      return {tabs,amountFont:getComputedStyle(input).fontSize,splitBorder:getComputedStyle(split).borderWidth,splitBackground:getComputedStyle(split).backgroundColor,overflow:document.documentElement.scrollWidth>innerWidth};
    });
    assert.equal(initial.overflow,false);
    if(!baseline){
      assert.ok(Math.abs(initial.tabs[0].width-initial.tabs[1].width)<1);assert.equal(initial.tabs[0].height,initial.tabs[1].height);
      assert.ok(parseFloat(initial.amountFont)>=48);assert.equal(initial.splitBorder,"0px");assert.equal(initial.splitBackground,"rgba(0, 0, 0, 0)");
      assert.match(await page.locator("#tab-chog").innerText(),/\$CHOG/);
      assert.equal(await page.locator(".checkout-amount-unit strong").innerText(),"$CHOG");
      assert.equal(await page.locator("#live-amount").inputValue(),"300");
      assert.match(await page.locator(".checkout-contribution-total").innerText(),/330/);
      assert.match(await page.locator("#checkout-amount-hint").innerText(),/Minimum 300 \$CHOG.*no minimum USD value/);
      const amountBox=await page.locator("#live-amount").boundingBox(),unitBox=await page.locator(".checkout-amount-unit").boundingBox();
      assert.ok(unitBox.x-(amountBox.x+amountBox.width)>=8&&unitBox.x-(amountBox.x+amountBox.width)<=18,"Ticker stays next to the amount");
      await page.getByRole("button",{name:"Edit donation amount"}).click();
      assert.deepEqual(await page.locator("#live-amount").evaluate(el=>({focused:document.activeElement===el,start:el.selectionStart,end:el.selectionEnd})),{focused:true,start:0,end:3});
      const presets=page.locator(".checkout-presets button");
      assert.deepEqual(await presets.allTextContents(),["300","3,000","30,000","300,000","1,000,000"]);
      for(const [index,amount] of ["300","3000","30000","300000","1000000"].entries()){
        await presets.nth(index).click();
        assert.equal(await page.locator("#live-amount").inputValue(),amount);
        assert.equal(await presets.nth(index).getAttribute("aria-pressed"),"true");
        assert.equal(await page.locator('.checkout-presets [aria-pressed="true"]').count(),1);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        assert.equal(await presets.nth(index).evaluate(el=>el.scrollWidth>el.clientWidth),false);
        assert.ok((await presets.nth(index).boundingBox()).height>=44);
      }
      assert.match(await page.locator(".checkout-contribution-total").innerText(),/1100000|1,100,000/);
      await presets.nth(1).click();assert.equal(await page.locator("#live-amount").inputValue(),"3000");
      assert.match(await page.locator(".checkout-contribution-total").innerText(),/3300|3,300/);
      await page.locator("#live-amount").fill("1234.5");assert.match(await page.locator(".checkout-contribution-total").innerText(),/1357.95|1,357.95/);
      assert.equal(await page.locator('.checkout-presets [aria-pressed="true"]').count(),0);
      await page.locator("#live-amount").fill("1000000");assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.locator("#live-amount").fill("300.123456789123456789");assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      assert.equal(await page.locator("#live-amount").inputValue(),"300.123456789123456789");
      await page.locator("#live-amount").fill("300");
      const notes=await page.locator(".checkout-payment-notes").innerText();assert.match(notes,/Exchange and delivery fees/);assert.match(notes,/MON/);assert.match(notes,/holds funds during processing/);
      const note=await page.locator(".checkout-payment-notes").boundingBox(),button=await page.locator("#panel-chog .checkout-submit").boundingBox();assert.ok(note.y+note.height<=button.y);
    }
    await page.locator("#tab-chog").focus();await page.keyboard.press("ArrowRight");
    await page.waitForSelector("#nft-holder");await page.waitForTimeout(500);
    assert.equal(await page.locator("#tab-nft").getAttribute("aria-selected"),"true");
    await capture(resolve(out,prefix+"-nft.png"));
    assert.equal(await page.locator("#panel-nft .checkout-submit").isDisabled(),true);
    await page.locator("#nft-holder").fill("0x1111111111111111111111111111111111111111");await page.locator('.nft-giving-consent input').check();
    assert.equal(await page.locator("#panel-nft .checkout-submit").isEnabled(),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    if(process.env.QA_PAYMENT_AVAILABILITY==="1"){
      availability={paymentsEnabled:false,chogReadiness:"network-unavailable"};
      await page.locator("#tab-chog").click();
      await page.getByText("Blockchain connection is recovering automatically.",{exact:false}).waitFor();
      assert.equal(await page.locator("#panel-chog .checkout-submit").isDisabled(),true);
      await capture(resolve(out,prefix+"-network-recovery.png"));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.locator("#tab-nft").click();
      assert.equal(await page.locator(".payment-service-notice").count(),0,"CHOG outage does not advertise an NFT outage");
      availability={paymentsEnabled:true,nftPaymentsEnabled:false,nftReadiness:"gas-needed"};
      await page.getByText("The service needs a network-fee top-up from the operator.",{exact:false}).waitFor();
      assert.equal(await page.locator("#panel-nft .checkout-submit").isDisabled(),true);
      availability={};await page.locator("#tab-chog").click();
      await page.waitForFunction(()=>!document.querySelector("#panel-chog .checkout-submit")?.disabled);
      await page.locator("#tab-nft").click();
      await page.waitForFunction(()=>!document.querySelector(".payment-service-notice"));
      await page.locator("#nft-holder").fill("0x1111111111111111111111111111111111111111");await page.locator('.nft-giving-consent input').check();
      assert.equal(await page.locator("#panel-nft .checkout-submit").isEnabled(),true);
    }
    if(!baseline&&[390,1440].includes(width)){
      offline=true;await page.locator("#tab-chog").click();await page.waitForSelector(".payment-service-notice");
      assert.equal(await page.locator("#panel-chog .checkout-submit").isDisabled(),true);
      await capture(resolve(out,prefix+"-offline.png"));
      offline=false;
      const id="b".repeat(64),hash="0x"+"a".repeat(64),depositAddress="0x1111111111111111111111111111111111111111";
      const fixture=validatePayableInvoice({kind:"payment",id,mode:"chog",asset:"CHOG",chainId:143,initiativeId:"school-supplies",recipient:chogBeneficiary("school-supplies",10),depositAddress,amount:"330",donationAmount:"300",poolContributionAmount:"30",contributionPercent:10,poolContributionState:"collected",paymentUri:`ethereum:${CHOG}@143/transfer?address=${getAddress(depositAddress)}&uint256=${parseUnits("330",18)}`,state:"delivered",expiresAt:Date.now()+600000,minUsdc:"200000",minimumUsd:"200000",depositHash:hash,bridgeHash:hash,destinationHash:hash,deliveredUsdc:"1500000",message:null,destinationChainId:10,destinationAsset:"USDC",destinationDecimals:6});
      await page.route("**/api/payments/invoices/**",route=>route.fulfill({contentType:"application/json",body:JSON.stringify(route.request().url().endsWith("/profile")?{profile:null,nfts:[{tokenId:"77",name:"CHOG #77",image:"/chog-holder-nft.png"}]}:fixture)}));
      await page.evaluate(id=>{sessionStorage.setItem("chogcare:active-invoice:v1",id);sessionStorage.setItem("chogcare:invoice-cause:chog:v1","school-supplies");sessionStorage.setItem("chogcare:checkout-mode:v1","chog");},id);
      await page.reload({waitUntil:"domcontentloaded"});
      await page.waitForSelector("#donor-nickname");await capture(resolve(out,prefix+"-profile.png"));
      assert.equal(await page.locator(".checkout.is-entry").count(),0);
      await page.locator("#donor-nickname").fill("Design QA");await page.getByRole("button",{name:"Choose your avatar"}).click();
      await page.waitForSelector(".donor-avatar-grid");await capture(resolve(out,prefix+"-avatars.png"));
      assert.equal(await page.locator('.donor-avatar-grid [role="radio"]').count(),2);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    }
    assert.equal(posts,0);results.push({width,...initial,paymentPosts:posts});await context.close();
  }
  await writeFile(resolve(out,`${baseline?"before":"after"}-${engine}-results.json`),JSON.stringify({siteOrigin,results},null,2));
  console.log(JSON.stringify({verified:true,siteOrigin,engine,results}));
}finally{await browser.close();await new Promise(ok=>server.close(ok));}

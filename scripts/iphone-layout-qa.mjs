import {createServer} from "node:http";
import {readFile,writeFile,mkdir,stat} from "node:fs/promises";
import {createReadStream} from "node:fs";
import {createRequire} from "node:module";
import {resolve,extname,sep} from "node:path";
import assert from "node:assert/strict";
const runtime=resolve(process.env.USERPROFILE,".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/package.json");
const require=createRequire(runtime),{chromium,devices}=require("playwright"),sharp=require("sharp");
const out=resolve("work/iphone-qa");await mkdir(out,{recursive:true});
const videoFile=process.argv[2],root=resolve("dist");
const types={".html":"text/html",".js":"text/javascript",".css":"text/css",".png":"image/png",".svg":"image/svg+xml",".woff2":"font/woff2",".jpg":"image/jpeg"};
const server=createServer(async(req,res)=>{
  try{
    const pathname=new URL(req.url,"http://localhost").pathname;
    if(pathname==="/__video_page"){res.setHeader("Content-Type","text/html");res.end('<video id="clip" src="/__video" muted playsinline preload="auto"></video>');return;}
    if(pathname==="/__video" && videoFile){
      const size=(await stat(videoFile)).size,range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range??"");
      const start=range?Number(range[1]):0,end=range&&range[2]?Math.min(Number(range[2]),size-1):size-1;
      if(start>end||end>=size){res.writeHead(416);res.end();return;}
      res.writeHead(range?206:200,{"Content-Type":"video/mp4","Accept-Ranges":"bytes","Content-Length":end-start+1,...(range?{"Content-Range":`bytes ${start}-${end}/${size}`}:{})});
      createReadStream(videoFile,{start,end}).pipe(res);return;
    }
    if(pathname.startsWith("/api/")){
      // QA cannot issue a payment, send a transaction or call the live worker.
      res.setHeader("Content-Type","application/json");res.end(JSON.stringify(pathname.endsWith("/config")?{chainId:143,paymentMode:"offline",custodyConfigured:false,integrityLocked:false,paymentsEnabled:false,nftPaymentsEnabled:false,supportedModes:["chog","nft"],readiness:{processing:"offline"}}:{donations:[],total:0}));return;
    }
    const file=resolve(root,"."+(pathname==="/"?"/index.html":decodeURIComponent(pathname)));
    if(!file.startsWith(root+sep)){res.writeHead(404);res.end();return;}
    const content=await readFile(file);res.setHeader("Content-Type",types[extname(file)]??"application/octet-stream");res.end(content);
  }catch{res.writeHead(404);res.end();}
});
await new Promise(ok=>server.listen(0,"127.0.0.1",ok));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:"chrome",headless:true});
try{
  if(videoFile){
    const page=await browser.newPage();await page.goto(origin+"/__video_page");
    const metadata=await page.evaluate(()=>new Promise((ok,bad)=>{const v=document.querySelector("video");v.onloadedmetadata=()=>ok({duration:v.duration,width:v.videoWidth,height:v.videoHeight});v.onerror=()=>bad(Error("Video decoding failed"));if(v.readyState>=1)v.onloadedmetadata();}));
    console.log(JSON.stringify({suppliedVideo:metadata}));
    const times=[0.1,0.5,1,2,4,6,10,15,20,30,45,60].filter(t=>t<metadata.duration),frames=[];
    for(const time of times){
      const data=await page.evaluate(t=>new Promise((ok,bad)=>{const v=document.querySelector("video");v.onseeked=()=>{try{const c=document.createElement("canvas");c.width=v.videoWidth;c.height=v.videoHeight;c.getContext("2d").drawImage(v,0,0);ok(c.toDataURL("image/jpeg",.88).split(",")[1]);}catch(e){bad(e);}};v.currentTime=t;}),time);
      const frame=Buffer.from(data,"base64");await writeFile(resolve(out,`video-${time}.jpg`),frame);
      const tile=await sharp(frame).resize({width:230}).jpeg().toBuffer();frames.push({input:tile,left:(frames.length%4)*230,top:Math.floor(frames.length/4)*Math.round(230*metadata.height/metadata.width)});
    }
    const height=Math.round(230*metadata.height/metadata.width);
    await sharp({create:{width:920,height:height*Math.ceil(frames.length/4),channels:3,background:"#111"}}).composite(frames).jpeg().toFile(resolve(out,"video-contact.jpg"));
    await page.close();
  }
  const siteOrigin=process.env.QA_SITE_ORIGIN??origin;
  if(![origin,"https://chogcare.xyz"].includes(siteOrigin))throw Error("Unapproved QA site origin");
  const results=[];
  for(const width of [390,430,1440]){
    const context=await browser.newContext(width<768?{...devices["iPhone 13"],viewport:{width,height:844}}:{viewport:{width,height:900}});
    const page=await context.newPage();
    await page.route("**/api/payments/**",route=>route.request().method()==="GET"?route.continue():route.abort());
    await page.addInitScript(()=>{window.__loadingSplashSeen=false;new MutationObserver(()=>{if(document.body?.innerText.includes("Loading ChogCare"))window.__loadingSplashSeen=true;}).observe(document,{subtree:true,childList:true});});
    await page.goto(siteOrigin,{waitUntil:"networkidle"});await page.waitForSelector(".care-intro");await page.waitForTimeout(1200);
    const top=await page.evaluate(()=>({rootBackground:getComputedStyle(document.documentElement).backgroundImage,bodyBackground:getComputedStyle(document.body).backgroundImage,heartsOpacity:Number(getComputedStyle(document.querySelector(".care-heart-scene")).opacity),splash:window.__loadingSplashSeen,overflow:document.documentElement.scrollWidth>innerWidth}));
    assert.equal(top.rootBackground,"none");assert.equal(top.bodyBackground,"none");assert.equal(top.heartsOpacity,0);assert.equal(top.splash,false);assert.equal(top.overflow,false);
    await page.screenshot({path:resolve(out,`top-${width}.png`)});
    await page.locator("#causes").scrollIntoViewIfNeeded();await page.waitForTimeout(600);
    const scrolled=await page.locator(".care-heart-scene").evaluate(el=>Number(getComputedStyle(el).opacity));assert.ok(scrolled>.95);
    await page.locator(".care-cause-button").first().click();await page.waitForTimeout(900);
    const stream=await page.locator("#station .care-stream-column").boundingBox(),tabs=await page.locator("#station .lp-payment-tabs").boundingBox();
    assert.ok(stream&&tabs);if(width<768)assert.ok(stream.y+stream.height<=tabs.y,`stream must precede methods at ${width}`);
    await page.screenshot({path:resolve(out,`checkout-${width}.png`),fullPage:true});
    results.push({width,top,scrolledHearts:scrolled,streamBeforeMethods:width>=768||stream.y+stream.height<=tabs.y});await context.close();
  }
  await writeFile(resolve(out,siteOrigin===origin?"layout-results.json":"production-results.json"),JSON.stringify(results,null,2));console.log(JSON.stringify({verified:true,origin:siteOrigin,results}));
}finally{await browser.close();await new Promise(ok=>server.close(ok));}

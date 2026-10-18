import {createRequire} from "node:module";
import {mkdir,writeFile,readFile} from "node:fs/promises";
import {resolve,extname,sep} from "node:path";
import {createServer} from "node:http";
import assert from "node:assert/strict";
const require=createRequire(resolve(process.env.USERPROFILE,".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/package.json"));
const {chromium,webkit,devices}=require("playwright"),sharp=require("sharp");
let fixtureBuffer;
if(process.env.QA_FRAME_FIXTURE==="1"){
  const encoder=await chromium.launch({channel:"chrome",headless:true});
  try{
    const page=await encoder.newPage();
    const encoded=await page.evaluate(async()=>{
      const canvas=document.createElement("canvas");canvas.width=720;canvas.height=1280;
      const ctx=canvas.getContext("2d"),paint=()=>{ctx.fillStyle="#b8d9d5";ctx.fillRect(0,0,720,1280);ctx.strokeStyle="#82aaa6";ctx.lineWidth=2;for(let x=0;x<720;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,1280);ctx.stroke();}ctx.fillStyle="#31595b";ctx.font="36px sans-serif";ctx.fillText("FRAME GEOMETRY QA",100,640);};
      paint();const stream=canvas.captureStream(10),chunks=[],recorder=new MediaRecorder(stream,{mimeType:"video/mp4;codecs=avc1.42001E"});
      const finished=new Promise(ok=>recorder.onstop=ok);recorder.ondataavailable=e=>chunks.push(e.data);recorder.start();const timer=setInterval(paint,100);
      await new Promise(ok=>setTimeout(ok,1500));recorder.stop();await finished;clearInterval(timer);stream.getTracks().forEach(t=>t.stop());
      return await new Promise(ok=>{const r=new FileReader();r.onload=()=>ok(r.result.split(",")[1]);r.readAsDataURL(new Blob(chunks,{type:"video/mp4"}));});
    });fixtureBuffer=Buffer.from(encoded,"base64");
  }finally{await encoder.close();}
}
const root=resolve("dist"),types={".html":"text/html",".js":"text/javascript",".css":"text/css",".png":"image/png",".svg":"image/svg+xml",".woff2":"font/woff2",".jpg":"image/jpeg"};
const server=createServer(async(req,res)=>{try{
  const pathname=new URL(req.url,"http://localhost").pathname;
  if(pathname==="/__fixture.mp4"&&fixtureBuffer){res.setHeader("Content-Type","video/mp4");res.end(fixtureBuffer);return;}
  if(pathname.startsWith("/api/")){res.setHeader("Content-Type","application/json");res.end(JSON.stringify({paymentsEnabled:false,nftPaymentsEnabled:false,readiness:{processing:"offline"},donations:[],total:0}));return;}
  const file=resolve(root,"."+(pathname==="/"?"/index.html":decodeURIComponent(pathname)));
  if(!file.startsWith(root+sep))throw Error("Invalid path");
  const content=await readFile(file);res.setHeader("Content-Type",types[extname(file)]??"application/octet-stream");res.end(content);
}catch{res.writeHead(404);res.end();}});
await new Promise(ok=>server.listen(0,"127.0.0.1",ok));
const origin=process.env.QA_SITE_ORIGIN??`http://127.0.0.1:${server.address().port}`;
if(!/^https:\/\/chogcare\.xyz$|^http:\/\/127\.0\.0\.1:\d+$/.test(origin))throw Error("Unapproved QA origin");
const out=resolve("work/stream-frame-qa");await mkdir(out,{recursive:true});
const engine=process.env.QA_BROWSER==="webkit"?"webkit":"chrome";
const browser=await (engine==="webkit"?webkit.launch({headless:true}):chromium.launch({channel:"chrome",headless:true}));
try{
  const results=[];
  for(const [width,dpr,stage] of [[390,3,"hero"],[430,3,"hero"],[1440,1,"hero"],[390,3,"checkout"],[430,3,"checkout"],[1440,1,"checkout"]]){
    const context=await browser.newContext({...(width<768?{...devices["iPhone 13"],viewport:{width,height:844},deviceScaleFactor:dpr}:{viewport:{width,height:900},deviceScaleFactor:dpr}),bypassCSP:process.env.QA_FRAME_FIXTURE==="1"});
    const page=await context.newPage();
    await page.route("**/api/payments/**",route=>route.request().method()==="GET"?route.continue():route.abort());
    if(fixtureBuffer)await page.route("**/__fixture.mp4",route=>route.fulfill({contentType:"video/mp4",body:fixtureBuffer}));
    await page.goto(origin,{waitUntil:"domcontentloaded"});
    if(stage==="checkout"){
      await page.locator("#causes").scrollIntoViewIfNeeded();
      await page.locator(".care-cause-button").first().click();
    }
    const scope=stage==="checkout"?"#station":".care-intro";
    await page.evaluate(scope=>window.__qaScope=scope,scope);
    await page.waitForSelector(scope+" video");
    if(process.env.QA_FRAME_FIXTURE==="1"){
      await page.waitForTimeout(1200);
      await page.evaluate(async fixtureUrl=>{
      // Isolated geometry fixture only. Never modifies the broadcaster or site.
      const original=document.querySelector(window.__qaScope+" video"),video=document.createElement("video");
      video.className=original.className;video.muted=true;video.playsInline=true;video.loop=true;video.src=fixtureUrl;
      await new Promise((ok,bad)=>{video.onloadedmetadata=ok;video.onerror=()=>bad(Error("Fixture decode failed"));});
      // Feed decoded fixture metadata through the original aspect-ratio callback,
      // then detach from HLS so its network recovery cannot replace test media.
      Object.defineProperties(original,{videoWidth:{value:video.videoWidth,configurable:true},videoHeight:{value:video.videoHeight,configurable:true}});
      original.dispatchEvent(new Event("loadedmetadata"));original.replaceWith(video);await video.play();
    },origin+"/__fixture.mp4");
      // A replaced HLS source may retain its offline state; test only the rim.
      await page.addStyleTag({content:".lp-broadcast-state { display: none !important; }"});
    }
    await page.waitForFunction(()=>{const v=document.querySelector(window.__qaScope+" video");return v&&v.videoWidth>0&&v.readyState>=2;},{},{timeout:35000});
    await page.waitForTimeout(1000);
    const data=await page.evaluate(()=>{
      const frame=document.querySelector(window.__qaScope+" .lp-broadcast-frame"),inner=frame.querySelector(".lp-broadcast-interior"),video=frame.querySelector("video");
      const rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};};
      let decoded=null;try{const canvas=document.createElement("canvas");canvas.width=video.videoWidth;canvas.height=video.videoHeight;canvas.getContext("2d").drawImage(video,0,0);decoded=canvas.toDataURL("image/png").split(",")[1];}catch{}
      return{frame:rect(frame),inner:rect(inner),video:rect(video),source:{width:video.videoWidth,height:video.videoHeight},frameBorder:getComputedStyle(frame).borderWidth,innerRadius:getComputedStyle(inner).borderRadius,innerClip:getComputedStyle(inner).clipPath,fit:getComputedStyle(video).objectFit,decoded};
    });
    const raw=data.decoded;delete data.decoded;
    const screenshot=resolve(out,`frame-${engine}-${stage}-${width}-${dpr}x.png`);
    await page.locator(scope+" .lp-broadcast-frame").screenshot({path:screenshot});
    if(raw){const buffer=Buffer.from(raw,"base64");await writeFile(resolve(out,`source-${width}.png`),buffer);const {data:pixels,info}=await sharp(buffer).removeAlpha().raw().toBuffer({resolveWithObject:true});const line=y=>{let sum=0,count=0;for(let x=Math.floor(info.width*.25);x<info.width*.75;x++){const at=(y*info.width+x)*info.channels;sum+=(pixels[at]+pixels[at+1]+pixels[at+2])/3;count++;}return Math.round(sum/count);};data.sourceEdgeLuma={top:[0,1,2,3].map(line),bottom:[info.height-4,info.height-3,info.height-2,info.height-1].map(line)};}
    if(process.env.QA_FRAME_FIXTURE==="1"){
      const {data:pixels,info}=await sharp(screenshot).removeAlpha().raw().toBuffer({resolveWithObject:true});
      const sample=(x,y)=>{const at=(Math.round(y*dpr)*info.width+Math.round(x*dpr))*info.channels;return Math.round((pixels[at]+pixels[at+1]+pixels[at+2])/3);};
      const w=data.frame.width,h=data.frame.height,r=26,a=r-r/Math.sqrt(2)+3;
      data.interiorLuma=[sample(w/2,2),sample(w/2,h-3),sample(2,h/2),sample(w-3,h/2),sample(a,a),sample(w-a,a),sample(a,h-a),sample(w-a,h-a)];
      if(process.env.QA_VERIFY_FRAME==="1")assert.ok(data.interiorLuma.every(value=>value>80),"no dark seam inside straight edges or rounded corners");
    }
    if(process.env.QA_VERIFY_FRAME==="1"){
      assert.equal(data.frameBorder,"0px");assert.equal(data.innerClip,"none");
      const sourceAspect=process.env.QA_FRAME_FIXTURE==="1"?720/1280:data.source.width/data.source.height;
      assert.ok(Math.abs(data.frame.width/data.frame.height-sourceAspect)<.0001);
      assert.ok(Math.abs(data.frame.width-data.inner.width)<.05&&Math.abs(data.frame.height-data.inner.height)<.05);
      assert.equal(data.fit,"cover");
    }
    results.push({stage,width,dpr,...data});await context.close();
  }
  await writeFile(resolve(out,`${engine}-${process.env.QA_VERIFY_FRAME==="1"?"verified":"baseline"}.json`),JSON.stringify(results,null,2));
  console.log(JSON.stringify({origin,engine,verified:process.env.QA_VERIFY_FRAME==="1",results}));
}finally{await browser.close();await new Promise(ok=>server.close(ok));}

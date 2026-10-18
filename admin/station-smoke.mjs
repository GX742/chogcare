// Isolated renderer QA. All IPC is mocked; never starts a worker or opens USB.
import { app, BrowserWindow, ipcMain, protocol, net, session } from "electron";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { ADMIN_URL, assetPath, trustedSender } from "./security.mjs";
const here=fileURLToPath(new URL("./",import.meta.url));
const output=join(here,"..","work","admin-qa");
mkdirSync(join(output,"station-test-profile"),{recursive:true});
app.setPath("userData",join(output,"station-test-profile"));
protocol.registerSchemesAsPrivileged([{scheme:"chogcare-admin",privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.enableSandbox();
void app.whenReady().then(async()=>{
  let window;
  try{
    const root=join(here,"renderer-dist");
    session.fromPartition("station-build-qa").protocol.handle("chogcare-admin",async request=>{
      try{return net.fetch(pathToFileURL(await assetPath(root,request.url)).href);}catch{return new Response("Not found",{status:404});}
    });
    let tests=0;
    const snapshot={checkedAt:Date.now(),workspacePath:"Isolated build QA",stationPort:"COM6",stationTest:"idle",services:["payments","broadcast","station","gateway"].map(id=>({id,state:id==="station"?"running":"unknown",managed:id==="station",detail:"Build QA — no live service or USB connection."})),payments:null,support:{open:0,total:0},events:[]};
    for(const channel of ["admin:snapshot","admin:settings","admin:action"]){
      ipcMain.handle(channel,(event,input)=>{
        if(!trustedSender(event,window))return {ok:false};
        if(input?.type==="station.test"){tests++;snapshot.stationTest="done";}
        return {ok:true,data:channel==="admin:settings"?{workspacePath:snapshot.workspacePath,stationPort:"COM6",owncastPasswordSet:false}:structuredClone(snapshot)};
      });
    }
    window=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{preload:join(here,"preload.cjs"),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,partition:"station-build-qa",backgroundThrottling:false}});
    await window.loadURL(ADMIN_URL);
    const delay=()=>new Promise(resolve=>setTimeout(resolve,250));
    await delay();
    await window.webContents.executeJavaScript("[...document.querySelectorAll('nav button')].find(b=>b.textContent==='Services').click()");
    await delay();
    const initial=await window.webContents.executeJavaScript("(()=>{const b=document.querySelector('.admin-test-button');b.closest('section').scrollIntoView({block:'center'});return {enabled:!b.disabled,label:b.textContent,overflow:document.documentElement.scrollWidth>innerWidth}})()");
    await delay();await mkdir(output,{recursive:true});
    await window.webContents.executeJavaScript("document.querySelector('.admin-test-button').scrollIntoView({block:'center',behavior:'instant'})");
    await delay();
    const visible=await window.webContents.executeJavaScript("(()=>{const r=document.querySelector('.admin-test-button').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()");
    if(!visible)throw Error("Test button is outside the QA viewport");
    await writeFile(join(output,"station-test-button.png"),(await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript("document.querySelector('.admin-test-button').click()");await delay();
    const confirmed=await window.webContents.executeJavaScript("document.querySelector('#station-test-note').textContent.includes('confirmed by the device')");
    snapshot.services.find(s=>s.id==="station").managed=false;
    await window.webContents.executeJavaScript("[...document.querySelectorAll('button')].find(b=>b.textContent==='Refresh').click()").catch(async()=>{
      // Refresh directly through the isolated mock, then trigger page polling.
      await window.webContents.executeJavaScript("[...document.querySelectorAll('nav button')].find(b=>b.textContent==='Overview').click()");
      await delay();await window.webContents.executeJavaScript("[...document.querySelectorAll('button')].find(b=>b.textContent==='Check status').click()");
    });
    await delay();await window.webContents.executeJavaScript("[...document.querySelectorAll('nav button')].find(b=>b.textContent==='Services').click()");await delay();
    const externalDisabled=await window.webContents.executeJavaScript("document.querySelector('.admin-test-button').disabled");
    const result={mockOnly:true,...initial,tests,confirmed,externalDisabled};
    if(!initial.enabled||initial.overflow||tests!==1||!confirmed||!externalDisabled)throw Error("Station button renderer QA failed");
    await writeFile(join(output,"station-test-smoke.json"),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
    window.destroy();app.exit(0);
  }catch(error){console.error(error.message);window?.destroy();app.exit(1);}
});

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import assert from "node:assert/strict";

// Layout QA, not an ESP emulator: uses the actual RGB565 header pixels and
// actual Adafruit glyph bitmaps. U8g2 captions are approximated with a scaled
// bitmap sans font; no system-font substitution or accidental serif fallback.
const require = createRequire(resolve(process.argv[2], "package.json"));
const sharp = require("sharp");
const library = resolve(process.env.USERPROFILE, "Documents/Arduino/libraries/Adafruit_GFX_Library/Fonts");
const colors = { bg: [15,5,25], ink:[252,247,255], pink:[255,163,215], muted:[181,165,203], live:[110,220,174] };
const fonts = new Map();
for (const size of [9,12,18,24]) {
  const source = await readFile(resolve(library,`FreeSansBold${size}pt7b.h`),"utf8");
  const bits = source.split("Bitmaps[] PROGMEM = {")[1].split("};")[0];
  const glyphs = source.split("Glyphs[] PROGMEM = {")[1].split("};")[0];
  fonts.set(size,{ bits:[...bits.matchAll(/0x([0-9A-Fa-f]{2})/g)].map(x=>parseInt(x[1],16)),
    glyphs:[...glyphs.matchAll(/\{\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(-?\d+),\s*(-?\d+)\}/g)].map(x=>x.slice(1).map(Number)) });
}
const artHeader = await readFile("firmware/chogcare_station/StationArt.h","utf8");
const brandHeader = await readFile("firmware/chogcare_station/StationBrand.h","utf8");
function image(header,key) {
  const values=header.split(`const uint16_t ${key}[`)[1].split("= {")[1].split("};")[0];
  return [...values.matchAll(/0x([0-9a-f]{4})/g)].map(x=>parseInt(x[1],16));
}
function rgb(pixel){return [Math.round((pixel>>11&31)*255/31),Math.round((pixel>>5&63)*255/63),Math.round((pixel&31)*255/31)];}
function textBounds(value,size){const f=fonts.get(size);let cursor=0,left=Infinity,right=-Infinity;for(const c of value){const [,w,,advance,x]=f.glyphs[c.charCodeAt(0)-32];if(w){left=Math.min(left,cursor+x);right=Math.max(right,cursor+x+w);}cursor+=advance;}return{left,width:right-left};}
function canvas(){const pixels=Buffer.alloc(240*320*3);for(let at=0;at<pixels.length;at+=3)for(let c=0;c<3;c++)pixels[at+c]=colors.bg[c];return pixels;}
function pixel(p,x,y,color){if(x<0||x>=240||y<0||y>=320)return;for(let c=0;c<3;c++)p[(y*240+x)*3+c]=color[c];}
function rect(p,x,y,w,h,color){for(let py=y;py<y+h;py++)for(let px=x;px<x+w;px++)pixel(p,px,py,color);}
function rounded(p,x,y,w,h,r,color){for(let py=0;py<h;py++)for(let px=0;px<w;px++){const ex=Math.min(px,w-1-px),ey=Math.min(py,h-1-py);if(ex<r&&ey<r&&(r-ex)**2+(r-ey)**2>r*r)continue;pixel(p,x+px,y+py,color);}}
function text(p,value,size,baseline,color){const font=fonts.get(size),bounds=textBounds(value,size);assert.ok(bounds.width<=216,`Text overflow: ${value}`);let cursor=Math.floor((240-bounds.width)/2)-bounds.left;for(const c of value){const [offset,w,h,advance,dx,dy]=font.glyphs[c.charCodeAt(0)-32];for(let bit=0;bit<w*h;bit++)if(font.bits[offset+(bit>>3)]&(0x80>>(bit%8)))pixel(p,cursor+dx+bit%w,baseline+dy+Math.floor(bit/w),color);cursor+=advance;}}
function bitmap(p,words,w,h,x,y,targetW=w,targetH=h,r=0){for(let py=0;py<targetH;py++)for(let px=0;px<targetW;px++){const ex=Math.min(px,targetW-1-px),ey=Math.min(py,targetH-1-py);if(ex<r&&ey<r&&(r-ex)**2+(r-ey)**2>r*r)continue;pixel(p,x+px,y+py,rgb(words[Math.floor(py*h/targetH)*w+Math.floor(px*w/targetW)]));}}
function label(p,value,x,baseline,color="ink",center=false,readable=false){
  const font=fonts.get(9),bounds=textBounds(value,9),scaleY=readable?0.78:0.68;
  const targetWidth=readable?Math.round(bounds.width*0.72):value.length*6;
  const scaleX=targetWidth/bounds.width,left=center?Math.round(x-targetWidth/2):x;
  let cursor=-bounds.left;
  for(const c of value){const [offset,w,h,advance,dx,dy]=font.glyphs[c.charCodeAt(0)-32];for(let bit=0;bit<w*h;bit++)if(font.bits[offset+(bit>>3)]&(0x80>>(bit%8)))pixel(p,left+Math.floor((cursor+dx+bit%w)*scaleX),baseline+Math.floor((dy+Math.floor(bit/w))*scaleY),colors[color]);cursor+=advance;}
}
await mkdir("work/station-art",{recursive:true});
const outputs=[];
const idle=canvas();
text(idle,"ChogCare",18,35,colors.ink);
bitmap(idle,image(brandHeader,"WaitingArt"),176,176,32,54);
text(idle,"Waiting for",12,254,colors.ink);text(idle,"kindness",12,279,colors.pink);
rect(idle,97,297,8,8,colors.live);label(idle,"LIVE",128,307,"live",true,true);
const idlePng=await sharp(idle,{raw:{width:240,height:320,channels:3}}).png().toBuffer();
await writeFile("work/station-art/waiting-preview.png",idlePng);
for(const [cause,key,title,subtitle] of [["school-supplies","School","School supplies","Crypto education"],["vida-verde","Vida","+Vida +Verde","Venezuela"],["solar-foundation","Solar","The Solar","Foundation"],["animal-ethics","Animals","Animal Ethics",""],["burundi","Burundi","Perfect Villages","Burundi"]]){
  for(let scene=0;scene<3;scene++){
    const p=canvas();
    for(let i=0;i<3;i++)rect(p,12+i*74,6,68,3,i===scene?colors.pink:[55,34,76]);
    label(p,["YOUR IMPACT","YOUR DONATION","WITH GRATITUDE"][scene],12,scene===0?30:29,"muted",false,scene===0);
    label(p,"TEST / NO PAYMENT",132,29,"pink");
    if(scene===0){text(p,title,textBounds(title,18).width<=216?18:12,subtitle?145:164,colors.ink);if(subtitle)text(p,subtitle,textBounds(subtitle,18).width<=216?18:12,187,colors.pink);rect(p,84,220,73,1,colors.pink);text(p,"Your care goes to",9,86,colors.muted);text(p,"INITIATIVE PREVIEW",9,304,colors.muted);}
    if(scene===1){bitmap(p,image(artHeader,"DonationCoin"),96,96,72,48);text(p,"300",24,205,colors.ink);text(p,"CHOG",12,237,colors.pink);label(p,"Original donation amount",120,263,"muted",true);label(p,"SIMULATED - NO FUNDS MOVED",120,290,"ink",true);}
    if(scene===2){bitmap(p,image(brandHeader,"ThanksArt"),128,128,56,48);text(p,"Thank you!",18,214,colors.pink);text(p,"CHOG FRIEND",12,253,colors.ink);label(p,"You made a difference.",120,283,"ink",true);label(p,"SCREEN PREVIEW ONLY",120,304,"muted",true);}
    rect(p,12,315,216,2,[55,34,76]);rect(p,12,315,Math.round(216*(scene+0.5)/3),2,colors.pink);
    const png=await sharp(p,{raw:{width:240,height:320,channels:3}}).png().toBuffer();
    await writeFile(`work/station-art/${cause}-scene-${scene}.png`,png);
    if(cause==="solar-foundation")outputs.push({input:png,left:24+scene*264,top:48});
  }
}
await sharp({create:{width:816,height:392,channels:3,background:"#180d26"}}).composite(outputs).png().toFile("work/station-art/scene-preview.png");
await sharp({create:{width:1080,height:392,channels:3,background:"#180d26"}}).composite([{input:idlePng,left:24,top:48},...outputs.map(item=>({...item,left:item.left+264}))]).png().toFile("work/station-art/station-preview.png");
console.log("Checked all five initiative names and actual Adafruit text bounds. Wrote waiting + three-scene preview.");

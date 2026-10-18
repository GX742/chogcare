import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import assert from "node:assert/strict";

// Layout QA, not an ESP emulator: uses the actual RGB565 header pixels and
// actual Adafruit glyph bitmaps. U8g2 captions are approximated with a scaled
// bitmap sans font; no system-font substitution or accidental serif fallback.
const arguments_ = process.argv.slice(2);
const previewLeaderboard = arguments_.includes("--leaderboard");
const require = createRequire(resolve(arguments_.find(value => value !== "--leaderboard") ?? ".", "package.json"));
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
function textBounds(value,size){const f=fonts.get(size);let cursor=0,left=Infinity,right=-Infinity,top=Infinity,bottom=-Infinity;for(const c of value){const [,w,h,advance,x,y]=f.glyphs[c.charCodeAt(0)-32];if(w){left=Math.min(left,cursor+x);right=Math.max(right,cursor+x+w);top=Math.min(top,y);bottom=Math.max(bottom,y+h);}cursor+=advance;}return{left,width:right-left,top,bottom};}
function canvas(){const pixels=Buffer.alloc(240*320*3);for(let at=0;at<pixels.length;at+=3)for(let c=0;c<3;c++)pixels[at+c]=colors.bg[c];return pixels;}
function pixel(p,x,y,color){if(x<0||x>=240||y<0||y>=320)return;for(let c=0;c<3;c++)p[(y*240+x)*3+c]=color[c];}
function rect(p,x,y,w,h,color){for(let py=y;py<y+h;py++)for(let px=x;px<x+w;px++)pixel(p,px,py,color);}
function rounded(p,x,y,w,h,r,color){for(let py=0;py<h;py++)for(let px=0;px<w;px++){const ex=Math.min(px,w-1-px),ey=Math.min(py,h-1-py);if(ex<r&&ey<r&&(r-ex)**2+(r-ey)**2>r*r)continue;pixel(p,x+px,y+py,color);}}
function text(p,value,size,baseline,color,center=120){const font=fonts.get(size),bounds=textBounds(value,size);assert.ok(bounds.width<=216,`Text overflow: ${value}`);let cursor=center-Math.ceil(bounds.width/2)-bounds.left;for(const c of value){const [offset,w,h,advance,dx,dy]=font.glyphs[c.charCodeAt(0)-32];for(let bit=0;bit<w*h;bit++)if(font.bits[offset+(bit>>3)]&(0x80>>(bit%8)))pixel(p,cursor+dx+bit%w,baseline+dy+Math.floor(bit/w),color);cursor+=advance;}}
function bitmap(p,words,w,h,x,y,targetW=w,targetH=h,r=0){for(let py=0;py<targetH;py++)for(let px=0;px<targetW;px++){const ex=Math.min(px,targetW-1-px),ey=Math.min(py,targetH-1-py);if(ex<r&&ey<r&&(r-ex)**2+(r-ey)**2>r*r)continue;pixel(p,x+px,y+py,rgb(words[Math.floor(py*h/targetH)*w+Math.floor(px*w/targetW)]));}}
function label(p,value,x,baseline,color="ink",center=false,readable=false){
  const font=fonts.get(9),bounds=textBounds(value,9),scaleY=readable?0.78:0.68;
  const targetWidth=readable?Math.round(bounds.width*0.72):value.length*6;
  const scaleX=targetWidth/bounds.width,left=center?Math.round(x-targetWidth/2):x;
  let cursor=-bounds.left;
  for(const c of value){const [offset,w,h,advance,dx,dy]=font.glyphs[c.charCodeAt(0)-32];for(let bit=0;bit<w*h;bit++)if(font.bits[offset+(bit>>3)]&(0x80>>(bit%8)))pixel(p,left+Math.floor((cursor+dx+bit%w)*scaleX),baseline+Math.floor((dy+Math.floor(bit/w))*scaleY),colors[color]);cursor+=advance;}
}
await mkdir("work/station-art",{recursive:true});
const outputs=[],initiativeOutputs=[];
const idle=canvas();
text(idle,"ChogCare",18,35,colors.ink);
bitmap(idle,image(brandHeader,"WaitingArt"),176,176,32,54);
text(idle,"Waiting for",12,254,colors.ink);text(idle,"kindness",12,279,colors.pink);
rect(idle,97,297,8,8,colors.live);label(idle,"LIVE",128,307,"live",true,true);
const idlePng=await sharp(idle,{raw:{width:240,height:320,channels:3}}).png().toBuffer();
await writeFile("work/station-art/waiting-preview.png",idlePng);
for(const [cause,titleLines] of [["school-supplies",["School","Supplies","& Crypto","Education"]],["vida-verde",["+Vida","+Verde","Venezuela"]],["solar-foundation",["The Solar","Foundation"]],["animal-ethics",["Animal","Ethics"]],["burundi",["Perfect","Villages","Burundi"]]]){
  for(let scene=0;scene<3;scene++){
    const p=canvas();
    for(let i=0;i<3;i++)rect(p,12+i*74,6,68,3,i===scene?colors.pink:[55,34,76]);
    label(p,["YOUR IMPACT","YOUR DONATION","WITH GRATITUDE"][scene],12,scene===0?30:29,"muted",false,scene===0);
    label(p,"TEST / NO PAYMENT",132,29,"pink");
    if(scene===0){
      rounded(p,12,50,216,36,18,[39,20,53]);
      for(let i=0;i<=6;i++)rect(p,29+i,65+i,1,2,colors.pink);
      for(let i=0;i<=11;i++)rect(p,35+i,71-i,1,2,colors.pink);
      text(p,"Kindness received",9,73,colors.ink,133);
      const rows=titleLines.map(title=>{const size=textBounds(title,24).width<=216?24:18;return{title,size,...textBounds(title,size)};});
      const totalHeight=rows.reduce((sum,row)=>sum+row.bottom-row.top,0)+(rows.length-1)*5;
      assert.ok(totalHeight<=172,`Title block too tall: ${cause}`);
      let top=100+Math.trunc((172-totalHeight)/2);
      let previousBottom=86;
      for(const [i,row] of rows.entries()){
        const baseline=top-row.top;
        assert.ok(top>=100&&top>=previousBottom+4,`Title rows overlap: ${cause}`);
        assert.ok(baseline+row.bottom<=272,`Title hits decoration: ${cause}`);
        previousBottom=baseline+row.bottom;
        text(p,row.title,row.size,baseline,i+1===rows.length?colors.pink:colors.ink);
        top=previousBottom+5;
      }
      rect(p,84,284,73,1,colors.pink);
    }
    if(scene===1){bitmap(p,image(artHeader,"DonationCoin"),96,96,72,48);text(p,"300",24,205,colors.ink);text(p,"CHOG",12,237,colors.pink);label(p,"Original donation amount",120,263,"muted",true);label(p,"SIMULATED - NO FUNDS MOVED",120,290,"ink",true);}
    if(scene===2){bitmap(p,image(brandHeader,"ThanksArt"),128,128,56,48);text(p,"Thank you!",18,214,colors.pink);text(p,"CHOG FRIEND",12,253,colors.ink);label(p,"You made a difference.",120,283,"ink",true);label(p,"SCREEN PREVIEW ONLY",120,304,"muted",true);}
    rect(p,12,315,216,2,[55,34,76]);rect(p,12,315,Math.round(216*(scene+0.5)/3),2,colors.pink);
    const png=await sharp(p,{raw:{width:240,height:320,channels:3}}).png().toBuffer();
    await writeFile(`work/station-art/${cause}-scene-${scene}.png`,png);
    if(scene===0)initiativeOutputs.push({input:png,left:24+initiativeOutputs.length*264,top:48});
    if(cause==="solar-foundation")outputs.push({input:png,left:24+scene*264,top:48});
  }
}
await sharp({create:{width:816,height:392,channels:3,background:"#180d26"}}).composite(outputs).png().toFile("work/station-art/scene-preview.png");
await sharp({create:{width:1080,height:392,channels:3,background:"#180d26"}}).composite([{input:idlePng,left:24,top:48},...outputs.map(item=>({...item,left:item.left+264}))]).png().toFile("work/station-art/station-preview.png");
await sharp({create:{width:1344,height:392,channels:3,background:"#180d26"}}).composite(initiativeOutputs).png().toFile("work/station-art/initiative-preview.png");
console.log("Checked all five initiative names and actual Adafruit text bounds. Wrote waiting + three-scene preview.");

if (previewLeaderboard) {
  // Optional host-only QA. This reads public presentation data and never opens
  // USB or a payment database. Existing donation previews remain unchanged.
  let source = "fixture", failure = null, cards;
  try {
    const { createStationLeaderboard } = await import("./station-leaderboard.mjs");
    const leaderboard = createStationLeaderboard();
    cards = [];
    try {
      await leaderboard.refresh();
      const ranks = new Set();
      for (let index = 0; index < 5; index++) {
        const card = await leaderboard.next();
        if (!card || ranks.has(card.rank)) break;
        ranks.add(card.rank); cards.push(card);
      }
    } finally { leaderboard.close(); }
    if (!cards.length) throw new Error("No public leaderboard cards available.");
    source = "live public leaderboard";
  } catch (error) {
    failure = error.message;
    cards = [{ rank: 1, nick: "GX", amount: "1,800", image: null }];
  }
  function boardText(p, value, size, baseline, color, at = null) {
    const font = fonts.get(size), bounds = textBounds(value, size);
    let cursor = at ?? (bounds.width <= 216 ? 120 - Math.ceil(bounds.width / 2) - bounds.left : 12 - bounds.left);
    for (const character of value) {
      const [offset, width, height, advance, dx, dy] = font.glyphs[character.charCodeAt(0) - 32];
      for (let bit = 0; bit < width * height; bit++) {
        const x = cursor + dx + bit % width;
        if (x >= 12 && x < 228 && (font.bits[offset + (bit >> 3)] & (0x80 >> (bit % 8)))) pixel(p, x, baseline + dy + Math.floor(bit / width), color);
      }
      cursor += advance;
    }
  }
  const displaySource = await readFile("firmware/chogcare_station/StationDisplay.h", "utf8");
  const amountBaseline = Number(displaySource.match(/boardTextX\(boardAmountWidth\) - boardAmountBearing, (\d+) - bandY/)?.[1]);
  assert.ok(Number.isInteger(amountBaseline), "Firmware leaderboard amount baseline was not found.");
  const boardOutputs = [], report = [];
  for (const card of cards) {
    const p = canvas();
    text(p, "LEADERBOARD", 12, 30, colors.ink);
    rect(p, 12, 45, 64, 1, [55, 34, 76]); rect(p, 165, 45, 64, 1, [55, 34, 76]);
    label(p, `TOP ${String(card.rank).padStart(2, "0")}`, 120, 49, "pink", true);
    rounded(p, 52, 56, 136, 136, 19, [106, 57, 138]);
    rounded(p, 53, 57, 134, 134, 18, colors.bg);
    let words;
    if (Buffer.isBuffer(card.image) && card.image.length === 8192) {
      words = Array.from({ length: 4096 }, (_, at) => card.image.readUInt16BE(at * 2));
      bitmap(p, words, 64, 64, 56, 60, 128, 128, 15);
    } else bitmap(p, image(artHeader, "DonationCoin"), 96, 96, 56, 60, 128, 128, 15);
    const ascii = /^[\x20-\x7e]+$/.test(card.nick);
    const nickBounds = ascii ? textBounds(card.nick, 18) : null;
    if (nickBounds?.width <= 216) boardText(p, card.nick, 18, 223, colors.ink);
    else {
      // The firmware uses its 10x20 Cyrillic font on this branch. ASCII glyph
      // geometry here is an approximation, as with existing U8g2 captions.
      assert.ok(ascii, "Non-ASCII nickname needs a U8g2 preview renderer; the hardware supports Cyrillic.");
      label(p, card.nick, 12, 220, "ink");
      rect(p, 0, 196, 12, 30, colors.bg); rect(p, 228, 196, 12, 30, colors.bg);
    }
    const amountSize = [24, 18, 12].find(size => textBounds(card.amount, size).width <= 216) ?? 12;
    const amountBounds = textBounds(card.amount, amountSize);
    assert.ok(amountBaseline + amountBounds.top >= 230 && amountBaseline + amountBounds.bottom <= 278, "Leaderboard amount leaves its firmware slot.");
    boardText(p, card.amount, amountSize, amountBaseline, colors.pink);
    label(p, "CHOG DONATED", 120, 287, "muted", true);
    rect(p, 97, 297, 8, 8, colors.live); label(p, "LIVE", 128, 307, "live", true, true);
    const png = await sharp(p, { raw: { width: 240, height: 320, channels: 3 } }).png().toBuffer();
    await writeFile(`work/station-art/leaderboard-${source === "fixture" ? "fixture-" : ""}${card.rank}-preview.png`, png);
    boardOutputs.push({ input: png, left: 24 + boardOutputs.length * 264, top: 48 });
    report.push({ rank: card.rank, nick: card.nick, amount: card.amount, avatar: !!words, amountFont: amountSize, amountBaseline, nicknameFont: nickBounds?.width <= 216 ? "FreeSansBold18pt7b" : "U8g2 approximate" });
  }
  const sheet = sharp({ create: { width: boardOutputs.length * 264 + 24, height: 392, channels: 3, background: source === "fixture" ? "#43252a" : "#180d26" } });
  await sheet.composite(boardOutputs).png().toFile(`work/station-art/leaderboard-${source === "fixture" ? "fixture-" : ""}preview.png`);
  await writeFile("work/station-art/leaderboard-preview.json", `${JSON.stringify({ source, failure, note: "Actual Adafruit glyphs/RGB565 pixels; U8g2 captions approximated. LIVE status is illustrative.", cards: report }, null, 2)}\n`);
  console.log(`Leaderboard preview source: ${source}${failure ? ` (${failure})` : ""}. Wrote ${report.length} 240x320 cards and montage.`);
}

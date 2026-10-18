// Generate delivery copies; the supplied PNG originals remain unchanged.
import {createRequire} from "node:module";
import {stat} from "node:fs/promises";
import {resolve} from "node:path";
const require=createRequire(process.argv[2]?resolve(process.argv[2],"package.json"):import.meta.url);
const sharp=require("sharp");
const conversions=[
  ["chogcare-care-background.png","chogcare-care-background.webp",null],
  ["chogcare-care-logo.png","chogcare-care-logo-128.webp",128],
  ["chogcare-care-logo.png","chogcare-care-logo-256.webp",256],
  ["chogcare-wordmark.png","chogcare-wordmark.webp",null],
  ["gx-avatar.png","gx-avatar-128.webp",128],
  ["chog-donation-coin.png","chog-donation-coin-256.webp",256],
  ["chog-donation-coin.png","chog-donation-coin-512.webp",512],
  ["chog-holder-nft.png","chog-holder-nft-256.webp",256],
  ["chog-holder-nft.png","chog-holder-nft-512.webp",512],
];
for(const [input,output,width] of conversions){
  let image=sharp(`public/${input}`);
  if(width)image=image.resize({width,withoutEnlargement:true});
  await image.webp({quality:86,effort:6}).toFile(`public/${output}`);
  console.log(`${output}: ${(await stat(`public/${output}`)).size} bytes`);
}
for(const [width,output] of [[32,"chogcare-favicon.png"],[180,"chogcare-apple-touch.png"]]){
  await sharp("public/chogcare-care-logo.png").resize(width,width).png({compressionLevel:9}).toFile(`public/${output}`);
  console.log(`${output}: ${(await stat(`public/${output}`)).size} bytes`);
}

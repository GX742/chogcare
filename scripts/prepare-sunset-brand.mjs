// Extract the supplied ChogCare wordmark. No generative or replacement artwork.
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
const source = PNG.sync.read(readFileSync(new URL('../public/chogcare-sunset.png', import.meta.url)));
const logo = new PNG({ width: 610, height: 200 });
for (let y = 0; y < logo.height; y++) for (let x = 0; x < logo.width; x++) {
  const from = ((y + 170) * source.width + x + 600) * 4;
  const to = (y * logo.width + x) * 4;
  const [r, g, b] = source.data.subarray(from, from + 3);
  logo.data[to] = r; logo.data[to + 1] = g; logo.data[to + 2] = b;
  // The white/pink letters are brighter than the purple wall behind them.
  logo.data[to + 3] = Math.round(Math.min(1, Math.max(0,
    Math.min((r - 180) / 35, (g - 125) / 35, (b - 160) / 35))) * 255);
}
writeFileSync(new URL('../public/chogcare-wordmark.png', import.meta.url), PNG.sync.write(logo));
// Clear only the large painted wordmark from the wall for a clean backdrop.
// Interpolate the original wall samples, feathering the edit into the image.
// The character, scenery and terminal are unchanged; no new scene is generated.
const backdrop = PNG.sync.read(readFileSync(new URL('../public/chogcare-sunset.png', import.meta.url)));
const wallSample = (x, y) => source.data.subarray((y * source.width + x) * 4, (y * source.width + x) * 4 + 3);
const topLeft = wallSample(710, 140), topRight = wallSample(1050, 110);
const bottomLeft = wallSample(615, 395), bottomRight = wallSample(930, 390);
for (let y = 156; y < 370; y++) for (let x = 592; x < 1206; x++) {
  const to = (y * source.width + x) * 4;
  const fraction = (x - 592) / 614, vertical = (y - 156) / 214;
  const feather = Math.min(1, (x - 592) / 16, (1205 - x) / 16, (y - 156) / 14, (369 - y) / 14);
  for (let channel = 0; channel < 3; channel++) {
    const top = topLeft[channel] * (1 - fraction) + topRight[channel] * fraction;
    const bottom = bottomLeft[channel] * (1 - fraction) + bottomRight[channel] * fraction;
    const wall = top * (1 - vertical) + bottom * vertical;
    backdrop.data[to + channel] = Math.round(source.data[to + channel] * (1 - feather) + wall * feather);
  }
}
writeFileSync(new URL('../public/chogcare-sunset-background.png', import.meta.url), PNG.sync.write(backdrop));
console.log('Prepared supplied artwork: transparent wordmark and clean sunset backdrop.');

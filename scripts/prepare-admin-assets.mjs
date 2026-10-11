import { mkdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
const directory = resolve("admin/assets");
await mkdir(directory, { recursive: true });
await copyFile(resolve("public/chog-donation-coin.png"), resolve(directory, "coin.png"));

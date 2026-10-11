import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
const repo = fileURLToPath(new URL("../", import.meta.url));
export default defineConfig({
  root: repo,
  base: "./",
  publicDir: false,
  plugins: [react()],
  build: { outDir: "admin/renderer-dist", emptyOutDir: true, assetsInlineLimit: 0, rollupOptions: { input: "admin/index.html" }, sourcemap: false },
});

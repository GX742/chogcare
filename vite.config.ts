import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { randomBytes } from "node:crypto";
import { webBoundary } from "./server/web-boundary.ts";

export default defineConfig(({ command, isPreview }) => {
  // A local dev-process nonce permits Vite's React refresh and HMR styles only.
  // Built/preview HTML has no inline script exception, not a reusable build nonce.
  const developmentNonce = command === "serve" && !isPreview ? randomBytes(24).toString("base64") : undefined;
  return {
  html: developmentNonce ? { cspNonce: developmentNonce } : undefined,
  plugins: [{
    name: "private-application-files",
    configureServer(server) { server.middlewares.use((req,res,next)=>webBoundary(req,res,next,developmentNonce)); },
    configurePreviewServer(server) { server.middlewares.use((req,res,next)=>webBoundary(req,res,next)); },
  }, react()],
  server: {
    host: "127.0.0.1",
    port: 4173, strictPort: true,
    fs: {
      strict: true,
      deny: [".env", ".env.*", ".npmrc", ".yarnrc.yml", "**/.git/**", "**/work/**", "**/admin/**", "**/server/**", "**/scripts/**", "**/test/**", "**/contracts/**", "**/artifacts/**", "**/*.{sqlite,sqlite-wal,sqlite-shm,db,pem,key,pfx,p12,crt,cer,der}"],
    },
    proxy: { "/api/payments": "http://127.0.0.1:4174" },
  },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
}; });

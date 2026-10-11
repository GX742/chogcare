import { resolve, relative, isAbsolute } from "node:path";
import { realpath, stat } from "node:fs/promises";

export const ADMIN_ORIGIN = "chogcare-admin://app";
export const ADMIN_URL = `${ADMIN_ORIGIN}/admin/index.html`;
export function trustedSender(event, window) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === ADMIN_URL);
}
export async function assetPath(root, target) {
  const url = new URL(target);
  if (url.protocol !== "chogcare-admin:" || url.host !== "app" || url.username || url.password || url.search || url.hash) throw Error("Invalid app resource.");
  const decoded = decodeURIComponent(url.pathname);
  if (!/^\/[A-Za-z0-9_./-]+$/.test(decoded) || decoded.split("/").some(p => p === ".." || p.startsWith(".")) ||
      !(decoded === "/admin/index.html" || decoded.startsWith("/assets/") && /\.(?:js|css|woff2?|png|svg)$/.test(decoded))) throw Error("Invalid app resource.");
  const candidate = resolve(root, `.${decoded}`), segment = relative(root, candidate);
  if (segment.startsWith("..") || isAbsolute(segment)) throw Error("Invalid app resource.");
  // Lexical containment alone does not stop NTFS junctions or symlinks. Return
  // the resolved file itself so the subsequent read does not follow an alias.
  const [canonicalRoot, canonicalFile] = await Promise.all([realpath(root), realpath(candidate)]);
  const actual = relative(canonicalRoot, canonicalFile);
  if (!actual || actual.startsWith("..") || isAbsolute(actual) || !(await stat(canonicalFile)).isFile()) throw Error("Invalid app resource.");
  return canonicalFile;
}
export function safeExternalTarget(target) {
  if (target === "website") return "https://chogcare.vercel.app";
  if (target === "dashboard") return "https://chogcare.vercel.app/dashboard";
  throw Error("Unknown destination.");
}

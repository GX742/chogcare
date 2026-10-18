import { existsSync } from "node:fs";
import { join } from "node:path";

// Explicitly supported LTS line, not "any newer version" (odd majors can be EOL).
export const PAYMENT_NODE_VERSION = "24.22.0";
export function supportedPaymentNode(version) {
  const match = /^v24\.(\d+)\.(\d+)\s*$/.exec(version ?? "");
  return Boolean(match && Number(match[1]) >= 22);
}
export function defaultPaymentNode(workspace) {
  const portable = join(workspace, "work", "runtimes", `node-v${PAYMENT_NODE_VERSION}-win-x64`, "node.exe");
  return existsSync(portable) ? portable : "C:\\Program Files\\nodejs\\node.exe";
}

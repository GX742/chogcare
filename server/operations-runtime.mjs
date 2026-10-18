import { resolve } from "node:path";
import { openSupportStore } from "./support-store.mjs";
import { createReadOnlyDashboard } from "./ops-dashboard.mjs";
import { createReadOnlyQuoteService } from "./ops-quotes.mjs";
import { createPaymentService } from "./payment-service.mjs";
import { initLocalOpsDirectory } from "./local-ops-storage.mjs";

const ORIGINS = new Set(["https://chogcare.xyz", "https://chogcare.vercel.app", "https://chogcare.com", "https://www.chogcare.com", "http://127.0.0.1:4173"]);
const offlineStatus = () => ({ paymentMode: "offline", paymentsEnabled: false, nftPaymentsEnabled: false, integrityLocked: false, availableClaims: 0 });

export function createOperationsRuntime({ workspacePath, status = offlineStatus, impact } = {}, dependencies = {}) {
  if (typeof workspacePath !== "string" || !workspacePath.length || typeof status !== "function" || impact !== undefined && typeof impact !== "function") throw new Error("Invalid operations configuration.");
  const supportDirectory = (dependencies.initDirectory ?? initLocalOpsDirectory)(workspacePath, "support");
  const supportStore = openSupportStore(resolve(supportDirectory, "support.sqlite"));
  let quoteService;
  try { quoteService = createReadOnlyQuoteService(); } catch (error) { supportStore.close(); throw error; }
  const dashboard = createReadOnlyDashboard({ status, ...(impact ? { impact } : {}) });
  let closed = false;
  return {
    options: { supportStore, dashboard, quoteService },
    close() { if (!closed) { closed = true; quoteService.close(); supportStore.close(); } },
  };
}

// A signer-free fallback. It holds no vault, opens no financial database and
// cannot create even a preview or mutate any protected payment/profile state.
// The desktop controller must stop this listener before starting the worker.
export function createOfflineOperationsService({ workspacePath, allowedOrigin = "https://chogcare.xyz" } = {}, dependencies = {}) {
  if (!ORIGINS.has(allowedOrigin)) throw new Error("Operations site origin is not approved.");
  const runtime = createOperationsRuntime({ workspacePath }, dependencies);
  const store = {
    poolSummary: () => ({ fundedAvailableUnits: 0, availableClaims: 0, reservedTodayUnits: 0 }),
    requests: { find: () => null },
  };
  let server;
  try { server = createPaymentService(store, allowedOrigin, false, null, { ...runtime.options, operationsOnly: true }); }
  catch (error) { runtime.close(); throw error; }
  server.once("close", () => runtime.close());
  server.once("error", () => runtime.close());
  return server;
}

import { parseBridgeEstimate, type BridgeAmount, type BridgeEstimate } from "./ops-dashboard-model.ts";

export const estimateUnavailableMessage = "No estimate available right now. Try again later; no payment was created.";

type EstimateTask = {
  amount: BridgeAmount;
  initiativeId: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
  onResult: (estimate: BridgeEstimate) => void;
  onError: (message: string) => void;
  onSettled: () => void;
};

// A request timeout is a recoverable error, not a component unmount. Only the
// explicit lifetime check may suppress React updates or leave cleanup to its owner.
export async function runBridgeEstimate(task: EstimateTask, http: typeof fetch = fetch, clock = Date.now): Promise<void> {
  try {
    task.signal.throwIfAborted();
    const bootstrap = await http("/api/payments/config", { signal: task.signal, cache: "no-store", credentials: "same-origin" });
    if (!bootstrap.ok) throw new Error();
    const params = new URLSearchParams({ amount: task.amount, initiativeId: task.initiativeId });
    const response = await http(`/api/payments/bridge-estimate?${params}`, { signal: task.signal, cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error();
    const estimate = parseBridgeEstimate(await response.json(), task.amount, clock());
    task.signal.throwIfAborted();
    if (!estimate) throw new Error();
    if (task.isCurrent()) task.onResult(estimate);
  } catch {
    if (task.isCurrent()) task.onError(estimateUnavailableMessage);
  } finally {
    if (task.isCurrent()) task.onSettled();
  }
}

// Check bytes before decoding/appending, including chunked responses with no
// Content-Length. Never call response.text() on the public relay's unbounded body.
export async function readBoundedBroadcastBody(response: Response): Promise<string> {
  const limit = 65_536;
  const declared = response.headers.get("content-length");
  if (!response.body || declared !== null && (declared.match(/^[0-9]{1,10}$/)?.[0] !== declared || Number(declared) > limit)) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Broadcast response is unavailable or too large.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "", completed = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) { completed = true; return text + decoder.decode(); }
      bytes += next.value.byteLength;
      if (bytes > limit) throw new Error("Broadcast response is too large.");
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

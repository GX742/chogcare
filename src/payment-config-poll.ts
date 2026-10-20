export const paymentConfigTimeoutMs = 30_000;
export const paymentConfigPollDelayMs = 10_000;

// Wait for each read to settle before scheduling another one. The gateway can
// take longer than the polling delay without making a healthy service offline.
export function startPaymentConfigPolling<T>(
  load: (signal: AbortSignal) => Promise<T>,
  onConfig: (config: T) => void,
  onUnavailable: () => void,
): () => void {
  let disposed = false;
  let requestController: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    const controller = new AbortController();
    requestController = controller;
    const deadline = setTimeout(() => controller.abort(), paymentConfigTimeoutMs);
    try {
      const config = await load(controller.signal);
      controller.signal.throwIfAborted();
      if (!disposed) onConfig(config);
    } catch {
      if (!disposed) onUnavailable();
    } finally {
      clearTimeout(deadline);
      requestController = undefined;
      if (!disposed) timer = setTimeout(() => void poll(), paymentConfigPollDelayMs);
    }
  };
  void poll();
  return () => {
    disposed = true;
    clearTimeout(timer);
    requestController?.abort();
  };
}

// Request a tighter signed minimum instead of increasing the allowed bridge
// loss. Both checkout and display-only estimates use the same 0.25% tolerance;
// issued invoice minima and the separate pool-batch cost ceiling still apply.
export const RELAY_SLIPPAGE_TOLERANCE_BPS = "25";

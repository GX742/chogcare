// Request a tighter signed minimum instead of increasing the allowed bridge
// loss. Both checkout and display-only estimates use the same 0.25% tolerance;
// the independent bridge-cost ceiling and issued invoice minima still apply.
export const RELAY_SLIPPAGE_TOLERANCE_BPS = "25";

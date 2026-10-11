import { getAddress, isAddress, parseUnits, zeroAddress } from "viem";
import { PAYMENT_POLICY } from "./policy.mjs";

const CHOG = "0x350035555E10d9AfAF1566AaebfCeD5BA6C27777";
// Internal builder, only for a durable invoice approved by a future live processor.
export function paymentRequestUri({ mode, depositAddress, amount, chainId }) {
  if (chainId !== PAYMENT_POLICY.chainId || !isAddress(depositAddress) || depositAddress.toLowerCase() === zeroAddress) throw new Error("Invalid Monad payment destination.");
  if (depositAddress.toLowerCase() === CHOG.toLowerCase() || depositAddress.toLowerCase() === PAYMENT_POLICY.nftCollection) throw new Error("Never send deposits to token contracts.");
  if (typeof amount !== "string" || !/^\d{1,60}(\.\d{1,18})?$/.test(amount)) throw new Error("Invalid exact payment amount.");
  const units = parseUnits(amount, 18);
  if (units <= 0n || units >= 2n ** 256n) throw new Error("Invalid payment units.");
  const address = getAddress(depositAddress);
  if (mode === "chog" && units >= parseUnits("300", 18)) return `ethereum:${CHOG}@143/transfer?address=${address}&uint256=${units}`;
  if (mode === "nft" && units === parseUnits("1", 18)) return `ethereum:${address}@143?value=${units}`;
  throw new Error("Unsupported payment amount or method.");
}

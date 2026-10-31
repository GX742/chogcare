import { createPublicClient, http, parseUnits, formatUnits } from "viem";
import { monad } from "viem/chains";
import { saleQuote, usdcQuote } from "./source-quotes.mjs";
import { validateRelayOrder } from "./relay-route.mjs";
import { RELAY_SLIPPAGE_TOLERANCE_BPS } from "./relay-quote-policy.mjs";
import { MONAD_USDC } from "../src/route.ts";
import { deliveryNetwork, NEW_DONATION_CHAIN_ID } from "../src/delivery-network.ts";
import { CHOG_INITIATIVES, chogBeneficiary, initiativeChain } from "../src/chog-beneficiary.ts";
import { contributionForDonationUnits, splitSettlementUnits } from "../src/pool-contribution.ts";

const AMOUNTS = new Set(["300", "3000", "30000"]);
// Synthetic estimate identity only. This is never an invoice or a custody address.
const ESTIMATE_PAYER = "0x1111111111111111111111111111111111111111";
const NOTICE = "Estimate only; source gas and slippage are separate.";
const unavailable = () => Object.assign(new Error("Bridge estimate is temporarily unavailable. No payment was created."), { status: 503 });
const matches = (pattern, value) => typeof value === "string" && value.match(pattern)?.[0] === value;

export function validateEstimateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2 ||
      Object.keys(input).some(key => !["amount", "initiativeId"].includes(key)) || !AMOUNTS.has(input.amount) || !CHOG_INITIATIVES.includes(input.initiativeId)) throw Object.assign(new Error("Choose a supported donation amount and initiative."), { status: 400 });
  return { amount: input.amount, initiativeId: input.initiativeId };
}

async function fetchQuote(body, fetcher) {
  const response = await fetcher("https://api.relay.link/quote/v2", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(7500), headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw unavailable(); }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 262144)) { await response.body.cancel().catch(() => {}); throw unavailable(); }
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.byteLength; if (bytes > 262144) throw unavailable(); chunks.push(Buffer.from(chunk)); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

export function createReadOnlyQuoteService(_options = {}, dependencies = {}) {
  const source = dependencies.source ?? createPublicClient({ chain: monad, transport: http("https://rpc.monad.xyz", {
    timeout: 5000, retryCount: 0, maxResponseBodySize: 262144,
    methods: { include: ["eth_chainId", "eth_call"] }, fetchOptions: { redirect: "error" },
    // Keep the deadline alive while consuming the body, not just until headers.
    fetchFn: (url, init) => fetch(url, { ...init, redirect: "error", signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(5000)]) }),
  }) });
  const quoteSale = dependencies.saleQuote ?? saleQuote, quoteSwap = dependencies.usdcQuote ?? usdcQuote;
  const validate = dependencies.validateRelayOrder ?? validateRelayOrder, clock = dependencies.clock ?? Date.now;
  const fetcher = dependencies.fetch ?? fetch, cache = new Map();
  let inFlight = null, closed = false;
  return {
    async quote(raw) {
      const input = validateEstimateInput(raw);
      if (closed) throw unavailable();
      const key = `${input.amount}:${input.initiativeId}`, now = clock();
      for (const [name, value] of cache) if (value.expiresAt <= now) cache.delete(name);
      if (cache.has(key)) return structuredClone(cache.get(key));
      if (inFlight) { if (inFlight.key === key) return structuredClone(await inFlight.request); throw unavailable(); }
      const request = (async () => {
        if (await source.getChainId() !== 143) throw unavailable();
        const allocation = contributionForDonationUnits(parseUnits(input.amount, 18));
        const sale = await quoteSale(source, allocation.totalUnits), swap = await quoteSwap(source, BigInt(sale.minMon));
        if (!matches(/^[1-9]\d{0,18}$/, swap.minUsdc)) throw unavailable();
        const cause = splitSettlementUnits(BigInt(swap.minUsdc)).causeUnits;
        if (cause <= 0n) throw unavailable();
        const chain = initiativeChain(input.initiativeId, NEW_DONATION_CHAIN_ID), network = deliveryNetwork(chain), recipient = chogBeneficiary(input.initiativeId, chain);
        const quote = await fetchQuote({ user: ESTIMATE_PAYER, originChainId: 143, destinationChainId: chain, originCurrency: MONAD_USDC, destinationCurrency: network.usdc, recipient, refundTo: ESTIMATE_PAYER, amount: String(cause), tradeType: "EXACT_INPUT", includeProtocolData: true, slippageTolerance: RELAY_SLIPPAGE_TOLERANCE_BPS }, fetcher);
        const checkedAt = clock(), validated = await validate(quote, ESTIMATE_PAYER, cause, 1n, checkedAt, chain, input.initiativeId);
        const usd = value => { if (!matches(/^\d{1,19}$/, value)) throw unavailable(); return BigInt(value); };
        const inputUsd = usd(validated.inputUsdMicros), expected = usd(validated.expectedOutputUsdMicros), minimum = usd(validated.minimumOutputUsdMicros);
        if (inputUsd <= 0n || expected <= 0n || minimum <= 0n || minimum > expected || !Number.isSafeInteger(validated.validUntil) || validated.validUntil <= checkedAt) throw unavailable();
        const fee = inputUsd > expected ? inputUsd - expected : 0n;
        const result = {
          checkedAt, expiresAt: Math.min(checkedAt + 30_000, validated.validUntil), amountChog: input.amount,
          poolContributionChog: formatUnits(allocation.contributionUnits, 18), totalChog: formatUnits(allocation.totalUnits, 18),
          conversionMinimumUsdc: formatUnits(BigInt(swap.minUsdc), 6), expectedCharityUsd: formatUnits(expected, 6), minimumCharityUsd: formatUnits(minimum, 6),
          bridgeFeeUsd: formatUnits(fee, 6), bridgeFeePercent: formatUnits(fee * 10_000n / inputUsd, 2),
          estimatedSeconds: Number.isSafeInteger(validated.estimatedSeconds) && validated.estimatedSeconds > 0 && validated.estimatedSeconds <= 3600 ? validated.estimatedSeconds : null,
          notice: NOTICE,
        };
        if (!closed) { if (cache.size >= 20) cache.delete(cache.keys().next().value); cache.set(key, result); }
        return result;
      })();
      inFlight = { key, request };
      try { return structuredClone(await request); } catch { throw unavailable(); } finally { if (inFlight?.request === request) inFlight = null; }
    },
    close() { closed = true; cache.clear(); },
  };
}

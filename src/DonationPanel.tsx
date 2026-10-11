import { useEffect, useRef, useState } from "react";
import { ArrowRight, Heart, ShieldCheck, X } from "@phosphor-icons/react";
import { decodeEventLog, erc20Abi, formatUnits, type Address, type Hex } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { GIVETH_PROJECT_RECIPIENT, GIVETH_PROJECT_SLUG, GIVETH_PROJECT_URL, LIFI_DIAMOND, MONAD_USDC } from "./route";
import {
  blocksResubmit, buildCalls, errorCode, getBridgeQuote, makeQuote, parseSubmission, preflightBatch,
  quoteIsCurrent, readableError, requireAtomicWallet, sendAtomic, storageKey,
  type DonationQuote, type Submission,
} from "./transactions";

export default function DonationPanel() {
  const { address, chainId } = useAccount();
  const client = usePublicClient({ chainId: 143 });
  const { data: wallet } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();
  const [mode, setMode] = useState<"chog" | "usdc">("chog");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<DonationQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [notice, setNotice] = useState("");
  const [details, setDetails] = useState(false);
  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null);
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [storageError, setStorageError] = useState(false);
  const [recoveryHash, setRecoveryHash] = useState("");
  const mountedOwner = useRef(address);
  mountedOwner.current = address;
  const activeRef = useRef(false);
  const statusRef = useRef(false);
  const locked = storageError || blocksResubmit(submission);

  const refreshBalance = async (owner: Address) => {
    if (!client) return;
    const balance = await client.readContract({ address: MONAD_USDC, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
    if (mountedOwner.current === owner) setUsdcBalance(balance);
  };

  useEffect(() => {
    setQuote(null);
    setNotice("");
    setUsdcBalance(null);
    setSubmission(null);
    setStorageError(false);
    if (!address) return;
    const restore = () => {
      try { setSubmission(parseSubmission(localStorage.getItem(storageKey(address)), address)); }
      catch (error) { setStorageError(true); setNotice(readableError(error)); }
    };
    restore();
    void refreshBalance(address).catch(() => {});
    window.addEventListener("storage", restore);
    return () => window.removeEventListener("storage", restore);
  }, [address, client]);

  // Write before opening the wallet: a reload or timeout must not allow a second donation.
  const save = (record: Submission) => {
    localStorage.setItem(storageKey(record.owner), JSON.stringify(record));
    if (mountedOwner.current === record.owner) setSubmission(record);
  };

  const verifySource = async (record: Submission, hash: Hex) => {
    if (!client) throw new Error("Monad RPC is unavailable.");
    const receipt = await client.getTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("The transaction reverted. Transfer to the bridge was not confirmed.");
    const transferred = receipt.logs.reduce((total, log) => {
      if (log.address.toLowerCase() !== MONAD_USDC.toLowerCase()) return total;
      try {
        const event = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", data: log.data, topics: log.topics });
        if (event.args.from.toLowerCase() === record.owner.toLowerCase() && event.args.to.toLowerCase() === LIFI_DIAMOND.toLowerCase()) return total + event.args.value;
      } catch { /* Other token event. */ }
      return total;
    }, 0n);
    if (transferred !== BigInt(record.bridgeAmount)) throw new Error("This transaction does not contain the expected USDC transfer from your address to the bridge.");
    return { ...record, hash, state: "source-confirmed" as const };
  };

  const checkStatus = async (record = submission) => {
    if (!record || !wallet || !client || record.owner !== address || statusRef.current) return;
    statusRef.current = true;
    try {
      let next = record;
      if (next.id && next.state !== "source-confirmed" && next.state !== "complete") {
        const result = await wallet.getCallsStatus({ id: next.id });
        if (result.chainId !== 143) throw new Error("The wallet returned a status for a different network.");
        if (result.status === "success") {
          const hash = result.receipts?.[0]?.transactionHash;
          if (!hash || !result.atomic) throw new Error("The wallet did not confirm atomic execution. Check your wallet history.");
          next = await verifySource(next, hash);
          save(next);
          await refreshBalance(next.owner);
        } else if (result.statusCode === 400 || result.statusCode === 500) {
          save({ ...next, state: "failed" });
          setQuote(null);
          setNotice("The batch failed. Get a new quote. A reverted onchain transaction may still incur gas fees.");
          return;
        } else if (result.status === "pending") {
          save({ ...next, state: "pending" });
          setNotice("Your wallet is still processing the batch. Resubmission is blocked.");
          return;
        } else {
          save({ ...next, state: "unknown" });
          throw new Error("The batch result is uncertain. Check your wallet history without resubmitting.");
        }
      }
      if (next.hash && next.state === "source-confirmed") {
        const params = new URLSearchParams({ txHash: next.hash, fromChain: "143", toChain: "1", bridge: next.bridgeTool });
        const r = await fetch(`https://li.quest/v1/status?${params}`, { signal: AbortSignal.timeout(15_000) });
        if (!r.ok) throw new Error("The Monad transaction is confirmed. The bridge status service is currently unavailable.");
        const result = await r.json();
        if (result.status === "DONE" && result.substatus === "COMPLETED") {
          save({ ...next, state: "complete" });
          setNotice("The bridge confirmed USDC delivery on Ethereum.");
        } else if (result.status === "FAILED" || (result.status === "DONE" && result.substatus !== "COMPLETED")) {
          setNotice("The bridge did not confirm delivery of the expected USDC to the recipient. Check LI.FI Explorer; resubmission is blocked.");
        } else {
          setNotice("The Monad transaction is confirmed. Waiting for USDC delivery on Ethereum.");
        }
      }
    } catch (error) { setNotice(readableError(error)); }
    finally { statusRef.current = false; }
  };

  useEffect(() => {
    if (!submission || !blocksResubmit(submission) || (!submission.id && !submission.hash)) return;
    const timer = window.setInterval(() => void checkStatus(submission), 10_000);
    return () => window.clearInterval(timer);
  }, [submission, wallet, client, address]);

  const getQuote = async () => {
    if (!client || !wallet || !address) { setNotice("To donate your tokens, connect your wallet using the button above this form."); return; }
    if (locked || activeRef.current) return;
    activeRef.current = true;
    setBusy(true); setStage("Getting your quote"); setNotice(""); setQuote(null);
    const owner = address;
    try {
      if (chainId !== 143) {
        await switchChainAsync({ chainId: 143 });
        setNotice("Switched to Monad. Select Get quote again.");
        return;
      }
      await requireAtomicWallet(wallet, owner);
      const next = await makeQuote(client, owner, mode, amount);
      if (mountedOwner.current !== owner) return;
      setQuote(next);
      setNotice("Your quote is ready. Review the amount and recipient before confirming.");
    } catch (error) { setNotice(readableError(error)); }
    finally { activeRef.current = false; setBusy(false); setStage(""); }
  };

  const execute = async () => {
    if (!quote || !client || !wallet || !address || activeRef.current || locked) return;
    const owner = address;
    activeRef.current = true; setBusy(true); setNotice(""); setStage("Checking the route");
    try {
      if (!navigator.locks) throw new Error("Your browser cannot prevent duplicate submissions. Open this site in a current version of Chrome or Edge.");
      await navigator.locks.request(storageKey(owner), { ifAvailable: true }, async lock => {
        if (!lock) throw new Error("This transaction is already open in another tab.");
        const existing = parseSubmission(localStorage.getItem(storageKey(owner)), owner);
        if (blocksResubmit(existing)) { setSubmission(existing); throw new Error("Check the status of your previous submission first."); }
        if (!quoteIsCurrent(quote, owner)) { setQuote(null); throw new Error("The quote expired or your account changed. Get a new quote."); }
        await requireAtomicWallet(wallet, owner);
        const bridge = await getBridgeQuote(owner, quote.bridgeAmount);
        const calls = buildCalls(quote, bridge);
        setStage("Simulating the batch");
        await preflightBatch(client, owner, calls);
        if (mode === "usdc") {
          const balance = await client.readContract({ address: MONAD_USDC, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
          if (balance < quote.bridgeAmount) throw new Error("Your USDC balance changed. Get a new quote.");
        }
        // Recheck account/chain immediately before the only signing request.
        await requireAtomicWallet(wallet, owner);
        if (mountedOwner.current !== owner || !quoteIsCurrent(quote, owner)) throw new Error("Your wallet or quote changed. Get a new quote.");
        const requestId = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, "0")).join("")}`;
        let record: Submission = { owner, chainId: 143, id: requestId, bridgeTool: bridge.tool, state: "submitting", bridgeAmount: quote.bridgeAmount.toString(), createdAt: Date.now() };
        save(record);
        setStage("Confirm the batch in your wallet");
        try {
          // The wallet estimates aggregate gas; a stale API gas limit must not be reused.
          const result = await sendAtomic(wallet, owner, calls, requestId);
          record = { ...record, id: result.id, state: "pending" };
          save(record); setQuote(null);
          setNotice("Batch submitted to your wallet. Checking execution and USDC delivery.");
          await checkStatus(record);
        } catch (error) {
          // A timeout is ambiguous. Only an explicit pre-submission rejection unlocks retry.
          const code = errorCode(error);
          save({ ...record, state: code === 4001 || code === 5700 || code === 4200 || code === -32601 ? "failed" : "unknown" });
          setQuote(null);
          throw error;
        }
      });
    } catch (error) { setNotice(readableError(error)); }
    finally { activeRef.current = false; setBusy(false); setStage(""); }
  };

  const attachHash = async () => {
    if (!submission || !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash)) { setNotice("Enter the Monad transaction hash from your wallet history."); return; }
    setBusy(true);
    try {
      const next = await verifySource(submission, recoveryHash as Hex);
      save(next); await checkStatus(next);
    } catch (error) { setNotice(readableError(error)); }
    finally { setBusy(false); }
  };

  const changeMode = (next: "chog" | "usdc") => {
    setMode(next); setAmount(""); setQuote(null); setNotice("");
  };

  return (
    <section className="donation-shell" id="donate" aria-labelledby="donation-title">
      <div className="panel-heading">
        <div><h2 id="donation-title">Donation details</h2></div>
        <span className="mode-badge live"><ShieldCheck size={16} /> Monad mainnet</span>
      </div>
      <div className="donation-modes" role="group" aria-label="Donation source">
        <button className="button secondary compact" aria-pressed={mode === "chog"} disabled={busy || locked} onClick={() => changeMode("chog")}>Send CHOG</button>
        <button className="button secondary compact" aria-pressed={mode === "usdc"} disabled={busy || locked} onClick={() => changeMode("usdc")}>I have USDC</button>
      </div>
      {usdcBalance !== null && usdcBalance > 0n && (
        <p className="recovery-hint">Your wallet holds {formatUnits(usdcBalance, 6)} USDC on Monad. If your swap already completed, select I have USDC to avoid swapping CHOG again.</p>
      )}
      <div className="field">
        <label htmlFor="amount">Amount {mode === "chog" ? "CHOG" : "USDC"}</label>
        <div className="token-input">
          <input id="amount" inputMode="decimal" placeholder={mode === "chog" ? "Min. 300" : "0.00"} aria-describedby="amount-help" disabled={busy || locked} value={amount} onChange={e => { setAmount(e.target.value); setQuote(null); }} />
          <span>{mode === "chog" ? "CHOG" : "USDC"}</span>
        </div>
        <p id="amount-help">{mode === "chog" ? "Minimum 300 CHOG. Swap and bridge initiation in a single batch." : "Bridge your existing USDC directly. No CHOG is spent."}</p>
      </div>
      <div className="field">
        <label htmlFor="recipient">Giveth project address on Ethereum</label>
        <input id="recipient" className="plain-input" value={GIVETH_PROJECT_RECIPIENT} readOnly />
      </div>
      <div className="field">
        <label htmlFor="project">Giveth project</label>
        <input id="project" className="plain-input" value={GIVETH_PROJECT_SLUG} readOnly />
        <a className="field-link" href={GIVETH_PROJECT_URL} target="_blank" rel="noreferrer">View project on Giveth <ArrowRight size={15} /></a>
      </div>
      <div className="bonus-row"><div className="bonus-icon"><Heart size={22} weight="fill" /></div><div><strong>Holder pool: coming soon</strong><p>The $0.50 pool will launch in a later phase.</p></div><span className="pending-label">Not included</span></div>
      <button className="details-toggle" onClick={() => setDetails(!details)} aria-expanded={details}>How the transaction works <ArrowRight className={details ? "rotated" : ""} size={18} /></button>
      {details && <ol className="route-list">
        <li><span>1</span> One batch confirmation in a compatible wallet.</li>
        <li><span>2</span> CHOG → MON → USDC and bridge initiation in one Monad transaction. If any step fails, the whole batch reverts.</li>
        <li><span>3</span> The bridge delivers USDC on Ethereum. Delivery is tracked separately.</li>
        <li><span>4</span> The I have USDC option skips both swaps.</li>
      </ol>}
      {quote && <div className="quote-box" aria-live="polite">
        <div><span>To the bridge</span><strong>{formatUnits(quote.bridgeAmount, 6)} USDC</strong></div>
        <div><span>Minimum received</span><strong>{formatUnits(quote.minUsdc, 6)} USDC</strong></div>
        <div><span>Bridge</span><strong>{quote.bridgeTool}</strong></div>
        <p>Quotes expire after 2 minutes. Gas is paid in MON. {mode === "chog" && "1 MON and any surplus USDC from the swap stay in your wallet."}</p>
      </div>}
      <button className="button primary full" disabled={busy || locked} onClick={quote ? execute : getQuote}>
        {busy ? stage || "Checking" : locked ? "Checking previous submission" : quote ? "Confirm in one batch" : "Get quote"}<ArrowRight size={19} weight="bold" />
      </button>
      {submission && <div className="quote-box" aria-live="polite">
        <p>{submission.state === "complete" ? "Delivery confirmed" : submission.state === "failed" ? "Batch failed" : "Transaction saved. Do not resubmit."}</p>
        {submission.hash && <a className="tx-link" href={`https://monadscan.com/tx/${submission.hash}`} target="_blank" rel="noreferrer">Monad transaction <ArrowRight size={16} /></a>}
        {submission.hash && <a className="tx-link" href={`https://scan.li.fi/tx/${submission.hash}`} target="_blank" rel="noreferrer">Track delivery on Ethereum <ArrowRight size={16} /></a>}
        {(submission.id || submission.hash) && blocksResubmit(submission) && <button className="button secondary full" disabled={busy} onClick={() => void checkStatus()}>Check status</button>}
        {blocksResubmit(submission) && !submission.hash && <div className="field">
          <label htmlFor="recovery-hash">Monad transaction hash from your wallet</label>
          <input id="recovery-hash" className="plain-input" placeholder="0x..." value={recoveryHash} onChange={e => setRecoveryHash(e.target.value)} />
          <button className="button secondary full" disabled={busy} onClick={attachHash}>Verify transaction hash</button>
          <p>If there is no hash and the wallet service timed out, wait for the final status in your wallet history.</p>
        </div>}
      </div>}
      {notice && <div className="notice" role="status"><span>{notice}</span><button aria-label="Dismiss notification" onClick={() => setNotice("")}><X size={18} /></button></div>}
    </section>
  );
}

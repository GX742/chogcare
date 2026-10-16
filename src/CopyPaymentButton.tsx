import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";

export default function CopyPaymentButton({ value, label, onError }: { value: string; label: string; onError: (message: string) => void }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearTimeout(timer.current); }; }, []);
  useEffect(() => { clearTimeout(timer.current); setCopied(false); }, [value]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      if (!mounted.current) return;
      clearTimeout(timer.current);
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      if (mounted.current) onError("Copy is unavailable. Select the displayed value manually.");
    }
  }
  return <button type="button" className="checkout-copy" aria-label={label} onClick={() => void copy()}>
    {copied ? <Check size={18} aria-hidden="true"/> : <Copy size={18} aria-hidden="true"/>}
    <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
  </button>;
}

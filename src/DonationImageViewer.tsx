import { useEffect, useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react";
import DonationShare from "./DonationShare";
import { donationCard, type DonationCardInput } from "./donation-card";
import { initiativeNames } from "./donation-share";
import { loadDonationImageReceipt } from "./donation-image-receipt";
import type { CheckoutMode } from "./checkout";
import "./checkout.css";

export default function DonationImageViewer({ reference }: { reference: { mode: CheckoutMode; id: string } }) {
  const [attempt, setAttempt] = useState(0);
  const [receipt, setReceipt] = useState<{ key: string; input: DonationCardInput } | null>(null), [failed, setFailed] = useState("");
  const key = `${reference.mode}:${reference.id}:${attempt}`;
  useEffect(() => {
    if (!reference) return;
    const controller = new AbortController(); let active = true;
    void loadDonationImageReceipt(reference, AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]))
      .then(input => { if (active) { setReceipt({ key, input }); setFailed(""); } })
      .catch(() => { if (active) setFailed(key); });
    return () => { active = false; controller.abort(); };
  }, [key]);
  const current = receipt?.key === key ? receipt.input : null;
  return <div className="donation-images-content">
    <p className="donation-images-saved">Matched to your latest saved donation</p>
    {current ? <>
      <h3>{initiativeNames[current.initiativeId]}</h3>
      {donationCard(current) ? <DonationShare {...current}/> : <p className="donation-images-status" role="status">Your image becomes available once the donation is received.</p>}
    </> : failed === key ? <div className="donation-images-status" role="alert"><p>We couldn’t verify this saved donation. Try again when the connection is back.</p><button type="button" onClick={() => setAttempt(value => value + 1)}><ArrowClockwise size={17}/>Try again</button></div> : <p className="donation-images-status" role="status">Checking your donation receipt…</p>}
  </div>;
}

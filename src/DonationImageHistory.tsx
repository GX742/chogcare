import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Images, X } from "@phosphor-icons/react";
import { checkoutChanged, donationImageReferences } from "./checkout-session";
import "./donation-image-history.css";

const Viewer = lazy(() => import("./DonationImageViewer"));
function saved() { try { return donationImageReferences(); } catch { return []; } }

export default function DonationImageHistory() {
  const [references, setReferences] = useState(saved), [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const refresh = () => setReferences(saved());
    window.addEventListener(checkoutChanged, refresh);
    return () => window.removeEventListener(checkoutChanged, refresh);
  }, []);
  if (!references.length) return null;
  return <>
    <aside className="donation-images-toolbar" aria-label="Saved donation images">
      <button type="button" className="donation-images-open" onClick={() => { dialog.current?.showModal(); setOpen(true); }}><Images size={20}/>Your donation images<ArrowUpRight size={17}/></button>
    </aside>
    <dialog className="donation-images-dialog" ref={dialog} aria-labelledby="donation-images-title" onClose={() => setOpen(false)} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="donation-images-heading"><div><span>MADE FOR YOUR POST</span><h2 id="donation-images-title">Your donation images</h2></div><button type="button" className="donation-images-close" aria-label="Close donation images" autoFocus onClick={() => dialog.current?.close()}><X size={23}/></button></div>
      <p className="donation-images-intro">Your initiative and donation amount are filled in automatically.</p>
      {open && <Suspense fallback={<p className="donation-images-status" role="status">Loading your saved donation…</p>}><Viewer references={references}/></Suspense>}
    </dialog>
  </>;
}

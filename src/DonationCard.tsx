import { useEffect, useState } from "react";
import { DownloadSimple, ArrowClockwise } from "@phosphor-icons/react";
import { CARD_HEIGHT, CARD_WIDTH, donationCard, type DonationCardInput } from "./donation-card";

type PreparedCard = { key: string; preview: string; download: string };
export default function DonationCard(props: DonationCardInput) {
  const card = donationCard(props);
  const [attempt, setAttempt] = useState(0), [prepared, setPrepared] = useState<PreparedCard | null>(null), [failedKey, setFailedKey] = useState("");
  const key = card ? `${card.key}:${attempt}` : "";
  useEffect(() => {
    if (!card) return;
    let active = true, download = "";
    const controller = new AbortController();
    const timeout = setTimeout(() => { if (active) setFailedKey(key); controller.abort(new DOMException("Image preparation timed out.", "TimeoutError")); }, 25_000);
    void import("./donation-card-render").then(async renderer => {
      const blob = await renderer.renderDonationCard(card, controller.signal);
      const preview = await renderer.cardPreviewData(blob);
      if (!active) return;
      download = URL.createObjectURL(blob);
      setPrepared({ key, preview, download }); setFailedKey("");
    }).catch(() => { if (active) setFailedKey(key); }).finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); if (download) URL.revokeObjectURL(download); };
  }, [key]);
  if (!card) return null;
  const ready = prepared?.key === key ? prepared : null;
  return <figure className="donation-card" aria-busy={!ready && failedKey !== key} aria-label="Your donation image">
    {ready ? <img className="donation-card-image" src={ready.preview} alt={card.alt} width={CARD_WIDTH} height={CARD_HEIGHT} decoding="async"/> :
      <div className="donation-card-placeholder" role={failedKey === key ? "alert" : "status"}>
        {failedKey === key ? <><span>Your image couldn’t load.</span><button type="button" onClick={() => setAttempt(value => value + 1)}><ArrowClockwise size={17}/>Try again</button></> : <span>Preparing your donation image…</span>}
      </div>}
    <figcaption className="donation-card-caption"><span>Made for your post</span>
      {ready ? <a className="donation-card-download" href={ready.download} download={card.filename}><DownloadSimple size={19} weight="bold"/>Download PNG</a> : <span className="donation-card-format">High-resolution PNG</span>}
    </figcaption>
  </figure>;
}

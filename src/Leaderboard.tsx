import { useEffect, useState } from "react";
import { ArrowRight, Heart } from "@phosphor-icons/react";
import { formatChogAmount, type LeaderboardEntry } from "./leaderboard-model";
import { loadPublicLeaderboard } from "./leaderboard-client";

export default function Leaderboard() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const timer = setTimeout(() => controller.abort(), 12000);
    setLoading(true); setUnavailable(false);
    void loadPublicLeaderboard(controller.signal)
      .then(next => { if (!disposed) setEntries(next); })
      .catch(() => { if (!disposed) setUnavailable(true); })
      .finally(() => { clearTimeout(timer); if (!disposed) setLoading(false); });
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, [revision]);
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener("chogcare:leaderboard", refresh);
    return () => window.removeEventListener("chogcare:leaderboard", refresh);
  }, []);

  return <section id="leaderboard" tabIndex={-1} className="care-leaderboard" aria-labelledby="leaderboard-heading">
    <div className="leaderboard-intro">
      <span>THE CARE BOARD</span><h2 id="leaderboard-heading">Every donation leaves a signal.</h2>
      <p>A public thank-you to people moving CHOG into real-world support. Wallet addresses are not displayed.</p>
      <a href="#causes">Join with a donation <ArrowRight size={17}/></a>
    </div>
    <div className="leaderboard-board" aria-busy={loading}>
      {unavailable && <div className="leaderboard-unavailable" role="status">
        <strong>Leaderboard unavailable</strong>
        <p>{entries.length ? "Showing the last loaded totals. We couldn’t refresh them." : "We couldn’t load the donations. This does not mean the board is empty."}</p>
        <button type="button" onClick={() => setRevision(value => value + 1)} disabled={loading}>Retry leaderboard</button>
      </div>}
      {loading && !entries.length ? <div className="leaderboard-loading" aria-label="Loading leaderboard"><span/><span/><span/></div> :
        entries.length ? <ol>{entries.map(entry => <li key={`${entry.rank}-${entry.nickname}-${entry.amount}`}>
          <b>{String(entry.rank).padStart(2, "0")}</b>
          <img src={entry.avatarImage || "/chog-donation-coin.png"} alt={entry.avatarName || "ChogCare badge"} referrerPolicy="no-referrer" onError={event => { if (!event.currentTarget.src.endsWith("/chog-donation-coin.png")) event.currentTarget.src = "/chog-donation-coin.png"; }}/>
          <div><strong>{entry.nickname}</strong></div>
          <p title={`${entry.amount} CHOG`}>{formatChogAmount(entry.amount)}<small>CHOG</small></p>
        </li>)}</ol> :
        !unavailable && <div className="leaderboard-empty"><Heart size={36} weight="light"/><strong>The first place is open.</strong><p>Complete a CHOG donation and choose your public name.</p></div>}
    </div>
  </section>;
}

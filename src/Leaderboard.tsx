import { useEffect, useState } from "react";
import { ArrowRight, Heart } from "@phosphor-icons/react";
import { presentChogAmount, type LeaderboardEntry } from "./leaderboard-model";
import { loadPublicCareBoard } from "./leaderboard-client";
import { loadPublicImpact, type PublicImpact } from "./leaderboard-impact";
import { presentPoolUsdc, type NftPoolImpact } from "./leaderboard-pool";

export default function Leaderboard() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [revision, setRevision] = useState(0);
  const [impact, setImpact] = useState<PublicImpact | null>(null);
  const [impactUnavailable, setImpactUnavailable] = useState(false);
  const [pool, setPool] = useState<NftPoolImpact | null>(null);
  const [poolUnavailable, setPoolUnavailable] = useState(false);
  const impactAmount = impact ? /[1-9]/.test(impact.chogDonated) ? presentChogAmount(impact.chogDonated) : { display: "0", rounded: false } : null;
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const timer = setTimeout(() => controller.abort(), 12000);
    setLoading(true); setUnavailable(false); setImpactUnavailable(false); setPoolUnavailable(false);
    const board = loadPublicCareBoard(controller.signal)
      .then(next => {
        if (!disposed) {
          setEntries(next.entries);
          setPoolUnavailable(next.pool === null);
          if (next.pool) setPool(next.pool);
        }
      })
      .catch(() => { if (!disposed) { setUnavailable(true); setPoolUnavailable(true); } });
    const total = loadPublicImpact(controller.signal)
      .then(next => { if (!disposed) setImpact(next); })
      .catch(() => { if (!disposed) setImpactUnavailable(true); });
    void Promise.all([board, total]).finally(() => { clearTimeout(timer); if (!disposed) setLoading(false); });
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, [revision]);
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener("chogcare:leaderboard", refresh);
    const visibleRefresh = () => { if (!document.hidden) refresh(); };
    const interval = window.setInterval(visibleRefresh, 60_000);
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => { window.removeEventListener("chogcare:leaderboard", refresh); document.removeEventListener("visibilitychange", visibleRefresh); clearInterval(interval); };
  }, []);

  return <section id="leaderboard" tabIndex={-1} className="care-leaderboard" aria-labelledby="leaderboard-heading">
    <div className="leaderboard-impact" aria-busy={loading}>
      <div className="leaderboard-impact-value">
        <span className="leaderboard-impact-label">Together, we’ve donated</span>
        <p className={`leaderboard-impact-amount${(impactAmount?.display.length ?? 0) > 6 ? " is-long" : ""}`} title={impact ? `${impact.chogDonated} $CHOG` : undefined}>
          <strong>{impactAmount?.display ?? "—"}</strong><span>$CHOG</span>
        </p>
        <small className="leaderboard-impact-usd">{impactUnavailable ? impact ? "(Last loaded total · refresh unavailable)" : "(Total temporarily unavailable)" : impact?.estimatedUsd ? `(≈ ${impact.estimatedUsd} USD)` : loading && !impact ? "(Loading donation total…)" : "(USD estimate unavailable)"}{impactAmount?.rounded && " · Rounded to 2 decimals"}</small>
      </div>
      <div className="leaderboard-impact-context">
        <p>Completed donations · selected amounts, including anonymous gifts. Wallet addresses are not displayed.</p>
        <small>USD estimate at the current rate, before fees. NFT pool contributions are separate.</small>
        {impactUnavailable && <button type="button" onClick={() => setRevision(value => value + 1)} disabled={loading}>Refresh total <ArrowRight size={16}/></button>}
      </div>
    </div>
    <div className="leaderboard-ranking">
    <div className="leaderboard-intro">
      <span>THE CARE BOARD</span><h2 id="leaderboard-heading">Every contribution counts.</h2>
      <a href="#causes">Join with a donation <ArrowRight size={17}/></a>
    </div>
    <div className="leaderboard-board" aria-busy={loading}>
      {unavailable && <div className="leaderboard-unavailable" role="status">
        <span className="care-board-state-icon" aria-hidden="true"><Heart size={30} weight="light" /></span>
        <strong>Leaderboard unavailable</strong>
        <p>{entries.length ? "Showing the last loaded totals. We couldn’t refresh them." : "We couldn’t load the donations. This does not mean the board is empty."}</p>
        <button type="button" onClick={() => setRevision(value => value + 1)} disabled={loading}>Retry leaderboard</button>
      </div>}
      {loading && !entries.length ? <div className="leaderboard-loading" aria-label="Loading leaderboard"><span/><span/><span/></div> :
        entries.length ? <ol>{entries.map(entry => { const amount = presentChogAmount(entry.amount); return <li key={`${entry.rank}-${entry.nickname}-${entry.amount}`}>
          <b>{String(entry.rank).padStart(2, "0")}</b>
          <img src={entry.avatarImage || "/chog-donation-coin.png"} loading="lazy" alt={entry.avatarName || "ChogCare badge"} referrerPolicy="no-referrer" onError={event => { if (!event.currentTarget.src.endsWith("/chog-donation-coin.png")) event.currentTarget.src = "/chog-donation-coin.png"; }}/>
          <div><strong>{entry.nickname}</strong></div>
          <p title={`${entry.amount} $CHOG`}>{amount.display}<small>$CHOG{amount.rounded ? " · rounded" : ""}</small></p>
        </li>; })}</ol> :
        !unavailable && <div className="leaderboard-empty"><Heart size={36} weight="light"/><strong>The first place is open.</strong><p>Complete a $CHOG donation and choose your public name.</p></div>}
      <div className="leaderboard-pool" role="group" aria-label="NFT Pool donations, outside the ranking">
        <img src="/chog-holder-nft.png" alt="" loading="lazy"/>
        <div className="leaderboard-pool-identity"><strong>NFT Pool <span>Not ranked</span></strong><p>Donated from the community pool</p></div>
        <div className="leaderboard-pool-total">
          <p title={pool ? `${presentPoolUsdc(pool.donatedUsdc)} USDC donated` : undefined}><strong>{pool ? presentPoolUsdc(pool.donatedUsdc) : "—"}</strong><span>USDC</span></p>
          <small>{poolUnavailable ? pool ? "Last loaded total · refresh unavailable" : "Total temporarily unavailable" : pool ? `${pool.donations.toLocaleString("en-US")} ${pool.donations === 1 ? "donation" : "donations"} delivered` : loading ? "Loading pool total…" : "Total temporarily unavailable"}</small>
        </div>
      </div>
    </div>
    </div>
  </section>;
}

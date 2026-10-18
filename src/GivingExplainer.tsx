import { ArrowUpRight } from "@phosphor-icons/react";

/** The original local layout, using the site's existing mechanics and trust styles. */
export default function GivingExplainer() {
  return <>
    <section id="how-it-works" tabIndex={-1} className="care-mechanics" aria-label="How ChogCare works">
      <div className="care-mechanics-heading"><span className="care-section-label">How it works</span><h2>Two ways to give.</h2></div>
      <article className="care-mechanic care-token-mechanic" aria-labelledby="token-mechanic-title">
        <div className="care-mechanic-art care-coin-art"><img src="/chog-donation-coin.png" srcSet="/chog-donation-coin-256.webp 256w, /chog-donation-coin-512.webp 512w" sizes="(max-width: 767px) 56px, 100px" alt="Purple $CHOG coin" width="1324" height="1188" loading="lazy" /></div>
        <div className="care-mechanic-copy">
          <span className="care-mechanic-label">$CHOG donation</span>
          <h3 id="token-mechanic-title">Give with $CHOG</h3>
          <p>Choose a cause and send $CHOG by QR. We handle the exchange and deliver your donation.</p>
          <span className="care-mechanic-note">Use your own wallet, not an exchange. ChogCare holds funds during processing.</span>
        </div>
        <ol className="care-giving-flow" aria-label="$CHOG donation steps">
          <li><span className="care-step-number" aria-hidden="true">01</span><span className="care-step-copy"><strong>Choose a cause</strong><small>Find an initiative you believe in.</small></span></li>
          <li><span className="care-step-number" aria-hidden="true">02</span><span className="care-step-copy"><strong>Send $CHOG by QR</strong><small>From your own wallet.</small></span></li>
          <li><span className="care-step-number" aria-hidden="true">03</span><span className="care-step-copy"><strong>We deliver it</strong><small>Exchange, then delivery to the cause.</small></span></li>
        </ol>
      </article>
      <article className="care-mechanic care-nft-mechanic" aria-labelledby="nft-mechanic-title">
        <div className="care-mechanic-art care-nft-art"><img src="/chog-holder-nft.png" srcSet="/chog-holder-nft-256.webp 256w, /chog-holder-nft-512.webp 512w" sizes="(max-width: 767px) 56px, 100px" alt="CHOG NFT with a blue hat and purple laser eyes" width="1000" height="1000" loading="lazy" /></div>
        <div className="care-mechanic-copy">
          <span className="care-mechanic-label">NFT community pool</span>
          <h3 id="nft-mechanic-title">Give as an NFT holder</h3>
          <p>Hold a CHOG NFT and choose a cause. The pool donates <strong>$1 on your behalf.</strong></p>
          <span className="care-mechanic-note">Three donations a day. $3 daily pool.<br />Standard allowance: one donation per wallet and NFT.</span>
        </div>
        <ol className="care-giving-flow" aria-label="NFT pool donation steps">
          <li><span className="care-step-number" aria-hidden="true">01</span><span className="care-step-copy"><strong>Choose a cause</strong><small>Pick an NFT-pool initiative.</small></span></li>
          <li><span className="care-step-number" aria-hidden="true">02</span><span className="care-step-copy"><strong>Verify your wallet</strong><small>With a separate 1 MON donation.</small></span></li>
          <li><span className="care-step-number" aria-hidden="true">03</span><span className="care-step-copy"><strong>Pool gives $1</strong><small>Subject to daily limits and availability.</small></span></li>
        </ol>
      </article>
    </section>

    <section className="care-giving-trust" aria-label="Transparent payment split and project sources">
      <div className="care-contribution-rule">
        <div className="care-trust-labels"><span>Transparent split</span><span>0% service fee</span></div>
        <h3>One donation. More daily impact.</h3>
        <p>Your cause amount stays intact. <strong>An extra 10%</strong> is added on top for the NFT community pool.</p>
        <div className="care-split-meter" aria-label="100 percent to your cause plus 10 percent to the NFT pool"><span><b>100%</b> your cause</span><span><b>+10%</b> NFT pool</span></div>
      </div>
      <div className="care-source-list">
        <a className="care-source-row" href="https://giveth.io/" target="_blank" rel="noopener noreferrer"><img src="/giveth-mark.png" alt="" width="48" height="48" loading="lazy" /><span><small>Verified project pages</small><strong>Giveth-listed causes</strong></span><ArrowUpRight size={18} /></a>
        <a className="care-source-row" href="https://www.animal-ethics.org/cryptocurrencies/" target="_blank" rel="noopener noreferrer"><img className="is-animal" src="/animal-ethics-mark.png" alt="" width="48" height="48" loading="lazy" /><span><small>Official donation address</small><strong>Animal Ethics</strong></span><ArrowUpRight size={18} /></a>
      </div>
      <p className="care-giving-terms">Before the QR, you see the full $CHOG total and live dollar estimate. Exchange and delivery fees still apply; keep MON for wallet gas. NFT verification uses a separate 1 MON donation.</p>
    </section>
  </>;
}

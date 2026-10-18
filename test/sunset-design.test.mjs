import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const app = read('../src/App.tsx');
const css = read('../src/sunset-redesign.css');
const giving = read('../src/GivingExplainer.tsx');

test('sunset animation mounts after the referenced hero DOM and cleans up its observers', () => {
  assert.ok(app.indexOf('<SunsetScene ') > app.indexOf('</main>'));
  const scene = read('../src/SunsetScene.tsx');
  assert.match(scene, /dependencies: \[checkout\], revertOnUpdate: true/);
  assert.match(scene, /observer.disconnect\(\); media.revert\(\)/);
  assert.match(scene, /prefers-reduced-motion: reduce/);
  assert.match(scene, /scrub: context.conditions\?\.reduced \? true : \.25/);
  assert.match(scene, /trigger: hero, start: "bottom 85%", end: "bottom 25%"/);
});

test('supplied wordmark has transparent corners and a substantial readable letter area', () => {
  const logo = PNG.sync.read(readFileSync(new URL('../public/chogcare-wordmark.png', import.meta.url)));
  assert.equal(logo.width, 610); assert.equal(logo.height, 200);
  let opaque = 0;
  for (let index = 3; index < logo.data.length; index += 4) if (logo.data[index] > 230) opaque++;
  assert.ok(opaque > 15000 && opaque < 60000);
  for (const [x, y] of [[0,0], [609,0], [0,199], [609,199]]) assert.equal(logo.data[(y*logo.width+x)*4+3], 0);
});

test('lower panels are opaque and the live frame no longer rotates a pixelated oversized rim', () => {
  assert.doesNotMatch(css, /background: #110c1df7/);
  assert.match(css, /care-lower-world[^}]*background: #110c1d;/);
  assert.match(css, /care-lower-world[^}]*border-radius: 28px;/);
  assert.match(css, /care-lower-world[^}]*border-radius: 22px;/);
  assert.match(css, /lp-broadcast-frame::before \{ display: none/);
  assert.match(css, /clip-path: inset\(0 round var\(--broadcast-radius\)\)/);
  assert.match(css, /care-brand-icon[^}]*box-shadow: none/);
});

test('minimal header navigation returns while FAQ stays replaced by protected support', () => {
  const navigation = app.match(/<nav className="care-header-nav"[\s\S]*?<\/nav>/)?.[0];
  assert.ok(navigation);
  assert.equal((navigation.match(/<a /g) || []).length, 3);
  for (const target of ['causes', 'how-it-works', 'leaderboard']) assert.ok(navigation.includes(`leaveStation("${target}")`));
  assert.match(navigation, />Causes<\/a>/);
  assert.doesNotMatch(navigation, /Choose a cause/);
  assert.doesNotMatch(app, /faq-heading|care-hero-coin/);
  assert.match(app, /onClick=\{\(\) => setSupport\(\{\}\)\}/);
  assert.match(app, /<SupportDialog context=\{support\}/);
});

test('headline shade is localized and leaves the illustration sharp', () => {
  assert.match(css, /ellipse 36% 40% at 68% 48%, #0c0614bf/);
  assert.match(css, /url\('\/chogcare-care-background.png'\)/);
  assert.doesNotMatch(css, /care-sunset-art[^}]*blur\(/);
  assert.match(css, /care-header-inner nav \{ display: none/);
});

test('native stream preserves the entire landscape or portrait frame instead of cropping it', () => {
  assert.match(css, /video\.lp-broadcast-player \{ object-fit: contain; object-position: center;/);
  assert.match(app, /loadState !== "playing"/);
  assert.match(app, /playerLoaded \? "LIVE" : "STREAM"/);
  assert.equal((app.match(/portraitAspect=\{portraitAspect\} onAspect=\{setPortraitAspect\}/g) ?? []).length, 2);
  const panel = app.slice(app.indexOf('function BroadcastPanel'), app.indexOf('export default function App'));
  assert.doesNotMatch(panel, /const \[portraitAspect, setPortraitAspect\]/);
});

test('compact broadcast sizing reduces both hero and checkout frames without restoring side bars', () => {
  assert.match(css, /care-intro-broadcast \{ width: min\(100%, 360px\)/);
  assert.match(css, /care-intro-broadcast \{ width: min\(100%, 300px\)/);
  assert.match(css, /care-station \.care-stream \{ width: min\(100%, 360px\)/);
  assert.match(css, /care-station \.care-stream, \.care-station-stream-heading \{ width: min\(100%, 300px\)/);
});

test('bridge precedes a single complete-panel motion without a separate hidden content phase', () => {
  assert.match(css, /care-scene-bridge \{ height: 64px; pointer-events: none; background: transparent/);
  assert.ok(app.indexOf('className="care-scene-bridge"') < app.indexOf('className="care-lower-stage"'));
  assert.match(app, /reveal\.from\(block, \{ y: 24, duration: \.65/);
  assert.doesNotMatch(app, /\.from\(content,/);
  assert.doesNotMatch(app, /querySelectorAll<HTMLElement>\("\.care-mechanic, \.care-source-row/);
});

test('initiative media uses project photos and the supplied Solar Foundation photo rather than generated mockups', () => {
  assert.match(app, /giveth\.mypinata\.cloud\/ipfs\/QmfZ6Yaq/);
  assert.match(app, /image: "\/solar-foundation-community.jpg"/);
  const photo = readFileSync(new URL('../public/solar-foundation-community.jpg', import.meta.url));
  assert.equal(photo.readUInt16BE(0), 0xffd8);
  assert.ok(photo.length > 100000);
  assert.match(app, /Community members holding solar-powered lights from The Solar Foundation/);
  assert.match(app, /giveth\.mypinata\.cloud\/ipfs\/QmcStBE4/);
  assert.match(app, /image: "\/animal-ethics-mark.png"/);
  assert.doesNotMatch(app, /generated_images|exec-149585/);
});

test('initiative display order puts Vida Verde before Solar Foundation without changing identities', () => {
  const entries = app.slice(app.indexOf('const initiatives:'), app.indexOf('const money ='));
  assert.deepEqual([...entries.matchAll(/id: "([^"]+)"/g)].map(match => match[1]),
    ['burundi', 'school-supplies', 'vida-verde', 'solar-foundation', 'animal-ethics']);
});

test('initiative frames keep an opaque core, smooth gradient border and reduced-motion support', () => {
  assert.match(css, /care-cause-button[^}]*border: 1px solid transparent; border-radius: 25px/);
  assert.match(css, /linear-gradient\(#191222, #191222\) padding-box/);
  assert.match(css, /#b990e033, #ea9cc829/);
  assert.match(css, /\(hover: hover\) and \(prefers-reduced-motion: no-preference\)/);
  assert.match(css, /care-cause-button:hover \{ transform: translateY\(-5px\)/);
});

test('header retains the clean ChogCare wordmark and the hero has only its primary action', () => {
  assert.ok(app.indexOf('className="care-header-icon"') < app.indexOf('className="care-header-wordmark"'));
  assert.doesNotMatch(app, /care-hero-logo/);
  assert.match(css, /care-intro h1 \{ font-weight: 650/);
  assert.match(app, /className="care-header-wordmark" src="\/chogcare-wordmark.png"/);
  assert.doesNotMatch(app, /I hold a CHOG NFT|Send by QR\. No wallet connection to this site\./);
  assert.doesNotMatch(css, /care-holder-link|care-intro-context/);
  assert.match(css, /care-header-wordmark[^}]*box-shadow: none; background: transparent/);
});

test('heart scene starts hidden above an opaque illustration and never paints a scrolling stripe', () => {
  const scene = read('../src/SunsetScene.tsx');
  assert.match(css, /care-heart-scene \{[^}]*opacity: 0/);
  assert.match(scene, /gsap.fromTo\(hearts.current, \{ opacity: 0 \}/);
  assert.ok(scene.indexOf('className="care-sunset-scene"') < scene.indexOf('className="care-heart-scene"'));
  assert.doesNotMatch(scene, /gsap.fromTo\(sunset/);
  assert.match(css, /care-scene-bridge[^}]*background: transparent/);
  assert.match(css, /care-header-wordmark[^}]*translateY\(-5px\)/);
  assert.match(app, /playerLoaded \? "LIVE" : "STREAM"/);
});

test('hero signature has a readable contrast surface rather than faint text over artwork', () => {
  assert.match(app, /className="care-signature-path"/);
  assert.match(css, /care-signature-path[^}]*min-height: 48px/);
  assert.match(css, /care-signature-path[^}]*background: #21132ded/);
  assert.match(css, /care-hero-signature[^}]*color: #f8e9ff/);
});

test('compact header and type scale share one surface and preserve the approved artwork', () => {
  assert.match(css, /--care-label-size: 14px; --care-body-size: 16px; --care-control-size: 15px/);
  assert.match(css, /care-header-inner \{[^}]*min-height: 84px/);
  assert.match(css, /site-header[^}]*background: var\(--care-surface\)/);
  assert.match(css, /care-header-wordmark[^}]*width: 180px/);
  assert.match(css, /care-background.png'\) center top \/ cover no-repeat/);
  assert.match(css, /care-sunset-art \{[^}]*background-size: cover; background-position: 44% center/);
});

test('two explicit giving scenarios keep pool limits, custody, the split and verification terms', () => {
  assert.match(app, /<GivingExplainer \/>/);
  assert.match(giving, /Two ways to give\./);
  assert.match(giving, /<h3 id="token-mechanic-title">Give with \$CHOG<\/h3>/);
  assert.match(giving, /<h3 id="nft-mechanic-title">Give as an NFT holder<\/h3>/);
  for (const term of ['$1 on your behalf', 'Three donations a day. $3 daily pool',
    'Standard allowance: one donation per wallet and NFT', 'ChogCare holds funds during processing',
    'An extra 10%', 'Exchange and delivery fees still apply; keep MON for wallet gas',
    'separate 1 MON donation']) {
    assert.ok(giving.includes(term), `Required term missing: ${term}`);
  }
  assert.doesNotMatch(giving, /<details|\shidden=|aria-hidden="true"[^>]*>[^<]*MON/);
});

test('footer reaches the viewport edges and support matches the board with symmetric spacing', () => {
  assert.match(css, /lp-footer \{[^}]*width: 100%; margin: 0; background: #110c1d; border-radius: 0/);
  assert.match(css, /care-leaderboard \{ width: min\(1480px, calc\(100% - 64px\)\); margin: 64px auto 0/);
  assert.match(css, /care-support-strip \{ width: min\(1480px, calc\(100% - 64px\)\); margin: 48px auto/);
  assert.match(css, /care-support-strip[^}]*border: 1px solid #e5b4ff20; border-radius: 24px; background: #110c1d/);
  assert.match(css, /care-support-strip \{ width: calc\(100% - 20px\); margin: 32px auto/);
});

test('amount field uses one outer focus treatment without an inner square', () => {
  const checkout = read('../src/checkout.css');
  assert.match(checkout, /\.checkout \.checkout-amount-input input:focus-visible \{ outline: none/);
  assert.match(checkout, /checkout-amount-input:focus-within \{ border-color: #c2a8ff; box-shadow:/);
  assert.match(checkout, /\.checkout button:focus-visible, \.checkout input:focus-visible \{ outline: 2px/);
});

function captureLandingMotion({ returnedToLanding = false, stationOpen = false, reduced = false } = {}) {
  const start = app.indexOf('  useGSAP(() => {', app.indexOf('export default function App()'));
  const end = app.indexOf('  const leaveStation', start);
  const hook = app.slice(start, end).replaceAll('appRef.current!', 'appRef.current');
  const tweens = [];
  const block = { name: 'block' }, stage = { name: 'stage' };
  const from = (target, vars) => { tweens.push({ target, vars }); };
  const timeline = { from(target, vars) { from(target, vars); return timeline; } };
  runInNewContext(hook, {
    stationOpen, returnedToLanding,
    appRef: { current: { querySelector: selector => selector.includes('stage') ? stage : block } },
    heroRef: { current: { getBoundingClientRect: () => ({ bottom: 100 }) } },
    useGSAP: callback => callback(),
    gsap: { from, timeline: () => timeline, matchMedia: () => ({ add: (_query, callback) => { if (!reduced) callback(); }, revert() {} }) },
  });
  return tweens;
}

test('real landing motion skips all entrances on checkout return and never hides the lower panel', () => {
  assert.equal(captureLandingMotion({ returnedToLanding: true }).length, 0);
  assert.equal(captureLandingMotion({ stationOpen: true }).length, 0);
  assert.equal(captureLandingMotion({ reduced: true }).length, 0);
  const panel = captureLandingMotion().find(tween => tween.target.name === 'block');
  assert.ok(panel);
  assert.equal(panel.vars.y, 24);
  assert.equal(panel.vars.duration, .65);
  assert.equal(panel.vars.opacity, undefined);
  assert.equal(panel.vars.autoAlpha, undefined);
  assert.doesNotMatch(app, /className=\{returnedToLanding \? "care-landing-return"/);
  assert.match(app, /dependencies: \[stationOpen, returnedToLanding\]/);
});

test('checkout exit positions the revealed destination before paint without native hash scrolling', () => {
  const exit = app.slice(app.indexOf('    if (!exitTarget) return;'), app.indexOf('  }, [exitTarget]);'));
  assert.match(exit, /history\.pushState\(window\.history\.state, "", `#\$\{exitTarget\}`\)/);
  assert.doesNotMatch(exit, /window\.location\.hash\s*=/);
  assert.match(app, /useLayoutEffect\(\(\) => \{\s*if \(stationOpen\)/);
  assert.match(app, /<ChangeInitiative[^\n]*onChange=\{\(\) => \{[^\n]*leaveStation\("causes"\)/);
  assert.match(read('../src/ChangeInitiative.tsx'), /await closeCheckoutForChange\(mode, confirmId\)/);
});

test('latest supplied background and logo are preserved byte-for-byte and hearts retain full brightness', () => {
  const art = readFileSync(new URL('../public/chogcare-care-background.png', import.meta.url));
  const icon = readFileSync(new URL('../public/chogcare-care-logo.png', import.meta.url));
  assert.equal(createHash('sha256').update(art).digest('hex'), 'b01f03bd64759883617d60f2367f160c89d8e7429a3f38dc986d35c7944b618a');
  assert.equal(createHash('sha256').update(icon).digest('hex'), '04a2126f4e6caebb3def1d51cda037294fb88c9e28e2c2ad0c29af485c6dc2ad');
  assert.equal((app.match(/src="\/chogcare-care-logo.png"/g) ?? []).length, 2);
  assert.match(css, /care-heart-scene \.heart-field \{ opacity: 1/);
  assert.doesNotMatch(read('../src/station-redesign.css'), /linear-gradient\(#160d2359/);
  assert.doesNotMatch(css, /care-sunset-art[^}]*opacity:/);
  assert.match(css, /care-cause-visual.is-artwork \{ background: radial-gradient/);
  assert.match(css, /care-cause-visual.is-artwork img \{[^}]*width: 56%/);
});

test('checkout compacts spacing but retains all security warnings, allocation and payment guards', () => {
  assert.match(css, /care-checkout-column \.checkout \{ padding: 18px 20px/);
  assert.match(css, /care-checkout-column \.checkout-submit \{ margin-top: 14px/);
  assert.doesNotMatch(css, /(?:payment-service-notice|checkout-help|checkout-contribution)[^}]*display: none/);
  const payment = read('../src/LiveChogCheckout.tsx');
  assert.match(payment, /NFT community pool <small>\+\{NFT_POOL_CONTRIBUTION_PERCENT\}%/);
  assert.match(payment, /Exchange and delivery fees reduce what the charity receives/);
  assert.match(payment, /className="checkout-contribution-total"/);
  assert.match(payment, /disabled=\{!serviceAllowed\|\|busy/);
});

test('mobile broadcast comes before payment methods in DOM and layout without hiding checkout', () => {
  const station = app.slice(app.indexOf('<section id="station"'), app.indexOf('{!stationOpen&&<Leaderboard/>}'));
  assert.ok(station.indexOf('className="care-stream-column"') < station.indexOf('className="care-checkout-column"'));
  assert.match(css, /grid-template-areas: "stream checkout"/);
  assert.match(css, /grid-template-areas: "stream" "checkout"/);
  assert.doesNotMatch(css, /care-stream-column[^}]*display: none/);
});

test('concise cause cards retain original descriptions and accessible giving steps', () => {
  assert.equal((app.match(/cardSummary: "/g) ?? []).length, 4);
  assert.match(app, /item\.cardSummary \?\? item\.summary/);
  assert.match(app, /community action, environmental education and art near Caracas/);
  assert.match(css, /care-cause-visual \{ aspect-ratio: 5 \/ 3/);
  assert.equal((giving.match(/<ol className="care-giving-flow"/g) ?? []).length, 2);
  assert.match(giving, /aria-label="NFT pool donation steps"/);
});

test('unavailable states remain truthful with branded presentation rather than invented activity', () => {
  assert.match(app, /care-broadcast-state-icon/);
  assert.match(app, /Broadcast unavailable/);
  const board = read('../src/Leaderboard.tsx');
  assert.match(board, /care-board-state-icon/);
  assert.match(board, /This does not mean the board is empty/);
  assert.match(css, /leaderboard-unavailable \{[^}]*border-radius: 20px/);
});

test('giving diagrams explain the routes without pretending to be live progress or availability', () => {
  assert.equal((giving.match(/className="care-step-number" aria-hidden="true">0[123]/g) ?? []).length, 6);
  assert.match(giving, /aria-label="\$CHOG donation steps"/);
  assert.match(giving, /aria-label="NFT pool donation steps"/);
  assert.match(giving, /Subject to daily limits and availability/);
  assert.doesNotMatch(giving, /aria-current|role="progressbar"|setInterval|fetch\(/);
  assert.match(css, /care-mechanics \{ grid-template-columns: 1fr/);
  assert.match(css, /care-giving-flow \{ grid-column: 1 \/ -1; grid-template-columns: 1fr/);
});

test('original local composition and quiet 100 percent plus 10 percent strip are restored', () => {
  assert.match(giving, /<b>100%<\/b> your cause/);
  assert.match(giving, /<b>\+10%<\/b> NFT pool/);
  assert.match(giving, /Your cause amount stays intact/);
  assert.match(giving, /is added on top for the NFT community pool/);
  assert.match(giving, /className="care-split-meter" aria-label="100 percent to your cause plus 10 percent to the NFT pool"/);
  assert.doesNotMatch(giving, /giving-mascot|chog-care-parcel|giving-dollar|giving-equation|role="img"/);
  assert.match(giving, /className="care-mechanics"/);
  assert.match(giving, /className="care-giving-trust"/);
  assert.doesNotMatch(giving, /giving-explainer\.css|giving-route|giving-split-rule/);
});

test('redesigned sources remain keyboard accessible with protected external links', () => {
  assert.equal((giving.match(/target="_blank" rel="noopener noreferrer"/g) ?? []).length, 2);
  const externalTargets = new Set([...giving.matchAll(/href="([^"]+)"/g)].map(match => match[1]));
  assert.ok(externalTargets.has("https://www.animal-ethics.org/cryptocurrencies/"));
  assert.match(read('../src/station-redesign.css'), /care-source-row:focus-visible \{ outline: 2px/);
  assert.match(giving, /id="how-it-works" tabIndex=\{-1\}/);
});

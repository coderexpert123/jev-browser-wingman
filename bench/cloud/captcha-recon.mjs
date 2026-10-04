// r21 WP-1 (P-3): tracked captcha recon. Loads each target page in an
// ephemeral headless Chrome and records, per site:
//   - the REAL enumerate verdict: `signals.captcha` plus the element count,
//     evaluated through the CURRENT dist build's buildEnumerateExpression —
//     run against the pre-change build for the baseline and against the
//     release candidate in the cloud stage;
//   - a recon-local RAW scan of EVERY element whose iframe src or id/class
//     matches the captcha regex, with kind, src/id/class, tag, rect, area,
//     visibility and the size=invisible flag. The raw scan is
//     rule-independent (it applies none of the scoped gates), so the same
//     dump serves baseline and release candidate and names which arm a
//     leaked match came from (WP-7 step 2 acceptance).
// The regex below mirrors src/core/page-scripts.ts's CAPTCHA_RE; if the RE
// ever changes, mirror it here in the same commit.
//
// Usage:
//   node bench/cloud/captcha-recon.mjs [--out <file>] [--fixtures] [name=url ...]
// Defaults to the three news sites; `--fixtures` adds the local
// captcha-challenge.html / captcha-decoys.html fixture pages via the fixture
// server. Output defaults to stdout; untracked outputs belong in `.calib/`
// (they carry page-derived URLs and match dumps).

import { writeFileSync } from 'node:fs';
import { launchEphemeralChrome } from '../../dist/src/browser/ephemeral.js';
import { CdpConnection } from '../../dist/src/adapters/cdp-connection.js';
import { buildEnumerateExpression } from '../../dist/src/core/page-scripts.js';
import { startFixtureServer } from '../../dist/src/fixture-server.js';

const CAPTCHA_RE = /recaptcha|hcaptcha|turnstile|captcha|challenges\.cloudflare\.com/i;

const DEFAULT_TARGETS = [
  ['bbc', 'https://www.bbc.com/news'],
  ['npr', 'https://www.npr.org'],
  ['guardian', 'https://www.theguardian.com/us'],
];

const args = process.argv.slice(2);
let outFile = null;
let withFixtures = false;
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') {
    outFile = args[i + 1];
    i += 1;
  } else if (args[i] === '--fixtures') {
    withFixtures = true;
  } else {
    positional.push(args[i]);
  }
}

const targets = positional.map((entry, i) => {
  const eq = entry.indexOf('=');
  return eq === -1 ? [`site-${i + 1}`, entry] : [entry.slice(0, eq), entry.slice(eq + 1)];
});
if (targets.length === 0) targets.push(...DEFAULT_TARGETS);

let closeFixtureServer = null;
if (withFixtures) {
  const server = await startFixtureServer();
  closeFixtureServer = server.close;
  targets.push(['captcha-tp', `${server.url}/captcha-challenge.html`]);
  targets.push(['captcha-fp', `${server.url}/captcha-decoys.html`]);
}

const browser = await launchEphemeralChrome({ headless: true });
const observer = await CdpConnection.connect(browser.endpoint);
let sessionId = null;

async function ensureSession() {
  if (sessionId) return sessionId;
  const { targetInfos } = await observer.send('Target.getTargets', {});
  const page = targetInfos.find((t) => t.type === 'page');
  const s = await observer.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  sessionId = s.sessionId;
  await observer.send('Page.enable', {}, sessionId);
  return sessionId;
}

async function evaluate(expression) {
  const sid = await ensureSession();
  for (let i = 0; i < 8; i++) {
    try {
      const r = await observer.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        sid,
      );
      if (!r.exceptionDetails) return r.result?.value;
    } catch { /* context destroyed mid-nav */ }
    await new Promise((r) => setTimeout(r, 700));
  }
  return null;
}

async function navigate(url) {
  const sid = await ensureSession();
  await observer.send('Page.navigate', { url }, sid);
  const deadline = Date.now() + 45_000;
  for (;;) {
    const state = await evaluate('document.readyState').catch(() => null);
    if (state === 'complete') break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  await new Promise((r) => setTimeout(r, 2500));
}

// Recon-local raw scan — rule-independent. Dumps EVERY CAPTCHA_RE match with
// the facts the scoped gates read (visibility, rect, area, size=invisible)
// and none of the gate decisions.
const RAW_SCAN = `(() => {
  var RE = ${CAPTCHA_RE.toString()};
  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  }
  function visible(el) {
    try {
      if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    } catch (e) { /* non-element host object */ }
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var node = el.parentElement;
    while (node) {
      if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return false;
      node = node.parentElement;
    }
    return true;
  }
  var matches = [];
  var iframes = document.querySelectorAll('iframe[src]');
  for (var fi = 0; fi < iframes.length; fi++) {
    var src = iframes[fi].getAttribute('src') || '';
    if (!RE.test(src)) continue;
    var rect = rectOf(iframes[fi]);
    matches.push({
      kind: 'iframe-src', src: src.slice(0, 200), tag: 'iframe',
      rect: rect, area: Math.round(rect.width * rect.height),
      visible: visible(iframes[fi]), sizeInvisible: src.indexOf('size=invisible') !== -1,
    });
  }
  var all = document.querySelectorAll('[id],[class]');
  for (var ai = 0; ai < all.length; ai++) {
    var el = all[ai];
    var cls = el.getAttribute('class') || '';
    var idc = (el.id || '') + ' ' + cls;
    if (!RE.test(idc)) continue;
    var rect2 = rectOf(el);
    matches.push({
      kind: 'id-class', id: el.id || '', cls: cls.slice(0, 120), tag: el.tagName.toLowerCase(),
      rect: rect2, area: Math.round(rect2.width * rect2.height),
      visible: visible(el), sizeInvisible: false,
    });
  }
  return JSON.stringify({ matches: matches });
})()`;

const enumerateExpr = buildEnumerateExpression({ maxElements: 1000, maxTextChars: 3000 });

const results = {};
for (const [name, url] of targets) {
  try {
    await navigate(url);
    const obs = await evaluate(enumerateExpr);
    const raw = await evaluate(RAW_SCAN);
    results[name] = {
      url,
      finalUrl: (await evaluate('location.href')) || null,
      title: (await evaluate('document.title')) || null,
      signalsCaptcha: obs ? obs.signals.captcha : null,
      elementCount: obs ? obs.elements.length : null,
      matches: raw ? JSON.parse(raw).matches : null,
    };
    const m = results[name];
    console.log(
      `${name}: signals.captcha=${m.signalsCaptcha} elements=${m.elementCount} rawMatches=${Array.isArray(m.matches) ? m.matches.length : 'ERR'}`,
    );
  } catch (e) {
    results[name] = { url, error: String(e) };
    console.log(`${name}: ERROR ${String(e).slice(0, 120)}`);
  }
}

const output = { generatedAt: new Date().toISOString(), targets: targets.map(([n, u]) => [n, u]), sites: results };
if (outFile) {
  writeFileSync(outFile, JSON.stringify(output, null, 1));
  console.log(`WROTE ${outFile}`);
} else {
  console.log(JSON.stringify(output, null, 1));
}

await observer.close().catch(() => {});
await browser.close().catch(() => {});
if (closeFixtureServer) await closeFixtureServer().catch(() => {});
process.exit(0);

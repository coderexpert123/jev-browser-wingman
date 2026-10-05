// r23 WP-C: fixture-parity recon (captcha-recon precedent). Loads each of the
// 16 mirrored the-internet paths (15 migrated pages + the index) in an
// ephemeral headless Chrome and records the REAL enumerate verdict — every
// element's {tag, role, name} — evaluated through the CURRENT dist build's
// buildEnumerateExpression.
//
// Modes:
//   --local            serve the paths from the local fixture server, dump
//                      <out>/local.json, then run the REQUIRED-NAME check.
//                      Exit 1 on any missing required name or failed count
//                      check — this is the tooth; a wrong or missing fixture
//                      must fail.
//   --live <base-url>  fetch the same paths from the deployed site,
//                      dump <out>/live.json. OBSERVATIONAL ONLY: never gates.
//   --diff <local.json> <live.json>
//                      print per-page missing/extra names between the two
//                      dumps. REPORT-ONLY: always exits 0.
//   --out <dir>        output directory; defaults to `.calib/r23-parity/`
//                      (untracked — dumps carry page-derived names).
//
// Exactly one of --local / --live / --diff is required.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchEphemeralChrome } from '../../dist/src/browser/ephemeral.js';
import { CdpConnection } from '../../dist/src/adapters/cdp-connection.js';
import { buildEnumerateExpression } from '../../dist/src/core/page-scripts.js';
import { startFixtureServer } from '../../dist/src/fixture-server.js';

// The 15 mirrored pages + the index, keyed by their LOCAL paths (the task
// paths in bench/tasks.json; / carries the trailing slash form
// /add_remove_elements/ verbatim per the live index href).
const PAGES = [
  '/',
  '/checkboxes',
  '/dropdown',
  '/dynamic_controls',
  '/add_remove_elements/',
  '/inputs',
  '/forgot_password',
  '/dynamic_loading',
  '/dynamic_loading/1',
  '/dynamic_loading/2',
  '/status_codes',
  '/status_codes/404',
  '/javascript_alerts',
  '/infinite_scroll',
  '/key_presses',
  '/tables',
];

// Required accessible names per page (spec WP-C "REQUIRED-NAME check").
// Matching pools include select-option labels, so the dropdown entries below
// match against the select record's options[].label.
const REQUIRED_NAMES = {
  '/add_remove_elements/': ['Add Element'],
  '/forgot_password': ['E-mail', 'Retrieve password'],
  '/dynamic_loading': [
    'Example 1: Element on page that is hidden',
    'Example 2: Element rendered after the fact',
  ],
  '/dynamic_loading/1': ['Start'],
  '/dynamic_loading/2': ['Start'],
  '/status_codes': ['200', '301', '404', '500'],
  '/javascript_alerts': ['Click for JS Alert', 'Click for JS Confirm', 'Click for JS Prompt'],
  '/infinite_scroll': ['next page'],
  '/tables': ['Last Name'],
  '/dropdown': ['Please select an option', 'Option 2'],
  // The four paths with no count check still get a minimal required name so
  // a 404/wrong-page body (zero named elements) cannot pass silently. Names
  // derived from a real healthy dump (.calib/r23-parity), not guessed.
  '/': ['Sortable Data Tables'],
  '/dynamic_controls': ['Remove', 'Enable'],
  '/status_codes/404': ['here'],
  '/key_presses': ['Elemental Selenium'],
};

const args = process.argv.slice(2);
let mode = null;
let liveBase = null;
let diffA = null;
let diffB = null;
let outDir = '.calib/r23-parity';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--local') mode = 'local';
  else if (args[i] === '--live') { mode = 'live'; liveBase = args[i + 1]; i += 1; }
  else if (args[i] === '--diff') { mode = 'diff'; diffA = args[i + 1]; diffB = args[i + 2]; i += 2; }
  else if (args[i] === '--out') { outDir = args[i + 1]; i += 1; }
}
if (!mode || (mode === 'live' && !liveBase) || (mode === 'diff' && (!diffA || !diffB))) {
  console.error('usage: fixture-parity-recon.mjs --local | --live <base-url> | --diff <local.json> <live.json> [--out <dir>]');
  process.exit(2);
}
if (liveBase && liveBase.endsWith('/')) liveBase = liveBase.slice(0, -1);

// Name pool for a dump: every element name plus every select-option label
// (the dropdown's required names live in options[].label, not element names).
function namePool(page) {
  const names = new Set();
  for (const el of page.elements || []) {
    if (el.name) names.add(String(el.name).trim());
    for (const opt of el.options || []) {
      if (opt.label) names.add(String(opt.label).trim());
    }
  }
  return names;
}

async function main() {
  if (mode === 'diff') {
    const a = JSON.parse(readFileSync(diffA, 'utf8'));
    const b = JSON.parse(readFileSync(diffB, 'utf8'));
    let lines = 0;
    for (const path of PAGES) {
      const pa = (a.pages || {})[path];
      const pb = (b.pages || {})[path];
      if (!pa || !pb) {
        console.log(`${path}: MISSING DUMP local=${pa ? 'yes' : 'no'} live=${pb ? 'yes' : 'no'}`);
        lines += 1;
        continue;
      }
      const na = namePool(pa);
      const nb = namePool(pb);
      const missing = [...na].filter((n) => !nb.has(n));
      const extra = [...nb].filter((n) => !na.has(n));
      if (missing.length || extra.length || (pa.count ?? (pa.elements || []).length) !== (pb.count ?? (pb.elements || []).length)) {
        console.log(`${path}: local=${(pa.elements || []).length} live=${(pb.elements || []).length}`);
        if (missing.length) console.log(`  missing on live: ${missing.join(' | ')}`);
        if (extra.length) console.log(`  extra on live:   ${extra.join(' | ')}`);
        lines += 1;
      }
    }
    if (lines === 0) console.log('no per-page differences (report-only; never gates)');
    else console.log(`${lines} page(s) differ (report-only; never gates)`);
    return 0;
  }

  let closeFixtureServer = null;
  let base;
  if (mode === 'local') {
    const server = await startFixtureServer();
    base = server.url;
    closeFixtureServer = server.close;
  } else {
    base = liveBase;
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
    await new Promise((r) => setTimeout(r, 500));
  }

  const enumerateExpr = buildEnumerateExpression({ maxElements: 1000, maxTextChars: 3000 });
  const pages = {};
  for (const path of PAGES) {
    const url = base + path;
    try {
      await navigate(url);
      const obs = await evaluate(enumerateExpr);
      // A local page whose load or evaluate failed (null obs, non-array or
      // EMPTY element list — e.g. the 404 "Not found" body after a fixture
      // file went missing) must fail the check, not read as a healthy page
      // with no required names.
      if (mode === 'local' && (!obs || !Array.isArray(obs.elements) || obs.elements.length === 0)) {
        throw new Error('page did not load: enumerate returned no elements');
      }
      const elements = (obs && obs.elements ? obs.elements : []).map((el) => ({
        tag: el.tag,
        role: el.role,
        name: el.name,
        ...(el.options ? { options: el.options.map((o) => ({ value: o.value, label: o.label })) } : {}),
      }));
      pages[path] = { page: path, count: elements.length, elements };
      console.log(`${path}: count=${elements.length}`);
    } catch (e) {
      pages[path] = { page: path, error: String(e) };
      console.log(`${path}: ERROR ${String(e).slice(0, 120)}`);
    }
  }

  await observer.close().catch(() => {});
  await browser.close().catch(() => {});
  if (closeFixtureServer) await closeFixtureServer().catch(() => {});

  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, mode === 'local' ? 'local.json' : 'live.json');
  const output = {
    generatedAt: new Date().toISOString(),
    mode,
    ...(mode === 'live' ? { base } : {}),
    pages,
  };
  writeFileSync(outFile, JSON.stringify(output, null, 1));
  console.log(`WROTE ${outFile}`);

  if (mode === 'live') {
    console.log('live run is observational; the required-name check runs in --local mode only');
    return 0;
  }

  // REQUIRED-NAME check (local mode) — the tooth.
  const misses = [];
  // A local page that failed to LOAD fails the check for EVERY path — the
  // required-name/count tables cover only some pages, and an unchecked page
  // whose load or evaluate failed must still exit 1.
  for (const path of PAGES) {
    if (pages[path] && pages[path].error) misses.push(`${path}: page failed to load`);
  }
  for (const [path, required] of Object.entries(REQUIRED_NAMES)) {
    const dump = pages[path];
    // A failed page is already reported once by the load-failure loop above;
    // skip its name checks rather than double-report.
    if (!dump || dump.error) continue;
    const names = namePool(dump);
    for (const req of required) {
      const hit = [...names].some((n) => n.toLowerCase() === req.toLowerCase());
      if (!hit) misses.push(`${path}: missing required name "${req}"`);
    }
  }

  // Count checks: checkboxes page has exactly 2 checkbox-role candidates;
  // inputs page has exactly 1 input and 0 labels.
  const cb = pages['/checkboxes'];
  if (cb && !cb.error) {
    const boxes = cb.elements.filter((el) => el.role === 'checkbox').length;
    if (boxes !== 2) misses.push(`/checkboxes: expected exactly 2 checkbox-role candidates, found ${boxes}`);
  }
  const inp = pages['/inputs'];
  if (inp && !inp.error) {
    const inputs = inp.elements.filter((el) => el.tag === 'input').length;
    const labels = inp.elements.filter((el) => el.tag === 'label' || el.role === 'label').length;
    if (inputs !== 1) misses.push(`/inputs: expected exactly 1 input, found ${inputs}`);
    if (labels !== 0) misses.push(`/inputs: expected 0 labels, found ${labels}`);
  }

  if (misses.length) {
    for (const m of misses) console.log(`FAIL ${m}`);
    console.log(`required-name/count check: ${misses.length} miss(es)`);
    return 1;
  }
  console.log('required-name/count check: all pass');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(String(e));
    process.exit(1);
  });

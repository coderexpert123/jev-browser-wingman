// pointer-enum E2E (boundary documentation; Chrome file). History: r21 P-5
// added a cursor-pointer candidacy heuristic; the D12 live bar REJECTED it
// (candidate inflation +88% to +298% vs the +30% cap) and the heuristic was
// REMOVED — not flag-gated. This file now pins the documented enumeration
// boundary that rejection leaves behind.
//
// The boundary (fixtures/pages/pointer-interactive.html): framework-style
// pointer-styled divs that are interactive ONLY through a root-delegated
// listener (no onclick, no ondblclick, no role, no own listener) do NOT
// enumerate. Page-side they are indistinguishable from real controls, so the
// loop cannot act on them — a known boundary, like the iframe and shadow
// pins in page-scripts.test.ts. The two decoy divs (cursor:pointer, text,
// outside #app, never fire the listener) and the Save/Cancel menu items must
// ALL stay invisible: the pin asserts zero records carry any of their names,
// mirroring the shadow-boundary pin's style.

import test from 'node:test';
import assert from 'node:assert/strict';
import { launchTestChrome } from './helpers/chrome.js';
import { startFixtureServer } from '../src/fixture-server.js';
import { buildEnumerateExpression } from '../src/core/page-scripts.js';

let chrome: Awaited<ReturnType<typeof launchTestChrome>>;
let fixture: Awaited<ReturnType<typeof startFixtureServer>>;

test.before(async () => {
  chrome = await launchTestChrome({ headless: true });
  fixture = await startFixtureServer();
});

test.after(async () => {
  await fixture.close();
  await chrome.close();
});

async function openFixturePage(name: string): Promise<string> {
  const res = await fetch(`${chrome.endpoint}/json/new?${fixture.url}/${name}.html`, { method: 'PUT' });
  const info = (await res.json()) as { id: string };
  // The /json/new target exists before the navigation commits (the chain-e2e
  // E1 flake shape): wait until the target shows the fixture URL AND a parsed
  // <title> before any loop attach enumerates it.
  const deadline = Date.now() + 10_000;
  for (;;) {
    const list = (await (await fetch(`${chrome.endpoint}/json/list`)).json()) as Array<{
      id: string;
      url: string;
      title: string;
    }>;
    const t = list.find((p) => p.id === info.id);
    if ((t && t.url.startsWith(`${fixture.url}/${name}.html`) && t.title !== '') || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return info.id;
}

async function closeFixturePage(id: string): Promise<void> {
  await fetch(`${chrome.endpoint}/json/close/${id}`).catch(() => {});
}

/** Raw enumerate on the fixture page, through a fresh CDP attach (main world). */
async function rawEnumerate(
  urlPart: string,
  opts: { maxElements: number; maxTextChars: number },
): Promise<{ elements: Array<Record<string, unknown>> }> {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(chrome.endpoint, { noDefaults: true });
  try {
    const ctx = browser.contexts()[0];
    const page = ctx.pages().find((p) => p.url().includes(urlPart));
    assert.ok(page, `a ${urlPart} page is open`);
    const expr = buildEnumerateExpression(opts);
    return (await page.evaluate(`(() => { return (${expr}); })()`)) as {
      elements: Array<Record<string, unknown>>;
    };
  } finally {
    await browser.close();
  }
}

// BOUNDARY PIN: pointer-styled delegation-only divs do not enumerate. The
// page's real interactivity (the delegated listener on #app) is invisible to
// enumerate — a discarded P-5 heuristic was the only arm that ever listed
// these, and it was rejected for live-page candidate inflation.
test('pointer-interactive.html enumerates zero records for the delegated menu items and the decoy divs', async () => {
  const pageId = await openFixturePage('pointer-interactive');
  try {
    const obs = await rawEnumerate('pointer-interactive.html', { maxElements: 240, maxTextChars: 3000 });
    for (const name of ['Save', 'Cancel', 'Decoy one', 'Decoy two']) {
      const recs = obs.elements.filter((e) => e.name === name);
      assert.strictEqual(recs.length, 0, `no record may carry the pointer-styled name ${name}`);
    }
  } finally {
    await closeFixturePage(pageId);
  }
});

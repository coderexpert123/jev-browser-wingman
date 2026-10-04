// r21 WP-3 — navigation-settled clicks (P-1). Real Chrome, both adapters, the
// proven adapter-test harness shape: the page is created blank through a raw
// CDP session and navigated there (Chrome never commits `Target.createTarget`
// with a URL on this machine), so the driver never opens a page itself.
//
// Pins:
// - T-nav-nowait: with `noWaitAfter` composed into the click family, a click
//   that schedules a slow navigation resolves fast instead of timing out in
//   Playwright's post-click "wait for scheduled navigations" wait (the r20
//   scheduled-nav act_error shape).
// - T-preclick-guard: on a page whose readyState reads 'loading' forever, the
//   pre-click readiness guard polls its full PRE_CLICK_SETTLE_MS budget and
//   then proceeds — the click still lands.
// - T-preclick-fastpath: on an already-loaded page the guard costs one eval,
//   not a settle.
// - T-cdp-preclick: the same guard shape over the CDP driver (no noWaitAfter
//   leg exists there — the guard is the only leg).
// - T-wait-growth / T-wait-static (r21 WP-4, P-2/D4): the wait act polls the
//   r17c growth signature with WAIT_GROWTH_MS budget instead of a blind
//   WAIT_OP_MS sleep — early exit when content lands, full budget when the
//   page never changes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { launchTestChrome } from './helpers/chrome.js';
import { startFixtureServer } from '../src/fixture-server.js';
import { createPlaywrightDriver } from '../src/adapters/playwright.js';
import { createCdpDriver } from '../src/adapters/cdp.js';
import type { Driver, ElementRecord } from '../src/contract/types.js';

// ---- shared browser and fixture server (one chrome for the whole file) ----

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

// ---- harness ----

async function openPageAt(url: string, expectedTitle: string): Promise<string> {
  const version = (await fetch(`${chrome.endpoint}/json/version`).then((r) => r.json())) as {
    webSocketDebuggerUrl: string;
  };
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('raw cdp websocket error')), { once: true });
    });
    let nextId = 0;
    const pending = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: unknown };
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    });
    const send = <T>(method: string, params?: object, sessionId?: string): Promise<T> =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, (msg) => {
          clearTimeout(timer);
          if (msg.error) reject(new Error(`cdp ${method}: ${JSON.stringify(msg.error)}`));
          else resolve(msg.result as T);
        });
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`raw cdp timeout: ${method}`));
        }, 10_000);
        ws.send(JSON.stringify({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) }));
      });
    const { targetId } = await send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await send('Page.enable', {}, sessionId);
    await send('Page.navigate', { url }, sessionId);
    const deadline = Date.now() + 15_000;
    for (;;) {
      const info = await send<{ result: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression: 'document.title', returnByValue: true },
        sessionId,
      ).catch(() => null);
      if (info?.result?.value === expectedTitle) break;
      assert.ok(Date.now() < deadline, `page ${url} never loaded`);
      await new Promise((r) => setTimeout(r, 250));
    }
    return targetId;
  } finally {
    ws.close();
  }
}

interface Rig {
  driver: Driver;
  pageUrl: string;
  pageId: string;
  close(): Promise<void>;
}

async function openRig(page: string, expectedTitle: string, driverKind: 'playwright' | 'cdp'): Promise<Rig> {
  const pageUrl = `${fixture.url}/${page}`;
  await openPageAt(pageUrl, expectedTitle);
  const driver = driverKind === 'playwright' ? createPlaywrightDriver() : createCdpDriver();
  await driver.attach({ cdpEndpoint: chrome.endpoint });
  const pageId = await waitForPage(driver, pageUrl);
  return {
    driver,
    pageUrl,
    pageId,
    close: async () => {
      await driver.detach().catch(() => {});
    },
  };
}

async function waitForPage(driver: Driver, pageUrl: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const pages = await driver.pages();
    const found = pages.find((p) => p.url === pageUrl);
    if (found) return found.id;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`fixture page never appeared: ${pageUrl}`);
}

async function elementNamed(driver: Driver, pageId: string, name: string): Promise<ElementRecord> {
  const obs = await driver.observe(pageId);
  const el = obs.elements.find((e) => e.name === name);
  assert.ok(el, `element "${name}" not in the observation`);
  return el;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---- pins ----

test('T-nav-nowait: a click that schedules a slow navigation resolves fast and the navigation still completes', async () => {
  const rig = await openRig('nav-slow.html', 'Nav Slow', 'playwright');
  try {
    const el = await elementNamed(rig.driver, rig.pageId, 'Go Slow');
    const t = Date.now();
    await rig.driver.act(rig.pageId, el.id, 'click');
    const elapsed = Date.now() - t;
    assert.ok(elapsed < 2_500, `click took ${elapsed} ms — the post-click navigation wait is back`);
    // The navigation still completes through settle+observe: poll observe for
    // the arrival page's title (transient mid-navigation observe failures are
    // expected and skipped).
    const deadline = Date.now() + 15_000;
    let arrived = false;
    while (Date.now() < deadline) {
      try {
        const obs = await rig.driver.observe(rig.pageId);
        if (obs.title === 'Arrived') {
          arrived = true;
          break;
        }
      } catch {
        // mid-navigation: execution context destroyed — poll on
      }
      await sleep(250);
    }
    assert.ok(arrived, 'navigation to the arrival page never observed within 15 s');
  } finally {
    await rig.close();
  }
});

test('T-preclick-guard: a forever-loading page holds the click for the full pre-click settle budget, then lands', async () => {
  const rig = await openRig('guard-loading.html', 'Guard Loading', 'playwright');
  try {
    const el = await elementNamed(rig.driver, rig.pageId, 'Next Step');
    const t = Date.now();
    await rig.driver.act(rig.pageId, el.id, 'click');
    const elapsed = Date.now() - t;
    assert.ok(elapsed >= 3_500, `click took only ${elapsed} ms — the pre-click guard did not poll its budget`);
    const obs = await rig.driver.observe(rig.pageId);
    assert.ok(obs.text.includes('clicked'), `act did not land on the guarded page: ${obs.text}`);
  } finally {
    await rig.close();
  }
});

test('T-preclick-fastpath: an already-loaded page pays one eval, not a settle', async () => {
  const rig = await openRig('form.html', 'Fixture form', 'playwright');
  try {
    const el = await elementNamed(rig.driver, rig.pageId, 'Continue');
    const t = Date.now();
    await rig.driver.act(rig.pageId, el.id, 'click');
    const elapsed = Date.now() - t;
    assert.ok(elapsed < 1_000, `loaded-page click took ${elapsed} ms — the guard is settling, not probing`);
  } finally {
    await rig.close();
  }
});

test('T-cdp-preclick: the CDP driver holds the same guard on a forever-loading page, then lands', async () => {
  const rig = await openRig('guard-loading.html', 'Guard Loading', 'cdp');
  try {
    const el = await elementNamed(rig.driver, rig.pageId, 'Next Step');
    const t = Date.now();
    await rig.driver.act(rig.pageId, el.id, 'click');
    const elapsed = Date.now() - t;
    assert.ok(elapsed >= 3_500, `cdp click took only ${elapsed} ms — the pre-click guard did not poll its budget`);
    const obs = await rig.driver.observe(rig.pageId);
    assert.ok(obs.text.includes('clicked'), `act did not land on the guarded page: ${obs.text}`);
  } finally {
    await rig.close();
  }
});

// ---- r21 WP-4 — wait-act growth poll (P-2, D4) ----
// The wait verb's act polls the r17c growth signature instead of one blind
// 1000 ms sleep: a page whose content is still arriving ends the wait act
// early; a never-changing page pays the full WAIT_GROWTH_MS budget (bounded).

test('T-wait-growth: a wait act exits early when delayed content lands, and the content is then visible', async () => {
  const rig = await openRig('chain-delay.html', 'Fixture chain delay', 'playwright');
  try {
    const el = await elementNamed(rig.driver, rig.pageId, 'Start');
    await rig.driver.act(rig.pageId, el.id, 'click');
    // The fixture appends #finish ~1500 ms after the click; the wait act's
    // growth poll must exit at or just after that moment instead of sleeping
    // the blind WAIT_OP_MS.
    const t = Date.now();
    await rig.driver.act(rig.pageId, null, 'wait');
    const elapsed = Date.now() - t;
    assert.ok(
      elapsed >= 1_400 && elapsed <= 2_800,
      `wait act took ${elapsed} ms — expected the growth poll to exit when #finish landed (~1500 ms)`,
    );
    const obs = await rig.driver.observe(rig.pageId);
    assert.ok(obs.elements.some((e) => e.name === 'Finish'), 'follow-up observe never saw #finish');
  } finally {
    await rig.close();
  }
});

test('T-wait-static: a wait act on a never-changing page pays the full bounded budget', async () => {
  const rig = await openRig('form.html', 'Fixture form', 'playwright');
  try {
    const t = Date.now();
    await rig.driver.act(rig.pageId, null, 'wait');
    const elapsed = Date.now() - t;
    assert.ok(
      elapsed >= 2_900 && elapsed <= 3_800,
      `wait act took ${elapsed} ms — expected the full WAIT_GROWTH_MS budget on a static page`,
    );
  } finally {
    await rig.close();
  }
});

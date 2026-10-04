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
//   leg exists there — the guard is the only leg). Mutants-pass fix: the old
//   `>= 3500` bound could not discriminate — it passed on BOTH sides of
//   KB_CDP_PRECLICK (cloud r21 pair: 9117 ms guard active vs 5124 ms skipped).
//   Measured pair on this box 2026-10-04: 4075/4220 ms guard active (the
//   PRE_CLICK_SETTLE_MS 4000 floor dominates) vs 28 ms with the flag flipped
//   — `>= 2000` discriminates with wide margin both ways.
// - T-wait-growth / T-wait-static (r21 WP-4, P-2/D4): the wait act polls the
//   r17c growth signature with WAIT_GROWTH_MS budget instead of a blind
//   WAIT_OP_MS sleep — early exit when content lands, full budget when the
//   page never changes. T-cdp-wait-growth adds the CDP-driver leg (the r21
//   mutants pass found KB_CDP_WAIT_GROWTH unpinned): same chain-delay shape
//   with the page waited to readyState 'complete' BEFORE the click (a
//   title-only poll can leave the guard settling inside the click act), and
//   the WAIT-ACT DELTA (time from click-act end to wait-act end) pinned to
//   [1250, 2900] — measured pair 2026-10-04: unflipped 1623 ms (first poll
//   tick after #finish lands), flipped 1009 ms (blind sleep, also ending
//   before #finish exists, which kills the observe too). The delta anchors
//   on the mouseReleased response — the moment the append timer starts — so
//   it is immune to this box's intermittent ~5 s stall inside the click
//   act's mouseMoved dispatch (move=5010-5015 ms with down/up at 1-3 ms).

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

async function openPageAt(url: string, expectedTitle: string, waitForReady = false): Promise<string> {
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
        {
          expression: waitForReady
            ? 'document.title + "|" + document.readyState'
            : 'document.title',
          returnByValue: true,
        },
        sessionId,
      ).catch(() => null);
      // waitForReady: the pre-click guard skips its settle only when the
      // document has finished loading — a title-poll alone can return while
      // the response is still streaming, and the guard then burns its
      // 4000 ms settle inside a later click act (observed: 5029 ms clicks
      // under box load). guard-loading.html never completes, so only tests
      // that opt in pay this.
      if (info?.result?.value === (waitForReady ? `${expectedTitle}|complete` : expectedTitle)) break;
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

async function openRig(
  page: string,
  expectedTitle: string,
  driverKind: 'playwright' | 'cdp',
  waitForReady = false,
): Promise<Rig> {
  const pageUrl = `${fixture.url}/${page}`;
  await openPageAt(pageUrl, expectedTitle, waitForReady);
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
    // Discriminating bound (mutants-pass fix): measured guard-active
    // 4075 ms on this box (the cloud r21 pair was 9117/5124 — remote
    // latency, not reproducible here) against the KB_CDP_PRECLICK-skipped
    // path's number pinned from the flip proof below. `>= 3500` passed both
    // cloud sides, so it could not fail on the flip. The guard-active floor
    // is PRE_CLICK_SETTLE_MS (4000) + the click itself.
    assert.ok(elapsed >= 2_000, `cdp click took only ${elapsed} ms — the pre-click guard did not poll its budget`);
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

// r21 mutants-pass fix: KB_CDP_WAIT_GROWTH had no pin — T-wait-growth /
// T-wait-static above run the playwright driver only, so flipping the CDP
// adapter's growth poll off stayed green. The same chain-delay shape over the
// CDP driver. The discriminating quantity is the WAIT-ACT DELTA (waitMs =
// click+wait elapsed minus the click act's own time): the flipped build
// sleeps the blind WAIT_OP_MS (1000 ms, no eval before it) and returns
// BEFORE #finish lands; the growth poll can never return before the append
// (~1500 ms after the mouseReleased response — which is exactly the moment
// the delta clock anchors on). This makes the delta immune to the box's
// intermittent ~5 s stall inside the click act's mouseMoved dispatch
// (measured 2026-10-04: move=5010-5015 ms with down/up at 1-3 ms, every
// stalled attempt): the stall precedes the click landing, so it inflates
// clickMs and the total but never the delta.
test('T-cdp-wait-growth: the CDP wait act exits early when delayed content lands, and the content is then visible', async () => {
  // Measured 2026-10-04, this box: unflipped growth-poll wait delta 1623 ms
  // (first 200 ms poll tick after #finish lands); flipped 1009 ms delta —
  // which also ends before #finish exists, killing the observe below. The
  // window excludes both sides of the pair; the upper bound also excludes a
  // hypothetical poll that never early-exits (it would burn the full
  // WAIT_GROWTH_MS budget).
  const rig = await openRig('chain-delay.html', 'Fixture chain delay', 'cdp', true);
  try {
    const el = await elementNamed(rig.driver, rig.pageId, 'Start');
    const t = Date.now();
    await rig.driver.act(rig.pageId, el.id, 'click');
    const clickMs = Date.now() - t;
    await rig.driver.act(rig.pageId, null, 'wait');
    const waitMs = Date.now() - t - clickMs;
    assert.ok(
      waitMs >= 1_250 && waitMs <= 2_900,
      `wait act returned ${waitMs} ms after the click — expected the growth poll to exit when #finish landed (~1500 ms after the click; the flipped build sleeps ~1000 ms instead)`,
    );
    const obs = await rig.driver.observe(rig.pageId);
    assert.ok(obs.elements.some((e) => e.name === 'Finish'), 'follow-up observe never saw #finish');
  } finally {
    await rig.close();
  }
});

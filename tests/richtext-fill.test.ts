// r28 — rich-text (contenteditable) fill tests against fixtures/pages/richtext-doubling.html.
//
// The fixture models the observed Draft.js-style doubling: ONE synthetic
// insertion event carrying more than one CODE POINT is applied twice. Real key
// events and per-char insertions (1 cp per event) never trip it.
//
// The tests pin the MECHANISM beside the outcome: with read-back + retry-once
// in place, a plain "final text equals value" assertion SELF-HEALS under a
// KB_*_RICH_TYPE flip (fast fill doubles -> read-back catches -> clear + retype
// by keys heals -> green). `window.__r28Events` is the per-input-event log the
// mechanism assertions read; they are what kills the rich-type flips.
//
// Rigs are self-contained copies of the adapter suites (adapter-playwright /
// adapter-cdp): inline openPageAt + withFixture over launchTestChrome() +
// startFixtureServer(); the cdp mirror over CdpConnection. No existing file is
// edited. Field reads go through the page over a SECOND connection (playwright)
// / the observer session (cdp) so the adapter never grades its own write. Tests
// may read field text; the ADAPTER must not.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright-core';
import { launchTestChrome } from './helpers/chrome.js';
import { startFixtureServer } from '../src/fixture-server.js';
import { createPlaywrightDriver } from '../src/adapters/playwright.js';
import { createCdpDriver } from '../src/adapters/cdp.js';
import { CdpConnection } from '../src/adapters/cdp-connection.js';
import { startFixtureServer as startCdpFixtureServer, type FixtureServer } from '../src/fixture-server.js';
import { ActFailedError } from '../src/contract/errors.js';
import type { Driver, ElementRecord } from '../src/contract/types.js';

// --- shared expectations -------------------------------------------------

const VALUE_PLAIN = 'hello world';
const VALUE_NEWLINES = 'line one\nline two';
const VALUE_EMOJI = 'ok 😂 done';
const VALUE_SELFHEAL = 'healed value';
const VALUE_NOKEYS = 'typed';
const VALUE_CURSED = 'cursed value';

interface R28Event {
  id: string;
  type: string;
  cps: number;
  trusted: boolean;
}

const TARGETS: Record<string, { sel: string; rich: boolean }> = {
  'Post text': { sel: '#editor', rich: true },
  'Self heal': { sel: '#selfheal', rich: false },
  'No keys': { sel: '#nokeys', rich: false },
  Cursed: { sel: '#cursed', rich: true },
};

const norm = (s: string | null | undefined): string => String(s ?? '').replace(/\s+/g, ' ').trim();
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The fixture's corruption arms land via setTimeout(0): wait them out so a
// read never observes the pre-corruption text.
const CORRUPT_SETTLE_MS = 300;

interface RichFillContext {
  fill(elementName: string, value: string): Promise<unknown>;
  readFieldText(elementName: string): Promise<string>;
  readEvents(): Promise<R28Event[]>;
  close(): Promise<void>;
}

// --- the six shared case bodies ------------------------------------------

function defineR28Suite(prefix: string, make: () => Promise<RichFillContext>): void {
  test(`${prefix} rich fill types by key events and lands the exact text`, async () => {
    const ctx = await make();
    try {
      await ctx.fill('Post text', VALUE_PLAIN);
      await delay(CORRUPT_SETTLE_MS);
      const events = (await ctx.readEvents()).filter((e) => e.id === 'editor');
      assert.ok(events.length > 0, 'the editor logged no input events');
      // MECHANISM (kills the rich-type flip): every insertion event into the
      // editor carried at most one code point.
      for (const ev of events) {
        assert.ok(ev.cps <= 1, `MECHANISM: an editor insertion event carried ${ev.cps} code points: ${JSON.stringify(ev)}`);
      }
      assert.equal(norm(await ctx.readFieldText('Post text')), norm(VALUE_PLAIN), 'the editor text is not the typed value');
    } finally {
      await ctx.close();
    }
  });

  test(`${prefix} rich fill newline value lands as typed`, async () => {
    const ctx = await make();
    try {
      await ctx.fill('Post text', VALUE_NEWLINES);
      await delay(CORRUPT_SETTLE_MS);
      assert.equal(norm(await ctx.readFieldText('Post text')), norm(VALUE_NEWLINES), 'the newline value did not land as typed');
    } finally {
      await ctx.close();
    }
  });

  test(`${prefix} rich fill emoji value lands as typed`, async () => {
    const ctx = await make();
    try {
      await ctx.fill('Post text', VALUE_EMOJI);
      await delay(CORRUPT_SETTLE_MS);
      assert.equal(norm(await ctx.readFieldText('Post text')), norm(VALUE_EMOJI), 'the emoji value did not land as typed');
    } finally {
      await ctx.close();
    }
  });

  test(`${prefix} plain input keeps the fast fill path`, async () => {
    const ctx = await make();
    try {
      // #nokeys swallows character keydowns, so it can ONLY be filled by the
      // fast path — a build that routes plain inputs through key typing
      // leaves it empty and reds.
      await ctx.fill('No keys', VALUE_NOKEYS);
      await delay(CORRUPT_SETTLE_MS);
      assert.equal(norm(await ctx.readFieldText('No keys')), VALUE_NOKEYS, 'the plain input was not filled by the fast path');
    } finally {
      await ctx.close();
    }
  });

  test(`${prefix} read-back retries a corrupted fast fill by key events`, async () => {
    const ctx = await make();
    try {
      // #selfheal corrupts on the fast-fill paths (untrusted event, or one
      // event carrying the whole string); only a key-event retry heals it.
      await ctx.fill('Self heal', VALUE_SELFHEAL);
      await delay(CORRUPT_SETTLE_MS);
      assert.equal(norm(await ctx.readFieldText('Self heal')), norm(VALUE_SELFHEAL), 'the fast-fill corruption was not healed');
      const events = (await ctx.readEvents()).filter((e) => e.id === 'selfheal');
      const corruptIdx = events.findIndex((e) => !e.trusted || e.cps > 1);
      assert.ok(corruptIdx !== -1, 'the fixture did not log the corrupting fast-fill event');
      assert.ok(
        events.slice(corruptIdx + 1).some((e) => e.trusted && e.cps === 1),
        'no trusted single-code-point event followed the corrupting entry (the retry did not type by keys)',
      );
    } finally {
      await ctx.close();
    }
  });

  test(`${prefix} read-back failure fails the act, never silently succeeds`, async () => {
    const ctx = await make();
    try {
      // #cursed appends X on EVERY input event (deletes included): no fill
      // strategy can land the exact value, so the act must FAIL loudly.
      // (r28 WP-B cross-package fix: assert.rejects fulfills with UNDEFINED on
      // Node 22, so the captured-error form threw TypeError on every correct
      // rejection; the validator form asserts the class AND the no-value-leak
      // redaction pin in one place.)
      await assert.rejects(ctx.fill('Cursed', VALUE_CURSED), (e: unknown) => {
        assert.ok(e instanceof ActFailedError, `the act rejected with ${String(e)}`);
        assert.equal(
          String((e as Error).message).includes(VALUE_CURSED),
          false,
          'the failure message must not carry the value',
        );
        return true;
      });
    } finally {
      await ctx.close();
    }
  });
}

// --- playwright rig (copied from tests/adapter-playwright.test.ts) --------

interface Fixture {
  endpoint: string;
  driver: Driver;
  pageUrl: string;
  close(): Promise<void>;
}

async function openPageAt(endpoint: string, url: string, expectedTitle: string): Promise<void> {
  const version = (await fetch(`${endpoint}/json/version`).then((r) => r.json())) as {
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
  } finally {
    ws.close();
  }
}

async function withFixture(page: string, expectedTitle: string): Promise<Fixture> {
  const chrome = await launchTestChrome();
  let server: Awaited<ReturnType<typeof startFixtureServer>> | null = null;
  try {
    server = await startFixtureServer();
    const pageUrl = `${server.url}${page}`;
    await openPageAt(chrome.endpoint, pageUrl, expectedTitle);
    const driver = createPlaywrightDriver();
    await driver.attach({ cdpEndpoint: chrome.endpoint });
    return {
      endpoint: chrome.endpoint,
      driver,
      pageUrl,
      async close() {
        await driver.detach().catch(() => {});
        await server!.close().catch(() => {});
        await chrome.close().catch(() => {});
      },
    };
  } catch (e) {
    if (server) await server.close().catch(() => {});
    await chrome.close().catch(() => {});
    throw e;
  }
}

async function waitForPage(driver: Driver, pageUrl: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const pages = await driver.pages();
    const found = pages.find((p) => p.url === pageUrl && p.title.length > 0);
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

async function makePwContext(): Promise<RichFillContext> {
  const fx = await withFixture('/richtext-doubling', 'Rich text doubling');
  try {
    const pageId = await waitForPage(fx.driver, fx.pageUrl);
    const readOverPage = async <T>(fn: (page: Page) => Promise<T>): Promise<T> => {
      // Read over a SEPARATE Playwright connection so the assert is not the
      // adapter grading its own write (r17b pattern).
      const browser2 = await chromium.connectOverCDP(fx.endpoint, { timeout: 5_000, noDefaults: true });
      try {
        const page2 = browser2.contexts()[0]?.pages().find((p) => p.url() === fx.pageUrl);
        assert.ok(page2, 'the fixture page is reachable over the second connection');
        return await fn(page2);
      } finally {
        await browser2.close().catch(() => {});
      }
    };
    return {
      fill: async (elementName, value) => {
        const el = await elementNamed(fx.driver, pageId, elementName);
        return fx.driver.act(pageId, el.id, 'fill', value);
      },
      readFieldText: async (elementName) => {
        const t = TARGETS[elementName];
        return (await readOverPage((page) =>
          page.evaluate(`document.querySelector(${JSON.stringify(t.sel)}).${t.rich ? 'innerText' : 'value'}`),
        )) as string;
      },
      readEvents: async () =>
        (await readOverPage((page) => page.evaluate('window.__r28Events'))) as R28Event[],
      close: () => fx.close(),
    };
  } catch (e) {
    await fx.close();
    throw e;
  }
}

// --- cdp rig (copied from tests/adapter-cdp.test.ts) ----------------------

interface Rig {
  fixture: FixtureServer;
  browser: { endpoint: string; close(): Promise<void> };
  observer: CdpConnection;
  observerSession: string;
  driver: Driver;
  pageId: string;
}

async function openRig(pageName: string, expectedTitle: string): Promise<Rig> {
  const fixture = await startCdpFixtureServer();
  const browser = await launchTestChrome();
  const pageUrl = `${fixture.url}/${pageName}`;
  const observer = await CdpConnection.connect(browser.endpoint);
  const { targetId } = await observer.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
  });
  const { sessionId } = await observer.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await observer.send('Page.enable', {}, sessionId);
  await observer.send('Page.navigate', { url: pageUrl }, sessionId);
  const deadline = Date.now() + 15_000;
  for (;;) {
    const info = await observer
      .send<{ result?: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression: 'document.title', returnByValue: true },
        sessionId,
      )
      .catch(() => null);
    if ((info?.result?.value as string | undefined) === expectedTitle) {
      break;
    }
    assert.ok(Date.now() < deadline, `page ${pageName} never loaded`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const driver = createCdpDriver();
  await driver.attach({ cdpEndpoint: browser.endpoint });
  return { fixture, browser, observer, observerSession: sessionId, driver, pageId: targetId };
}

async function closeRig(rig: Rig): Promise<void> {
  await rig.driver.detach().catch(() => {});
  await rig.observer.close().catch(() => {});
  await rig.browser.close().catch(() => {});
  await rig.fixture.close().catch(() => {});
}

async function evalMain(rig: Rig, expression: string): Promise<any> {
  const result = await rig.observer.send<{ result?: { value?: unknown } }>(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    rig.observerSession,
  );
  return result.result?.value;
}

async function elementByName(rig: Rig, name: string): Promise<ElementRecord> {
  const observation = await rig.driver.observe(rig.pageId);
  const el = observation.elements.find((e) => e.name === name);
  assert.ok(el, `element named ${name} not found`);
  return el;
}

async function makeCdpContext(): Promise<RichFillContext> {
  const rig = await openRig('richtext-doubling', 'Rich text doubling');
  return {
    fill: async (elementName, value) => {
      const el = await elementByName(rig, elementName);
      return rig.driver.act(rig.pageId, el.id, 'fill', value);
    },
    readFieldText: async (elementName) => {
      const t = TARGETS[elementName];
      return (await evalMain(
        rig,
        `document.querySelector(${JSON.stringify(t.sel)}).${t.rich ? 'innerText' : 'value'}`,
      )) as string;
    },
    readEvents: async () => (await evalMain(rig, 'window.__r28Events')) as R28Event[],
    close: () => closeRig(rig),
  };
}

// --- the two parameterized suites ----------------------------------------

defineR28Suite('r28 pw', makePwContext);
defineR28Suite('r28 cdp', makeCdpContext);

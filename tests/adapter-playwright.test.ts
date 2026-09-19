// WP-D1 — Playwright adapter tests.
//
// Launches headless Chrome on a temp profile with --remote-debugging-port=0
// through the D0 test helper and opens fixture pages through Chrome's HTTP
// endpoint (blank target + raw-CDP Page.navigate, see openPageAt below), so
// the adapter never opens a page itself, and needs no import from WP-D2,
// which builds in the same wave.

import test from 'node:test';
import assert from 'node:assert/strict';
import { launchTestChrome } from './helpers/chrome.js';
import { startFixtureServer } from '../src/fixture-server.js';
import { createPlaywrightDriver } from '../src/adapters/playwright.js';
import { DialogOpenError } from '../src/contract/errors.js';
import type { Driver, ElementRecord } from '../src/contract/types.js';

interface Fixture {
  endpoint: string;
  driver: Driver;
  pageUrl: string;
  close(): Promise<void>;
}

// Spec correction (WP-D1 report, 2026-09-19): on this machine's Chrome 151,
// `PUT /json/new?<url>` accepts the target but never commits the navigation —
// the page stays at about:blank, and a stuck-pending target also makes the
// first Playwright connectOverCDP miss the adapter's 5 s pin. Same defect and
// same mechanical workaround as WP-D2: create the target blank
// (Target.createTarget), navigate it over a raw flatten-attached session, and
// poll `document.title` until the navigation commits. Implemented here on the
// global WebSocket so the test needs no import from WP-D2. The adapter never
// opens a page either way.
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
        // Bounded like WP-D2's CdpConnection (10 s default): a wedged command
        // must fail loudly, never hang the harness.
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
    // Never leak the browser or the fixture server when setup fails.
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

test('attaches to the default context and lists the page', async () => {
  const fx = await withFixture('/form.html', 'Fixture form');
  try {
    const pages = await fx.driver.pages();
    const form = pages.find((p) => p.url === fx.pageUrl);
    assert.ok(form, 'the fixture form page is listed');
    assert.ok(form.id.length > 0, 'page id is the CDP targetId');
    assert.equal(form.title, 'Fixture form');
    assert.equal(form.visible, true);
    assert.equal(fx.driver.name, 'playwright');
  } finally {
    await fx.close();
  }
});

test('observe matches the pinned form.html table', async () => {
  const fx = await withFixture('/form.html', 'Fixture form');
  try {
    const pageId = await waitForPage(fx.driver, fx.pageUrl);
    const obs = await fx.driver.observe(pageId);
    const simplified = obs.elements.map((e) => ({
      id: e.id, tag: e.tag, role: e.role, name: e.name, type: e.type, state: e.state,
    }));
    assert.deepStrictEqual(simplified, [
      { id: 'e1', tag: 'input', role: 'textbox', name: 'Full name', type: 'text', state: { disabled: false, filled: false } },
      { id: 'e2', tag: 'input', role: 'textbox', name: 'Email', type: 'email', state: { disabled: false, filled: false } },
      { id: 'e3', tag: 'textarea', role: 'textbox', name: 'Notes', type: '', state: { disabled: false, filled: true } },
      { id: 'e4', tag: 'select', role: 'combobox', name: 'Country', type: '', state: { disabled: false, selected: 'Choose' } },
      { id: 'e5', tag: 'button', role: 'button', name: 'Continue', type: 'button', state: { disabled: false } },
      { id: 'e6', tag: 'button', role: 'button', name: 'Place order', type: 'submit', state: { disabled: false } },
    ]);
    assert.deepStrictEqual(obs.forms, [
      { index: 0, id: 'details', name: '', actionPath: '/save', method: 'post' },
    ]);
    for (const e of obs.elements) {
      assert.equal(e.form, 0);
    }
  } finally {
    await fx.close();
  }
});

test('click Continue writes continued', async () => {
  const fx = await withFixture('/form.html', 'Fixture form');
  try {
    const pageId = await waitForPage(fx.driver, fx.pageUrl);
    const el = await elementNamed(fx.driver, pageId, 'Continue');
    await fx.driver.act(pageId, el.id, 'click');
    await fx.driver.settle(pageId, 3_000);
    const obs = await fx.driver.observe(pageId);
    assert.ok(obs.text.includes('continued'), `log text missing from excerpt: ${obs.text}`);
  } finally {
    await fx.close();
  }
});

test('fill never leaves the value in observe output', async () => {
  const fx = await withFixture('/form.html', 'Fixture form');
  try {
    const pageId = await waitForPage(fx.driver, fx.pageUrl);
    const el = await elementNamed(fx.driver, pageId, 'Full name');
    const sentinel = 'WINGMAN_SENTINEL_VALUE_4c9e';
    await fx.driver.act(pageId, el.id, 'fill', sentinel);
    await fx.driver.settle(pageId, 3_000);
    const obs = await fx.driver.observe(pageId);
    assert.equal(JSON.stringify(obs).includes(sentinel), false, 'the typed value leaked into observe output');
    const filled = obs.elements.find((e) => e.name === 'Full name');
    assert.ok(filled, 'Full name still listed after fill');
    assert.equal(filled.state.filled, true);
  } finally {
    await fx.close();
  }
});

test('dialog is reported and stays open', async () => {
  const fx = await withFixture('/dialog.html', 'Fixture dialogs');
  try {
    const pageId = await waitForPage(fx.driver, fx.pageUrl);
    const events: Array<{ pageId: string; type: string; message: string }> = [];
    fx.driver.onDialog((e) => events.push(e));
    const el = await elementNamed(fx.driver, pageId, 'Show alert');
    // Resolves normally when the dialog wins the race; never dismisses it.
    await fx.driver.act(pageId, el.id, 'click');
    assert.equal(events.length, 1, `expected one dialog event, got ${JSON.stringify(events)}`);
    assert.equal(events[0].pageId, pageId);
    assert.equal(events[0].type, 'alert');
    assert.equal(events[0].message, 'Hello from fixture');
    // Stays open: an evaluation on the same page is blocked, and the driver
    // maps that to DialogOpenError instead of a generic timeout.
    await assert.rejects(fx.driver.observe(pageId), DialogOpenError);
    // Dismiss over raw CDP so the fixture browser can be torn down cleanly;
    // the adapter itself never dismisses. (A second Playwright connection
    // cannot initialise against a browser holding an open modal: its per-page
    // bootstrap waits on the blocked renderer and times out — measured
    // 2026-09-19 — so the dismissal uses the same raw-WebSocket mechanics as
    // openPageAt, with no import from WP-D2.)
    const version2 = (await fetch(`${fx.endpoint}/json/version`).then((r) => r.json())) as {
      webSocketDebuggerUrl: string;
    };
    const ws2 = new WebSocket(version2.webSocketDebuggerUrl);
    try {
      await new Promise<void>((resolve, reject) => {
        ws2.addEventListener('open', () => resolve(), { once: true });
        ws2.addEventListener('error', () => reject(new Error('raw cdp websocket error')), { once: true });
      });
      let nextId2 = 0;
      const pending2 = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>();
      ws2.addEventListener('message', (ev) => {
        const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: unknown };
        if (msg.id !== undefined && pending2.has(msg.id)) {
          pending2.get(msg.id)!(msg);
          pending2.delete(msg.id);
        }
      });
      const send2 = <T>(method: string, params?: object, sessionId?: string): Promise<T> =>
        new Promise((resolve, reject) => {
          const id = ++nextId2;
          pending2.set(id, (msg) => {
            if (msg.error) reject(new Error(`cdp ${method}: ${JSON.stringify(msg.error)}`));
            else resolve(msg.result as T);
          });
          ws2.send(JSON.stringify({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) }));
        });
      const targets = await send2<{ targetInfos: Array<{ targetId: string; url: string }> }>('Target.getTargets');
      const dialogTarget = targets.targetInfos.find((t) => t.url === fx.pageUrl);
      assert.ok(dialogTarget, 'dialog page target found over raw CDP');
      const { sessionId } = await send2<{ sessionId: string }>('Target.attachToTarget', {
        targetId: dialogTarget.targetId,
        flatten: true,
      });
      // Best-effort: the stays-open proof is the DialogOpenError above. On
      // this machine's headless Chrome the dialog is sometimes already gone
      // by teardown time ("No dialog is showing"), which is not a failure.
      try {
        await send2('Page.handleJavaScriptDialog', { accept: true }, sessionId);
      } catch {
        // dialog already closed
      }
    } finally {
      ws2.close();
    }
  } finally {
    await fx.close();
  }
});

test('detach leaves the browser answering', async () => {
  const fx = await withFixture('/form.html', 'Fixture form');
  try {
    await waitForPage(fx.driver, fx.pageUrl);
    await fx.driver.detach();
    const res = await fetch(`${fx.endpoint}/json/version`);
    assert.equal(res.ok, true, 'the browser still answers /json/version after detach');
  } finally {
    await fx.close();
  }
});

// WP-E — conformance suite.
//
// One ephemeral Chrome (temp profile, port 0, via the D0 test helper) and one
// fixture server per describe. Every fixture page is opened by a browser-level
// observer CdpConnection (Target.createTarget blank + flatten Page.navigate —
// see the WP-D1/D2 reports: `/json/new?<url>` never commits a navigation on
// this machine's Chrome), never by an adapter under test. Each test attaches
// its own driver from the WP-E registry, acts, and detaches; the test page's
// target is closed afterwards so pages never accumulate.
//
// `describe('cross-adapter')` deep-compares the FULL ElementRecord arrays from
// both adapters on the four table pages. `describe(<adapter>)` runs the same
// 12 behaviours against every entry of ADAPTERS.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchTestChrome } from './helpers/chrome.js';
import { startFixtureServer, type FixtureServer } from '../src/fixture-server.js';
import { ADAPTERS, createDriver } from '../src/adapters/index.js';
import { CdpConnection } from '../src/adapters/cdp-connection.js';
import { CoveredTargetError, DialogOpenError, StaleElementError } from '../src/contract/errors.js';
import type { Driver, ElementRecord } from '../src/contract/types.js';

type TestChrome = Awaited<ReturnType<typeof launchTestChrome>>;

interface Env {
  chrome: TestChrome;
  fixture: FixtureServer;
  observer: CdpConnection;
}

interface Page {
  pageId: string;
  url: string;
  sessionId: string;
}

interface Ctx extends Page {
  env: Env;
  driver: Driver;
  adapter: 'playwright' | 'cdp';
}

const TITLES: Record<string, string> = {
  'form.html': 'Fixture form',
  'styled-controls.html': 'Fixture styled controls',
  'big-select.html': 'Fixture big select',
  'many.html': 'Fixture many',
  'dialog.html': 'Fixture dialogs',
  'overlay.html': 'Fixture overlay',
  'delayed-nav.html': 'Fixture delayed',
  'spa.html': 'Fixture SPA',
  'residue.html': 'Fixture residue',
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function startEnv(): Promise<Env> {
  const chrome = await launchTestChrome();
  try {
    const fixture = await startFixtureServer();
    const observer = await CdpConnection.connect(chrome.endpoint);
    return { chrome, fixture, observer };
  } catch (e) {
    await chrome.close().catch(() => {});
    throw e;
  }
}

async function stopEnv(env: Env): Promise<void> {
  await env.observer.close().catch(() => {});
  await env.fixture.close().catch(() => {});
  await env.chrome.close().catch(() => {});
}

async function openPage(env: Env, file: string): Promise<Page> {
  const url = `${env.fixture.url}/${file}`;
  const { targetId } = await env.observer.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
  });
  const { sessionId } = await env.observer.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await env.observer.send('Page.enable', {}, sessionId);
  // A fresh browser's first navigation can occasionally miss the command
  // timeout; retry bounded before giving up.
  for (let attempt = 0; ; attempt++) {
    try {
      await env.observer.send('Page.navigate', { url }, sessionId, 10_000);
      break;
    } catch (e) {
      if (attempt >= 2 || !(e instanceof Error) || !/cdp timeout/.test(e.message)) throw e;
    }
  }
  const expected = TITLES[file];
  const deadline = Date.now() + 15_000;
  for (;;) {
    const info = await env.observer
      .send<{ result?: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression: 'document.title', returnByValue: true },
        sessionId,
      )
      .catch(() => null);
    if (info?.result?.value === expected) break;
    assert.ok(Date.now() < deadline, `page ${file} never loaded`);
    await sleep(250);
  }
  return { pageId: targetId, url, sessionId };
}

// Runs one test body against a fresh driver from the registry attached to a
// freshly opened fixture page. Driver detach and page-target close are
// best-effort in finally, so a failed body never leaks either.
async function withPage<T>(
  env: Env,
  adapter: 'playwright' | 'cdp',
  file: string,
  fn: (ctx: Ctx) => Promise<T>,
): Promise<T> {
  const page = await openPage(env, file);
  const driver = createDriver(adapter);
  await driver.attach({ cdpEndpoint: env.chrome.endpoint });
  // Registers the driver's per-page records (the playwright adapter creates
  // them lazily in pages(), exactly as the WP-D1 suite drives it).
  await driver.pages();
  const ctx: Ctx = { ...page, env, driver, adapter };
  try {
    return await fn(ctx);
  } finally {
    await driver.detach().catch(() => {});
    await env.observer.send('Target.closeTarget', { targetId: page.pageId }).catch(() => {});
  }
}

async function evalMain(ctx: Ctx, expression: string): Promise<any> {
  const result = await ctx.env.observer.send<{ result?: { value?: unknown } }>(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    ctx.sessionId,
  );
  return result.result?.value;
}

async function elementNamed(ctx: Ctx, name: string): Promise<ElementRecord> {
  const obs = await ctx.driver.observe(ctx.pageId);
  const el = obs.elements.find((e) => e.name === name);
  assert.ok(el, `element named "${name}" not found on ${ctx.url}`);
  return el;
}

async function elementState(ctx: Ctx, name: string): Promise<ElementRecord['state']> {
  const obs = await ctx.driver.observe(ctx.pageId);
  const el = obs.elements.find((e) => e.name === name);
  assert.ok(el, `element named "${name}" not found on ${ctx.url}`);
  return el.state;
}

// Chrome can add a page global lazily between two clean reads (measured by the
// wave-0 verifier, 1 run in 6 on residue.html), so the baseline is only
// trusted once two consecutive reads agree. A driver-caused change still
// fails the comparison.
async function globalNames(ctx: Ctx): Promise<string[]> {
  const value = (await evalMain(ctx, 'Object.getOwnPropertyNames(globalThis).sort()')) as string[];
  return Array.isArray(value) ? value : [];
}

async function stableGlobals(ctx: Ctx): Promise<string[]> {
  let prev = await globalNames(ctx);
  for (let i = 0; i < 5; i++) {
    const next = await globalNames(ctx);
    if (JSON.stringify(next) === JSON.stringify(prev)) return next;
    prev = next;
  }
  return prev;
}

async function pageTargetIds(env: Env): Promise<string[]> {
  const { targetInfos } = await env.observer.send<{
    targetInfos: Array<{ targetId: string; type: string }>;
  }>('Target.getTargets');
  return targetInfos
    .filter((t) => t.type === 'page')
    .map((t) => t.targetId)
    .sort();
}

const CROSS_PAGES = ['form.html', 'styled-controls.html', 'big-select.html', 'many.html'];

describe('cross-adapter', () => {
  let env: Env;
  before(async () => {
    env = await startEnv();
  });
  after(async () => {
    await stopEnv(env);
  });

  for (const file of CROSS_PAGES) {
    test(`element table for ${file} is identical across adapters`, async () => {
      const tables: Array<{ adapter: string; elements: ElementRecord[] }> = [];
      for (const adapter of ADAPTERS) {
        await withPage(env, adapter, file, async (ctx) => {
          const obs = await ctx.driver.observe(ctx.pageId);
          assert.ok(obs.elements.length > 0, `${adapter} observed no elements on ${file}`);
          tables.push({ adapter, elements: obs.elements });
        });
      }
      assert.equal(tables.length, 2);
      assert.deepEqual(
        tables[1].elements,
        tables[0].elements,
        `${tables[1].adapter} element table differs from ${tables[0].adapter} on ${file}`,
      );
    });
  }
});

function adapterSuite(adapter: 'playwright' | 'cdp'): void {
  describe(adapter, () => {
    let env: Env;
    before(async () => {
      env = await startEnv();
    });
    after(async () => {
      await stopEnv(env);
    });

    test('click writes the expected log text', async () => {
      await withPage(env, adapter, 'form.html', async (ctx) => {
        const el = await elementNamed(ctx, 'Continue');
        await ctx.driver.act(ctx.pageId, el.id, 'click');
        assert.equal(await evalMain(ctx, "document.getElementById('log').textContent"), 'continued');
      });
    });

    test('fill sets the value', async () => {
      await withPage(env, adapter, 'form.html', async (ctx) => {
        const el = await elementNamed(ctx, 'Full name');
        await ctx.driver.act(ctx.pageId, el.id, 'fill', 'Jane Doe');
        assert.equal(await evalMain(ctx, "document.getElementById('fullname').value"), 'Jane Doe');
        assert.equal((await elementState(ctx, 'Full name')).filled, true);
      });
    });

    test('select sets the value on big-select.html option v290', async () => {
      await withPage(env, adapter, 'big-select.html', async (ctx) => {
        const el = await elementNamed(ctx, 'Size');
        await ctx.driver.act(ctx.pageId, el.id, 'select', 'v290');
        assert.equal(await evalMain(ctx, "document.getElementById('size').value"), 'v290');
        assert.equal((await elementState(ctx, 'Size')).selected, 'Option 290');
      });
    });

    test('check and uncheck toggle the styled checkbox through its label', async () => {
      await withPage(env, adapter, 'styled-controls.html', async (ctx) => {
        const el = await elementNamed(ctx, 'Send me the newsletter');
        assert.equal((await elementState(ctx, 'Send me the newsletter')).checked, false);
        await ctx.driver.act(ctx.pageId, el.id, 'check');
        assert.equal((await elementState(ctx, 'Send me the newsletter')).checked, true);
        assert.equal(await evalMain(ctx, "document.getElementById('news').checked"), true);
        await ctx.driver.act(ctx.pageId, el.id, 'uncheck');
        assert.equal((await elementState(ctx, 'Send me the newsletter')).checked, false);
        assert.equal(await evalMain(ctx, "document.getElementById('news').checked"), false);
      });
    });

    test('press Enter submits form.html', async () => {
      await withPage(env, adapter, 'form.html', async (ctx) => {
        const el = await elementNamed(ctx, 'Full name');
        await ctx.driver.act(ctx.pageId, el.id, 'press', 'Enter');
        assert.equal(await evalMain(ctx, "document.getElementById('log').textContent"), 'submitted');
      });
    });

    test('scroll moves many.html down', async () => {
      await withPage(env, adapter, 'many.html', async (ctx) => {
        const el = await elementNamed(ctx, 'Row 001');
        await ctx.driver.act(ctx.pageId, el.id, 'scroll');
        // The wheel event applies asynchronously in the renderer; poll briefly
        // before reading scrollY.
        const deadline = Date.now() + 2_000;
        let y = 0;
        for (;;) {
          y = Number(await evalMain(ctx, 'window.scrollY'));
          if (y > 0 || Date.now() >= deadline) break;
          await sleep(100);
        }
        assert.ok(y > 0, `expected a positive scrollY, got ${y}`);
      });
    });

    test('settle waits out delayed navigation within 3000 ms', async () => {
      await withPage(env, adapter, 'delayed-nav.html', async (ctx) => {
        const el = await elementNamed(ctx, 'Go next');
        await ctx.driver.act(ctx.pageId, el.id, 'click');
        // Cross the fixture's 800 ms navigation timer first so settle runs
        // against a page whose execution context is being replaced.
        await sleep(900);
        const result = await ctx.driver.settle(ctx.pageId, 3_000);
        assert.ok(result.settled, `settle did not settle: ${JSON.stringify(result)}`);
        assert.ok(result.ms <= 3_000, `settle overran its budget: ${JSON.stringify(result)}`);
        const deadline = Date.now() + 3_000;
        for (;;) {
          if ((await evalMain(ctx, 'document.title')) === 'Fixture arrived') break;
          assert.ok(Date.now() < deadline, 'delayed navigation never arrived');
          await sleep(250);
        }
      });
    });

    test('settle picks up the SPA items', async () => {
      await withPage(env, adapter, 'spa.html', async (ctx) => {
        const el = await elementNamed(ctx, 'Load items');
        await ctx.driver.act(ctx.pageId, el.id, 'click');
        // Cross the fixture's 500 ms mutation timer so settle observes the
        // post-mutation page.
        await sleep(600);
        const result = await ctx.driver.settle(ctx.pageId, 3_000);
        assert.ok(result.settled, `settle did not settle: ${JSON.stringify(result)}`);
        const obs = await ctx.driver.observe(ctx.pageId);
        const names = obs.elements.map((e) => e.name);
        for (let i = 1; i <= 5; i++) {
          assert.ok(names.includes(`Item ${i}`), `Item ${i} missing after settle: ${names.join(', ')}`);
        }
      });
    });

    test('dialog is reported and never answered', async () => {
      await withPage(env, adapter, 'dialog.html', async (ctx) => {
        const dialogs: Array<{ pageId: string; type: string; message: string }> = [];
        ctx.driver.onDialog((e) => dialogs.push({ pageId: e.pageId, type: e.type, message: e.message }));
        const el = await elementNamed(ctx, 'Show alert');
        // Resolves normally when the dialog wins the race; never dismisses it.
        await ctx.driver.act(ctx.pageId, el.id, 'click');
        assert.equal(dialogs.length, 1, `expected one dialog event, got ${JSON.stringify(dialogs)}`);
        assert.equal(dialogs[0].pageId, ctx.pageId);
        assert.equal(dialogs[0].type, 'alert');
        assert.equal(dialogs[0].message, 'Hello from fixture');
        // Still open: an evaluation on the same page stays blocked, which
        // proves nothing answered the dialog. The playwright adapter surfaces
        // the wedged evaluation as DialogOpenError; the raw-CDP adapter's
        // Page.getFrameTree preamble can also time out first — either way the
        // rejection is bounded and the dialog was never answered.
        await assert.rejects(
          ctx.driver.observe(ctx.pageId),
          (e: unknown) =>
            e instanceof DialogOpenError ||
            (e instanceof Error && /cdp timeout/.test(e.message)),
        );
        // Dismiss over the observer session so the page can be torn down; the
        // adapter itself never answers. (The dialog is sometimes already gone
        // at teardown on headless Chrome, which is not a failure.)
        await ctx.env.observer
          .send('Page.handleJavaScriptDialog', { accept: true }, ctx.sessionId)
          .catch(() => {});
        await sleep(250);
      });
    });

    test('covered target raises CoveredTargetError', async () => {
      await withPage(env, adapter, 'overlay.html', async (ctx) => {
        const el = await elementNamed(ctx, 'Show details');
        await assert.rejects(ctx.driver.act(ctx.pageId, el.id, 'click'), CoveredTargetError);
      });
    });

    test('stale element raises StaleElementError', async () => {
      await withPage(env, adapter, 'form.html', async (ctx) => {
        const el = await elementNamed(ctx, 'Full name');
        // Mutate the page through the observer so the cached fingerprint no
        // longer matches, then act on the cached element id.
        await evalMain(ctx, "document.getElementById('fullname').remove()");
        await assert.rejects(ctx.driver.act(ctx.pageId, el.id, 'click'), StaleElementError);
      });
    });

    test('detach leaves no residue and never closes the browser', async () => {
      const page = await openPage(env, 'residue.html');
      const probe = { ...page, env, driver: null as unknown as Driver, adapter };
      try {
        const globalsBefore = await stableGlobals(probe);
        const attrsBefore = await evalMain(probe, 'document.documentElement.attributes.length');
        const targetsBefore = await pageTargetIds(env);
        const contextsBefore = await env.observer.send<{ browserContextIds?: string[] }>(
          'Target.getBrowserContexts',
        );

        // Real attach activity, then detach.
        const driver = createDriver(adapter);
        await driver.attach({ cdpEndpoint: env.chrome.endpoint });
        await driver.pages();
        await driver.detach();

        const globalsAfter = await globalNames(probe);
        const attrsAfter = await evalMain(probe, 'document.documentElement.attributes.length');
        const targetsAfter = await pageTargetIds(env);
        const contextsAfter = await env.observer.send<{ browserContextIds?: string[] }>(
          'Target.getBrowserContexts',
        );
        assert.deepEqual(globalsAfter, globalsBefore);
        assert.equal(attrsAfter, attrsBefore);
        assert.deepEqual(targetsAfter, targetsBefore);
        assert.deepEqual(contextsAfter, contextsBefore);
        const ver = await (await fetch(`${env.chrome.endpoint}/json/version`)).json();
        assert.ok(ver && typeof ver === 'object' && 'Browser' in (ver as object));
      } finally {
        await env.observer.send('Target.closeTarget', { targetId: page.pageId }).catch(() => {});
      }
    });
  });
}

for (const adapter of ADAPTERS) {
  adapterSuite(adapter);
}

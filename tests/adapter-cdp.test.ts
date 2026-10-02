// WP-D2: raw-CDP driver tests, same six titles as the playwright adapter (WP-D1).
// Each test launches the package's own ephemeral Chrome (temp profile, port 0)
// and opens its page through a browser-level CdpConnection (Target.createTarget
// + Page.navigate), so the adapter never opens one. Main-world checks reuse the
// same observer connection. On this machine's Chrome neither `/json/new` nor
// `Target.createTarget({ url })` commits the navigation, so the page is created
// blank and navigated through a flatten session.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { launchTestChrome } from './helpers/chrome.js';
import { startFixtureServer, type FixtureServer } from '../src/fixture-server.js';
import { createCdpDriver } from '../src/adapters/cdp.js';
import { CdpConnection } from '../src/adapters/cdp-connection.js';
import { ActFailedError } from '../src/contract/errors.js';
import type { Driver, ElementRecord } from '../src/contract/types.js';

interface Rig {
  fixture: FixtureServer;
  browser: { endpoint: string; close(): Promise<void> };
  observer: CdpConnection;
  observerSession: string;
  driver: Driver;
  pageId: string;
}

async function openRig(pageName: string, expectedTitle: string): Promise<Rig> {
  const fixture = await startFixtureServer();
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

async function findPage(rig: Rig, urlPrefix: string) {
  const pages = await rig.driver.pages();
  const page = pages.find((p) => p.url.startsWith(urlPrefix));
  assert.ok(page, `page ${urlPrefix} not listed`);
  return page;
}

async function elementByName(rig: Rig, name: string): Promise<ElementRecord> {
  const observation = await rig.driver.observe(rig.pageId);
  const el = observation.elements.find((e) => e.name === name);
  assert.ok(el, `element named ${name} not found`);
  return el;
}

test('attaches to the default context and lists the page', async () => {
  const rig = await openRig('form.html', 'Fixture form');
  try {
    const pages = await rig.driver.pages();
    const page = pages.find((p) => p.id === rig.pageId);
    assert.ok(page, 'fixture page not listed');
    assert.match(page.url, /\/form\.html$/);
    assert.equal(page.title, 'Fixture form');
    assert.equal(typeof page.visible, 'boolean');
  } finally {
    await closeRig(rig);
  }
});

// Box geometry (rect x/y/w/h and the fingerprint's x/y) is a function of
// viewport width and font rendering, both of which vary across machines: the
// same fixture wrapped its two buttons to a second row at the 780px-wide
// window this suite was originally pinned on (Windows), but lays out as one
// row at the 1280x800 window the ephemeral Chrome now launches with (commit
// c7a6436) — e.g. "Continue" pinned at x=8,y=122 (row 2) is observed at
// x=780 on row 1 on Linux. No absolute-pin tolerance, gap-relative or
// otherwise, survives a reflow like that: the pin itself encodes a specific
// viewport/font combination, not a portable expectation.
//
// So geometry is no longer checked against a pinned value at all: it is
// checked against the SAME page's own live geometry, read straight from the
// DOM via each element's `path` selector (`querySelector(path).getBoundingClientRect()`).
// Every semantic field (role, name, htmlId, placeholder, obscured, type,
// attrName, state, editable, inViewport, form, options, ...) keeps its exact
// pinned-equality check; only geometry moves to a live comparison, and the
// check still can't be satisfied by nothing: rect.x/y/w/h must equal the
// live rect exactly (src/core/page-scripts.ts rounds rect fields with
// `Math.round`, and reading the same static page moments later reproduces
// the identical rounded values), and fingerprint.x/y must equal rect.x/y
// (page-scripts.ts sets `fingerprint = { ..., x: rect.x, y: rect.y }` at
// enumerate time).
type PinnedElementSemantics = Omit<ElementRecord, 'rect' | 'fingerprint'> & {
  fingerprint: Omit<ElementRecord['fingerprint'], 'x' | 'y'>;
};

interface LiveRect { x: number; y: number; w: number; h: number }

// Reads every element's live getBoundingClientRect() in one round trip,
// keyed by the same `path` selector page-scripts.ts used to build `rect`.
async function readLiveRects(rig: Rig, paths: string[]): Promise<Record<string, LiveRect | null>> {
  const expression = `
    (function () {
      var paths = ${JSON.stringify(paths)};
      var out = {};
      for (var i = 0; i < paths.length; i++) {
        var el = document.querySelector(paths[i]);
        if (!el) { out[paths[i]] = null; continue; }
        var r = el.getBoundingClientRect();
        out[paths[i]] = {
          x: Math.round(r.left + window.scrollX),
          y: Math.round(r.top + window.scrollY),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      }
      return out;
    })()
  `;
  return evalMain(rig, expression);
}

function assertElementsMatchLiveGeometry(
  actual: ElementRecord[],
  expected: PinnedElementSemantics[],
  liveRectsByPath: Record<string, LiveRect | null>,
): void {
  assert.equal(actual.length, expected.length, 'element count mismatch');
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i];
    const e = expected[i];
    const { rect: aRect, fingerprint: aFp, ...aRest } = a as any;
    const { fingerprint: eFp, ...eRest } = e as any;
    assert.deepEqual(aRest, eRest, `element ${i} (${e.name}) semantic fields differ`);
    const { x: aFpX, y: aFpY, ...aFpRest } = aFp;
    assert.deepEqual(aFpRest, eFp, `element ${i} (${e.name}) fingerprint non-geometric fields differ`);
    const live = liveRectsByPath[a.path];
    assert.ok(live, `element ${i} (${e.name}) path ${a.path} not found live on the page`);
    for (const key of ['x', 'y', 'w', 'h'] as const) {
      assert.equal(
        aRect[key],
        (live as LiveRect)[key],
        `element ${i} (${e.name}) rect.${key}=${aRect[key]} does not equal live ${key}=${(live as LiveRect)[key]}`,
      );
    }
    // fingerprint.x/y are captured from the same rect at enumerate time
    // (src/core/page-scripts.ts: `fingerprint = { ..., x: rect.x, y: rect.y }`),
    // so they must equal the actual rect exactly.
    assert.equal(aFpX, aRect.x, `element ${i} (${e.name}) fingerprint.x=${aFpX} does not equal rect.x=${aRect.x}`);
    assert.equal(aFpY, aRect.y, `element ${i} (${e.name}) fingerprint.y=${aFpY} does not equal rect.y=${aRect.y}`);
  }
}

test('observe matches the pinned form.html table', async () => {
  const rig = await openRig('form.html', 'Fixture form');
  try {
    const observation = await rig.driver.observe(rig.pageId);
    assert.equal(observation.title, 'Fixture form');
    assert.match(observation.url, /\/form\.html$/);
    assert.equal(observation.truncated, false);
    const liveRects = await readLiveRects(rig, observation.elements.map((el) => el.path));
    assertElementsMatchLiveGeometry(observation.elements, PINNED_FORM_ELEMENTS, liveRects);
    assert.equal(observation.forms.length, 1);
    assert.equal(observation.forms[0].id, 'details');
    assert.equal(observation.forms[0].method, 'post');
    assert.equal(observation.signals.password, false);
  } finally {
    await closeRig(rig);
  }
});

test('click Continue writes continued', async () => {
  const rig = await openRig('form.html', 'Fixture form');
  try {
    const el = await elementByName(rig, 'Continue');
    await rig.driver.act(rig.pageId, el.id, 'click');
    const log = await evalMain(rig, "document.getElementById('log').textContent");
    assert.equal(log, 'continued');
  } finally {
    await closeRig(rig);
  }
});

test('fill never leaves the value in observe output', async () => {
  const rig = await openRig('form.html', 'Fixture form');
  try {
    const observation = await rig.driver.observe(rig.pageId);
    const el = observation.elements.find((e) => e.name === 'Full name');
    assert.ok(el, 'fullname field not found');
    const secret = 'WingmanSecret123';
    await rig.driver.act(rig.pageId, el.id, 'fill', secret);
    const after = await rig.driver.observe(rig.pageId);
    assert.equal(after.elements.find((e) => e.id === el.id)?.state.filled, true);
    assert.ok(!JSON.stringify(after).includes(secret), 'typed value leaked into observe output');
  } finally {
    await closeRig(rig);
  }
});

test('dialog is reported and stays open', async () => {
  const rig = await openRig('dialog.html', 'Fixture dialogs');
  const dialogs: Array<{ type: string; message: string }> = [];
  rig.driver.onDialog((e) => dialogs.push({ type: e.type, message: e.message }));
  try {
    const el = await elementByName(rig, 'Show alert');
    await rig.driver.act(rig.pageId, el.id, 'click');
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].type, 'alert');
    assert.equal(dialogs[0].message, 'Hello from fixture');
    // The adapter never answers a dialog: an alert still blocks evaluation, so
    // a bounded evaluate on that page must time out. (A dismissed dialog would
    // let the evaluate through; the button's handler only sets the log after
    // the alert closes, so a timeout also proves nothing answered it.)
    await assert.rejects(
      rig.observer.send(
        'Runtime.evaluate',
        { expression: "document.getElementById('log').textContent", returnByValue: true },
        rig.observerSession,
        1_500,
      ),
      (err: unknown) => err instanceof Error && err.message === 'cdp timeout: Runtime.evaluate',
    );
    const pages = await rig.driver.pages();
    assert.ok(pages.some((p) => p.id === rig.pageId), 'page vanished');
  } finally {
    await closeRig(rig);
  }
});

test('detach leaves the browser answering', async () => {
  const rig = await openRig('form.html', 'Fixture form');
  try {
    await rig.driver.pages();
  } finally {
    await rig.driver.detach();
  }
  const ver = await (await fetch(`${rig.browser.endpoint}/json/version`)).json();
  assert.ok(ver && typeof ver === 'object' && 'Browser' in (ver as object));
  const { targetInfos } = await rig.observer.send<{ targetInfos: Array<{ targetId: string }> }>(
    'Target.getTargets',
  );
  assert.ok(targetInfos.some((t) => t.targetId === rig.pageId), 'page target vanished');
  await closeRig(rig);
});

test('act surfaces an operation failure', async () => {
  const rig = await openRig('form.html', 'Fixture form');
  try {
    const el = await elementByName(rig, 'Continue');
    // fill without a value makes performOp fail; act must reject, never
    // resolve as if the operation had run.
    await assert.rejects(rig.driver.act(rig.pageId, el.id, 'fill'));
  } finally {
    await closeRig(rig);
  }
});

// r17: answerDialog on a page with no open dialog rejects — Chrome answers
// "no dialog is showing" and the adapter wraps it in ActFailedError (the loop
// degrades that to blocked/dialog-open, an answer that failed leaves the
// dialog open, which is exactly what the reason means).
test('answerDialog with no open dialog rejects', async () => {
  const rig = await openRig('form.html', 'Fixture form');
  try {
    await assert.rejects(rig.driver.answerDialog(rig.pageId, true), ActFailedError);
  } finally {
    await closeRig(rig);
  }
});

test('attach retries a cold endpoint within its budget', async () => {
  const browser = await launchTestChrome();
  const version = (await (await fetch(`${browser.endpoint}/json/version`)).json()) as unknown;
  // A stub debug endpoint that answers 503 for the first 300 ms, then serves
  // the real /json/version body. Without the bounded retry the attach fails.
  let ready = false;
  setTimeout(() => {
    ready = true;
  }, 300);
  const server = createServer((req, res) => {
    if (!ready) {
      res.statusCode = 503;
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(version));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const driver = createCdpDriver();
  try {
    const port = (server.address() as AddressInfo).port;
    await driver.attach({ cdpEndpoint: `http://127.0.0.1:${port}` });
    assert.equal(driver.name, 'cdp');
  } finally {
    await driver.detach().catch(() => {});
    server.close();
    await browser.close();
  }
});

// Pinned from the actual enumeration of fixtures/pages/form.html at WP-D2
// build time; verified by hand against the in-page script contract (§ 3.5).
// Re-pinned 2026-09-26 for the § 3.5 record fields added since: `placeholder`
// and `htmlId` (amendment 2026-09-21b, machine-attribute routing criteria) and
// `obscured` (amendment 2026-09-21h, enumerate-time occlusion probe). Nothing
// covers any control on this fixture, so every row is `obscured: false` with
// no `coveredBy`; only the textarea carries a placeholder.
//
// `rect` and `fingerprint.x/y` were removed 2026-09-27: they used to carry
// absolute pixel geometry recorded on Windows in a 780px-wide viewport (the
// two buttons wrapped to a second row there); that geometry is not portable
// across viewport widths or font rendering (see the comment above
// `assertElementsMatchLiveGeometry`), so geometry is now checked against the
// live page instead of a pin.
const PINNED_FORM_ELEMENTS: PinnedElementSemantics[] = [
  {
    id: 'e1',
    path: '#fullname',
    tag: 'input',
    role: 'textbox',
    name: 'Full name',
    type: 'text',
    attrName: 'fullname',
    placeholder: '',
    htmlId: 'fullname',
    ariaLabel: '',
    autocomplete: '',
    state: { disabled: false, filled: false },
    editable: true,
    inViewport: true,
    form: 0,
    fingerprint: { tag: 'input', role: 'textbox', name: 'Full name' },
    obscured: false,
  },
  {
    id: 'e2',
    path: '#email',
    tag: 'input',
    role: 'textbox',
    name: 'Email',
    type: 'email',
    attrName: 'email',
    placeholder: '',
    htmlId: 'email',
    ariaLabel: 'Email',
    autocomplete: '',
    state: { disabled: false, filled: false },
    editable: true,
    inViewport: true,
    form: 0,
    fingerprint: { tag: 'input', role: 'textbox', name: 'Email' },
    obscured: false,
  },
  {
    id: 'e3',
    path: '#notes',
    tag: 'textarea',
    role: 'textbox',
    name: 'Notes',
    type: '',
    attrName: 'notes',
    placeholder: 'Notes',
    htmlId: 'notes',
    ariaLabel: '',
    autocomplete: '',
    state: { disabled: false, filled: true },
    editable: true,
    inViewport: true,
    form: 0,
    fingerprint: { tag: 'textarea', role: 'textbox', name: 'Notes' },
    obscured: false,
  },
  {
    id: 'e4',
    path: '#country',
    tag: 'select',
    role: 'combobox',
    name: 'Country',
    type: '',
    attrName: 'country',
    placeholder: '',
    htmlId: 'country',
    ariaLabel: '',
    autocomplete: '',
    state: { disabled: false, selected: 'Choose' },
    editable: false,
    inViewport: true,
    form: 0,
    fingerprint: { tag: 'select', role: 'combobox', name: 'Country' },
    obscured: false,
    options: [
      { value: '', label: 'Choose' },
      { value: 'in', label: 'India' },
      { value: 'us', label: 'United States' },
    ],
  },
  {
    id: 'e5',
    path: '#continue',
    tag: 'button',
    role: 'button',
    name: 'Continue',
    type: 'button',
    attrName: '',
    placeholder: '',
    htmlId: 'continue',
    ariaLabel: '',
    autocomplete: '',
    state: { disabled: false },
    editable: false,
    inViewport: true,
    form: 0,
    fingerprint: { tag: 'button', role: 'button', name: 'Continue' },
    obscured: false,
  },
  {
    id: 'e6',
    path: '#place',
    tag: 'button',
    role: 'button',
    name: 'Place order',
    type: 'submit',
    attrName: '',
    placeholder: '',
    htmlId: 'place',
    ariaLabel: '',
    autocomplete: '',
    state: { disabled: false },
    editable: false,
    inViewport: true,
    form: 0,
    fingerprint: { tag: 'button', role: 'button', name: 'Place order' },
    obscured: false,
  },
];

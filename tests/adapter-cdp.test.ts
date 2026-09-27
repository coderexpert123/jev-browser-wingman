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

// Font rendering (and therefore box geometry: rect x/y/w/h and the fingerprint's
// x/y) is OS-specific — the same fixture measures differently on Linux than on
// the Windows box this suite was pinned on (e.g. w: 185 vs pinned 177, x: 257 vs
// pinned 249). Every semantic field (role, name, htmlId, placeholder, obscured,
// type, attrName, state, editable, inViewport, form, options, ...) still asserts
// exact equality; only the pixel-geometry fields get a tolerance, and even those
// are still checked, not skipped: each must be within a few px of the pinned
// value and stay sane (non-negative, matching between rect and fingerprint).
//
// A flat per-field tolerance on absolute x was too strict for a wide row: each
// text control's width drifts a few px with the font, and those per-element
// drifts accumulate along the row (element 3 in form.html's row 1 measured
// x=677 on Linux against a pinned 647 — 30px off a 20px budget — while each
// individual control's width was within tolerance). w/h keep the flat
// tolerance; x is checked relative to the previous element on the same line
// (gap = x - (prev.x + prev.w), within tolerance of the pinned gap) so a
// width drift doesn't compound, with the first element's x checked absolute
// (there is no previous element to gap from). y is checked the same way, as a
// delta from the previous element's y, which also catches a wrap to a new
// line: a wrapped element's y jumps by roughly a full row height, so its
// delta from the previous element no longer matches the pinned delta, and the
// tolerance check fails. A genuine pinned row break (its pinned gap-from-prev
// at or below -GEOMETRY_TOLERANCE_PX, e.g. form.html's Country -> Continue)
// gets the SAME absolute check as element 0 instead: a gap-relative check
// there would inherit the whole previous row's accumulated drift into the
// new row's first element, reproducing the exact compounding bug one element
// downstream (verifier fix, 2026-09-27).
const GEOMETRY_TOLERANCE_PX = 20;

function assertElementsMatchWithGeometryTolerance(actual: ElementRecord[], expected: ElementRecord[]): void {
  assert.equal(actual.length, expected.length, 'element count mismatch');
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i];
    const e = expected[i];
    const { rect: aRect, fingerprint: aFp, ...aRest } = a as any;
    const { rect: eRect, fingerprint: eFp, ...eRest } = e as any;
    assert.deepEqual(aRest, eRest, `element ${i} (${e.name}) semantic fields differ`);
    const { x: eFpX, y: eFpY, ...eFpRest } = eFp;
    const { x: aFpX, y: aFpY, ...aFpRest } = aFp;
    assert.deepEqual(aFpRest, eFpRest, `element ${i} (${e.name}) fingerprint non-geometric fields differ`);
    for (const key of ['w', 'h'] as const) {
      const av = aRect[key];
      const ev = eRect[key];
      assert.ok(av >= 0, `element ${i} (${e.name}) rect.${key}=${av} is negative`);
      assert.ok(
        Math.abs(av - ev) <= GEOMETRY_TOLERANCE_PX,
        `element ${i} (${e.name}) rect.${key}=${av} not within ${GEOMETRY_TOLERANCE_PX}px of pinned ${ev}`,
      );
    }
    assert.ok(aRect.x >= 0, `element ${i} (${e.name}) rect.x=${aRect.x} is negative`);
    assert.ok(aRect.y >= 0, `element ${i} (${e.name}) rect.y=${aRect.y} is negative`);
    // A gap-from-previous check only makes sense when i and i-1 sit on the
    // same pinned line: a genuine row break (e.g. form.html's Country ->
    // Continue, whose pinned gap is -742) otherwise inherits the entire
    // previous row's accumulated font-width drift into the first element of
    // the new row, reproducing the exact compounding failure this tolerance
    // was written to remove — just one element downstream (verifier fix,
    // 2026-09-27: caught by a scratch harness modelling realistic reflow,
    // where a widened row-1 pushed the row-2 gap out by ~24px). Row
    // membership is decided from the PINNED gap (stable, known at pin time):
    // a pinned gap at or below -GEOMETRY_TOLERANCE_PX means the next element
    // starts a new line, so it gets the same absolute check as element 0
    // (its own position never depends on the previous row's drift); anything
    // less negative is treated as the same line and gets the relative check.
    const prevE = i > 0 ? (expected[i - 1] as any) : null;
    const pinnedGapFromPrev = prevE ? eRect.x - (prevE.rect.x + prevE.rect.w) : null;
    const rowBreak = i === 0 || (pinnedGapFromPrev as number) <= -GEOMETRY_TOLERANCE_PX;
    if (rowBreak) {
      assert.ok(
        Math.abs(aRect.x - eRect.x) <= GEOMETRY_TOLERANCE_PX,
        `element ${i} (${e.name}) rect.x=${aRect.x} not within ${GEOMETRY_TOLERANCE_PX}px of pinned ${eRect.x}`,
      );
      assert.ok(
        Math.abs(aRect.y - eRect.y) <= GEOMETRY_TOLERANCE_PX,
        `element ${i} (${e.name}) rect.y=${aRect.y} not within ${GEOMETRY_TOLERANCE_PX}px of pinned ${eRect.y}`,
      );
    } else {
      const prevA = actual[i - 1] as any;
      const actualGap = aRect.x - (prevA.rect.x + prevA.rect.w);
      const pinnedGap = pinnedGapFromPrev as number;
      assert.ok(
        Math.abs(actualGap - pinnedGap) <= GEOMETRY_TOLERANCE_PX,
        `element ${i} (${e.name}) x-gap from the previous element=${actualGap} not within ${GEOMETRY_TOLERANCE_PX}px of pinned gap ${pinnedGap}`,
      );
      const actualRowDelta = aRect.y - prevA.rect.y;
      const pinnedRowDelta = eRect.y - prevE.rect.y;
      assert.ok(
        Math.abs(actualRowDelta - pinnedRowDelta) <= GEOMETRY_TOLERANCE_PX,
        `element ${i} (${e.name}) y-delta from the previous element=${actualRowDelta} not within ${GEOMETRY_TOLERANCE_PX}px of pinned delta ${pinnedRowDelta} (row membership mismatch, e.g. a wrap to a new line)`,
      );
    }
    // fingerprint.x/y are captured from the same rect at enumerate time
    // (src/core/page-scripts.ts: `fingerprint = { ..., x: rect.x, y: rect.y }`),
    // so they must equal the actual rect exactly, not just the pin.
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
    assertElementsMatchWithGeometryTolerance(observation.elements, PINNED_FORM_ELEMENTS);
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
const PINNED_FORM_ELEMENTS: ElementRecord[] = [
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
    rect: { x: 72, y: 101, w: 177, h: 21 },
    form: 0,
    fingerprint: { tag: 'input', role: 'textbox', name: 'Full name', x: 72, y: 101 },
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
    rect: { x: 249, y: 101, w: 177, h: 21 },
    form: 0,
    fingerprint: { tag: 'input', role: 'textbox', name: 'Email', x: 249, y: 101 },
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
    rect: { x: 426, y: 80, w: 168, h: 36 },
    form: 0,
    fingerprint: { tag: 'textarea', role: 'textbox', name: 'Notes', x: 426, y: 80 },
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
    rect: { x: 647, y: 102, w: 103, h: 19 },
    form: 0,
    fingerprint: { tag: 'select', role: 'combobox', name: 'Country', x: 647, y: 102 },
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
    rect: { x: 8, y: 122, w: 69, h: 21 },
    form: 0,
    fingerprint: { tag: 'button', role: 'button', name: 'Continue', x: 8, y: 122 },
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
    rect: { x: 77, y: 122, w: 84, h: 21 },
    form: 0,
    fingerprint: { tag: 'button', role: 'button', name: 'Place order', x: 77, y: 122 },
    obscured: false,
  },
];

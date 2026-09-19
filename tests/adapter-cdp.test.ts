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

test('observe matches the pinned form.html table', async () => {
  const rig = await openRig('form.html', 'Fixture form');
  try {
    const observation = await rig.driver.observe(rig.pageId);
    assert.equal(observation.title, 'Fixture form');
    assert.match(observation.url, /\/form\.html$/);
    assert.equal(observation.truncated, false);
    assert.deepEqual(observation.elements, PINNED_FORM_ELEMENTS);
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
const PINNED_FORM_ELEMENTS: ElementRecord[] = [
  {
    id: 'e1',
    path: '#fullname',
    tag: 'input',
    role: 'textbox',
    name: 'Full name',
    type: 'text',
    attrName: 'fullname',
    ariaLabel: '',
    autocomplete: '',
    state: { disabled: false, filled: false },
    editable: true,
    inViewport: true,
    rect: { x: 72, y: 101, w: 177, h: 21 },
    form: 0,
    fingerprint: { tag: 'input', role: 'textbox', name: 'Full name', x: 72, y: 101 },
  },
  {
    id: 'e2',
    path: '#email',
    tag: 'input',
    role: 'textbox',
    name: 'Email',
    type: 'email',
    attrName: 'email',
    ariaLabel: 'Email',
    autocomplete: '',
    state: { disabled: false, filled: false },
    editable: true,
    inViewport: true,
    rect: { x: 249, y: 101, w: 177, h: 21 },
    form: 0,
    fingerprint: { tag: 'input', role: 'textbox', name: 'Email', x: 249, y: 101 },
  },
  {
    id: 'e3',
    path: '#notes',
    tag: 'textarea',
    role: 'textbox',
    name: 'Notes',
    type: '',
    attrName: 'notes',
    ariaLabel: '',
    autocomplete: '',
    state: { disabled: false, filled: true },
    editable: true,
    inViewport: true,
    rect: { x: 426, y: 80, w: 168, h: 36 },
    form: 0,
    fingerprint: { tag: 'textarea', role: 'textbox', name: 'Notes', x: 426, y: 80 },
  },
  {
    id: 'e4',
    path: '#country',
    tag: 'select',
    role: 'combobox',
    name: 'Country',
    type: '',
    attrName: 'country',
    ariaLabel: '',
    autocomplete: '',
    state: { disabled: false, selected: 'Choose' },
    editable: false,
    inViewport: true,
    rect: { x: 647, y: 102, w: 103, h: 19 },
    form: 0,
    fingerprint: { tag: 'select', role: 'combobox', name: 'Country', x: 647, y: 102 },
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
    ariaLabel: '',
    autocomplete: '',
    state: { disabled: false },
    editable: false,
    inViewport: true,
    rect: { x: 8, y: 122, w: 69, h: 21 },
    form: 0,
    fingerprint: { tag: 'button', role: 'button', name: 'Continue', x: 8, y: 122 },
  },
  {
    id: 'e6',
    path: '#place',
    tag: 'button',
    role: 'button',
    name: 'Place order',
    type: 'submit',
    attrName: '',
    ariaLabel: '',
    autocomplete: '',
    state: { disabled: false },
    editable: false,
    inViewport: true,
    rect: { x: 77, y: 122, w: 84, h: 21 },
    form: 0,
    fingerprint: { tag: 'button', role: 'button', name: 'Place order', x: 77, y: 122 },
  },
];

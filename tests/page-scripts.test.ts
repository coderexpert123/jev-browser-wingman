import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startFixtureServer } from '../src/fixture-server.js';
import {
  buildEnumerateExpression,
  buildVerifyExpression,
  buildHitTestExpression,
} from '../src/core/page-scripts.js';

interface Observation {
  url: string;
  title: string;
  elements: Array<Record<string, unknown>>;
  forms: Array<Record<string, unknown>>;
  signals: Record<string, unknown>;
  text: string;
  truncated: boolean;
}

let fixtureUrl: string;
let closeFixtureServer: () => Promise<void>;
let browser: Browser;

test.before(async () => {
  const server = await startFixtureServer();
  fixtureUrl = server.url;
  closeFixtureServer = server.close;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

test.after(async () => {
  await browser.close();
  await closeFixtureServer();
});

async function withPage(path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const page = await browser.newPage();
  await page.goto(`${fixtureUrl}${path}`);
  return { page, close: () => page.close() };
}

async function enumerateAt(page: Page, opts: { maxElements: number; maxTextChars: number }): Promise<Observation> {
  const expr = buildEnumerateExpression(opts);
  return page.evaluate(expr) as Promise<Observation>;
}

test('form.html element table matches the pinned table', async () => {
  const { page, close } = await withPage('/form.html');
  try {
    const obs = await enumerateAt(page, { maxElements: 240, maxTextChars: 3000 });
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
      assert.strictEqual(e.form, 0);
    }
  } finally {
    await close();
  }
});

test('styled-controls.html proxies hidden inputs through their labels', async () => {
  const { page, close } = await withPage('/styled-controls.html');
  try {
    const obs = await enumerateAt(page, { maxElements: 240, maxTextChars: 3000 });
    const simplified = obs.elements.map((e) => ({
      id: e.id, tag: e.tag, role: e.role, name: e.name, path: e.path, controlPath: e.controlPath, state: e.state,
    }));
    assert.deepStrictEqual(simplified, [
      {
        id: 'e1', tag: 'input', role: 'checkbox', name: 'Send me the newsletter',
        path: '#l-news', controlPath: '#news', state: { disabled: false, checked: false },
      },
      {
        id: 'e2', tag: 'input', role: 'radio', name: 'Basic plan',
        path: '#l-basic', controlPath: '#basic', state: { disabled: false, checked: false },
      },
      {
        id: 'e3', tag: 'input', role: 'radio', name: 'Pro plan',
        path: '#l-pro', controlPath: '#pro', state: { disabled: false, checked: false },
      },
      {
        id: 'e4', tag: 'input', role: 'checkbox', name: 'I agree to the terms',
        path: '#terms', controlPath: undefined, state: { disabled: false, checked: false },
      },
    ]);
  } finally {
    await close();
  }
});

test('verify resolves proxied styled controls through the label path', async () => {
  const { page, close } = await withPage('/styled-controls.html');
  try {
    const obs = await enumerateAt(page, { maxElements: 240, maxTextChars: 3000 });
    for (const expectedName of ['Send me the newsletter', 'Basic plan', 'Pro plan']) {
      const el = obs.elements.find((e) => e.name === expectedName);
      assert.ok(el, `expected a proxied element named ${expectedName}`);
      assert.ok(el!.controlPath, 'expected the element to be a proxy (controlPath set)');
      const fp = el!.fingerprint as { tag: string; role: string; name: string; x: number; y: number };
      const result = await page.evaluate(buildVerifyExpression(el!.path as string, fp));
      assert.deepStrictEqual(result, { ok: true });
    }
  } finally {
    await close();
  }
});

test('text excerpt never contains the prefilled textarea text', async () => {
  const { page, close } = await withPage('/form.html');
  try {
    const obs = await enumerateAt(page, { maxElements: 240, maxTextChars: 3000 });
    assert.ok(!obs.text.includes('prefilled note text'));
  } finally {
    await close();
  }
});

test('enumeration adds no globals and makes no DOM mutations', async () => {
  const { page, close } = await withPage('/form.html');
  try {
    const expr = buildEnumerateExpression({ maxElements: 240, maxTextChars: 3000 });
    const result = await page.evaluate((exprText: string) => {
      const before = Object.getOwnPropertyNames(window);
      const observer = new MutationObserver(() => {});
      observer.observe(document.documentElement, {
        attributes: true, childList: true, subtree: true, characterData: true,
      });
      // eslint-disable-next-line no-eval
      const obs = eval(exprText) as { elements: unknown[] };
      const mutationCount = observer.takeRecords().length;
      observer.disconnect();
      const after = Object.getOwnPropertyNames(window);
      const addedGlobals = after.filter((k) => !before.includes(k));
      return { addedGlobals, mutationCount, elementCount: obs.elements.length };
    }, expr);
    assert.deepStrictEqual(result.addedGlobals, []);
    assert.strictEqual(result.mutationCount, 0);
    assert.ok(result.elementCount > 0);
  } finally {
    await close();
  }
});

test('many.html returns 300 elements untruncated and 100 with truncated=true at maxElements 100', async () => {
  const { page, close } = await withPage('/many.html');
  try {
    const full = await enumerateAt(page, { maxElements: 400, maxTextChars: 3000 });
    assert.strictEqual(full.elements.length, 300);
    assert.strictEqual(full.truncated, false);

    const limited = await enumerateAt(page, { maxElements: 100, maxTextChars: 3000 });
    assert.strictEqual(limited.elements.length, 100);
    assert.strictEqual(limited.truncated, true);
  } finally {
    await close();
  }
});

test('password.html sets password and currentPassword signals', async () => {
  const { page, close } = await withPage('/password.html');
  try {
    const obs = await enumerateAt(page, { maxElements: 240, maxTextChars: 3000 });
    assert.strictEqual(obs.signals.password, true);
    assert.strictEqual(obs.signals.currentPassword, true);
    assert.strictEqual(obs.signals.newPassword, false);
  } finally {
    await close();
  }
});

test('otp.html sets otpAutocomplete and otpText signals', async () => {
  const { page, close } = await withPage('/otp.html');
  try {
    const obs = await enumerateAt(page, { maxElements: 240, maxTextChars: 3000 });
    assert.strictEqual(obs.signals.otpAutocomplete, true);
    assert.strictEqual(obs.signals.otpText, true);
  } finally {
    await close();
  }
});

test('big-select.html carries 300 options on the select element', async () => {
  const { page, close } = await withPage('/big-select.html');
  try {
    const obs = await enumerateAt(page, { maxElements: 240, maxTextChars: 3000 });
    const select = obs.elements.find((e) => e.tag === 'select');
    assert.ok(select);
    assert.strictEqual((select!.options as unknown[]).length, 300);
  } finally {
    await close();
  }
});

test('verify returns mismatch after the button text changes', async () => {
  const { page, close } = await withPage('/form.html');
  try {
    const obs = await enumerateAt(page, { maxElements: 240, maxTextChars: 3000 });
    const continueBtn = obs.elements.find((e) => e.name === 'Continue');
    assert.ok(continueBtn);
    const fp = continueBtn!.fingerprint as { tag: string; role: string; name: string; x: number; y: number };

    const okExpr = buildVerifyExpression(continueBtn!.path as string, fp);
    const okResult = await page.evaluate(okExpr);
    assert.deepStrictEqual(okResult, { ok: true });

    await page.evaluate((path: string) => {
      const el = document.querySelector(path);
      if (el) el.textContent = 'Something else entirely';
    }, continueBtn!.path as string);

    const mismatchExpr = buildVerifyExpression(continueBtn!.path as string, fp);
    const mismatchResult = await page.evaluate(mismatchExpr);
    assert.deepStrictEqual(mismatchResult, { ok: false, reason: 'mismatch' });
  } finally {
    await close();
  }
});

test('hit test reports covered on overlay.html', async () => {
  const { page, close } = await withPage('/overlay.html');
  try {
    const obs = await enumerateAt(page, { maxElements: 240, maxTextChars: 3000 });
    const target = obs.elements.find((e) => e.name === 'Show details');
    assert.ok(target);
    const expr = buildHitTestExpression(target!.path as string);
    const result = (await page.evaluate(expr)) as { ok: boolean; covered?: boolean };
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.covered, true);
  } finally {
    await close();
  }
});

test('a button without a type attribute reports the defaulted submit type', async () => {
  const { page, close } = await withPage('/form.html');
  try {
    await page.evaluate(() => {
      const form = document.querySelector('form');
      if (!form) return;
      const b = document.createElement('button');
      b.textContent = 'Bare submit';
      form.appendChild(b);
    });
    const obs = await enumerateAt(page, { maxElements: 240, maxTextChars: 3000 });
    const bare = obs.elements.find((e) => e.name === 'Bare submit');
    assert.ok(bare);
    assert.strictEqual(bare!.type, 'submit');
  } finally {
    await close();
  }
});

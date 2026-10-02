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
  focus?: { path: string; role: string; name: string };
  repeatedGroups?: Array<{ signature: string; count: number }>;
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

test('enumeration emits obscured and coveredBy on overlay.html', async () => {
  // Amendment 2026-09-21h: the enumerate-time occlusion probe (§ 3.5). Every
  // record carries a boolean `obscured`; a covered element also names its
  // cover. Fail-first: the pre-amendment enumerate emits neither field, so the
  // typeof assertion sees undefined.
  const { page, close } = await withPage('/overlay.html');
  try {
    const obs = await enumerateAt(page, { maxElements: 240, maxTextChars: 3000 });
    for (const e of obs.elements) {
      assert.strictEqual(typeof e.obscured, 'boolean', `record ${e.id} carries a boolean obscured`);
    }
    const target = obs.elements.find((e) => e.name === 'Show details');
    assert.ok(target, 'the veiled button is enumerated');
    assert.strictEqual(target!.obscured, true);
    assert.strictEqual(target!.coveredBy, 'div#veil');
    const dismiss = obs.elements.find((e) => e.name === 'Dismiss');
    assert.ok(dismiss, 'the banner button is enumerated');
    assert.strictEqual(dismiss!.obscured, false);
    assert.strictEqual(dismiss!.coveredBy, undefined);
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

test('enumeration emits placeholder and htmlId on form controls', async () => {
  // Amendment 2026-09-21b: the record must carry the machine attributes the
  // § 3.5 criterion enrichment appends. Fail-first: the pre-amendment
  // enumerate emits neither field, so both assertions see undefined.
  const { page, close } = await withPage('/form.html');
  try {
    const obs = await enumerateAt(page, { maxElements: 240, maxTextChars: 3000 });
    const notes = obs.elements.find((e) => e.name === 'Notes');
    assert.ok(notes, 'expected the notes textarea');
    assert.strictEqual(notes!.placeholder, 'Notes');
    assert.strictEqual(notes!.htmlId, 'notes');
    const fullname = obs.elements.find((e) => e.name === 'Full name');
    assert.ok(fullname, 'expected the fullname input');
    assert.strictEqual(fullname!.htmlId, 'fullname');
    assert.strictEqual(fullname!.placeholder, '');
  } finally {
    await close();
  }
});

test('a labelled file input enumerates as button and verifies (A1)', async () => {
  // The 0.3.0 upload op targets file inputs, and Jev picks targets by role:
  // both implicitRole copies must classify input[type=file] as 'button', so
  // enumerate's fingerprint and verify agree (a 'textbox' copy fails verify).
  const { page, close } = await withPage('/ops.html');
  try {
    const obs = await enumerateAt(page, { maxElements: 240, maxTextChars: 3000 });
    const doc = obs.elements.find((e) => e.name === 'Document');
    assert.ok(doc, 'expected the labelled file input');
    assert.strictEqual(doc!.tag, 'input');
    assert.strictEqual(doc!.type, 'file');
    assert.strictEqual(doc!.role, 'button');
    const fp = doc!.fingerprint as { tag: string; role: string; name: string; x: number; y: number };
    const result = await page.evaluate(buildVerifyExpression(doc!.path as string, fp));
    assert.deepStrictEqual(result, { ok: true });
  } finally {
    await close();
  }
});

// r17 (D7): a visually hidden checkbox/radio resolves its name through an
// adjacent visible sibling <label> (the TodoMVC shape) — PROXY arm, path is
// the label, controlPath is the input; failing a label, a non-empty
// accessibleName (aria-label → placeholder → title here) keeps the record
// NON-proxy on the input's own path; with no name source at all the input is
// never enumerated.
test('hidden-controls.html names hidden inputs through sibling labels and their own names', async () => {
  const { page, close } = await withPage('/hidden-controls.html');
  try {
    const obs = await enumerateAt(page, { maxElements: 240, maxTextChars: 3000 });
    const byId = new Map(obs.elements.map((e) => [e.htmlId as string, e]));
    // Proxy arm — sibling label AFTER the input.
    const alpha = byId.get('t1');
    assert.ok(alpha, 'expected the Alpha task record');
    assert.strictEqual(alpha!.name, 'Alpha task');
    assert.strictEqual(alpha!.role, 'checkbox');
    assert.strictEqual(alpha!.controlPath, '#t1');
    assert.notStrictEqual(alpha!.path, '#t1');
    // Proxy arm — sibling label BEFORE the input.
    const beta = byId.get('t2');
    assert.ok(beta, 'expected the Beta task record');
    assert.strictEqual(beta!.name, 'Beta task');
    assert.strictEqual(beta!.role, 'checkbox');
    assert.strictEqual(beta!.controlPath, '#t2');
    assert.notStrictEqual(beta!.path, '#t2');
    // Named-only arm — aria-label: the record stays on the input's own path.
    const aria = byId.get('t3');
    assert.ok(aria, 'expected the aria-named record');
    assert.strictEqual(aria!.name, 'Hidden aria');
    assert.strictEqual(aria!.role, 'checkbox');
    assert.strictEqual(aria!.path, '#t3');
    assert.strictEqual(aria!.controlPath, undefined);
    // Named-only arm — title, on a radio.
    const titled = byId.get('t4');
    assert.ok(titled, 'expected the title-named record');
    assert.strictEqual(titled!.name, 'Hidden title');
    assert.strictEqual(titled!.role, 'radio');
    assert.strictEqual(titled!.path, '#t4');
    assert.strictEqual(titled!.controlPath, undefined);
    // Named-only arm — placeholder.
    const phased = byId.get('t5');
    assert.ok(phased, 'expected the placeholder-named record');
    assert.strictEqual(phased!.name, 'Hidden placeholder');
    assert.strictEqual(phased!.path, '#t5');
    assert.strictEqual(phased!.controlPath, undefined);
    // Proxy through a visible label[for] on a display:none input (the byFor
    // arm still works under the new sibling fallback).
    const fine = byId.get('t6');
    assert.ok(fine, 'expected the Fine print record');
    assert.strictEqual(fine!.name, 'Fine print');
    assert.strictEqual(fine!.path, '#l-t6');
    assert.strictEqual(fine!.controlPath, '#t6');
    // No label, no aria-label, no title, no placeholder: never enumerated.
    assert.strictEqual(byId.get('t7'), undefined, 'the unnamed hidden input must not enumerate');
  } finally {
    await close();
  }
});

// r17 (D2): the focused element rides the observation as evidence (computed
// once beside textExcerpt).
test('enumeration reports the focused element', async () => {
  const { page, close } = await withPage('/ops.html');
  try {
    await page.focus('#first');
    const obs = await enumerateAt(page, { maxElements: 240, maxTextChars: 3000 });
    assert.ok(obs.focus, 'expected a focus record on the observation');
    assert.strictEqual(obs.focus!.path, '#first');
    assert.strictEqual(obs.focus!.role, 'textbox');
    assert.strictEqual(obs.focus!.name, 'First');
  } finally {
    await close();
  }
});

// r17 (C8): repeated-element group tallies over ALL nodes, groups with count
// >= 3 kept. many.html's 300 class-less buttons give the deterministic pin;
// chain-scroll.html crosses the floor only once its .item list reaches 3+.
test('repeatedGroups counts the many.html button field', async () => {
  const { page, close } = await withPage('/many.html');
  try {
    const obs = await enumerateAt(page, { maxElements: 400, maxTextChars: 3000 });
    const group = obs.repeatedGroups?.find((g) => g.signature === 'button.');
    assert.ok(group, 'expected a button. group on many.html');
    assert.strictEqual(group!.count, 300);
  } finally {
    await close();
  }
});

test('repeatedGroups counts div.item once the list crosses the group floor', async () => {
  const { page, close } = await withPage('/chain-scroll.html');
  try {
    const before = await enumerateAt(page, { maxElements: 240, maxTextChars: 3000 });
    // The fixture starts with 2 items — below the >= 3 floor, no div.item
    // group (repeatedGroups itself is absent when no group qualifies).
    assert.ok(
      !before.repeatedGroups?.some((g) => g.signature === 'div.item'),
      'two items sit below the >= 3 group floor',
    );
    await page.evaluate(() => window.scrollTo(0, 2000));
    await page.waitForTimeout(150);
    await page.evaluate(() => window.scrollTo(0, 4000));
    await page.waitForTimeout(150);
    const after = await enumerateAt(page, { maxElements: 240, maxTextChars: 3000 });
    const items = after.repeatedGroups?.find((g) => g.signature === 'div.item');
    assert.ok(items, 'expected a div.item group after scrolling');
    assert.ok((items!.count ?? 0) >= 4, `div.item count ${String(items!.count)} >= 4`);
    for (const g of after.repeatedGroups ?? []) {
      assert.ok(g.count >= 3, `group ${g.signature} below the >= 3 floor`);
    }
  } finally {
    await close();
  }
});

// r17 (D7 mirror): verify re-finds the sibling-labeled hidden input through
// the label record, and the named-only arm re-verifies on the input's own
// path with no proxy rewrite.
test('verify re-finds hidden-control records through the label and their own path', async () => {
  const { page, close } = await withPage('/hidden-controls.html');
  try {
    const obs = await enumerateAt(page, { maxElements: 240, maxTextChars: 3000 });
    for (const expectedName of ['Alpha task', 'Beta task', 'Fine print']) {
      const el = obs.elements.find((e) => e.name === expectedName);
      assert.ok(el, `expected a proxied element named ${expectedName}`);
      assert.ok(el!.controlPath, `expected ${expectedName} to be a proxy record`);
      const fp = el!.fingerprint as { tag: string; role: string; name: string; x: number; y: number };
      const result = await page.evaluate(buildVerifyExpression(el!.path as string, fp));
      assert.deepStrictEqual(result, { ok: true });
    }
    for (const expectedName of ['Hidden aria', 'Hidden title', 'Hidden placeholder']) {
      const el = obs.elements.find((e) => e.name === expectedName);
      assert.ok(el, `expected a named-only element named ${expectedName}`);
      assert.strictEqual(el!.controlPath, undefined);
      const fp = el!.fingerprint as { tag: string; role: string; name: string; x: number; y: number };
      const result = await page.evaluate(buildVerifyExpression(el!.path as string, fp));
      assert.deepStrictEqual(result, { ok: true });
    }
  } finally {
    await close();
  }
});

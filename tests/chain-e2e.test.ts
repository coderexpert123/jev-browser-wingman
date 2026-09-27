// chain E2E (spec 2026-09-26-wingman-forced-handoff § 6 WP-B2; Chrome file).
// The server under test is the real built CLI (`node <this build>/src/cli/main.js
// mcp`) spawned in the pick-e2e style: a temp WINGMAN_HOME, the shared headless
// Chrome via WINGMAN_CDP_ENDPOINT, and the decision service from
// startTypeSafeStub. The config has mode 'on' and NO handoff key, so it runs
// forced (§ 5.3).
//
// The stub policy is deterministic: it reads state.url, state.text, state.step,
// state.history and the target criteria, and answers per the § 6 WP-B2 clause
// table. Defaults are 0.05; every chain row not listed with ready/right_page
// answers those 0.95 (the defaults below).
//
// E1 the four-clause chain in one call; E2 the same chain split by max_steps
// and resumed from the chain memory; E3 the D7 pin (navigate only from a
// url-typed binding); E4 the mechanical wait; E5 the verbatim t9 first call;
// E6 recover; E7 the ready Noul; E8 scroll_to.
//
// SCOPED GATE DEFERRED per § 3 rule 9: this file builds src/cli/main.ts and
// its E-runs need WP-A's adapter ops (back/navigate/wait/reload). It runs only
// after "WP-A gate green".

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { launchTestChrome } from './helpers/chrome.js';
import { fillDefaultAnswers, startTypeSafeStub } from './helpers/typesafe-stub.js';
import { startFixtureServer } from '../src/fixture-server.js';
import type { WingmanResult } from '../src/contract/types.js';

const mainJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.js');

// ---- shared browser and fixture server ----

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

function scrubEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (
      k === 'WINGMAN_HOME' ||
      k === 'WINGMAN_CDP_ENDPOINT' ||
      k === 'PLAYWRIGHT_MCP_CDP_ENDPOINT' ||
      k === 'TYPESAFE_API_KEY' ||
      k === 'TYPESAFE_BASE_URL'
    ) {
      continue;
    }
    env[k] = v;
  }
  return env;
}

function mkHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-chain-e2e-'));
  // No handoff key: with mode 'on' this loads forced (§ 5.3).
  const config = {
    mode: 'on',
    adapter: 'cdp',
    window: 'headless',
    profile_dir: path.join(home, 'profile'),
    port: chrome.port,
  };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  return home;
}

interface ServerHandle {
  home: string;
  client: Client;
  close(): Promise<void>;
}

async function startServer(stubUrl: string): Promise<ServerHandle> {
  const home = mkHome();
  const env: Record<string, string> = {
    ...scrubEnv(),
    WINGMAN_HOME: home,
    WINGMAN_CDP_ENDPOINT: chrome.endpoint,
    TYPESAFE_API_KEY: 'dummy-key',
    TYPESAFE_BASE_URL: stubUrl,
  };
  const transport = new StdioClientTransport({ command: process.execPath, args: [mainJs, 'mcp'], env });
  const client = new Client({ name: 'wingman-chain-e2e', version: '0.0.0' });
  await client.connect(transport);
  return { home, client, close: () => client.close() };
}

async function callTool(client: Client, args: Record<string, unknown>): Promise<WingmanResult> {
  const res = (await client.callTool({ name: 'browse_step', arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  assert.notEqual(res.isError, true, 'browse_step returned isError for a status result');
  return JSON.parse(res.content[0].text) as WingmanResult;
}

async function openFixturePage(name: string): Promise<string> {
  const res = await fetch(`${chrome.endpoint}/json/new?${fixture.url}/${name}.html`, { method: 'PUT' });
  const info = (await res.json()) as { id: string };
  return info.id;
}

async function closeFixturePage(id: string): Promise<void> {
  await fetch(`${chrome.endpoint}/json/close/${id}`).catch(() => {});
}

/** The visible page's url and title, via the CDP /json list. */
async function visiblePage(): Promise<{ url: string; title: string }> {
  const res = await fetch(`${chrome.endpoint}/json/list`);
  const pages = (await res.json()) as Array<{ url: string; title: string; type: string }>;
  const page = pages.find((p) => p.type === 'page' && p.url.startsWith(fixture.url));
  assert.ok(page, 'a fixture page is open');
  return { url: page.url, title: page.title };
}

/** Read a main-world value from a fixture page, through a fresh CDP attach. */
async function pageEval(urlPart: string, fn: () => unknown): Promise<unknown> {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(chrome.endpoint, { noDefaults: true });
  try {
    const ctx = browser.contexts()[0];
    const page = ctx.pages().find((p) => p.url().includes(urlPart));
    if (!page) return null;
    return await page.evaluate(fn);
  } finally {
    await browser.close();
  }
}

/** The last browse_step log record from the server's log.jsonl. */
function lastLogRecord(home: string): Record<string, unknown> {
  const lines = fs.readFileSync(path.join(home, 'log.jsonl'), 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

// ---- the deterministic stub policy ----

interface StubQuestion {
  type: string;
  criteria?: Record<string, string>;
}

function findId(target: StubQuestion | undefined, regex: RegExp): string | null {
  for (const [id, text] of Object.entries(target?.criteria ?? {})) {
    if (regex.test(text)) return id;
  }
  return null;
}

async function startChainStub(opts: { urlAnswer: string }): Promise<Awaited<ReturnType<typeof startTypeSafeStub>>> {
  return await startTypeSafeStub((body) => {
    const state = (body.state ?? {}) as {
      url?: string;
      text?: string;
      step?: string;
      history?: Array<{ verb: string; label: string }>;
    };
    const q = (body.questions ?? {}) as Record<string, StubQuestion>;
    const url = state.url ?? '';
    const text = state.text ?? '';
    const step = state.step ?? '';
    const history = state.history ?? [];
    const answers: Record<string, unknown> = {};

    const noul = (key: string, v: number): void => {
      if (key in q) answers[key] = { type: 'noul', noul: v };
    };
    const cho = (key: string, c: string, probs: Record<string, number>): void => {
      if (key in q) answers[key] = { type: 'choice', choice: c, probabilities: probs, confidence: 0.9 };
    };
    const clickOn = (regex: RegExp): boolean => {
      const id = findId(q.target, regex);
      if (id === null) return false;
      cho('action', 'click', { click: 0.9, none: 0.05 });
      cho('target', id, { [id]: 0.9, none: 0.05, ambiguous: 0.05 });
      return true;
    };

    // Defaults: quiet Nouls, ready and right_page high on every chain round.
    for (const [key, v] of Object.entries({
      done: 0.05, blocked: 0.05, login: 0.05, error: 0.05, irreversible: 0.05,
      step_done: 0.05, right_page: 0.95, ready: 0.95,
    })) {
      noul(key, v);
    }

    if (step.includes('tick Accept terms')) {
      if (url.includes('chain-check.html')) {
        const box = findId(q.target, /checkbox "Accept terms"/);
        const checked = box !== null && /checkbox "Accept terms".*\(checked\)/.test(q.target?.criteria?.[box] ?? '');
        if (checked) {
          noul('step_done', 0.95);
        } else if (box !== null) {
          cho('action', 'check', { check: 0.9, none: 0.05 });
          cho('target', box, { [box]: 0.9, none: 0.05, ambiguous: 0.05 });
        }
      } else {
        clickOn(/link "Checkboxes"/);
      }
    } else if (step.includes('go back to the index')) {
      if (url.includes('chain-check.html')) {
        cho('action', 'back', { back: 0.9, none: 0.05 });
      } else {
        noul('step_done', 0.95);
      }
    } else if (step.includes('by its address')) {
      if (url.includes('chain-form.html')) {
        noul('step_done', 0.95);
      } else {
        cho('action', 'navigate', { navigate: 0.9, none: 0.05 });
        cho('url', opts.urlAnswer, { [opts.urlAnswer]: 0.9, none: 0.05 });
      }
    } else if (step.includes('value named email')) {
      if (url.includes('chain-form.html')) {
        if (text.includes('sent:')) {
          noul('step_done', 0.95);
        } else {
          const empty = findId(q.target, /textbox "Email".*\(empty\)/);
          if (empty !== null) {
            cho('action', 'fill', { fill: 0.9, none: 0.05 });
            cho('target', empty, { [empty]: 0.9, none: 0.05, ambiguous: 0.05 });
            cho('value', 'email', { email: 0.9, none: 0.05 });
          } else {
            clickOn(/button "Send"/);
          }
        }
      } else {
        clickOn(/link "Form"/);
      }
    } else if (step.includes('open Form')) {
      if (url.includes('chain-form.html')) {
        noul('step_done', 0.95);
      } else if (url.includes('chain-error.html')) {
        if (text.includes('Not found')) {
          noul('error', 0.9);
          cho('recover', 'back', { back: 0.9, none: 0.05 });
        } else if (history.some((h) => /Broken link/.test(h.label))) {
          clickOn(/link "Form"/);
        } else {
          clickOn(/link "Broken link"/);
        }
      } else {
        clickOn(/link "Form"/);
      }
    } else if (step.includes('Finish')) {
      if (text.includes('finished')) {
        noul('step_done', 0.95);
      } else if (findId(q.target, /button "Finish"/) !== null) {
        noul('ready', step.includes('wait for Finish') ? 0.95 : 0.9);
        clickOn(/button "Finish"/);
      } else if (history.some((h) => h.verb === 'click' && /Start/.test(h.label))) {
        if (step.includes('wait for Finish')) {
          cho('action', 'wait', { wait: 0.9, none: 0.05 });
        } else {
          // E7: ready low with a click answer — the loop must wait, not act.
          noul('ready', 0.2);
          clickOn(/button "Start"/);
        }
      } else {
        clickOn(/button "Start"/);
      }
    } else if (step.includes('Far away')) {
      if (text.includes('far')) {
        noul('step_done', 0.95);
      } else if (history.some((h) => h.verb === 'scroll_to')) {
        clickOn(/button "Far away"/);
      } else {
        const id = findId(q.target, /button "Far away"/);
        cho('action', 'scroll_to', { scroll_to: 0.9, none: 0.05 });
        if (id !== null) cho('target', id, { [id]: 0.9, none: 0.05, ambiguous: 0.05 });
      }
    }

    // Every other question the request asks (key is always offered; value
    // when no clause above filled it, recover/step_done/right_page/ready
    // otherwise) gets a neutral default so parseJevAnswers never rejects the
    // response as invalid.
    return { status: 200, body: { answers: fillDefaultAnswers(q, answers), usage: {} } };
  });
}

// ---- shared clause texts ----

const CLAUSE_CHECK = 'open Checkboxes and tick Accept terms';
const CLAUSE_BACK = 'go back to the index';
const CLAUSE_FORM = 'open Form';
const CLAUSE_SEND = 'type the value named email into Email and click Send';

// ---- E1: the four-clause chain in one call ----

test('E1: the four-clause chain completes in one call', { timeout: 120_000 }, async () => {
  const stub = await startChainStub({ urlAnswer: 'none' });
  const s = await startServer(stub.url);
  const pageId = await openFixturePage('chain-index');
  try {
    const r = await callTool(s.client, {
      goal: 'chain-e2e E1 four clause goal',
      steps: [CLAUSE_CHECK, CLAUSE_BACK, CLAUSE_FORM, CLAUSE_SEND],
      values: { email: 'wingman@example.com' },
      url_match: 'chain-index.html',
    });
    assert.equal(r.status, 'done', `reason: ${r.reason}`);
    assert.ok(r.steps >= 6, `steps ${r.steps} >= 6`);
    assert.deepEqual(r.progress, { step_index: 4, steps_done: 4, steps_total: 4 });
    const log = await pageEval('chain-form.html', () => document.getElementById('log')?.textContent ?? null);
    assert.equal(log, 'sent:wingman@example.com:1');
    const rec = lastLogRecord(s.home);
    assert.equal((rec.acts_by_op as Record<string, number>)?.back, 1);
  } finally {
    await s.close();
    await stub.close();
    await closeFixturePage(pageId);
  }
});

// ---- E2: budget-steps, then resume from the chain memory ----

test('E2: max_steps splits the chain; the re-call resumes on clause 3', { timeout: 120_000 }, async () => {
  const stub = await startChainStub({ urlAnswer: 'none' });
  const s = await startServer(stub.url);
  const pageId = await openFixturePage('chain-index');
  const args = {
    goal: 'chain-e2e E2 resume goal',
    steps: [CLAUSE_CHECK, CLAUSE_BACK, CLAUSE_FORM, CLAUSE_SEND],
    values: { email: 'wingman@example.com' },
    url_match: 'chain-index.html',
  };
  try {
    const r1 = await callTool(s.client, { ...args, max_steps: 3 });
    assert.equal(r1.status, 'fallback');
    assert.equal(r1.reason, 'budget-steps');
    assert.equal(r1.progress?.steps_done, 2);

    const r2 = await callTool(s.client, args);
    assert.equal(r2.status, 'done', `reason: ${r2.reason}`);
    assert.deepEqual(r2.progress, { step_index: 4, steps_done: 4, steps_total: 4 });
    // Call 2 ran clauses 3 and 4 only: two clicks (Form, Send) and one fill.
    const rec = lastLogRecord(s.home);
    assert.deepEqual(rec.acts_by_op, { click: 2, fill: 1 });
  } finally {
    await s.close();
    await stub.close();
    await closeFixturePage(pageId);
  }
});

// ---- E3: the D7 pin — navigate only from a url-typed binding ----

test('E3: navigate works from a url binding and bounces no-value otherwise', { timeout: 180_000 }, async () => {
  const good = await startChainStub({ urlAnswer: 'form_url' });
  const sg = await startServer(good.url);
  const pageId = await openFixturePage('chain-index');
  const args = {
    goal: 'chain-e2e E3 navigate goal',
    steps: ['open the form page by its address'],
    values: { form_url: `${fixture.url}/chain-form.html`, note: 'hello' },
    url_match: 'chain-index.html',
  };
  try {
    const rg = await callTool(sg.client, args);
    assert.equal(rg.status, 'done', `reason: ${rg.reason}`);
    const now = await visiblePage();
    assert.ok(now.url.includes('chain-form.html'), `navigated to the form: ${now.url}`);

    for (const bad of ['note', 'none', 'https://evil.example/']) {
      const stub = await startChainStub({ urlAnswer: bad });
      const s = await startServer(stub.url);
      try {
        const r = await callTool(s.client, args);
        assert.equal(r.status, 'fallback', `urlAnswer ${bad}`);
        assert.equal(r.reason, 'step-uncertain', `urlAnswer ${bad}`);
        assert.equal(r.step_review?.why, 'no-value', `urlAnswer ${bad}`);
        const after = await visiblePage();
        assert.ok(after.url.includes('chain-index.html'), `urlAnswer ${bad}: URL unchanged (${after.url})`);
      } finally {
        await s.close();
        await stub.close();
      }
    }
  } finally {
    await sg.close();
    await good.close();
    await closeFixturePage(pageId);
  }
});

// ---- E4: the mechanical wait ----

test('E4: the delay page waits for Finish and finishes', { timeout: 120_000 }, async () => {
  const stub = await startChainStub({ urlAnswer: 'none' });
  const s = await startServer(stub.url);
  const pageId = await openFixturePage('chain-delay');
  try {
    const r = await callTool(s.client, {
      goal: 'chain-e2e E4 wait goal',
      steps: ['click Start, wait for Finish, then click Finish'],
      url_match: 'chain-delay.html',
    });
    assert.equal(r.status, 'done', `reason: ${r.reason}`);
    const log = await pageEval('chain-delay.html', () => document.getElementById('log')?.textContent ?? null);
    assert.equal(log, 'finished');
    const rec = lastLogRecord(s.home);
    assert.ok(((rec.acts_by_op as Record<string, number>)?.wait ?? 0) >= 1, 'a wait act ran');
  } finally {
    await s.close();
    await stub.close();
    await closeFixturePage(pageId);
  }
});

// ---- E5: the verbatim t9 first call through MCP (C1) ----

test('E5: the verbatim 549-char t9 goal is not invalid-input through tools/call', { timeout: 120_000 }, async () => {
  const stub = await startChainStub({ urlAnswer: 'none' });
  const s = await startServer(stub.url);
  const pageId = await openFixturePage('chain-index');
  try {
    const t9Goal =
      'Multi-page chain, in order: open Checkboxes and tick the first checkbox; open Dropdown and choose Option 1; open Add/Remove Elements and click the Add Element button twice; open Inputs and type the value named amount into the unlabeled number input, the only input field on the page; open Forgot Password, enter the value named email into the E-mail field and click the Retrieve password button; open Dynamic Loading, open the link named Example 2: Element rendered after the fact and click the Start button; open Status Codes and open the 404 link.';
    assert.equal(t9Goal.length, 549);
    const r = await callTool(s.client, {
      goal: t9Goal,
      steps: [CLAUSE_CHECK, CLAUSE_FORM],
      values: { email: 'x@example.com', amount: 77 },
      url_match: 'chain-index.html',
    });
    assert.notEqual(r.reason, 'invalid-input');
    assert.notEqual(r.status, 'error');
  } finally {
    await s.close();
    await stub.close();
    await closeFixturePage(pageId);
  }
});

// ---- E6: recover (Q5) ----

test('E6: a broken link recovers with back and then opens Form', { timeout: 120_000 }, async () => {
  const stub = await startChainStub({ urlAnswer: 'none' });
  const s = await startServer(stub.url);
  const pageId = await openFixturePage('chain-error');
  try {
    const r = await callTool(s.client, {
      goal: 'chain-e2e E6 recover goal',
      steps: [CLAUSE_FORM],
      url_match: 'chain-error.html',
    });
    assert.equal(r.status, 'done', `reason: ${r.reason}`);
    const rec = lastLogRecord(s.home);
    assert.equal((rec.acts_by_op as Record<string, number>)?.back, 1);
    const now = await visiblePage();
    assert.equal(now.title, 'Fixture chain form');
  } finally {
    await s.close();
    await stub.close();
    await closeFixturePage(pageId);
  }
});

// ---- E7: the ready Noul (Q5) ----

test('E7: the ready variant waits for Finish without acting while ready is low', { timeout: 120_000 }, async () => {
  const stub = await startChainStub({ urlAnswer: 'none' });
  const s = await startServer(stub.url);
  const pageId = await openFixturePage('chain-delay');
  try {
    const r = await callTool(s.client, {
      goal: 'chain-e2e E7 ready goal',
      steps: ['click Start, then click Finish once it appears'],
      url_match: 'chain-delay.html',
    });
    assert.equal(r.status, 'done', `reason: ${r.reason}`);
    const log = await pageEval('chain-delay.html', () => document.getElementById('log')?.textContent ?? null);
    assert.equal(log, 'finished');
    const rec = lastLogRecord(s.home);
    const byOp = rec.acts_by_op as Record<string, number>;
    assert.ok((byOp.wait ?? 0) >= 1, 'a wait act ran');
    for (const op of Object.keys(byOp)) {
      assert.ok(op === 'click' || op === 'wait', `no act other than click/wait ran: ${op}`);
    }
  } finally {
    await s.close();
    await stub.close();
    await closeFixturePage(pageId);
  }
});

// ---- E8: scroll_to (Q5) ----

test('E8: scroll_to brings Far away into view and clicks it', { timeout: 120_000 }, async () => {
  const stub = await startChainStub({ urlAnswer: 'none' });
  const s = await startServer(stub.url);
  const pageId = await openFixturePage('ops');
  try {
    const r = await callTool(s.client, {
      goal: 'chain-e2e E8 scroll to goal',
      steps: ['click Far away'],
      url_match: 'ops.html',
    });
    assert.equal(r.status, 'done', `reason: ${r.reason}`);
    const log = await pageEval('ops.html', () => document.getElementById('log')?.textContent ?? null);
    assert.equal(log, 'far');
    const rec = lastLogRecord(s.home);
    assert.equal((rec.acts_by_op as Record<string, number>)?.scroll_to, 1);
  } finally {
    await s.close();
    await stub.close();
    await closeFixturePage(pageId);
  }
});
